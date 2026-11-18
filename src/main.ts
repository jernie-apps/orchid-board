import { ConfigError, boardHome, loadConfig } from './config.ts';
import { hasSecret, readSecret, redact, SecretError, type SecretName } from './secrets.ts';
import { dbPath } from './store/db.ts';
import { openStore } from './store/store.ts';
import { createGitHubPoller } from './sync/poller.ts';
import { startWebServer, type WebServer } from './web/server.ts';

const OPTIONAL_SECRETS: readonly SecretName[] = ['mcp.token', 'web.passphrase'];

async function main(): Promise<void> {
  const home = boardHome();
  const config = loadConfig(home);
  const token = readSecret(home, 'github.token');
  const store = openStore(dbPath(home));
  const poller = createGitHubPoller({
    repos: config.repos,
    project: config.project,
    pollSeconds: config.pollSeconds,
    store,
    token,
    onError: (repo, error) => {
      const detail = error instanceof Error ? error.message : 'unknown error';
      console.error(`orchid-board: sync ${repo}: ${redact(detail, [token])}`);
    },
  });
  // Log presence only. Secret values never reach a log.
  const secrets = { 'github.token': true, ...Object.fromEntries(OPTIONAL_SECRETS.map(name => [name, hasSecret(home, name)])) };
  console.log(JSON.stringify({ msg: 'orchid-board starting', config, secrets }));

  let web: WebServer | null = null;
  if (hasSecret(home, 'web.passphrase')) {
    web = await startWebServer({ store, sync: poller, passphrase: readSecret(home, 'web.passphrase'), port: config.port, mcpPort: config.mcpPort });
    console.log(JSON.stringify({ msg: 'web board listening', url: `http://127.0.0.1:${web.port}` }));
  } else {
    console.error(`orchid-board: web board disabled: missing or unreadable ${home}/web.passphrase`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await poller.stop();
    await web?.close();
    store.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  poller.start();
}

main().catch(err => {
  if (err instanceof ConfigError || err instanceof SecretError) {
    console.error(`orchid-board: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
