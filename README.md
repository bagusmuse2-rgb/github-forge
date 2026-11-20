# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bagusmuse2-rgb/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bagusmuse2-rgb/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process with its own store — no UI, no outside service, no git binary. It serves four surfaces from one base URL: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API for repositories, issues, pull requests and contents; the GraphQL v4 API in the shapes `gh` and github-mcp-server send; and an MCP endpoint with repository, issue and pull-request tools acting on the same store. Everything is deterministic — a logical clock and counters instead of wall time or randomness — so two runs of the same trial produce byte-identical exports. On the kit's practice suite it passes 120/120 conformance checks.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, serves until the environment answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, and then exits 0. With no `MAKEFUN_ENV_URL` set it simply serves until killed.

---
<sub>Entered on [make.fun](https://make.fun/?ref=nn256rse&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
