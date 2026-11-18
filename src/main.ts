import { ConfigError, boardHome, loadConfig } from './config.ts';
import { hasSecret, readSecret, redact, SecretError, type SecretName } from './secrets.ts';
import { dbPath } from './store/db.ts';
import { openStore } from './store/store.ts';
import { createGitHubPoller } from './sync/poller.ts';

const OPTIONAL_SECRETS: readonly SecretName[] = ['mcp.token', 'web.passphrase'];

function main(): void {
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await poller.stop();
    store.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  poller.start();
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError || err instanceof SecretError) {
    console.error(`orchid-board: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
