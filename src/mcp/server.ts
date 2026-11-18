import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Secret } from '../secrets.ts';
import { isRef, RefError } from '../store/ref.ts';
import { ClaimConflictError, StoreError, type ChecksRollup, type Issue, type Pr, type Store } from '../store/store.ts';

// ---------------------------------------------------------------------------
// Toolsets
//
// A toolset registers a group of tools on a fresh McpServer. Each toolset closes
// over its own dependencies, so later groups (proposals, #13) plug in by adding
// one entry to the `toolsets` list passed to startMcpServer.
// ---------------------------------------------------------------------------

export type Toolset = (server: McpServer) => void;

/** Thrown by a tool to return a clean `isError` result with this message. */
export class ToolError extends Error {
  override name = 'ToolError';
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const taskRef = z.string().refine(isRef, 'expected owner/name#number');
const agentName = z.string().trim().min(1, 'agent must be non-empty').max(100);

/** Zod input schemas for the task tools. Exported for tests. */
export const taskSchemas = {
  list_tasks: z
    .object({
      repo: z.string().regex(REPO, 'expected owner/name').optional(),
      status: z.enum(['open', 'closed']).optional(),
      sprint: z.string().min(1).optional(),
    })
    .strict(),
  get_task: z.object({ ref: taskRef }).strict(),
  claim: z.object({ task: taskRef, agent: agentName }).strict(),
  release: z.object({ task: taskRef, agent: agentName }).strict(),
  done: z.object({ task: taskRef, agent: agentName }).strict(),
} as const;

export interface TaskToolsDeps {
  store: Store;
  /** How long a claim lasts before another agent may take it. */
  claimTtlMs: number;
}

/** list_tasks, get_task, claim, release, done. Reads the local cache; never writes GitHub. */
export function taskTools({ store, claimTtlMs }: TaskToolsDeps): Toolset {
  const summary = (issue: Issue) => ({
    ref: issue.ref,
    type: issue.type,
    title: issue.title,
    state: issue.state,
    sprint: issue.iteration?.title ?? null,
    parent: issue.parent,
    claim: store.getClaim(issue.ref),
    done: store.getDone(issue.ref),
  });

  const requireIssue = (ref: string): Issue => {
    const issue = store.getIssue(ref);
    if (!issue) throw new ToolError(`unknown task ${ref} (not in the board cache)`);
    return issue;
  };

  const requireTask = (ref: string): Issue => {
    const issue = requireIssue(ref);
    if (issue.type !== null && issue.type !== 'Task') throw new ToolError(`${ref} is a ${issue.type}, not a Task`);
    return issue;
  };

  return (server) => {
    server.registerTool(
      'list_tasks',
      {
        description:
          'List Task issues from the board cache. Filters: repo ("owner/name"), status (issue state: open|closed), sprint (iteration title or id). Each entry shows its active claim and done signal.',
        inputSchema: taskSchemas.list_tasks,
        annotations: { readOnlyHint: true },
      },
      (args) =>
        runTool(() => {
          const filter = {
            ...(args.repo !== undefined && { repo: args.repo }),
            ...(args.status !== undefined && { state: args.status }),
            ...(args.sprint !== undefined && { iteration: args.sprint }),
          };
          return store
            .listIssues(filter)
            .filter((issue) => issue.type === 'Task')
            .map(summary);
        }),
    );

    server.registerTool(
      'get_task',
      {
        description:
          'Get one issue ("owner/name#number") with its parent chain (nearest first), children, linked PRs, CI rollup, active claim and done signal.',
        inputSchema: taskSchemas.get_task,
        annotations: { readOnlyHint: true },
      },
      (args) =>
        runTool(() => {
          const issue = requireIssue(args.ref);
          const parents: Array<Pick<Issue, 'ref' | 'type' | 'title' | 'state'>> = [];
          const seen = new Set([issue.ref]);
          for (let ref = issue.parent; ref && !seen.has(ref); ) {
            seen.add(ref);
            const parent = store.getIssue(ref);
            if (!parent) {
              parents.push({ ref, type: null, title: '(not cached)', state: 'open' });
              break;
            }
            parents.push({ ref: parent.ref, type: parent.type, title: parent.title, state: parent.state });
            ref = parent.parent;
          }
          const children = store.listIssues().filter((child) => child.parent === issue.ref).map(summary);
          const prs = store.prsForIssue(issue.ref);
          return { ...summary(issue), parents, children, prs, ci: ciRollup(prs) };
        }),
    );

    server.registerTool(
      'claim',
      {
        description: `Claim a Task for an agent. Renewing your own claim extends it. Claims expire after ${Math.round(claimTtlMs / 60_000)} minutes; fails naming the holder if another agent has it.`,
        inputSchema: taskSchemas.claim,
      },
      (args) =>
        runTool(() => {
          requireTask(args.task);
          return store.claim(args.task, args.agent, { ttlMs: claimTtlMs });
        }),
    );

    server.registerTool(
      'release',
      {
        description: 'Release your claim on a Task. Fails naming the holder if another agent has it.',
        inputSchema: taskSchemas.release,
      },
      (args) =>
        runTool(() => {
          requireTask(args.task);
          if (!store.release(args.task, args.agent)) throw new ToolError(`${args.task} has no claim`);
          return { task: args.task, released: true };
        }),
    );

    server.registerTool(
      'done',
      {
        description:
          'Signal that you finished a Task: releases your claim and records the done signal for the board. Local only; does not close the GitHub issue.',
        inputSchema: taskSchemas.done,
      },
      (args) =>
        runTool(() => {
          requireTask(args.task);
          return store.markDone(args.task, args.agent);
        }),
    );
  };
}

/** Worst state across PRs that still matter (open or merged). */
export function ciRollup(prs: readonly Pr[]): ChecksRollup {
  const states = new Set(prs.filter((pr) => pr.state !== 'closed').map((pr) => pr.checks));
  if (states.has('fail')) return 'fail';
  if (states.has('running')) return 'running';
  if (states.has('pass')) return 'pass';
  return 'none';
}

/** Run a tool body; known errors become `isError` results, unknown ones a generic message. */
export function runTool(body: () => unknown): CallToolResult {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(body(), null, 2) }] };
  } catch (err) {
    if (err instanceof ToolError || err instanceof ClaimConflictError || err instanceof StoreError || err instanceof RefError) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'internal error' }] };
  }
}

// ---------------------------------------------------------------------------
// HTTP: streamable HTTP on 127.0.0.1:<port>/mcp, stateless, bearer auth.
// ---------------------------------------------------------------------------

export class McpServerError extends Error {
  override name = 'McpServerError';
}

export interface McpServerOptions {
  port: number;
  /** Value of `mcp.token`. Never logged. */
  token: Secret;
  toolsets: readonly Toolset[];
  version?: string;
  /** Unexpected request/server errors. Never receives the token. */
  onError?: (error: unknown) => void;
}

export interface RunningMcpServer {
  /** Port actually bound (useful with port 0). */
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

/** DNS-rebinding guard: only `127.0.0.1:<port>` or `localhost:<port>`. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time bearer check: both sides hashed to equal-length buffers. */
function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const match = header ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header) : null;
  const given = digest(match?.[1] ?? '');
  // Compare even when absent so timing doesn't reveal which check failed.
  return timingSafeEqual(given, expected) && match !== null;
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: message }));
}

/** Start the MCP server on 127.0.0.1. Rejects with McpServerError if the port cannot be bound. */
export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const expected = digest(options.token.reveal());
  const onError = options.onError ?? (() => {});
  let port = options.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return reply(res, 403, 'forbidden');
    if (!isAllowedHost(req.headers.host, port)) return reply(res, 403, 'forbidden');
    if (!bearerMatches(req.headers.authorization, expected)) {
      return reply(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/mcp') return reply(res, 404, 'not found');
    if (req.method !== 'POST') return reply(res, 405, 'method not allowed', { allow: 'POST' });

    // Stateless: a fresh server + transport per request.
    const server = new McpServer({ name: 'orchid-board', version: options.version ?? '0.0.0' });
    for (const toolset of options.toolsets) toolset(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      onError(err);
      if (!res.headersSent) reply(res, 500, 'internal error');
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (err: NodeJS.ErrnoException) => {
      reject(new McpServerError(`cannot listen on 127.0.0.1:${options.port} (${err.code ?? 'error'})`));
    };
    http.once('error', fail);
    http.listen(options.port, '127.0.0.1', () => {
      http.off('error', fail);
      resolve();
    });
  });
  http.on('error', onError);
  port = (http.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      return closing;
    },
  };
}
