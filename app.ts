// The HTTP server: routing, bearer auth, body handling, and the JSON discipline every surface
// shares. The surfaces themselves live in gitproto.ts (git smart HTTP), rest.ts (REST v3),
// graphql.ts (GraphQL v4) and mcp.ts (MCP); this file only decides who answers a request and
// refuses the ones the protocol refuses (no token -> 401, malformed JSON -> 400, unknown route
// -> 404 JSON).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is
// the entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { infoRefs, receivePack, uploadPack, type HttpResult } from './gitproto.ts';
import { handleRest, notFound, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the shop token. With no token configured, every request passes. */
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, result: HttpResult): void {
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(result.body);
}

function sendRest(res: ServerResponse, result: RestResult): void {
  if (result.empty) {
    res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, result.headers ?? {});
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; `undefined` marks malformed JSON, `null` an absent body. */
function parseJsonBody(raw: Buffer): Record<string, unknown> | null | undefined {
  if (raw.length === 0) return null;
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  } catch {
    return undefined;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(forge, req, res).catch(() => {
      // A handler failure must never take the server down: answer 500 JSON and keep serving.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot probe: 200 {"ok":true}, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeSegment(gitMatch[1]);
    const name = decodeSegment(gitMatch[2]);
    const repo = forge.getRepo(owner, name);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const route = gitMatch[3];
    if (route === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      const protocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
      sendRaw(res, infoRefs(forge, repo, service, protocol));
      return;
    }
    const raw = await readBody(req);
    if (route === 'git-upload-pack') sendRaw(res, uploadPack(forge, repo, raw));
    else sendRaw(res, receivePack(forge, repo, raw));
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendRest(res, notFound());
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const result = handleGraphQL(forge, raw.toString('utf8'));
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP over streamable HTTP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(forge, raw.toString('utf8'));
    if (result.empty) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (parsed === undefined) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      body = parsed;
    }
    const result = handleRest({
      forge,
      method,
      segments,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'localhost',
      path,
    });
    sendRest(res, result);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
