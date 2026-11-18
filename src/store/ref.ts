/**
 * Canonical issue / PR reference: `owner/name#number`, e.g. `companie-apps/orchid-board#7`.
 * Every module passes refs as this string; the store keys rows by (repo, number).
 */
export interface IssueRef {
  /** `owner/name` */
  repo: string;
  number: number;
}

export class RefError extends Error {
  override name = 'RefError';
}

const REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRef(ref: string): IssueRef {
  const match = REF.exec(ref);
  if (!match) throw new RefError(`invalid ref "${ref}": expected owner/name#number`);
  return { repo: match[1]!, number: Number(match[2]) };
}

export function formatRef(repo: string, number: number): string {
  if (!REPO.test(repo)) throw new RefError(`invalid repo "${repo}": expected owner/name`);
  if (!Number.isInteger(number) || number < 1) throw new RefError(`invalid issue number ${number}`);
  return `${repo}#${number}`;
}

export function isRef(value: string): boolean {
  return REF.test(value);
}
