export type GitScope = 'all' | 'unstaged' | 'staged';

export type GitFile = {
  path: string;
  previousPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type GitStatus = {
  root: string;
  branch: string;
  head: string | null;
  scope: GitScope;
  files: GitFile[];
};

export type GitFileDiff = {
  file: GitFile;
  patch: string;
  binary: boolean;
  truncated: boolean;
};
