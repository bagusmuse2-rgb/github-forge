# Plan — github-core-clone-01 entry: a standalone GitHub-compatible forge

One Node process, no dependencies, no filesystem state. `main.ts` is the kit's
lifecycle (bind ephemeral port, POST /register, poll /done, exit 0). Everything
else is the server in `app.ts`, split into modules:

| File | Surface |
| --- | --- |
| `gitobj.ts` | git object model: SHA-1 ids, commit/tree/tag parse+build, pack read/write (incl. ofs/ref deltas), reachability, shallow closure, ancestry |
| `forge.ts` | the store and domain logic shared by every surface: repos, refs, labels, issues, comments, pull requests, contents commits, three-way merges, tree diffs |
| `gitproto.ts` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 + v0), `git-receive-pack` (v0, report-status, side-band-64k) |
| `rest.ts` | REST v3: root, meta, user, repos, branches, git refs, commits, contents, labels, issues, comments, pulls, files, merge |
| `graphql.ts` | GraphQL v4: a small parser + executor for the documents `gh` / github-mcp-server send, introspection, Relay global ids, batching |
| `mcp.ts` | MCP over streamable HTTP: `server/discover` (2026-07-28), `initialize`, `tools/list`, `tools/call` for the six repository tools |
| `app.ts` | HTTP routing, bearer auth, body limits, JSON error shape |

## Storage design

Everything lives in memory in Maps. Git objects sit in ONE global
content-addressed store (`oid -> {type, data}`): an oid is a hash of its bytes,
so sharing the store across repos cannot leak data — a repo only ever serves
objects reachable from its own refs. Repos hold refs (`refs/heads/*`,
`refs/tags/*`), labels, issues and pull requests. Issues and PRs share one
per-repo number counter, as on GitHub.

Determinism is a hard requirement (the final replays contender trials and the
state export must be byte-identical), so the forge never reads a clock or a
random source: timestamps come from a logical counter anchored at
2025-01-01T00:00:00Z, request ids from a counter, and database ids from
counters. Same request sequence => same bytes out.

## Identity

The contest's scenario is fixed data (one seed in the kit's wire contract), and
the shop token belongs to that scenario's viewer: login `adaiversen`, id 1000.
The forge answers as that account for `GET /api/v3/user`, `viewer { login }`
and commit authorship. Auth rule: when `MAKEFUN_SHOP_TOKEN` is set, a request
must carry exactly `Authorization: Bearer <token>`; anything else is a 401 with
a JSON body. `/healthz` is the only open route.

## How each suite area maps

- **git (30 checks)** — `gitproto.ts`. v2 advertisement with `fetch=shallow`
  and `ls-refs=unborn`; ls-refs with peel/symrefs/unborn/ref-prefix; fetch with
  have-exclusion, depth-limited closure and shallow-info; v0 fallback fetch;
  receive-pack with per-ref fast-forward validation and report-status inside
  side-band-64k. Packs are written plain (no deltas) in a deterministic order;
  packs are read fully (delta resolution included) so any client pack unpacks.
- **repos / issues / pulls (50 checks)** — `rest.ts` + `forge.ts`. Contents
  writes build real commits (tree surgery on the flattened tree), stale-sha
  updates answer 409, unknown issue labels 422, PR merge does a true three-way
  merge (merge-base diff applied to the base tree; same-path divergent edits
  conflict => 405 and GraphQL `CONFLICTING`).
- **graphql (20 checks)** — `graphql.ts`. Hand-written parser (operations,
  variables, aliases, inline fragments, input objects, enum lists, batching)
  and a schema-table executor. Global ids are opaque base64 (`Type:dbId...`),
  stable across reads and never the bare database id.
- **mcp (15 checks)** — `mcp.ts`. Modern revision first (`server/discover`),
  legacy `initialize` also answered. The six tools act on the same store and
  return the same object views as REST, so ids match across surfaces.
  `tools/list` is a frozen constant: byte-identical on every call.
- **protocol (5 checks)** — `app.ts`/`rest.ts` discipline: every REST reply is
  `application/json` with a non-empty `X-GitHub-Request-Id`, error bodies are
  JSON with a string `message`, unknown routes are 404 JSON, malformed JSON is
  400, missing/wrong token is 401.

## Performance choices (the four timed workloads)

- Push workload (200 receive-pack exchanges): pack ingest is one pass of
  inflate+hash per object; the fast-forward check walks from the new tip and
  stops at the old tip (O(1) for the linear bench chain).
- Clone workload (50 concurrent depth-1 clones of a 200-commit repo): the
  depth-limited closure touches only the tip commit's tree; pack building is
  deflate of a handful of small objects; no per-request state.
- Read workload (2,000 issue GETs on one keep-alive socket): the handler is a
  Map lookup plus one `JSON.stringify`; the server sets a long keep-alive
  timeout so the pool socket survives all rounds.
- Write workload (200 issue POSTs): issue creation is counter increments and a
  Map insert; the JSON body is built once per request with no extra passes.
- No locking anywhere: Node's single thread plus fully synchronous handlers
  (after body read) means no interleaving hazards and no await overhead in the
  hot paths.
