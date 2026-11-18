import { EventEmitter } from 'node:events';
import type { ProjectRef, RepoRef } from '../config.ts';
import { GitHubClient, GitHubError } from '../github/client.ts';
import { listIssuePullRequests, listIssues } from '../github/queries.ts';
import type { Issue, PullRequest } from '../github/types.ts';
import type { Secret } from '../secrets.ts';
import type { Store } from '../store/store.ts';
import { mirrorRepo, type SyncChange } from './mirror.ts';

interface SyncClient {
  listIssues(options: { since: string | null; project: ProjectRef | null }): Promise<readonly Issue[]>;
  listIssuePullRequests(nodeIds: readonly string[]): Promise<ReadonlyMap<string, readonly PullRequest[]>>;
}

interface PollerOptions {
  store: Store;
  repos: readonly RepoRef[];
  project?: ProjectRef | null;
  pollSeconds: number;
  createClient: (repo: RepoRef, signal: AbortSignal) => SyncClient;
  onError?: (repo: string, error: unknown) => void;
  now?: () => number;
}

interface RepoPoll {
  name: string;
  cursorKey: string;
  client: SyncClient;
  full: boolean;
  retryAt: number;
  active?: Promise<void>;
}

export function createGitHubPoller({ token, ...options }: Omit<PollerOptions, 'createClient'> & { token: Secret }): Poller {
  return new Poller({
    ...options,
    createClient: (repo, signal) => {
      const client = new GitHubClient(token, { signal });
      return {
        listIssues: options => listIssues(client, repo, options),
        listIssuePullRequests: nodeIds => listIssuePullRequests(client, nodeIds),
      };
    },
  });
}

export class Poller {
  readonly events = new EventEmitter<{ change: [SyncChange] }>();
  readonly #options: PollerOptions;
  readonly #repos = new Map<string, RepoPoll>();
  readonly #stop = new AbortController();
  readonly #now: () => number;
  #timer?: NodeJS.Timeout;

  constructor(options: PollerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    for (const repo of options.repos) {
      const name = `${repo.owner}/${repo.name}`.toLowerCase();
      if (this.#repos.has(name)) continue;
      this.#repos.set(name, {
        name,
        cursorKey: `sync:since:${name}`,
        client: options.createClient(repo, this.#stop.signal),
        full: true,
        retryAt: 0,
      });
    }
  }

  start(): void {
    if (this.#timer || this.#stop.signal.aborted) return;
    this.#timer = setInterval(() => void this.pollOnce(), this.#options.pollSeconds * 1_000);
    void this.pollOnce();
  }

  /** Cancel GitHub requests and wait for all repo polls before the store is closed. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#stop.abort();
    await Promise.all([...this.#repos.values()].map(repo => repo.active));
  }

  async pollOnce(): Promise<void> {
    if (this.#stop.signal.aborted) return;
    const active: Promise<void>[] = [];
    for (const repo of this.#repos.values()) {
      if (!repo.active && this.#now() >= repo.retryAt) {
        repo.active = this.#pollRepo(repo).finally(() => { repo.active = undefined; });
      }
      if (repo.active) active.push(repo.active);
    }
    await Promise.all(active);
  }

  async #pollRepo(repo: RepoPoll): Promise<void> {
    const { store, project = null, onError } = this.#options;
    try {
      const since = repo.full ? null : store.getMeta(repo.cursorKey);
      const issues = await repo.client.listIssues({ since, project });
      if (this.#stop.signal.aborted) return;
      let refreshedPrs: ReadonlyMap<string, readonly PullRequest[]> = new Map();
      if (since !== null) {
        // PR/CI changes don't bump an issue's updatedAt, so re-check unchanged issues.
        // Open issues only: closing an issue bumps updatedAt, and refreshing every closed
        // issue each poll would burn the GraphQL budget across many repos.
        const returned = new Set(issues.map(issue => issue.nodeId));
        const remaining = store.listIssues()
          .filter(issue => issue.repo.toLowerCase() === repo.name && issue.state === 'open' && !returned.has(issue.nodeId))
          .map(issue => issue.nodeId);
        if (remaining.length) refreshedPrs = await repo.client.listIssuePullRequests(remaining);
      }
      if (this.#stop.signal.aborted) return;

      const change = mirrorRepo(store, repo.name, repo.cursorKey, since, issues, refreshedPrs);
      repo.full = false;
      if (change.issues.length || change.prs.length) this.events.emit('change', change);
    } catch (error) {
      if (this.#stop.signal.aborted) return;
      if (error instanceof GitHubError && error.retryAfterMs !== undefined) {
        repo.retryAt = this.#now() + error.retryAfterMs;
      }
      onError?.(repo.name, error);
    }
  }
}
