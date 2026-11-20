// The GraphQL v4 surface: a small hand-written parser (operations, variables, aliases, inline
// fragments, input objects, enum lists, batching) and a schema-table executor for the documents
// gh and github-mcp-server send. Unknown fields answer HTTP 200 with an `errors` array naming the
// field, as GitHub does; an unknown repository answers data.repository = null with no errors.

import {
  VIEWER,
  analyzeMerge,
  diffTrees,
  globalId,
  issueView,
  mergePull,
  parseGlobalId,
  pullView,
  repoView,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';
import { mergeBase } from './gitobj.ts';

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ t: string; v: string }> {
  const tokens: Array<{ t: string; v: string }> = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ t: '...', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|'.includes(c)) {
      tokens.push({ t: c, v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ t: 'string', v: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ t: 'string', v: value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ t: 'name', v: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ t: 'number', v: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Array<{ t: string; v: string }>) {}

  private peek(): { t: string; v: string } {
    return this.tokens[this.pos];
  }
  private next(): { t: string; v: string } {
    return this.tokens[this.pos++];
  }
  private expect(t: string): { t: string; v: string } {
    const token = this.next();
    if (token.t !== t) throw new GqlSyntaxError(`expected ${t}, got ${token.t} ${token.v}`);
    return token;
  }
  private skipDirectives(): void {
    while (this.peek().t === '@') {
      this.next();
      this.expect('name');
      if (this.peek().t === '(') this.parseArgs();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.peek().t !== 'eof') {
      const token = this.peek();
      if (token.t === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.t === 'name' && (token.v === 'query' || token.v === 'mutation' || token.v === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().t === 'name') name = this.next().v;
        if (this.peek().t === '(') this.parseVariableDefs();
        this.skipDirectives();
        operations.push({ type: token.v === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token.t === 'name' && token.v === 'fragment') {
        this.next();
        const fragName = this.expect('name').v;
        const on = this.expect('name');
        if (on.v !== 'on') throw new GqlSyntaxError('fragment without on');
        const typeCondition = this.expect('name').v;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token.t} ${token.v}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): void {
    this.expect('(');
    while (this.peek().t !== ')') {
      this.expect('$');
      this.expect('name');
      this.expect(':');
      this.parseTypeRef();
      if (this.peek().t === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseTypeRef(): void {
    if (this.peek().t === '[') {
      this.next();
      this.parseTypeRef();
      this.expect(']');
    } else {
      this.expect('name');
    }
    if (this.peek().t === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().t !== '}') {
      if (this.peek().t === '...') {
        this.next();
        if (this.peek().t === 'name' && this.peek().v === 'on') {
          this.next();
          const typeCondition = this.expect('name').v;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek().t === 'name') {
          const name = this.next().v;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expect('name').v;
    let alias: string | null = null;
    if (this.peek().t === ':') {
      this.next();
      alias = name;
      name = this.expect('name').v;
    }
    const args = this.peek().t === '(' ? this.parseArgs() : new Map<string, ValueNode>();
    this.skipDirectives();
    const selection = this.peek().t === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selection };
  }

  private parseArgs(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().t !== ')') {
      const key = this.expect('name').v;
      this.expect(':');
      args.set(key, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.t === '$') return { kind: 'var', name: this.expect('name').v };
    if (token.t === 'string') return { kind: 'string', value: token.v };
    if (token.t === 'number') {
      return token.v.includes('.') || /[eE]/.test(token.v)
        ? { kind: 'float', value: Number.parseFloat(token.v) }
        : { kind: 'int', value: Number.parseInt(token.v, 10) };
    }
    if (token.t === 'name') {
      if (token.v === 'true') return { kind: 'bool', value: true };
      if (token.v === 'false') return { kind: 'bool', value: false };
      if (token.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.v };
    }
    if (token.t === '[') {
      const items: ValueNode[] = [];
      while (this.peek().t !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.t === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek().t !== '}') {
        const key = this.expect('name').v;
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.t}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type Obj = { __type: string; [key: string]: unknown };
type Resolver = (obj: Obj, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

const wrap = (type: string, fields: Record<string, unknown>): Obj => ({ __type: type, ...fields });

function repoObj(repo: Repo): Obj {
  return wrap('Repository', { repo });
}
function issueObj(repo: Repo, issue: Issue): Obj {
  return wrap('Issue', { repo, issue });
}
function pullObj(repo: Repo, pull: Pull): Obj {
  return wrap('PullRequest', { repo, pull });
}

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  State: ['OPEN', 'CLOSED'],
};

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}
function seqOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Obj {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  const field = orderBy?.field ?? 'CREATED_AT';
  issues.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedSec - b.updatedSec || a.seq - b.seq;
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length || a.seq - b.seq;
    else cmp = a.seq - b.seq;
    return cmp * direction;
  });
  const total = issues.length;
  const afterSeq = seqOfCursor(args.after);
  let startIndex = 0;
  if (afterSeq !== null) {
    const at = issues.findIndex((issue) => issue.seq === afterSeq);
    if (at >= 0) startIndex = at + 1;
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = issues.slice(startIndex, startIndex + Math.max(0, first));
  const hasNextPage = startIndex + page.length < total;
  const endCursor = page.length ? cursorOf(page[page.length - 1].seq) : null;
  return wrap('IssueConnection', {
    repo,
    nodes: page.map((issue) => issueObj(repo, issue)),
    totalCount: total,
    pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: startIndex > 0, startCursor: page.length ? cursorOf(page[0].seq) : null, endCursor }),
  });
}

function pullFiles(ctx: ExecCtx, repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number; changeType: string }> {
  const forge = ctx.forge;
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headTip = forge.pullHeadSha(repo, pull);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(forge.store, baseTip, headTip);
  const baseTree = base ? (forge.store.commit(base)?.tree ?? null) : null;
  const headTree = forge.store.commit(headTip)?.tree ?? null;
  return diffTrees(forge, baseTree, headTree).map((file) => ({
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
}

function pullMergeable(ctx: ExecCtx, repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const analysis = analyzeMerge(ctx.forge, repo, pull);
  if (!analysis) return 'UNKNOWN';
  return analysis.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function findByGlobalId(forge: Forge, id: unknown): Obj | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const dbId = Number(parsed.rest);
    for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repoObj(repo);
    return null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest' || parsed.type === 'Comment') {
    const [dbIdRaw, numberRaw, commentRaw] = parsed.rest.split(':');
    const dbId = Number(dbIdRaw);
    const number = Number(numberRaw);
    for (const repo of forge.repos.values()) {
      if (repo.dbId !== dbId) continue;
      if (parsed.type === 'Issue') {
        const issue = repo.issues.get(number);
        return issue ? issueObj(repo, issue) : null;
      }
      if (parsed.type === 'PullRequest') {
        const pull = repo.pulls.get(number);
        return pull ? pullObj(repo, pull) : null;
      }
      const issue = repo.issues.get(number);
      const comment = issue?.comments.find((candidate) => candidate.id === Number(commentRaw));
      if (issue && comment) return wrap('Comment', { repo, issue, comment });
      return null;
    }
  }
  if (parsed.type === 'User') return wrap('User', {});
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap('User', {}),
    repository: (_obj, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.forge.getRepo(owner, name);
      return repo ? repoObj(repo) : null;
    },
    node: (_obj, args, ctx) => findByGlobalId(ctx.forge, args.id),
    search: () => null,
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(ctx.forge, input.repositoryId);
      if (!target || target.__type !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return wrap('CreateIssuePayload', { issue: null });
      }
      const repo = target.repo as Repo;
      const issue = ctx.forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return wrap('CreateIssuePayload', { issue: issueObj(repo, issue) });
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(ctx.forge, input.issueId);
      if (!target || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'issueId does not name an issue' });
        return wrap('CloseIssuePayload', { issue: null });
      }
      const issue = target.issue as Issue;
      issue.state = 'closed';
      issue.updatedSec = ctx.forge.clock.nextSec();
      return wrap('CloseIssuePayload', { issue: target });
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(ctx.forge, input.repositoryId);
      if (!target || target.__type !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return wrap('CreatePullRequestPayload', { pullRequest: null });
      }
      const repo = target.repo as Repo;
      const pull = ctx.forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? ''),
      });
      if (!pull) {
        ctx.errors.push({ message: 'head branch does not exist' });
        return wrap('CreatePullRequestPayload', { pullRequest: null });
      }
      return wrap('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(ctx.forge, input.pullRequestId);
      if (!target || target.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
        return wrap('MergePullRequestPayload', { pullRequest: null });
      }
      const repo = target.repo as Repo;
      const pull = target.pull as Pull;
      const methodRaw = String(input.mergeMethod ?? 'SQUASH');
      const outcome = mergePull(ctx.forge, repo, pull, methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash');
      if (!outcome.ok) ctx.errors.push({ message: outcome.reason ?? 'Merge failed' });
      return wrap('MergePullRequestPayload', { pullRequest: target });
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(ctx.forge, input.subjectId);
      if (!target || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'subjectId does not name an issue' });
        return wrap('AddCommentPayload', { commentEdge: null });
      }
      const repo = target.repo as Repo;
      const issue = target.issue as Issue;
      const comment = ctx.forge.addComment(repo, issue, String(input.body ?? ''));
      const node = wrap('Comment', { repo, issue, comment });
      return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node }) });
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => globalId('User', String(VIEWER.id)),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => null,
    avatarUrl: () => null,
  },
  Repository: {
    id: (obj) => globalId('Repository', String((obj.repo as Repo).dbId)),
    databaseId: (obj) => (obj.repo as Repo).dbId,
    name: (obj) => (obj.repo as Repo).name,
    nameWithOwner: (obj) => `${(obj.repo as Repo).owner}/${(obj.repo as Repo).name}`,
    owner: (obj) => wrap('User', { login: (obj.repo as Repo).owner }),
    defaultBranchRef: (obj, _args, ctx) => {
      const repo = obj.repo as Repo;
      const tip = ctx.forge.branchTip(repo, repo.defaultBranch);
      return tip ? wrap('Ref', { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (obj) => (obj.repo as Repo).isPrivate,
    description: (obj) => (obj.repo as Repo).description || null,
    createdAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.repo as Repo).createdSec),
    url: () => null,
    issue: (obj, args) => {
      const repo = obj.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (obj, args, ctx) => issuesConnection(ctx, obj.repo as Repo, args),
    pullRequest: (obj, args) => {
      const repo = obj.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (obj, args) => {
      const repo = obj.repo as Repo;
      let pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      const states = args.states;
      if (Array.isArray(states) && states.length) {
        const wanted = new Set(states.map((s) => String(s)));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      const first = typeof args.first === 'number' ? args.first : 30;
      const page = pulls.slice(0, Math.max(0, first));
      return wrap('PullRequestConnection', {
        nodes: page.map((pull) => pullObj(repo, pull)),
        totalCount: pulls.length,
        pageInfo: wrap('PageInfo', { hasNextPage: pulls.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
      });
    },
  },
  Issue: {
    id: (obj) => globalId('Issue', `${(obj.repo as Repo).dbId}:${(obj.issue as Issue).number}`),
    databaseId: (obj) => (obj.issue as Issue).id,
    number: (obj) => (obj.issue as Issue).number,
    title: (obj) => (obj.issue as Issue).title,
    state: (obj) => (obj.issue as Issue).state.toUpperCase(),
    body: (obj) => (obj.issue as Issue).body,
    url: () => null,
    createdAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.issue as Issue).createdSec),
    updatedAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.issue as Issue).updatedSec),
    closed: (obj) => (obj.issue as Issue).state === 'closed',
    repository: (obj) => repoObj(obj.repo as Repo),
    author: () => wrap('User', {}),
    comments: (obj) => {
      const repo = obj.repo as Repo;
      const issue = obj.issue as Issue;
      return wrap('IssueCommentConnection', {
        nodes: issue.comments.map((comment) => wrap('Comment', { repo, issue, comment })),
        totalCount: issue.comments.length,
      });
    },
  },
  PullRequest: {
    id: (obj) => globalId('PullRequest', `${(obj.repo as Repo).dbId}:${(obj.pull as Pull).number}`),
    databaseId: (obj) => (obj.pull as Pull).id,
    number: (obj) => (obj.pull as Pull).number,
    title: (obj) => (obj.pull as Pull).title,
    body: (obj) => (obj.pull as Pull).body,
    state: (obj) => {
      const pull = obj.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (obj) => (obj.pull as Pull).merged,
    mergeable: (obj, _args, ctx) => pullMergeable(ctx, obj.repo as Repo, obj.pull as Pull),
    headRefName: (obj) => (obj.pull as Pull).headRef,
    baseRefName: (obj) => (obj.pull as Pull).baseRef,
    headRefOid: (obj, _args, ctx) => ctx.forge.pullHeadSha(obj.repo as Repo, obj.pull as Pull),
    baseRefOid: (obj, _args, ctx) => ctx.forge.pullBaseSha(obj.repo as Repo, obj.pull as Pull),
    mergedAt: (obj, _args, ctx) => {
      const pull = obj.pull as Pull;
      return pull.mergedSec === null ? null : ctx.forge.clock.iso(pull.mergedSec);
    },
    mergeCommit: (obj) => {
      const pull = obj.pull as Pull;
      return pull.mergeCommitSha ? wrap('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    createdAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.pull as Pull).createdSec),
    updatedAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.pull as Pull).updatedSec),
    url: () => null,
    author: () => wrap('User', {}),
    repository: (obj) => repoObj(obj.repo as Repo),
    files: (obj, args, ctx) => {
      const files = pullFiles(ctx, obj.repo as Repo, obj.pull as Pull);
      const first = typeof args.first === 'number' ? args.first : 100;
      return wrap('PullRequestChangedFilesConnection', {
        nodes: files.slice(0, Math.max(0, first)).map((file) => wrap('PullRequestChangedFile', file)),
        totalCount: files.length,
      });
    },
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path,
    additions: (obj) => obj.additions,
    deletions: (obj) => obj.deletions,
    changeType: (obj) => obj.changeType,
  },
  Comment: {
    id: (obj) => globalId('Comment', `${(obj.repo as Repo).dbId}:${(obj.issue as Issue).number}:${(obj.comment as { id: number }).id}`),
    body: (obj) => (obj.comment as { body: string }).body,
    createdAt: (obj, _args, ctx) => ctx.forge.clock.iso((obj.comment as { createdSec: number }).createdSec),
    author: () => wrap('User', {}),
  },
  Ref: {
    name: (obj) => obj.name,
  },
  Commit: {
    oid: (obj) => obj.oid,
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage,
    hasPreviousPage: (obj) => obj.hasPreviousPage,
    startCursor: (obj) => obj.startCursor,
    endCursor: (obj) => obj.endCursor,
  },
  IssueConnection: {
    nodes: (obj) => obj.nodes,
    totalCount: (obj) => obj.totalCount,
    pageInfo: (obj) => obj.pageInfo,
    edges: (obj) =>
      (obj.nodes as Obj[]).map((node) => wrap('IssueEdge', { node, cursor: cursorOf((node.issue as Issue).seq) })),
  },
  IssueEdge: {
    node: (obj) => obj.node,
    cursor: (obj) => obj.cursor,
  },
  PullRequestConnection: {
    nodes: (obj) => obj.nodes,
    totalCount: (obj) => obj.totalCount,
    pageInfo: (obj) => obj.pageInfo,
  },
  PullRequestChangedFilesConnection: {
    nodes: (obj) => obj.nodes,
    totalCount: (obj) => obj.totalCount,
  },
  IssueCommentConnection: {
    nodes: (obj) => obj.nodes,
    totalCount: (obj) => obj.totalCount,
  },
  CreateIssuePayload: { issue: (obj) => obj.issue },
  CloseIssuePayload: { issue: (obj) => obj.issue },
  CreatePullRequestPayload: { pullRequest: (obj) => obj.pullRequest },
  MergePullRequestPayload: { pullRequest: (obj) => obj.pullRequest },
  AddCommentPayload: { commentEdge: (obj) => obj.commentEdge },
  CommentEdge: { node: (obj) => obj.node },
  __Type: {
    name: (obj) => obj.name,
    kind: (obj) => (ENUM_VALUES[obj.name as string] ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (obj) => {
      const typeName = obj.name as string;
      if (ENUM_VALUES[typeName]) return null;
      const fields = TYPE_FIELDS[typeName];
      if (!fields) return null;
      return fields.map((name) => wrap('__Field', { name }));
    },
    enumValues: (obj) => {
      const values = ENUM_VALUES[obj.name as string];
      if (!values) return null;
      return values.map((name) => wrap('__EnumValue', { name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (obj) => obj.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (obj) => obj.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

/** The field names introspection reports: exactly the resolver tables, per type. */
const TYPE_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(RESOLVERS).map(([type, fields]) => [type, Object.keys(fields)]),
);

function typeInfo(name: string): Obj | null {
  if (RESOLVERS[name] || ENUM_VALUES[name]) return wrap('__Type', { name });
  return null;
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && typeof (value as Obj).__type === 'string';
}

function executeSelection(
  ctx: ExecCtx,
  typeName: string,
  obj: Obj,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const flat: FieldNode[] = [];
  const collect = (sels: SelectionNode[], currentType: string): void => {
    for (const sel of sels) {
      if (sel.kind === 'field') flat.push(sel.field);
      else if (sel.kind === 'inline') {
        if (sel.typeCondition === null || sel.typeCondition === currentType) collect(sel.selection, currentType);
      } else {
        const fragment = ctx.fragments.get(sel.name);
        if (fragment && (fragment.typeCondition === null || fragment.typeCondition === currentType)) {
          collect(fragment.selection, currentType);
        }
      }
    }
  };
  collect(selections, typeName);
  for (const field of flat) {
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (field.name === '__type' && typeName === 'Query') {
      const nameArg = field.args.get('name');
      const typeName2 = nameArg ? String(resolveValue(nameArg, ctx.variables) ?? '') : '';
      const info = typeInfo(typeName2);
      out[key] = info && field.selection ? executeSelection(ctx, '__Type', info, field.selection, fieldPath) : info;
      continue;
    }
    if (field.name === '__schema') {
      out[key] = null;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argNode] of field.args) args[argName] = resolveValue(argNode, ctx.variables);
    let value: unknown;
    try {
      value = resolver(obj, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field, fieldPath);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, field: FieldNode, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(ctx, item, field, [...path, index]));
  if (isObj(value)) {
    if (!field.selection) return {};
    return executeSelection(ctx, value.__type, value, field.selection, path);
  }
  return value;
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one operation document (or a batch, when the body is a JSON array). */
export function handleGraphQL(forge: Forge, rawBody: string): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, body: executeOne(forge, parsed) };
}

function executeOne(forge: Forge, entry: unknown): Record<string, unknown> {
  const request = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') return { errors: [{ message: 'No query document was provided' }] };
  let document: Document;
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  let operation: Operation | undefined;
  if (typeof request.operationName === 'string') operation = document.operations.find((op) => op.name === request.operationName);
  operation ??= document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, wrap(rootType, {}), operation.selection, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return body;
}

/** REST-shaped views re-exported for the MCP surface's reuse. */
export { issueView, pullView, repoView };
