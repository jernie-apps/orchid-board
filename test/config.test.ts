import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, describe, it } from 'node:test';
import { ConfigError, boardHome, loadConfig } from '../src/config.ts';
import { Secret, SecretError, hasSecret, readSecret, redact } from '../src/secrets.ts';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchid-board-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('boardHome', () => {
  it('defaults to ~/.orchid/board', () => {
    assert.equal(boardHome({}, '/Users/x'), '/Users/x/.orchid/board');
  });
  it('honours an absolute ORCHID_BOARD_HOME', () => {
    assert.equal(boardHome({ ORCHID_BOARD_HOME: '/tmp/b' }, '/Users/x'), '/tmp/b');
  });
  it('ignores a relative ORCHID_BOARD_HOME', () => {
    assert.equal(boardHome({ ORCHID_BOARD_HOME: 'b' }, '/Users/x'), '/Users/x/.orchid/board');
  });
});

describe('loadConfig', () => {
  it('loads a full config', () => {
    const home = tempHome();
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ port: 8080, mcpPort: 8081, pollSeconds: 30, repos: ['companie-apps/orchid-board'], project: { owner: 'companie-apps', number: 3 } }),
    );
    assert.deepEqual(loadConfig(home), {
      home,
      port: 8080,
      mcpPort: 8081,
      pollSeconds: 30,
      repos: [{ owner: 'companie-apps', name: 'orchid-board' }],
      project: { owner: 'companie-apps', number: 3 },
    });
  });

  it('applies defaults', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ repos: ['a/b'] }));
    const config = loadConfig(home);
    assert.equal(config.port, 4310);
    assert.equal(config.mcpPort, 4311);
    assert.equal(config.pollSeconds, 60);
    assert.equal(config.project, null);
  });

  it('fails on a missing file', () => {
    assert.throws(() => loadConfig(tempHome()), (err: unknown) => err instanceof ConfigError && /missing .*config\.json/.test(err.message));
  });

  it('fails on bad JSON without echoing the content', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), '{"repos": ["a/b"], "leak": "hunter2"');
    assert.throws(
      () => loadConfig(home),
      (err: unknown) => err instanceof ConfigError && /not valid JSON/.test(err.message) && !err.message.includes('hunter2'),
    );
  });

  for (const [label, body, field] of [
    ['no repos', {}, 'repos'],
    ['bad repo', { repos: ['nope'] }, 'repos\\[0\\]'],
    ['bad port', { repos: ['a/b'], port: 70000 }, 'port'],
    ['bad poll', { repos: ['a/b'], pollSeconds: 0 }, 'pollSeconds'],
    ['bad project', { repos: ['a/b'], project: { owner: 'x' } }, 'project.number'],
  ] as const) {
    it(`rejects ${label}`, () => {
      const home = tempHome();
      writeFileSync(join(home, 'config.json'), JSON.stringify(body));
      assert.throws(() => loadConfig(home), (err: unknown) => err instanceof ConfigError && new RegExp(field).test(err.message));
    });
  }
});

describe('readSecret', () => {
  function writeSecret(home: string, name: string, value: string, mode = 0o600): void {
    const file = join(home, name);
    writeFileSync(file, value);
    chmodSync(file, mode);
  }

  it('reads and trims a 0600 file', () => {
    const home = tempHome();
    writeSecret(home, 'github.token', 'ghp_example\n');
    assert.equal(readSecret(home, 'github.token').reveal(), 'ghp_example');
    assert.equal(hasSecret(home, 'github.token'), true);
  });

  it('fails closed on a missing file', () => {
    const home = tempHome();
    assert.throws(() => readSecret(home, 'mcp.token'), (err: unknown) => err instanceof SecretError && /missing/.test(err.message));
    assert.equal(hasSecret(home, 'mcp.token'), false);
  });

  it('fails closed on an empty file', () => {
    const home = tempHome();
    writeSecret(home, 'mcp.token', '  \n');
    assert.throws(() => readSecret(home, 'mcp.token'), (err: unknown) => err instanceof SecretError && /empty/.test(err.message));
  });

  it('fails closed on a group/world-readable file without echoing the value', { skip: process.platform === 'win32' }, () => {
    const home = tempHome();
    writeSecret(home, 'web.passphrase', 'open-sesame', 0o644);
    assert.throws(
      () => readSecret(home, 'web.passphrase'),
      (err: unknown) => err instanceof SecretError && /chmod 600/.test(err.message) && !err.message.includes('open-sesame'),
    );
  });
});

describe('redaction', () => {
  const secret = new Secret('github.token', 'ghp_supersecret');

  it('never prints the value via String, JSON or inspect', () => {
    for (const out of [String(secret), `${secret}`, JSON.stringify({ secret }), inspect(secret), inspect({ nested: secret })]) {
      assert.ok(!out.includes('ghp_supersecret'), out);
      assert.ok(out.includes('[secret github.token]'), out);
    }
  });

  it('redacts every occurrence in text', () => {
    assert.equal(redact('a ghp_supersecret b ghp_supersecret', [secret]), 'a [secret github.token] b [secret github.token]');
  });
});
