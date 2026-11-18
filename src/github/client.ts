import { setTimeout as sleep } from 'node:timers/promises';
import { redact } from '../secrets.ts';
import type { Secret } from '../secrets.ts';

const API = 'https://api.github.com';
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_FALLBACK_MS = 60_000;

export class GitHubError extends Error {
  override name = 'GitHubError';
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

interface GraphQLOptions {
  /** Disable for mutations when a 5xx could mean the write already happened. */
  retryServerErrors?: boolean;
  /** A nodes lookup can still return the other requested IDs when an ID is missing. */
  allowMissingNodes?: boolean;
}

interface RestOptions {
  method?: string;
  body?: unknown;
}

export class GitHubClient {
  readonly #token: Secret;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #signal?: AbortSignal;
  #resumeAt = 0;

  constructor(token: Secret, options: ClientOptions = {}) {
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#signal = options.signal;
    this.#sleep = options.sleep ?? (ms => sleep(ms, undefined, { signal: this.#signal }));
    this.#now = options.now ?? Date.now;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, options: GraphQLOptions = {}): Promise<T> {
    const result = await this.#request(
      new URL('/graphql', API), 'POST', { query, variables }, true, options.retryServerErrors ?? true, options.allowMissingNodes,
    );
    const data = record(result)?.data;
    if (data == null) throw new GitHubError('GitHub GraphQL response did not contain data');
    return data as T;
  }

  async rest<T>(path: string, { method = 'GET', body }: RestOptions = {}): Promise<T> {
    let url: URL;
    try {
      url = new URL(path, API);
    } catch {
      throw new GitHubError('Invalid GitHub REST URL');
    }
    if (url.origin !== API || url.username || url.password) {
      throw new GitHubError('GitHub REST requests must use the GitHub API origin');
    }
    method = method.toUpperCase();
    return await this.#request(url, method, body, false, method === 'GET' || method === 'HEAD') as T;
  }

  async #request(
    url: URL, method: string, body: unknown, graphql: boolean, retryServerErrors: boolean, allowMissingNodes = false,
  ): Promise<unknown> {
    let retryAt = 0;
    for (let attempt = 1; ; attempt++) {
      this.#signal?.throwIfAborted();
      const wait = Math.max(this.#resumeAt, retryAt) - this.#now();
      if (wait > 0) await this.#sleep(wait);

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          signal: this.#signal,
          headers: {
            authorization: `Bearer ${this.#token.reveal()}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new GitHubError(redact(`GitHub request failed: ${detail}`, [this.#token]));
      }

      const now = this.#now();
      const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
      const reset = exhausted ? secondsHeader(response.headers.get('x-ratelimit-reset')) : undefined;
      if (reset !== undefined) this.#resumeAt = Math.max(this.#resumeAt, reset);
      if (response.ok && (response.status === 204 || response.status === 205 || method === 'HEAD')) return undefined;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // An HTTP error can have an empty or non-JSON body and still be retryable.
      }

      const envelope = record(payload);
      const errors = graphql && Array.isArray(envelope?.errors)
        ? envelope.errors.map(record).filter(error => !allowMissingNodes || !missingNode(error))
        : [];
      const detail = [envelope?.message, ...errors.map(error => error?.message)]
        .filter((message): message is string => typeof message === 'string')
        .join('; ');
      const secondary = /secondary rate limit|abuse detection/i.test(detail);
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), now);
      const throttled = response.status === 429 ||
        (response.status === 403 && (exhausted || secondary || retryAfter !== undefined)) ||
        (response.ok && errors.length > 0 && (secondary || errors.some(error => error?.type === 'RATE_LIMITED')));
      const backoff = 1_000 * 2 ** (attempt - 1);

      if (throttled) {
        const fallback = retryAfter === undefined && reset === undefined ? RATE_LIMIT_FALLBACK_MS * 2 ** (attempt - 1) : 0;
        const delay = Math.max(backoff, retryAfter ?? 0, (reset ?? now) - now, fallback);
        this.#resumeAt = Math.max(this.#resumeAt, now + delay);
        if (attempt < MAX_ATTEMPTS) continue;
        throw this.#responseError('GitHub rate limit exceeded', detail, response.status, this.#resumeAt - now);
      }

      if (response.status >= 500 && retryServerErrors && attempt < MAX_ATTEMPTS) {
        retryAt = now + Math.max(backoff, retryAfter ?? 0);
        continue;
      }

      if (!response.ok) throw this.#responseError(`GitHub HTTP ${response.status}`, detail, response.status);
      if (errors.length > 0) throw this.#responseError('GitHub GraphQL error', detail, response.status);
      if (payload === undefined) throw new GitHubError('GitHub returned invalid JSON', response.status);
      return payload;
    }
  }

  #responseError(message: string, detail: string, status: number, retryAfter?: number): GitHubError {
    return new GitHubError(redact(detail ? `${message}: ${detail}` : message, [this.#token]), status, retryAfter);
  }
}

function missingNode(error: Record<string, unknown> | undefined): boolean {
  const path = error?.path;
  return error?.type === 'NOT_FOUND' && Array.isArray(path) &&
    path.length === 2 && path[0] === 'nodes' && Number.isInteger(path[1]);
}

export interface GitHubPage<T> {
  nodes: readonly (T | null)[] | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** A first page supplied by a parent query can be reused when paging a nested connection. */
export async function* paginate<T>(
  load: (cursor: string | null) => Promise<GitHubPage<T>>,
  firstPage?: GitHubPage<T>,
): AsyncGenerator<T> {
  let page = firstPage ?? await load(null);
  const seen = new Set<string>();
  while (true) {
    for (const node of page.nodes ?? []) {
      if (node !== null) yield node;
    }
    if (!page.pageInfo.hasNextPage) return;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new GitHubError('GitHub pagination did not advance');
    seen.add(cursor);
    page = await load(cursor);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function secondsHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const ms = Number(value) * 1_000;
  if (Number.isFinite(ms)) return ms;
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const seconds = secondsHeader(value);
  if (seconds !== undefined) return seconds;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
}
