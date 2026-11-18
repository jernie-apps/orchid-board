import { z } from 'zod';
import { runTool, ToolError, type Toolset } from '../mcp/server.ts';
import { isRef } from '../store/ref.ts';
import type { ApproveResult } from '../store/store.ts';
import { proposeTree, resubmitTree, type ProposalDeps } from './tree.ts';

const proposal = z.string().trim().min(1);
const fields = {
  key: z.string().trim().min(1).optional(),
  type: z.enum(['Phase', 'Feature', 'Task']),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional(),
  iteration: z.string().nullable().optional(),
};
// Bound the schema depth even for invalid input. The board validates types relative to the actual parent.
const leaf = z.strictObject({ ...fields, children: z.tuple([], 'a Task cannot have child nodes').optional() });
const middle = z.strictObject({ ...fields, children: z.array(leaf).optional() });
const nodes = z.array(z.strictObject({ ...fields, children: z.array(middle).optional() })).min(1);

const codeErrors: Record<Extract<ApproveResult, { ok: false }>['reason'], string> = {
  missing: 'No approve code has been issued for this proposal. Ask Por for a fresh code.',
  wrong: 'Incorrect approve code.',
  expired: 'The approve code has expired. Ask Por for a fresh code.',
  used: 'The approve code has already been used.',
  locked: 'The approve code is locked after five incorrect attempts. Ask Por for a fresh code.',
};

export function proposalTools(deps: ProposalDeps): Toolset {
  const { store } = deps;
  return (server) => {
    server.registerTool('propose_tree', {
      description: 'Submit a nested Phase → Feature → Task draft for Por to review. Supply your agent name and optionally a cached Phase or Feature ref to attach below. Returns the proposal ID, node keys and branches.',
      inputSchema: z.strictObject({
        agent: z.string().trim().min(1).max(100),
        parent: z.string().refine(isRef, 'expected owner/name#number').nullable().optional(),
        nodes,
      }),
    }, input => runTool(() => proposeTree(deps, input)));

    server.registerTool('get_feedback', {
      description: "Get sent-back nodes and Por's review comments for a proposal.",
      inputSchema: z.strictObject({ proposal }),
      annotations: { readOnlyHint: true },
    }, input => runTool(() => {
      if (!store.getProposal(input.proposal)) throw new ToolError('Unknown proposal.');
      return store.getFeedback(input.proposal);
    }));

    server.registerTool('resubmit', {
      description: 'Replace sent-back nodes using their existing keys. Include each replacement subtree under children. Replacements return to draft for review.',
      inputSchema: z.strictObject({ proposal, nodes }),
    }, input => runTool(() => resubmitTree(deps, input.proposal, input.nodes)));

    server.registerTool('approve', {
      description: 'Approve the reviewed draft nodes using a one-time code from Por.',
      inputSchema: z.object({ proposal, code: z.string() }),
    }, input => runTool(() => {
      const result = store.approveProposal(input.proposal, input.code.trim());
      if (!result.ok) throw new ToolError(codeErrors[result.reason]);
      return { proposal: input.proposal, state: 'approved' };
    }));
  };
}
