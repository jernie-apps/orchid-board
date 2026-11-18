# Orchid Board MCP for T3 agents

Orchid Board serves MCP over streamable HTTP at `http://127.0.0.1:<mcpPort>/mcp`, where `mcpPort` defaults to `4311` in `config.json`. Requests must:

- come from loopback,
- carry `Host: 127.0.0.1:<port>` or `localhost:<port>`,
- send `Authorization: Bearer <token>`, where the token is the content of `~/.orchid/board/mcp.token`.

The board does not start without `mcp.token`.

## Token

Create the token once. It must be mode 0600:

```sh
umask 077 && openssl rand -hex 32 > ~/.orchid/board/mcp.token
```

Never paste the token into a config file. Both clients below read it from the `ORCHID_MCP_TOKEN` environment variable. Export that variable from the file in your shell profile (`~/.zshrc`):

```sh
export ORCHID_MCP_TOKEN="$(cat ~/.orchid/board/mcp.token)"
```

T3 must inherit the variable. If T3 was already running, restart it from a new shell. Do not use `claude mcp add --header "Authorization: Bearer $(cat ...)"`: the shell expands the token, and Claude stores the result inline in `~/.claude.json`.

## Claude (Claude Code)

Add this to `.mcp.json` in the project, or under `mcpServers` in `~/.claude.json` for all projects. Claude expands `${ORCHID_MCP_TOKEN}` when it connects:

```json
{
  "mcpServers": {
    "orchid": {
      "type": "http",
      "url": "http://127.0.0.1:4311/mcp",
      "headers": { "Authorization": "Bearer ${ORCHID_MCP_TOKEN}" }
    }
  }
}
```

## Codex

Add this to `~/.codex/config.toml`. Codex reads the token from the named variable and sends it as `Authorization: Bearer <token>`:

```toml
[mcp_servers.orchid]
url = "http://127.0.0.1:4311/mcp"
bearer_token_env_var = "ORCHID_MCP_TOKEN"
```

## Tools

Task refs are `owner/name#number`. `agent` is a short stable name for the agent, such as `claude-t3-61c9`.

| Tool | Input | Does |
| --- | --- | --- |
| `list_tasks` | `repo?`, `status?` (`open` or `closed`), `sprint?` | Lists cached Task issues. Each entry shows its claim and done signal. |
| `get_task` | `ref` | Returns one issue with its parent chain, children, linked PRs, CI rollup, active claim and done signal. |
| `claim` | `task`, `agent` | Claims a Task. Your own re-claim renews it. Another agent's active claim gives an error naming the holder. |
| `release` | `task`, `agent` | Drops your claim. |
| `done` | `task`, `agent` | Drops your claim and records the done signal for the board. It does not close the GitHub issue. |

Claims expire after `claimTtlMinutes`, which defaults to `120` in `config.json`. After that another agent can claim the task. A long task should re-claim before the claim expires.

Agents never create or edit GitHub issues through this server.
