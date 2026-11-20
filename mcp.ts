// The MCP surface: Model Context Protocol over streamable HTTP at POST /mcp. The modern revision
// (2026-07-28) is answered statelessly — server/discover returns the supported versions, identity
// and capabilities in one request — and the legacy initialize handshake is answered too. The six
// tools act on the same store as REST and answer with the same object views, so an object created
// over MCP is the same object over REST, ids included.

import { VIEWER, issueView, mergePull, pullView, repoView, type Forge, type Repo } from './forge.ts';

const SERVER_INFO = Object.freeze({ name: 'github-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const OWNER_REPO = {
  owner: { type: 'string', description: 'The repository owner login' },
  repo: { type: 'string', description: 'The repository name' },
};

/** The tool list is a frozen constant: two tools/list calls answer byte-for-byte identical bytes. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: schema(
      {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: schema({ ...OWNER_REPO }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: schema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state',
    inputSchema: schema(
      {
        ...OWNER_REPO,
        state: { type: 'string', description: 'open, closed or all (default open)' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    inputSchema: schema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch',
    inputSchema: schema(
      {
        ...OWNER_REPO,
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
]);

export interface McpResult {
  status: number;
  body: unknown;
  /** Send an empty body (notifications, 202). */
  empty?: boolean;
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolOk(view: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, repo);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>, id: unknown): McpResult | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return rpcError(id, -32602, `Missing required argument: ${key}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(VIEWER.login, String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (created === 'exists') return rpcResult(id, toolError('Repository already exists'));
      return rpcResult(id, toolOk(repoView(forge, created)));
    }
    case 'get_repo': {
      const repo = repoArg(forge, args);
      if (!repo) return rpcResult(id, toolError('Repository not found'));
      return rpcResult(id, toolOk(repoView(forge, repo)));
    }
    case 'create_issue': {
      const repo = repoArg(forge, args);
      if (!repo) return rpcResult(id, toolError('Repository not found'));
      const issue = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return rpcResult(id, toolOk(issueView(forge, repo, issue)));
    }
    case 'list_issues': {
      const repo = repoArg(forge, args);
      if (!repo) return rpcResult(id, toolError('Repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return rpcResult(id, toolOk(issues.map((issue) => issueView(forge, repo, issue))));
    }
    case 'create_pull_request': {
      const repo = repoArg(forge, args);
      if (!repo) return rpcResult(id, toolError('Repository not found'));
      const pull = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: String(args.head),
        baseRef: String(args.base),
      });
      if (!pull) return rpcResult(id, toolError('Head branch does not exist'));
      return rpcResult(id, toolOk(pullView(forge, repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = repoArg(forge, args);
      if (!repo) return rpcResult(id, toolError('Repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return rpcResult(id, toolError('Pull request not found'));
      const outcome = mergePull(forge, repo, pull, 'squash');
      if (!outcome.ok) return rpcResult(id, toolError(outcome.reason ?? 'Merge failed'));
      return rpcResult(id, toolOk(pullView(forge, repo, pull)));
    }
  }
  return null;
}

/** Handle one POST /mcp body. Auth is the router's job; this answers the protocol. */
export function handleMcp(forge: Forge, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleOne(forge, entry)).filter((result) => !result.empty);
    return { status: 200, body: results.map((result) => result.body) };
  }
  return handleOne(forge, parsed);
}

function handleOne(forge: Forge, entry: unknown): McpResult {
  const request = (entry ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const isNotification = request.id === undefined;
  if (isNotification) return { status: 202, body: null, empty: true };
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const result = callTool(forge, name, args, id);
      if (result === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return result;
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
