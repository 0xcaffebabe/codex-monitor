export type ProjectFileEntry = {
  name: string;
  /** Path relative to the project, with forward slashes on every platform. */
  path: string;
  type: 'directory' | 'file';
};

export type ProjectFileListing = {
  root: string;
  directory: string;
  entries: ProjectFileEntry[];
  truncated: boolean;
  incomplete: boolean;
};
