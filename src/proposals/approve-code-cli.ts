import { boardHome } from '../config.ts';
import { dbPath } from '../store/db.ts';
import { openStore, StoreError } from '../store/store.ts';
import { issueApproveCode } from './approve-code.ts';

function main(args: string[]): void {
  const [id] = args;
  if (args.length !== 1 || !id) throw new StoreError('usage: npm run approve-code -- <proposalId>');
  const store = openStore(dbPath(boardHome()));
  try {
    console.log(issueApproveCode(store, id));
  } finally {
    store.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error('orchid-board: ' + (error instanceof StoreError ? error.message : 'could not issue an approve code'));
  process.exitCode = 1;
}
