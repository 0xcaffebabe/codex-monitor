export type SessionFileLink = {
  id: string;
  offset: number;
  path: string;
  line?: number;
  endLine?: number;
};

export type SessionFilePreview = {
  name: string;
  path: string;
  size: number;
} & (
  | { kind: 'image' | 'download' }
  | {
      kind: 'text' | 'markdown';
      lines: string[];
      startLine: number;
      line?: number;
      endLine?: number;
      partial: boolean;
    }
);
