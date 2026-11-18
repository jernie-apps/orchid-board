import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A GitHub repository, parsed from `"owner/name"` in config.json. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** A GitHub Projects (v2) board that holds the `Iteration` (Sprint) field. */
export interface ProjectRef {
  owner: string;
  number: number;
}

export interface Config {
  /** State dir holding config.json, secret files and board.db. */
  home: string;
  /** Web board port on 127.0.0.1. */
  port: number;
  /** MCP server port on 127.0.0.1. */
  mcpPort: number;
  /** Seconds between sync polls. */
  pollSeconds: number;
  repos: RepoRef[];
  project: ProjectRef | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const DEFAULTS = { port: 4310, mcpPort: 4311, pollSeconds: 60 } as const;

/** `$ORCHID_BOARD_HOME` when it is an absolute path, else `~/.orchid/board`. */
export function boardHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.ORCHID_BOARD_HOME;
  if (override && isAbsolute(override)) return override;
  return join(home, '.orchid', 'board');
}

/** Load and validate `<home>/config.json`. Throws ConfigError naming the file and field, never echoing file content. */
export function loadConfig(home: string = boardHome()): Config {
  const file = join(home, 'config.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(code === 'ENOENT' ? `missing ${file}` : `cannot read ${file} (${code ?? 'error'})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file} is not valid JSON`);
  }
  return parseConfig(raw, home, file);
}

export function parseConfig(raw: unknown, home: string, file = 'config.json'): Config {
  if (!isObject(raw)) throw new ConfigError(`${file}: expected a JSON object`);
  return {
    home,
    port: port(raw.port ?? DEFAULTS.port, 'port', file),
    mcpPort: port(raw.mcpPort ?? DEFAULTS.mcpPort, 'mcpPort', file),
    pollSeconds: positiveInt(raw.pollSeconds ?? DEFAULTS.pollSeconds, 'pollSeconds', file),
    repos: repos(raw.repos, file),
    project: raw.project == null ? null : project(raw.project, file),
  };
}

function repos(value: unknown, file: string): RepoRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`${file}: repos must be a non-empty array of "owner/name"`);
  return value.map((entry, i) => {
    const match = typeof entry === 'string' ? /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(entry) : null;
    if (!match) throw new ConfigError(`${file}: repos[${i}] must be "owner/name"`);
    return { owner: match[1]!, name: match[2]! };
  });
}

function project(value: unknown, file: string): ProjectRef {
  if (!isObject(value) || typeof value.owner !== 'string' || value.owner === '') {
    throw new ConfigError(`${file}: project must be { "owner": string, "number": integer }`);
  }
  return { owner: value.owner, number: positiveInt(value.number, 'project.number', file) };
}

function port(value: unknown, field: string, file: string): number {
  const n = positiveInt(value, field, file);
  if (n > 65535) throw new ConfigError(`${file}: ${field} must be <= 65535`);
  return n;
}

function positiveInt(value: unknown, field: string, file: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${file}: ${field} must be a positive integer`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
