import { randomInt } from 'node:crypto';
import { StoreError, underReview, type Store } from '../store/store.ts';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const TTL_MS = 15 * 60_000;

/** Issue a fresh code for Por. Only the web inbox and local CLI should display it. */
export function issueApproveCode(store: Store, proposalId: string, now = new Date()): string {
  return store.transaction(() => {
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new StoreError('unknown proposal');
    // Approved proposals qualify only while Por still holds withheld draft items for review.
    if (!underReview(proposal)) throw new StoreError('only pending proposals or withheld draft items can receive an approve code');
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
    store.saveApproveCode(proposalId, code, new Date(now.getTime() + TTL_MS), now);
    return code;
  });
}
