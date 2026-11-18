import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Secret } from '../secrets.ts';
import type { Store } from '../store/store.ts';
import type { SyncEvents } from '../sync/poller.ts';
import { applyProposalPost, applySendBack, isProposalId, renderInbox, type InboxOutcome, type InboxState, type InboxWriter } from './inbox.ts';
import { parseQuery, renderApp, renderLogin, renderPage, type BoardQuery, type BoardView } from './render.ts';

/** What the board needs from the poller: change events and the last successful poll. */
export interface SyncSource {
  readonly events: EventEmitter<SyncEvents>;
  readonly lastSyncAt: number | null;
}

export interface WebServerOptions {
  store: Store;
  passphrase: Secret;
  sync: SyncSource;
  /** Listen port on 127.0.0.1; 0 picks a free one (tests). */
  port: number;
  mcpPort: number;
  /** GitHub writer, kicked when Por approves in the inbox. Without it approval only marks the proposal. */
  writer?: InboxWriter;
  now?: () => number;
  sessionTtlMs?: number;
  heartbeatMs?: number;
}

export interface WebServer {
  readonly port: number;
  close(): Promise<void>;
}

const COOKIE = 'orchid_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const MAX_BODY = 4096;
/** Inbox forms carry every title of a proposal plus comments. */
const MAX_INBOX_BODY = 256 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
} as const;

const ASSETS = {
  '/board.css': { type: 'text/css; charset=utf-8', body: readFileSync(new URL('./board.css', import.meta.url)), public: true },
  '/board.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('./board.js', import.meta.url)), public: false },
} as const;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time compare on fixed-length hashes, so neither length nor content leaks through timing. */
export function passphraseMatches(given: string, secret: Secret): boolean {
  return timingSafeEqual(sha256(given), sha256(secret.reveal()));
}

/** CSRF check: constant-time compare of fixed-length hashes. */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Failed-login limiter: at most `max` failures per key inside a sliding window. */
export class LoginLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max = MAX_FAILURES, windowMs = FAILURE_WINDOW_MS) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  blocked(key: string, now: number): boolean {
    this.#prune(now);
    return (this.#failures.get(key)?.length ?? 0) >= this.#max;
  }

  fail(key: string, now: number): void {
    const list = this.#failures.get(key) ?? [];
    list.push(now);
    this.#failures.set(key, list);
  }

  #prune(now: number): void {
    for (const [key, list] of this.#failures) {
      const recent = list.filter(t => now - t < this.#windowMs);
      if (recent.length) this.#failures.set(key, recent);
      else this.#failures.delete(key);
    }
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Rate-limit key. Every connection comes from Caddy on loopback, so the socket address is
 * the same for all clients; Caddy appends the real client as the last X-Forwarded-For hop.
 */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = value?.split(',').at(-1)?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  send(res, 303, '', { Location: location, ...headers });
}

async function readForm(req: IncomingMessage, max = MAX_BODY): Promise<URLSearchParams | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function buildView(
  store: Store, sync: SyncSource, query: BoardQuery, mcpPort: number, now: number, csrf?: string,
): BoardView {
  const issues = store.listIssues();
  const repos = [...new Set(issues.map(issue => issue.repo))].sort();
  const sprints = [...new Set(issues.flatMap(issue => (issue.iteration ? [issue.iteration.title] : [])))].sort();
  const tree = store.getTree({
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.sprint ? { iteration: query.sprint } : {}),
  });
  const inboxCount = store.listProposals('pending').length;
  return { tree, repos, sprints, issueCount: issues.length, lastSyncAt: sync.lastSyncAt, mcpPort, now, inboxCount, ...(csrf ? { csrf } : {}) };
}

interface Stream {
  res: ServerResponse;
  session: string;
}

interface Session {
  expires: number;
  /** Per-session token every POST must echo back. */
  csrf: string;
}

/** Start the board on 127.0.0.1. Resolves once listening. */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const { store, passphrase, sync, mcpPort } = options;
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? SESSION_TTL_MS;
  const sessions = new Map<string, Session>();
  const limiter = new LoginLimiter();
  const streams = new Set<Stream>();

  const session = (req: IncomingMessage): string | null => {
    const id = cookie(req, COOKIE);
    if (!id) return null;
    const expires = sessions.get(id)?.expires;
    if (expires === undefined) return null;
    if (expires <= now()) {
      sessions.delete(id);
      return null;
    }
    return id;
  };

  const endStreams = (match: (stream: Stream) => boolean) => {
    for (const stream of streams) {
      if (!match(stream)) continue;
      streams.delete(stream);
      stream.res.end();
    }
  };

  const broadcast = (event: string, data: string) => {
    for (const stream of streams) stream.res.write(`event: ${event}\ndata: ${data}\n\n`);
  };
  const onChange = () => broadcast('change', '{}');
  const onSynced = (at: number) => broadcast('synced', String(at));
  sync.events.on('change', onChange);
  sync.events.on('synced', onSynced);

  const heartbeat = setInterval(() => {
    for (const [id, { expires }] of sessions) if (expires <= now()) sessions.delete(id);
    endStreams(stream => !sessions.has(stream.session));
    for (const stream of streams) stream.res.write(': ping\n\n');
  }, options.heartbeatMs ?? 25_000);
  heartbeat.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopback(req.socket.remoteAddress)) {
      send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/login') {
      if (method === 'GET') {
        if (session(req)) return redirect(res, '/');
        return send(res, 200, renderLogin());
      }
      if (method !== 'POST') return send(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
      const key = clientKey(req);
      if (limiter.blocked(key, now())) {
        return send(res, 429, renderLogin('Too many attempts. Wait a minute and try again.'), { 'Retry-After': '60' });
      }
      const form = await readForm(req);
      if (!form) return send(res, 413, renderLogin('Request too large.'));
      if (!passphraseMatches(form.get('passphrase') ?? '', passphrase)) {
        limiter.fail(key, now());
        return send(res, 401, renderLogin('Wrong passphrase.'));
      }
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { expires: now() + ttl, csrf: randomBytes(32).toString('base64url') });
      const maxAge = Math.floor(ttl / 1000);
      return redirect(res, '/', { 'Set-Cookie': `${COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict` });
    }

    // Public on purpose: the login page needs its stylesheet. It holds no board data.
    if (path === '/board.css' && method === 'GET') {
      return send(res, 200, ASSETS['/board.css'].body, { 'Content-Type': ASSETS['/board.css'].type, 'Cache-Control': 'no-cache' });
    }

    const id = session(req);
    if (!id) {
      if (method === 'GET' && (path === '/' || path === '/inbox' || path.startsWith('/inbox/'))) return redirect(res, '/login');
      return send(res, 401, 'Login required', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const csrf = sessions.get(id)!.csrf;

    // Every POST past login carries the session's CSRF token.
    let form: URLSearchParams | null = null;
    if (method === 'POST') {
      form = await readForm(req, path.startsWith('/inbox/') ? MAX_INBOX_BODY : MAX_BODY);
      if (!form) return send(res, 413, 'Request too large', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!tokenMatches(form.get('csrf') ?? '', csrf)) {
        return send(res, 403, 'Invalid or missing CSRF token. Reload the page and try again.', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }

    if (path === '/logout' && method === 'POST') {
      sessions.delete(id);
      endStreams(stream => stream.session === id);
      return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    }
    const inbox = /^\/inbox(?:\/([^/]+)(\/send-back)?)?$/.exec(path);
    if (inbox) {
      const proposalId = inbox[1] === undefined ? null : inbox[1];
      if (proposalId !== null && !isProposalId(proposalId)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const showInbox = (status: number, state: InboxState = {}) => {
        const proposals = store.listProposals();
        const selected = proposalId === null
          ? proposals.filter(p => p.state === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
          : store.getProposal(proposalId);
        if (!selected && proposalId !== null) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        const html = renderInbox({
          ...state,
          proposals,
          selected,
          dropped: selected ? store.droppedNodeKeys(selected.id) : [],
          feedback: selected ? store.getFeedback(selected.id).comments : [],
          write: selected && options.writer ? options.writer.status(selected.id) : null,
          csrf,
          now: now(),
        });
        return send(res, status, html);
      };
      if (method === 'GET' && !inbox[2]) return showInbox(200);
      if (method !== 'POST' || proposalId === null || !form) {
        return send(res, 405, 'Method not allowed', { Allow: inbox[2] ? 'POST' : proposalId === null ? 'GET' : 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const outcome: InboxOutcome = inbox[2]
        ? applySendBack(store, proposalId, form, now())
        : applyProposalPost(store, options.writer ?? null, proposalId, form, now());
      if (outcome.kind === 'missing') return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (outcome.kind === 'redirect') return redirect(res, outcome.location);
      return showInbox(outcome.status, outcome.state);
    }

    if (method !== 'GET') return send(res, 405, 'Method not allowed', { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });

    if (path === '/board.js') {
      return send(res, 200, ASSETS['/board.js'].body, { 'Content-Type': ASSETS['/board.js'].type, 'Cache-Control': 'no-cache' });
    }
    if (path === '/' || path === '/fragment') {
      const query = parseQuery(url.searchParams);
      const view = buildView(store, sync, query, mcpPort, now(), csrf);
      return send(res, 200, path === '/' ? renderPage(view, query) : renderApp(view, query));
    }
    if (path === '/events') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      const stream = { res, session: id };
      streams.add(stream);
      req.on('close', () => streams.delete(stream));
      return;
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never echo the error: it may carry request data.
      if (!res.headersSent) send(res, 500, 'Internal error', { 'Content-Type': 'text/plain; charset=utf-8' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      sync.events.off('change', onChange);
      sync.events.off('synced', onSynced);
      clearInterval(heartbeat);
      endStreams(() => true);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
