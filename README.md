# Orchid Board

A self-hosted project board for one developer and their AI coding agents.

GitHub issues stay the source of truth. Orchid Board mirrors them into a local SQLite cache, shows them as a Phase → Feature → Task tree in a web board that works on desktop and phone, and exposes the same tree to agents over MCP. Agents claim tasks, propose new work, and wait for a human to approve it in the web inbox before anything is written back to GitHub.

## What it does

- **Board.** Live tree of Phases, Features and Tasks across your repos, with PR links, status badges, filters and a collapsed Done section. Updates over Server-Sent Events.
- **Inbox.** Agents' proposals land here. Approve, edit, or send items back with comments. Approval uses a one-time code so an agent cannot approve its own work.
- **MCP server.** Tools for agents: `list_tasks`, `get_task`, `claim`, `release`, `done`, `propose_tree`, `get_proposal`, `resubmit`, `get_feedback`, `approve`.
- **Sync.** Polls GitHub GraphQL/REST and writes approved proposal trees back as issues and sub-issues, resuming safely after a crash.

## Stack

- Node 22.18+ running TypeScript directly (type stripping, no build step), strict ESM
- Built-in `node:sqlite` for storage, `node:test` for tests
- Plain `fetch` to GitHub GraphQL and REST (no Octokit)
- Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod`
- Caddy for local HTTPS, launchd to keep it running on macOS

## Security

- Credentials live in mode-600 files under `~/.orchid/board/` and stay wrapped in a `Secret` type that prints as a placeholder in logs, JSON and errors.
- Web login is passphrase-based with CSRF protection and rate limiting. MCP is bearer-token only and bound to loopback.
- Caddy serves only loopback and private-network clients. Nothing is exposed to the internet.

## Quick start

```sh
npm ci
mkdir -p ~/.orchid/board && chmod 700 ~/.orchid/board
# write ~/.orchid/board/config.json, e.g. {"repos": ["owner/repo"]}
# put a GitHub token, an MCP token and a web passphrase in
#   github.token, mcp.token, web.passphrase (one value each, chmod 600)
npm start
```

Open `http://127.0.0.1:4310`. The MCP server listens on `127.0.0.1:4311`.

For a permanent install with HTTPS on your home network, see [`docs/RUNBOOK.md`](docs/RUNBOOK.md). To connect an agent, see [`docs/t3-mcp.md`](docs/t3-mcp.md).

## Development

```sh
npm run typecheck
npm test
```

CI runs both on Node 22 and 24. Contributor and agent rules are in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)
