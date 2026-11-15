import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Keep the native PTY and its platform handles inside a disposable process. */
export function createTerminalProcess(
  options: { cwd: string; cols: number; rows: number },
  onData: (data: string) => void,
  onExit: (code: number) => void,
) {
  const child = fork(fileURLToPath(new URL('./terminal-worker.mjs', import.meta.url)), [], {
    execArgv: [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  let exited = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Terminal startup timed out'));
      child.kill();
    }, 10000);
    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      clearTimeout(timeout);
      reject(new Error('Terminal process exited'));
      onExit(code);
    };
    child.on('message', (message: { type: string; data?: string; code?: number }) => {
      if (message.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      } else if (message.type === 'data' && typeof message.data === 'string') onData(message.data);
      else if (message.type === 'exit') finish(message.code ?? -1);
    });
    child.once('error', () => finish(-1));
    child.once('exit', (code) => {
      clearTimeout(force);
      finish(code ?? -1);
    });
  });
  const send = (message: object) => {
    if (!child.connected) return false;
    child.send(message, () => {});
    return true;
  };
  send({ type: 'open', ...options });
  return {
    ready,
    write: (data: string) => send({ type: 'input', data }),
    resize: (cols: number, rows: number) => send({ type: 'resize', cols, rows }),
    kill: () => {
      send({ type: 'close' });
      force ??= setTimeout(() => child.kill(), 3000);
      force.unref();
    },
  };
}
