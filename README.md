# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/happy456733/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/happy456733/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: smart HTTP, REST v3, GraphQL v4 and MCP. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node --experimental-strip-types main.ts
```

The forge is one Node 22 process with no dependencies and no network use of its own: it binds an ephemeral port, registers it with the environment at `$MAKEFUN_ENV_URL/register`, serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and MCP at `/mcp` from its own in-memory store, then exits 0 when the environment says the trial is done.

## Layout

- `main.ts`: the entry lifecycle (bind, register, poll done, exit 0). Kept as the starter ships it.
- `app.ts`: the HTTP server and router.
- `store.ts`: the in-memory forge store — repositories, refs, git objects, issues, pull requests.
- `gitobj.ts`: git object model, packfile read/write, pkt-line codec.
- `gitproto.ts`: git smart HTTP (upload-pack v2/v0, receive-pack v0).
- `rest.ts`: the REST v3 API.
- `graphql.ts`: the GraphQL v4 executor (a small parser for the documents `gh` and `github-mcp-server` send).
- `mcp.ts`: the MCP endpoint over streamable HTTP (revision 2026-07-28).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5xhhehwj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
