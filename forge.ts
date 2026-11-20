// The forge's store and domain logic, shared by every surface (git smart HTTP, REST, GraphQL,
// MCP) so an object created on one surface is the same object on all of them. All state is in
// memory. Nothing here reads a wall clock or a random source: timestamps come from a logical
// counter anchored at 2025-01-01, so a replayed request sequence produces identical bytes.

import {
  ObjectStore,
  buildCommit,
  collectReachable,
  flattenTree,
  isAncestor,
  mergeBase,
  parseIdent,
  unflattenTree,
  type FlatEntry,
} from './gitobj.ts';

/** The account the shop token belongs to: the fixed scenario's viewer (see PLAN.md). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

/** A deterministic logical clock: every call advances the forge's timeline by one second. */
export class LogicalClock {
  private tick = 0;
  nextSec(): number {
    this.tick += 1;
    return EPOCH_SEC + this.tick;
  }
  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSec: number;
}

export interface Issue {
  /** Global numeric id (the REST `id` field), unique across repos. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSec: number;
  updatedSec: number;
  /** Creation order within the repo (issues and pulls share one sequence). */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The head tip as last observed; refreshed from the ref on every read. */
  headSha: string;
  createdSec: number;
  updatedSec: number;
  seq: number;
}

export interface Repo {
  /** The numeric database id, assigned in creation order across the forge. */
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One shared counter for issue and pull numbers, as on GitHub. */
  nextNumber: number;
  nextSeq: number;
  createdSec: number;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly clock = new LogicalClock();
  readonly repos = new Map<string, Repo>();
  private nextDbId = 0;
  private nextIssueId = 0;
  private nextLabelId = 0;
  private nextCommentId = 0;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(Forge.key(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, init: { description?: string; isPrivate?: boolean }): Repo | 'exists' {
    const key = Forge.key(owner, name);
    if (this.repos.has(key)) return 'exists';
    const repo: Repo = {
      dbId: ++this.nextDbId,
      owner,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextSeq: 1,
      createdSec: this.clock.nextSec(),
    };
    // No labels are seeded: the suite creates the labels it uses and expects 201 for them, and
    // an issue may only carry a label the repo actually holds.
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.dbId - b.dbId);
  }

  /** The ident line server-made commits carry: the viewer, at the logical time. */
  ident(sec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
  }

  /** Make a commit in the store and answer its oid. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const sec = this.clock.nextSec();
    const ident = this.ident(sec);
    return this.store.put('commit', buildCommit({ tree, parents, message, author: ident, committer: ident }));
  }

  /** The tip commit oid of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a ref-ish (branch name, full ref, tag name, or raw oid) to a commit oid. */
  resolveCommit(repo: Repo, ref: string): string | null {
    if (!ref) return this.branchTip(repo, repo.defaultBranch);
    const candidates = [
      repo.refs.get(ref),
      repo.refs.get(`refs/heads/${ref}`),
      repo.refs.get(`refs/tags/${ref}`),
      this.store.has(ref) ? ref : undefined,
    ];
    for (const candidate of candidates) {
      if (candidate) return this.store.peelToCommit(candidate);
    }
    return null;
  }

  /**
   * Apply a path->entry change set to a branch as one new commit. `changes` maps a path to its
   * new flat entry, or null to delete it. Returns the new commit oid.
   */
  commitTreeChange(
    repo: Repo,
    branch: string,
    changes: ReadonlyMap<string, FlatEntry | null>,
    message: string,
  ): string {
    const tip = this.branchTip(repo, branch);
    const baseTree = tip ? (this.store.commit(tip)?.tree ?? null) : null;
    const flat = baseTree ? flattenTree(this.store, baseTree) : new Map<string, FlatEntry>();
    for (const [path, entry] of changes) {
      if (entry === null) flat.delete(path);
      else flat.set(path, entry);
    }
    const tree = unflattenTree(this.store, flat);
    const commit = this.makeCommit(tree, tip ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    if (repo.refs.size === 1 && !tip) repo.defaultBranch = branch;
    return commit;
  }

  /** Write one file (creating intermediate trees) as a commit on `branch`. */
  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commit: string; blob: string } {
    const blob = this.store.put('blob', content);
    const commit = this.commitTreeChange(repo, branch, new Map([[path, { mode: '100644', oid: blob }]]), message);
    return { commit, blob };
  }

  /** Register a label on a repo with the forge's next label id. */
  makeLabel(repo: Repo, label: { name: string; color: string; description: string | null }): Label {
    const created: Label = { id: ++this.nextLabelId, name: label.name, color: label.color, description: label.description };
    repo.labels.set(created.name, created);
    return created;
  }

  createIssue(repo: Repo, init: { title: string; body?: string; labels?: string[] }): Issue {
    const sec = this.clock.nextSec();
    const issue: Issue = {
      id: ++this.nextIssueId,
      number: repo.nextNumber++,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      labels: [...(init.labels ?? [])],
      comments: [],
      createdSec: sec,
      updatedSec: sec,
      seq: repo.nextSeq++,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: ++this.nextCommentId, body, createdSec: this.clock.nextSec() };
    issue.comments.push(comment);
    issue.updatedSec = comment.createdSec;
    return comment;
  }

  createPull(repo: Repo, init: { title: string; body?: string; headRef: string; baseRef: string }): Pull | null {
    const headSha = this.branchTip(repo, init.headRef);
    if (!headSha) return null;
    const sec = this.clock.nextSec();
    const pull: Pull = {
      id: ++this.nextIssueId,
      number: repo.nextNumber++,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      merged: false,
      mergedSec: null,
      mergeCommitSha: null,
      headRef: init.headRef,
      baseRef: init.baseRef,
      headSha,
      createdSec: sec,
      updatedSec: sec,
      seq: repo.nextSeq++,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The pull's current head tip: the live ref when it exists, else the last observed sha. */
  pullHeadSha(repo: Repo, pull: Pull): string {
    const tip = this.branchTip(repo, pull.headRef);
    if (tip) pull.headSha = tip;
    return pull.headSha;
  }

  pullBaseSha(repo: Repo, pull: Pull): string | null {
    return this.branchTip(repo, pull.baseRef);
  }
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  /** The blob oid on the head side (absent for a removal). */
  sha: string | null;
}

/** Line counts for one blob pair: an LCS diff for small files, a multiset diff past the cap. */
function lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length * newLines.length <= 4_000_000 && oldLines.length + newLines.length > 0) {
    // Classic LCS dynamic program over lines.
    const m = oldLines.length;
    const n = newLines.length;
    let prev = new Uint32Array(n + 1);
    let curr = new Uint32Array(n + 1);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        curr[j] = oldLines[i] === newLines[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
      }
      [prev, curr] = [curr, prev];
    }
    const common = prev[0];
    return { additions: n - common, deletions: m - common };
  }
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const held = counts.get(line) ?? 0;
    if (held > 0) counts.set(line, held - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const held of counts.values()) deletions += held;
  return { additions, deletions };
}

/** The file diff between two trees (by oid), GitHub's pulls/{n}/files shape. */
export function diffTrees(forge: Forge, baseTree: string | null, headTree: string | null): FileDiff[] {
  const base = baseTree ? flattenTree(forge.store, baseTree) : new Map<string, FlatEntry>();
  const head = headTree ? flattenTree(forge.store, headTree) : new Map<string, FlatEntry>();
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && after && before.oid === after.oid && before.mode === after.mode) continue;
    const oldData = before ? (forge.store.get(before.oid)?.data ?? null) : null;
    const newData = after ? (forge.store.get(after.oid)?.data ?? null) : null;
    const { additions, deletions } = lineCounts(oldData, newData);
    diffs.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? null,
    });
  }
  return diffs;
}

export interface MergeOutcome {
  ok: boolean;
  /** The merge/squash commit oid when ok. */
  sha?: string;
  /** Why the merge cannot run (a conflict, or the pull is not open). */
  reason?: string;
}

/**
 * Three-way merge analysis of a pull request: the changes the head made relative to the merge
 * base, applied onto the base branch's tree. A path both sides changed to different results is
 * a conflict.
 */
export function analyzeMerge(forge: Forge, repo: Repo, pull: Pull): { conflict: boolean; mergedTree: string | null; baseTip: string; headTip: string } | null {
  const baseTip = forge.pullBaseSha(repo, pull);
  const headTip = forge.pullHeadSha(repo, pull);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(forge.store, baseTip, headTip);
  const baseCommit = base ? forge.store.commit(base) : null;
  const baseTree = baseCommit?.tree ?? null;
  const baseTipTree = forge.store.commit(baseTip)?.tree ?? null;
  const headTree = forge.store.commit(headTip)?.tree ?? null;
  const ancestorFlat = baseTree ? flattenTree(forge.store, baseTree) : new Map<string, FlatEntry>();
  const baseFlat = baseTipTree ? flattenTree(forge.store, baseTipTree) : new Map<string, FlatEntry>();
  const headFlat = headTree ? flattenTree(forge.store, headTree) : new Map<string, FlatEntry>();
  const merged = new Map(baseFlat);
  let conflict = false;
  const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const headEntry = headFlat.get(path);
    const sameAsAncestor = (a?: FlatEntry, b?: FlatEntry): boolean =>
      (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
    if (sameAsAncestor(headEntry, ancestor)) continue; // the head did not touch this path
    const baseEntry = baseFlat.get(path);
    if (!sameAsAncestor(baseEntry, ancestor) && !sameAsAncestor(baseEntry, headEntry)) {
      conflict = true; // both sides changed the same path to different results
      continue;
    }
    if (headEntry === undefined) merged.delete(path);
    else merged.set(path, headEntry);
  }
  return { conflict, mergedTree: conflict ? null : unflattenTree(forge.store, merged), baseTip, headTip };
}

/** Merge a pull request (squash or merge-commit), moving the base branch. */
export function mergePull(forge: Forge, repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'Pull Request is not open' };
  const analysis = analyzeMerge(forge, repo, pull);
  if (!analysis) return { ok: false, reason: 'Base or head branch is missing' };
  if (analysis.conflict || analysis.mergedTree === null) return { ok: false, reason: 'Merge conflict' };
  let sha: string;
  if (method === 'merge') {
    sha = forge.makeCommit(analysis.mergedTree, [analysis.baseTip, analysis.headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`);
  } else {
    // Squash (and rebase, which lands the same single-commit shape here).
    sha = forge.makeCommit(analysis.mergedTree, [analysis.baseTip], `${pull.title} (#${pull.number})\n`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const sec = forge.clock.nextSec();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = sec;
  pull.mergeCommitSha = sha;
  pull.updatedSec = sec;
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------------------------
// REST/GraphQL view builders (one shape, every surface)
// ---------------------------------------------------------------------------------------------

export function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', String(repo.dbId)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: forge.clock.iso(repo.createdSec),
    updated_at: forge.clock.iso(repo.createdSec),
    pushed_at: forge.clock.iso(repo.createdSec),
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    language: null,
    topics: [],
    license: null,
    allow_forking: true,
    is_template: false,
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueView(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(label) : { id: 0, name, color: '000000', description: null, default: false };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: forge.clock.iso(issue.createdSec),
    updated_at: forge.clock.iso(issue.updatedSec),
    closed_at: issue.state === 'closed' ? forge.clock.iso(issue.updatedSec) : null,
    pull_request: undefined,
  };
}

export function commentView(forge: Forge, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.clock.iso(comment.createdSec),
    updated_at: forge.clock.iso(comment.createdSec),
  };
}

export function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.pullHeadSha(repo, pull);
  const baseSha = forge.pullBaseSha(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : forge.clock.iso(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoView(forge, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoView(forge, repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    draft: false,
    created_at: forge.clock.iso(pull.createdSec),
    updated_at: forge.clock.iso(pull.updatedSec),
    closed_at: pull.state === 'closed' ? forge.clock.iso(pull.updatedSec) : null,
  };
}

export function commitView(forge: Forge, oid: string): Record<string, unknown> | null {
  const commit = forge.store.commit(oid);
  if (!commit) return null;
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const person = (ident: { name: string; email: string; timestamp: number }): Record<string, unknown> => ({
    name: ident.name,
    email: ident.email,
    date: forge.clock.iso(ident.timestamp),
  });
  return {
    sha: oid,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree },
      author: person(author),
      committer: person(committer),
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** Opaque, stable Relay-style global ids: base64 of `Type:rest`, never the bare database id. */
export function globalId(type: string, rest: string): string {
  return Buffer.from(`${type}:${rest}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Every object reachable from a repo's refs (for the git surface's internal use). */
export function repoReachable(forge: Forge, repo: Repo): Set<string> {
  return collectReachable(forge.store, repo.refs.values(), { allowMissing: true });
}
