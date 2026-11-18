import { isDeepStrictEqual } from 'node:util';
import type { Issue, PullRequest } from '../github/types.ts';
import { formatRef, parseRef } from '../store/ref.ts';
import type { Pr, Store } from '../store/store.ts';

export interface SyncChange {
  repo: string;
  issues: string[];
  prs: string[];
}

const FIRST_UPDATE = '1970-01-01T00:00:00Z';

/** Apply a complete repo response and its cursor together. */
export function mirrorRepo(
  store: Store,
  repo: string,
  cursorKey: string,
  since: string | null,
  issues: readonly Issue[],
  refreshedPrs: ReadonlyMap<string, readonly PullRequest[]>,
): SyncChange {
  return store.transaction(() => {
    const cached = store.listIssues();
    const byNode = new Map(cached.map(issue => [issue.nodeId, issue]));
    const byRef = new Map(cached.map(issue => [issue.ref, issue]));
    const returned = new Set<string>(issues.map(issue => issue.ref));
    const links = new Map<string, readonly PullRequest[]>(issues.map(issue => [issue.ref, issue.pullRequests]));
    const touched = new Set<string>();

    const remove = (ref: string) => {
      if (store.deleteIssue(ref)) touched.add(ref);
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

    let cursor = since ?? FIRST_UPDATE;
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
      if (Date.parse(issue.updatedAt) > Date.parse(cursor)) cursor = issue.updatedAt;
    }

    const prs = mirrorPullRequests(store, links, touched);
    if (cursor !== since) store.setMeta(cursorKey, cursor);
    return { repo, issues: [...touched].sort(), prs: prs.sort() };
  });
}

function mirrorPullRequests(
  store: Store,
  snapshots: ReadonlyMap<string, readonly PullRequest[]>,
  touchedIssues: Set<string>,
): string[] {
  const incoming = new Map<string, Pr>();
  for (const [issue, prs] of snapshots) {
    for (const pr of prs) {
      const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/.exec(pr.url);
      if (!repo || Number(repo[2]) !== pr.number) throw new Error('GitHub returned an invalid pull request URL');
      const ref = formatRef(repo[1]!, pr.number);
      const previous = incoming.get(ref);
      const issues = previous?.issues ?? [];
      issues.push(issue);
      if (!previous || Date.parse(pr.updatedAt) >= Date.parse(previous.updatedAt)) {
        incoming.set(ref, {
          ...parseRef(ref),
          ref,
          url: pr.url,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          updatedAt: pr.updatedAt,
          checks: pr.checkStatus,
          issues,
        });
      }
    }
  }

  const touchedPrs: string[] = [];
  for (const cached of store.listPrs()) {
    const latest = incoming.get(cached.ref);
    const retained = cached.issues.filter(issue => !snapshots.has(issue));
    if (!latest && retained.length === cached.issues.length) continue;
    incoming.delete(cached.ref);

    // Replace links for refreshed issues only. Another repo may still link this PR.
    const issues = [...new Set([...retained, ...(latest?.issues ?? [])])].sort();
    const details = latest && Date.parse(latest.updatedAt) >= Date.parse(cached.updatedAt) ? latest : cached;
    const next = { ...details, issues };
    if (isDeepStrictEqual(cached, next)) continue;
    if (issues.length === 0) store.deletePr(cached.ref);
    else store.upsertPr(next);
    touchedPrs.push(cached.ref);
    for (const issue of [...cached.issues, ...issues]) touchedIssues.add(issue);
  }
  for (const pr of incoming.values()) {
    store.upsertPr({ ...pr, issues: [...new Set(pr.issues)].sort() });
    touchedPrs.push(pr.ref);
    for (const issue of pr.issues) touchedIssues.add(issue);
  }
  return touchedPrs;
}
