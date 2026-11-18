import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

/**
 * Forward-only migrations: index i migrates schema version i to i+1.
 * Never edit a shipped entry; append a new one.
 * Timestamps we write (claims, proposals, codes) are ISO strings from Date#toISOString().
 * Issue/PR `updated_at` is GitHub's string, stored as-is and never compared with ours.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE issues (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    node_id TEXT NOT NULL UNIQUE,
    type TEXT CHECK (type IN ('Phase','Feature','Task')),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','closed')),
    parent TEXT,
    iteration_id TEXT,
    iteration_title TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  );
  CREATE INDEX issues_parent ON issues(parent);

  CREATE TABLE prs (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
    draft INTEGER NOT NULL CHECK (draft IN (0,1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  );
  CREATE TABLE pr_issues (
    pr_repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    issue TEXT NOT NULL,
    PRIMARY KEY (pr_repo, pr_number, issue),
    FOREIGN KEY (pr_repo, pr_number) REFERENCES prs(repo, number) ON DELETE CASCADE
  );
  CREATE INDEX pr_issues_issue ON pr_issues(issue);
  CREATE TABLE checks (
    pr_repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    rollup TEXT NOT NULL CHECK (rollup IN ('pass','fail','running','none')),
    PRIMARY KEY (pr_repo, pr_number),
    FOREIGN KEY (pr_repo, pr_number) REFERENCES prs(repo, number) ON DELETE CASCADE
  );

  CREATE TABLE claims (
    task TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    since TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    parent TEXT,
    agent TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','approved','done','rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE proposal_nodes (
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    parent_key TEXT,
    position INTEGER NOT NULL,
    repo TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('Phase','Feature','Task')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    branch TEXT,
    iteration TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft','sent_back','approved','created')),
    issue_number INTEGER,
    issue_node_id TEXT,
    PRIMARY KEY (proposal_id, key)
  );
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    node_key TEXT,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX feedback_proposal ON feedback(proposal_id);
  CREATE TABLE approve_codes (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
  `
  ALTER TABLE pr_issues ADD COLUMN source TEXT NOT NULL DEFAULT 'github'
    CHECK (source IN ('github', 'body', 'both'));
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class SchemaError extends Error {
  override name = 'SchemaError';
}

/** `<home>/board.db` */
export function dbPath(home: string): string {
  return join(home, 'board.db');
}

/** Open (creating if needed) and migrate. Use `':memory:'` in tests. */
export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

/** Apply pending migrations, each in its own transaction. Safe to call repeatedly. */
export function migrate(db: DB): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new SchemaError(`board.db schema ${current} is newer than this build (${SCHEMA_VERSION})`);
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version + 1));
    });
  }
  return SCHEMA_VERSION;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

const depth = new WeakMap<DB, number>();

/** Run fn in one IMMEDIATE transaction; nested calls join the outer one. */
export function tx<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return fn();
    } finally {
      depth.set(db, level);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}
