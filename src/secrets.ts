import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

/** Credential files in the board home dir. One value per file, mode 0600. */
export type SecretName = 'github.token' | 'mcp.token' | 'web.passphrase';

export class SecretError extends Error {
  override name = 'SecretError';
}

/**
 * Wraps a credential so it cannot leak by accident: String(), JSON.stringify()
 * and console.log() all print a placeholder. Call reveal() only at the point of use
 * (e.g. building an Authorization header).
 */
export class Secret {
  readonly name: SecretName;
  readonly #value: string;

  constructor(name: SecretName, value: string) {
    this.name = name;
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[secret ${this.name}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * Read `<home>/<name>`. Fails closed: missing, empty, or group/world-accessible
 * files throw SecretError. Errors name the file, never its content.
 */
export function readSecret(home: string, name: SecretName): Secret {
  const file = join(home, name);
  let mode: number;
  let text: string;
  try {
    mode = statSync(file).mode;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SecretError(code === 'ENOENT' ? `missing ${file}` : `cannot read ${file} (${code ?? 'error'})`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new SecretError(`${file} must not be readable by group or others (run: chmod 600 ${file})`);
  }
  const value = text.trim();
  if (value === '') throw new SecretError(`${file} is empty`);
  return new Secret(name, value);
}

/** True when the secret file exists and passes readSecret's checks. */
export function hasSecret(home: string, name: SecretName): boolean {
  try {
    readSecret(home, name);
    return true;
  } catch {
    return false;
  }
}

/** Replace every occurrence of each secret's value in text. Use on anything that may reach a log or error. */
export function redact(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.reveal();
    if (value !== '') out = out.split(value).join(`[secret ${secret.name}]`);
  }
  return out;
}
