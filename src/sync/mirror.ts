import { isDeepStrictEqual } from 'node:util';
import type { Issue, PullRequest, RepoPullRequest } from '../github/types.ts';
import { formatRef, parseRef } from '../store/ref.ts';
import type { Pr, Store } from '../store/store.ts';

export interface SyncChange {
  repo: string;
  issues: string[];
  prs: string[];
}

const FIRST_UPDATE = '1970-01-01T00:00:00Z';

interface RepoSnapshot {
  repo: string;
  cursorKey: string;
  since: string | null;
  issues: readonly Issue[];
  refreshedPrs: ReadonlyMap<string, readonly PullRequest[]>;
  prCursorKey: string;
  prSince: string | null;
  prs: readonly RepoPullRequest[];
}

/** Apply a complete repo response and advance both cursors in the same transaction. */
export function mirrorRepo(store: Store, snapshot: RepoSnapshot): SyncChange {
  const { repo, cursorKey, since, issues, refreshedPrs, prCursorKey, prSince, prs } = snapshot;
  return store.transaction(() => {
    const cached = store.listIssues();
    const byNode = new Map(cached.map(issue => [issue.nodeId, issue]));
    const byRef = new Map(cached.map(issue => [issue.ref, issue]));
    const returned = new Set<string>(issues.map(issue => issue.ref));
    const links = new Map<string, readonly PullRequest[]>(issues.map(issue => [issue.ref, issue.pullRequests]));
    const canonicalRefs = new Map(cached.map(issue => [issue.ref.toLowerCase(), issue.ref]));
    const removedRefs = new Set<string>();
    const touched = new Set<string>();

    const remove = (ref: string) => {
      if (store.deleteIssue(ref)) touched.add(ref);
      canonicalRefs.delete(ref.toLowerCase());
      removedRefs.add(ref.toLowerCase());
      links.set(ref, []);
    };
    for (const issue of cached) {
      if (issue.repo.toLowerCase() !== repo || returned.has(issue.ref)) continue;
      if (since === null) {
        remove(issue.ref);
      } else {
        const prs = refreshedPrs.get(issue.nodeId);
        if (prs) links.set(issue.ref, prs);
      }
    }

    for (const issue of issues) {
      const oldRef = byNode.get(issue.nodeId)?.ref;
      if (oldRef && oldRef !== issue.ref) remove(oldRef);
      const input = {
        ...parseRef(issue.ref),
        ref: issue.ref,
        nodeId: issue.nodeId,
        title: issue.title,
        type: issue.issueType,
        state: issue.state,
        parent: issue.parentRef,
        iteration: issue.iteration ? { id: issue.iteration.iterationId, title: issue.iteration.title } : null,
        updatedAt: issue.updatedAt,
      };
      if (!isDeepStrictEqual(byRef.get(issue.ref), input)) {
        store.upsertIssue(input);
        touched.add(issue.ref);
      }
      canonicalRefs.set(issue.ref.toLowerCase(), issue.ref);
      removedRefs.delete(issue.ref.toLowerCase());
    }

    const normalize = (refs: readonly string[]) => [...new Set(refs
      .map(ref => ref.toLowerCase())
      .filter(ref => !removedRefs.has(ref))
      .map(ref => canonicalRefs.get(ref) ?? ref))].sort();
    const touchedPrs = mirrorPullRequests(store, links, prs, prSince === null ? repo : null, normalize, touched);
    advanceCursor(store, cursorKey, since, issues);
    advanceCursor(store, prCursorKey, prSince, prs);
    return { repo, issues: [...touched].sort(), prs: touchedPrs.sort() };
  });
}

function advanceCursor(store: Store, key: string, since: string | null, items: readonly { updatedAt: string }[]): void {
  let cursor = since ?? FIRST_UPDATE;
  for (const item of items) {
    if (Date.parse(item.updatedAt) > Date.parse(cursor)) cursor = item.updatedAt;
  }
  if (cursor !== since) store.setMeta(key, cursor);
}

function mirrorPullRequests(
  store: Store,
  snapshots: ReadonlyMap<string, readonly PullRequest[]>,
  repoPrs: readonly RepoPullRequest[],
  fullRepo: string | null,
  normalize: (refs: readonly string[]) => string[],
  touchedIssues: Set<string>,
): string[] {
  const reported = new Map<string, { pr: PullRequest; issues: string[] }>();
  for (const [issue, prs] of snapshots) {
    for (const pr of prs) {
      const ref = pullRequestRef(pr);
      const previous = reported.get(ref);
      const issues = previous?.issues ?? [];
      issues.push(issue);
      reported.set(ref, { pr: newer(pr, previous?.pr), issues });
    }
  }

  const listed = new Map(repoPrs.map(pr => [pullRequestRef(pr), pr]));
  const cached = new Map(store.listPrsWithLinks().map(entry => [entry.pr.ref, entry]));
  const refreshed = new Set([...snapshots.keys()].map(ref => ref.toLowerCase()));
  const touchedPrs: string[] = [];
  for (const ref of new Set([...cached.keys(), ...reported.keys(), ...listed.keys()])) {
    const old = cached.get(ref);
    const repoPr = listed.get(ref);
    const issuePr = reported.get(ref);
    // A repo PR response replaces that PR's links. Issue-only responses cover just the refreshed issues.
    const retainedGithub = old?.githubIssues.filter(issue => !refreshed.has(issue.toLowerCase())) ?? [];
    const retainedBody = old?.pr.repo.toLowerCase() === fullRepo ? [] : old?.bodyIssues ?? [];
    const githubIssues = normalize([...(repoPr?.githubIssueRefs ?? retainedGithub), ...(issuePr?.issues ?? [])]);
    const bodyIssues = normalize(repoPr?.bodyIssueRefs ?? retainedBody);
    const issues = [...new Set([...githubIssues, ...bodyIssues])].sort();

    if (issues.length === 0) {
      if (!old) continue;
      store.deletePr(ref);
    } else {
      const latest = repoPr ? newer(repoPr, issuePr?.pr) : issuePr?.pr;
      const next = latest && (!old || Date.parse(latest.updatedAt) >= Date.parse(old.pr.updatedAt))
        ? toPr(ref, latest, issues)
        : old && { ...old.pr, issues };
      if (!next) throw new Error('Missing pull request details for the mirrored links');
      const changed = !isDeepStrictEqual(next, old?.pr);
      if (changed || !isDeepStrictEqual(githubIssues, old?.githubIssues) || !isDeepStrictEqual(bodyIssues, old?.bodyIssues)) {
        store.upsertPr({ ...next, issues: githubIssues }, bodyIssues);
      }
      if (!changed) continue;
    }
    touchedPrs.push(ref);
    for (const issue of [...(old?.pr.issues ?? []), ...issues]) touchedIssues.add(issue);
  }
  return touchedPrs;
}

function pullRequestRef(pr: PullRequest): string {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/.exec(pr.url);
  if (!repo || Number(repo[2]) !== pr.number) throw new Error('GitHub returned an invalid pull request URL');
  return formatRef(repo[1]!, pr.number);
}

function newer(pr: PullRequest, other: PullRequest | undefined): PullRequest {
  return !other || Date.parse(pr.updatedAt) >= Date.parse(other.updatedAt) ? pr : other;
}

function toPr(ref: string, pr: PullRequest, issues: string[]): Pr {
  return {
    ...parseRef(ref), ref, url: pr.url, title: pr.title, state: pr.state, draft: pr.draft,
    updatedAt: pr.updatedAt, checks: pr.checkStatus, issues,
  };
}
