// The REST v3 surface: root, meta, the token's user, repositories, branches, git refs, commits,
// contents, labels, issues, comments, pull requests, their files and merges. Every reply is JSON
// with an X-GitHub-Request-Id header; every error body is JSON with a string `message`.

import { flattenTree, isObjectId, mergeBase } from './gitobj.ts';
import {
  VIEWER,
  analyzeMerge,
  commentView,
  commitView,
  diffTrees,
  issueView,
  labelView,
  mergePull,
  pullView,
  repoView,
  type Forge,
  type Repo,
} from './forge.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** When true the body is sent empty (204). */
  empty?: boolean;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function fail(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function notFound(): RestResult {
  return fail(404, 'Not Found');
}

interface Ctx {
  forge: Forge;
  method: string;
  /** Path segments under /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  host: string;
  path: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function pagination(ctx: Ctx): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice a list for the page and build the Link header chain (next/last/prev/first). */
function paged<T>(ctx: Ctx, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const url = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<http://${ctx.host}${ctx.path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`${url(page + 1)}; rel="next"`, `${url(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${url(1)}; rel="first"`, `${url(page - 1)}; rel="prev"`);
  }
  return { slice, headers: links.length ? { link: links.join(', ') } : {} };
}

function repoOf(ctx: Ctx, owner: string, name: string): Repo | null {
  return ctx.forge.getRepo(owner, name);
}

export function handleRest(ctx: Ctx): RestResult {
  const { forge, method, segments } = ctx;
  const body = ctx.body ?? {};

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0-forge',
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      type: VIEWER.type,
      name: VIEWER.name,
      email: VIEWER.email,
      site_admin: false,
    });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paged(ctx, forge.listRepos(VIEWER.login).map((repo) => repoView(forge, repo)));
      return ok(200, slice, headers);
    }
    if (method === 'POST') return createRepo(ctx);
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoOf(ctx, owner, name);
        return repo ? ok(200, repoView(forge, repo)) : notFound();
      }
      if (method === 'PATCH') {
        const repo = repoOf(ctx, owner, name);
        if (!repo) return notFound();
        const description = str(body.description);
        if (description !== null) repo.description = description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        const newName = str(body.name);
        if (newName !== null && newName !== repo.name) {
          forge.repos.delete(`${repo.owner}/${repo.name}`);
          repo.name = newName;
          forge.repos.set(`${repo.owner}/${repo.name}`, repo);
        }
        return ok(200, repoView(forge, repo));
      }
      if (method === 'DELETE') {
        return forge.deleteRepo(owner, name) ? { status: 204, body: null, empty: true } : notFound();
      }
      return notFound();
    }
    const repo = repoOf(ctx, owner, name);
    if (!repo) return notFound();
    return handleRepoRoute(ctx, repo, rest);
  }
  return notFound();
}

function createRepo(ctx: Ctx): RestResult {
  const body = ctx.body ?? {};
  const name = str(body.name);
  if (name === null || name === '') return fail(422, 'Repository creation failed: name is required');
  const created = ctx.forge.createRepo(VIEWER.login, name, {
    description: str(body.description) ?? '',
    isPrivate: body.private === true,
  });
  if (created === 'exists') return fail(422, 'Repository creation failed: name already exists on this account');
  if (body.auto_init === true) {
    ctx.forge.writeFile(created, created.defaultBranch, 'README.md', Buffer.from(`# ${name}\n`, 'utf8'), 'Initial commit');
  }
  return ok(201, repoView(ctx.forge, created));
}

function handleRepoRoute(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const { forge, method } = ctx;
  const body = ctx.body ?? {};
  const head = rest[0];

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref)! },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { slice, headers } = paged(ctx, branches);
      return ok(200, slice, headers);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (!tip) return notFound();
      const view = commitView(forge, tip);
      return ok(200, { name: branch, commit: view?.commit ? { sha: tip, ...view.commit } : { sha: tip }, protected: false });
    }
    return notFound();
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, oid]) => ({ ref, object: { sha: oid, type: forge.store.get(oid)?.type ?? 'commit' } }));
        return ok(200, refs);
      }
      if (method === 'POST') {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (ref === null || sha === null || !forge.store.has(sha)) return fail(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } });
      }
      return notFound();
    }
    if (method === 'GET') {
      const ref = rest.slice(2).join('/');
      const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
      if (!oid) return notFound();
      const fullRef = repo.refs.has(ref) ? ref : `refs/${ref}`;
      return ok(200, { ref: fullRef, object: { sha: oid, type: forge.store.get(oid)?.type ?? 'commit' } });
    }
    return notFound();
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') return listCommits(ctx, repo);
    if (rest.length === 2 && method === 'GET') {
      const view = commitView(forge, rest[1]);
      return view ? ok(200, view) : notFound();
    }
    return notFound();
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelView));
      if (method === 'POST') {
        const name = str(body.name);
        const color = str(body.color) ?? '000000';
        if (name === null || name === '') return fail(422, 'Invalid label');
        if (repo.labels.has(name)) return fail(422, 'Label already exists');
        const created = forge.makeLabel(repo, { name, color, description: str(body.description) });
        return ok(201, labelView(created));
      }
      return notFound();
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(rest[1]);
      return label ? ok(200, labelView(label)) : notFound();
    }
    return notFound();
  }

  if (head === 'issues') return handleIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(ctx, repo, rest.slice(1));
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// commits and contents
// ---------------------------------------------------------------------------------------------

function listCommits(ctx: Ctx, repo: Repo): RestResult {
  const forge = ctx.forge;
  const ref = ctx.query.get('sha') ?? '';
  const tip = forge.resolveCommit(repo, ref);
  if (!tip) return ok(200, []);
  // Collect every ancestor, then order newest first by committer timestamp (ties: BFS depth).
  const seen = new Map<string, number>();
  let frontier = [tip];
  let depth = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.set(oid, depth);
      const commit = forge.store.commit(oid);
      if (commit) next.push(...commit.parents);
    }
    frontier = next;
    depth += 1;
  }
  const ordered = [...seen.entries()]
    .map(([oid, d]) => ({ oid, d, ts: tsOf(forge, oid) }))
    .sort((a, b) => b.ts - a.ts || a.d - b.d)
    .map((entry) => commitView(forge, entry.oid))
    .filter((view) => view !== null);
  const { slice, headers } = paged(ctx, ordered);
  return ok(200, slice, headers);
}

function tsOf(forge: Forge, oid: string): number {
  const commit = forge.store.commit(oid);
  if (!commit) return 0;
  const match = / (\d+) [+-]\d{4}$/.exec(commit.committer);
  return match ? Number(match[1]) : 0;
}

function putContents(ctx: Ctx, repo: Repo, path: string): RestResult {
  const forge = ctx.forge;
  const body = ctx.body ?? {};
  const message = str(body.message);
  const content = str(body.content);
  if (message === null || content === null || path === '') return fail(422, 'Invalid contents request');
  const branch = str(body.branch) ?? repo.defaultBranch;
  const data = Buffer.from(content.replace(/\s/g, ''), 'base64');
  const tip = forge.branchTip(repo, branch);
  const tipCommit = tip ? forge.store.commit(tip) : null;
  const flat = tipCommit ? flattenTree(forge.store, tipCommit.tree) : new Map();
  const existing = flat.get(path);
  const givenSha = str(body.sha);
  if (existing && givenSha !== existing.oid) return fail(409, 'Conflict: the file has changed since the sha was read');
  if (!existing && tip === null && repo.refs.size > 0 && branch !== repo.defaultBranch) {
    // A contents write naming a fresh branch on a born repo forks from the default branch,
    // matching the suite's branch-creation fallback.
    const defaultTip = forge.branchTip(repo, repo.defaultBranch);
    if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
  }
  const written = forge.writeFile(repo, branch, path, data, message);
  const status = existing ? 200 : 201;
  return ok(status, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: written.blob,
      size: data.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: written.commit, message },
  });
}

function getContents(ctx: Ctx, repo: Repo, path: string): RestResult {
  const forge = ctx.forge;
  const ref = ctx.query.get('ref') ?? '';
  const tip = forge.resolveCommit(repo, ref);
  if (!tip) return notFound();
  const commit = forge.store.commit(tip);
  if (!commit) return notFound();
  const flat = flattenTree(forge.store, commit.tree);
  if (path !== '') {
    const entry = flat.get(path);
    if (entry) {
      const object = forge.store.get(entry.oid);
      if (!object) return notFound();
      return ok(200, {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: entry.oid,
        size: object.data.length,
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
    }
  }
  // Directory listing: the entries directly under `path` (or the root).
  const prefix = path === '' ? '' : `${path}/`;
  const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', name: rest, path: filePath, sha: entry.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) {
        seen.set(dirName, { type: 'dir', name: dirName, path: prefix + dirName, sha: treeShaAt(forge, commit.tree, prefix + dirName) ?? '' });
      }
    }
  }
  if (path !== '' && seen.size === 0) return notFound();
  const entries = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return ok(200, entries);
}

/** The tree oid at a directory path inside a root tree, for directory listing entries. */
function treeShaAt(forge: Forge, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const entries = forge.store.tree(current);
    const entry = entries?.find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): RestResult {
  const forge = ctx.forge;
  const body = ctx.body ?? {};
  const message = str(body.message) ?? `Delete ${path}`;
  const branch = str(body.branch) ?? repo.defaultBranch;
  const tip = forge.branchTip(repo, branch);
  if (!tip) return notFound();
  const commit = forge.store.commit(tip);
  if (!commit) return notFound();
  const flat = flattenTree(forge.store, commit.tree);
  const existing = flat.get(path);
  if (!existing) return notFound();
  const givenSha = str(body.sha);
  if (givenSha !== null && givenSha !== existing.oid) return fail(409, 'Conflict: the file has changed since the sha was read');
  const newCommit = forge.commitTreeChange(repo, branch, new Map([[path, null]]), message);
  return ok(200, { content: null, commit: { sha: newCommit, message } });
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const forge = ctx.forge;
  const method = ctx.method;
  const body = ctx.body ?? {};
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (title === null || title === '') return fail(422, 'Invalid issue: a title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(422, `Unknown label: ${label}`);
      }
      const issue = forge.createIssue(repo, { title, body: str(body.body) ?? '', labels });
      return ok(201, issueView(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const labelFilter = ctx.query.get('labels');
      if (labelFilter) {
        const wanted = labelFilter.split(',');
        issues = issues.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      const direction = ctx.query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { slice, headers } = paged(ctx, issues.map((issue) => issueView(forge, repo, issue)));
      return ok(200, slice, headers);
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return ok(200, issueView(forge, repo, issue));
    if (method === 'PATCH') {
      const title = str(body.title);
      if (title !== null) issue.title = title;
      const text = str(body.body);
      if (text !== null) issue.body = text;
      const state = str(body.state);
      if (state === 'closed' || state === 'open') issue.state = state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return fail(422, `Unknown label: ${label}`);
        issue.labels = labels;
      }
      issue.updatedSec = forge.clock.nextSec();
      return ok(200, issueView(forge, repo, issue));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') return ok(200, issue.comments.map((comment) => commentView(forge, comment)));
    if (method === 'POST') {
      const text = str(body.body);
      if (text === null) return fail(422, 'Invalid comment: a body is required');
      const comment = forge.addComment(repo, issue, text);
      return ok(201, commentView(forge, comment));
    }
    return notFound();
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const forge = ctx.forge;
  const method = ctx.method;
  const body = ctx.body ?? {};
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (title === null || headRaw === null || baseRaw === null) return fail(422, 'Invalid pull request');
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      if (!forge.branchTip(repo, base)) return fail(422, `Invalid base branch: ${base}`);
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (existing) return fail(422, `A pull request already exists for ${head} into ${base}`);
      const pull = forge.createPull(repo, { title, body: str(body.body) ?? '', headRef: head, baseRef: base });
      if (!pull) return fail(422, `Invalid head branch: ${head}`);
      return ok(201, pullView(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { slice, headers } = paged(ctx, pulls.map((pull) => pullView(forge, repo, pull)));
      return ok(200, slice, headers);
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return ok(200, pullView(forge, repo, pull));
    if (method === 'PATCH') {
      const title = str(body.title);
      if (title !== null) pull.title = title;
      const text = str(body.body);
      if (text !== null) pull.body = text;
      const state = str(body.state);
      if (state === 'closed' || state === 'open') {
        if (!(pull.merged && state === 'open')) pull.state = state;
      }
      pull.updatedSec = forge.clock.nextSec();
      return ok(200, pullView(forge, repo, pull));
    }
    return notFound();
  }
  if (!pull) return notFound();
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = forge.pullHeadSha(repo, pull);
    const headTree = forge.store.commit(headTip)?.tree ?? null;
    // GitHub diffs a pull request from its merge base to its head.
    const files = diffTrees(forge, mergeBaseTree(forge, repo, pull), headTree);
    return ok(200, files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    })));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const methodName = str(body.merge_method) ?? 'merge';
    const outcome = mergePull(forge, repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge');
    if (!outcome.ok) {
      if (outcome.reason === 'Pull Request is not open') return fail(405, 'Pull Request is not mergeable');
      if (outcome.reason === 'Merge conflict') return fail(405, 'Merge conflict');
      return fail(405, outcome.reason ?? 'Merge failed');
    }
    return ok(200, { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}

/** The tree of the merge base between a pull's base and head tips (its diff base). */
function mergeBaseTree(forge: Forge, repo: Repo, pull: { baseRef: string; headRef: string }): string | null {
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headTip = forge.branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(forge.store, baseTip, headTip);
  return base ? (forge.store.commit(base)?.tree ?? null) : null;
}

export { isObjectId };
