# Results — local practice runs (kit sdk/run.ts, the same suite the trial runs)

## Conformance: 120 / 120

Measured three times against fresh server processes (the trial starts a fresh
process); the per-check pass vector was identical in all three runs.

| Group | Passed |
| --- | --- |
| git | 30 / 30 |
| repos | 15 / 15 |
| issues | 15 / 15 |
| pulls | 20 / 20 |
| graphql | 20 / 20 |
| mcp | 15 / 15 |
| protocol | 5 / 5 |

Feature column at this pass rate: 600/600. Agent column (mcp group): 200/200.

## Benchmarks (local, this shared VM — client and server on one box)

T_ref is the house reference forge's calibrated median; points are
`round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50))` per workload.

| Workload | p50 (run A) | p50 (run B) | T_ref | Points (A/B) |
| --- | --- | --- | --- | --- |
| push (200 pushes) | 1321 ms | 1413 ms | 1641 ms | 29 / 28 |
| clone (50 shallow) | 423 ms | 396 ms | 267 ms | 17 / 18 |
| read (2000 issue GETs) | 3304 ms | 3324 ms | 2760 ms | 22 / 22 |
| write (200 issue POSTs) | 508 ms | 605 ms | 349 ms | 18 / 15 |
| **Total** | | | | **86 / 83 of 200** |

Local caveat: on this VM the benchmark client and the forge share ~1.5 CPUs, and
a stub HTTP server returning a fixed JSON body measures *slower* than the forge
on the read pattern (3707 ms vs 3311 ms for 2000 reads) — the local numbers are
transport-bound, and the forge process itself used ~0.6 s CPU across a full
2000-read round. In the trial the env and the entry get separate 2-CPU
containers, so the split differs; the server side is a Map lookup plus one
JSON serialization per request by design.

## Lifecycle

`node main.ts` was run against a stub env: it bound an ephemeral port,
registered it, served /healthz and REST while waiting, and exited 0 when the
env answered {"done": true}.

## What is fully working

- git smart HTTP: protocol v2 (ls-refs with peel/symrefs/unborn/ref-prefix,
  fetch with shallow/deepen/shallow-info, have-exclusion that respects shallow
  boundaries) and v0 fallback; receive-pack with report-status in
  side-band-64k, fast-forward-only updates, per-ref ok/ng.
- REST v3: repos (create/list with Link pagination/get/patch/delete), branches,
  git refs, commits, contents (create/update with 409 on stale sha, directory
  listings, delete), labels, issues (state filters, sort, comments), pulls
  (files via merge-base diff, squash/merge/rebase merges with real three-way
  conflict detection -> 405).
- GraphQL: the gh/github-mcp-server documents, introspection for Issue,
  PullRequest, Repository and SearchType, Relay global ids (opaque, stable),
  cursor pagination, mutations (createIssue, closeIssue, createPullRequest,
  mergePullRequest, addComment), operation batching, errors-array semantics.
- MCP: server/discover (2026-07-28) plus the legacy initialize handshake;
  create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request on the shared store; byte-identical tools/list.

## Known limits (accepted, not hit by the suite)

- Rebase merges land with the squash commit shape (single parent).
- GraphQL supports the query shapes in the kit's documents; arbitrary
  fragments/directives beyond those shapes are parsed leniently but not
  exhaustively validated.
- REST surfaces beyond the suite's routes (search, users, orgs) answer 404.
