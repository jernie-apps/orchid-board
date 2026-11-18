import { ConfigError, boardHome, loadConfig } from './config.ts';
import { McpServerError, startMcpServer, taskTools } from './mcp/server.ts';
import { hasSecret, readSecret, redact, SecretError, type SecretName } from './secrets.ts';
import { dbPath } from './store/db.ts';
import { openStore } from './store/store.ts';
import { createGitHubPoller } from './sync/poller.ts';

const OPTIONAL_SECRETS: readonly SecretName[] = ['web.passphrase'];

async function main(): Promise<void> {
  const home = boardHome();
  const config = loadConfig(home);
  const token = readSecret(home, 'github.token');
  // Required: the MCP server never runs without auth.
  const mcpToken = readSecret(home, 'mcp.token');
  const secrets = [token, mcpToken];
  const store = openStore(dbPath(home));
  const poller = createGitHubPoller({
    repos: config.repos,
    project: config.project,
    pollSeconds: config.pollSeconds,
    store,
    token,
    onError: (repo, error) => {
      const detail = error instanceof Error ? error.message : 'unknown error';
      console.error(`orchid-board: sync ${repo}: ${redact(detail, secrets)}`);
    },
  });
  let mcp;
  try {
    mcp = await startMcpServer({
      port: config.mcpPort,
      token: mcpToken,
      toolsets: [taskTools({ store, claimTtlMs: config.claimTtlMinutes * 60_000 })],
      onError: (error) => {
        const detail = error instanceof Error ? error.message : 'unknown error';
        console.error(`orchid-board: mcp: ${redact(detail, secrets)}`);
      },
    });
  } catch (err) {
    store.close();
    throw err;
  }
  // Log presence only. Secret values never reach a log.
  const present = {
    'github.token': true,
    'mcp.token': true,
    ...Object.fromEntries(OPTIONAL_SECRETS.map(name => [name, hasSecret(home, name)])),
  };
  console.log(JSON.stringify({ msg: 'orchid-board starting', config, secrets: present, mcp: mcp.url }));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await mcp.close();
    await poller.stop();
    store.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  poller.start();
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof SecretError || err instanceof McpServerError) {
    console.error(`orchid-board: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
