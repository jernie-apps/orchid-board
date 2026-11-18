# Orchid Board: agent rules

Self-hosted task board over GitHub issues (Phase → Feature → Task) plus an MCP server for T3 agents.
Runs on Por's Mac at `https://orchid.jernie.app`, home network only.
Tracking: Phase issue #1 in `companie-apps/orchid-board`. Read your Task issue (`gh issue view <n>`) before starting.

## Hard rules

- **≤10 changed files per PR**, tests and `package-lock.json` included.
- **Runtime deps:** only `@modelcontextprotocol/sdk` and `zod`. Anything else needs Por's OK. Dev deps: `typescript`, `@types/node` only.
- **Secrets** live in `~/.orchid/board/` files (`github.token`, `mcp.token`, `web.passphrase`). Read them only via `src/secrets.ts`. Never log, commit, echo or put them in errors. Keep values wrapped in `Secret` until the point of use.
- **GitHub is truth.** The local DB is cache + claims + proposals + feedback only.
- **Stem lifts:** copy from `companie-agents/packages/stem/src` (local checkout: `/Users/poranaiiii/Desktop/Work/repo/Companie/orchid/companie-agents`). Never import or depend on it.
- **Never bypass git hooks** (no `--no-verify`).
- No network in tests. Use fixtures and fake `fetch`.

## Stack

- Node ≥22.18 (runs `.ts` directly via type stripping; `node:sqlite` unflagged). TypeScript strict, ESM.
- Only erasable TS syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Use `as const` objects and union types.
- Relative imports use the `.ts` extension: `import { loadConfig } from './config.ts'`. Type-only imports use `import type`.
- GitHub: plain `fetch` to GraphQL + REST. No Octokit.
- Store: built-in `node:sqlite` (`DatabaseSync`).
- Tests: `node:test` + `node:assert/strict`.

## Commands

```sh
npm run typecheck   # tsc --noEmit, must pass
npm test            # node --test "test/**/*.test.ts", must pass
npm start           # node src/main.ts
npm run build       # tsc to dist/ (optional; nothing runs from dist)
```

Run `typecheck` and `test` before every push. CI runs both on Node 22 and 24.

## Layout

```
src/config.ts        config.json loader (ORCHID_BOARD_HOME override)
src/secrets.ts       credential files, Secret wrapper, redact()
src/main.ts          entry point
src/store/           SQLite schema, migrations, typed repo layer        (#7)
src/github/          fetch wrapper, GraphQL/REST queries, pagination   (#8)
src/sync/            poller, tree build, change events                  (#9)
src/web/             HTTP server, pages, SSE                            (#10)
src/mcp/             MCP server + tools                                 (#12)
src/proposals/       proposal validation, approve codes                 (#13)
deploy/, scripts/    Caddy, launchd, TLS setup                          (#11)
test/                mirrors src/: test/store/*.test.ts, test/github/*.test.ts, ...
test/fixtures/       recorded JSON responses
docs/                RUNBOOK, T3 MCP config
```

Each module owns its own types. `src/store` must not import `src/github` and vice versa; `src/sync` maps between them.

## Git

- Feature branch: `feature/<feature>/<feature>` (e.g. `feature/core/core`). Task branch: `feature/<feature>/<task>` (e.g. `feature/core/store`).
  Git cannot hold `feature/core` and `feature/core/store` at once, so the feature branch repeats its name. A global hook enforces this.
- Task PR: `feature/<feature>/<task>` → `feature/<feature>/<feature>`. Feature → `develop` when done. `develop` → `main` at milestones.
- Commit subject: `<Verb> - summary` with Verb in Fixed, Added, Updated, Changed, Removed, Refactored, Docs, Chore, Test. Example: `Added - SQLite store with migrations (#7)`.
- PR body ends with `Closes #<task issue>`.
