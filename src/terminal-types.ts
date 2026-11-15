export interface ProjectTerminal {
  id: string;
  sessionId: string;
  cwd: string;
  shell: string;
  running: boolean;
  exitCode: number | null;
}

export interface TerminalOutput extends ProjectTerminal {
  data: string;
  next: number;
  truncated: boolean;
}
