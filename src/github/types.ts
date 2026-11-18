export type IssueRef = `${string}/${string}#${number}`;
export type IssueType = 'Phase' | 'Feature' | 'Task';
export type CheckStatus = 'pass' | 'fail' | 'running' | 'none';

export interface Iteration {
  title: string;
  iterationId: string;
}

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checkStatus: CheckStatus;
}

export interface Issue {
  ref: IssueRef;
  number: number;
  nodeId: string;
  title: string;
  state: 'open' | 'closed';
  updatedAt: string;
  issueType: IssueType | null;
  parentRef: IssueRef | null;
  subIssueRefs: IssueRef[];
  iteration: Iteration | null;
  pullRequests: PullRequest[];
}
