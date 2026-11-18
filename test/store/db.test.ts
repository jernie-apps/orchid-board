import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SCHEMA_VERSION, SchemaError, dbPath, migrate, openDb, schemaVersion, tx } from '../../src/store/db.ts';
import { RefError, formatRef, isRef, parseRef } from '../../src/store/ref.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('migrates a fresh :memory: db to the latest version', () => {
    const db = openDb(':memory:');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    assert.deepEqual(tables, [
      'approve_codes',
      'checks',
      'claims',
      'feedback',
      'issues',
      'meta',
      'pr_issues',
      'proposal_nodes',
      'proposals',
      'prs',
    ]);
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    assert.equal(migrate(db), SCHEMA_VERSION);
    assert.equal(migrate(db), SCHEMA_VERSION);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  });

  it('keeps existing PR links as GitHub links when upgrading from v1', () => {
    const db = openDb(':memory:');
    db.exec(`
      ALTER TABLE pr_issues DROP COLUMN source;
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
      INSERT INTO prs (repo, number, url, title, state, draft, updated_at)
      VALUES ('org/repo', 10, 'https://github.com/org/repo/pull/10', 'A PR', 'open', 0, '2026-11-18T00:00:00Z');
      INSERT INTO pr_issues (pr_repo, pr_number, issue) VALUES ('org/repo', 10, 'org/repo#5');
    `);
    assert.equal(migrate(db), SCHEMA_VERSION);
    const link = db.prepare('SELECT issue, source FROM pr_issues').get();
    assert.deepEqual({ ...link }, { issue: 'org/repo#5', source: 'github' });
    db.close();
  });

  it('refuses a db from a newer build', () => {
    const db = openDb(':memory:');
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    assert.throws(() => migrate(db), SchemaError);
  });

  it('uses WAL on a file db and keeps the schema on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchid-board-db-'));
    dirs.push(dir);
    const path = dbPath(dir);
    assert.equal(path, join(dir, 'board.db'));
    const first = openDb(path);
    assert.equal(String(first.prepare('PRAGMA journal_mode').get()?.journal_mode), 'wal');
    first.close();
    const second = openDb(path);
    assert.equal(schemaVersion(second), SCHEMA_VERSION);
    second.close();
  });
});

describe('tx', () => {
  it('rolls back on error and joins nested calls', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    assert.throws(() =>
      tx(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        tx(db, () => db.prepare('INSERT INTO t VALUES (2)').run());
        throw new Error('boom');
      }),
    );
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.n), 0);
    tx(db, () => tx(db, () => db.prepare('INSERT INTO t VALUES (3)').run()));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.n), 1);
  });
});

describe('ref', () => {
  it('round-trips owner/name#number', () => {
    assert.deepEqual(parseRef('companie-apps/orchid-board#7'), { repo: 'companie-apps/orchid-board', number: 7 });
    assert.equal(formatRef('companie-apps/orchid-board', 7), 'companie-apps/orchid-board#7');
  });

  it('rejects malformed refs', () => {
    for (const bad of ['orchid-board#7', 'a/b#0', 'a/b#x', 'a/b', '#7', 'a/b/c#1']) {
      assert.equal(isRef(bad), false, bad);
      assert.throws(() => parseRef(bad), RefError, bad);
    }
    assert.throws(() => formatRef('a/b', 0), RefError);
    assert.throws(() => formatRef('nope', 1), RefError);
  });
});
