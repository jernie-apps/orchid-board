import { ConfigError, boardHome, loadConfig } from './config.ts';
import { hasSecret, type SecretName } from './secrets.ts';

const SECRETS: readonly SecretName[] = ['github.token', 'mcp.token', 'web.passphrase'];

function main(): void {
  const home = boardHome();
  const config = loadConfig(home);
  // Log presence only. Secret values never reach a log.
  const secrets = Object.fromEntries(SECRETS.map((name) => [name, hasSecret(home, name)]));
  console.log(JSON.stringify({ msg: 'orchid-board starting', config, secrets }));
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`orchid-board: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
