import { spawn } from 'node-pty';
import path from 'node:path';

let terminal;
let closing = false;
let pending = 0;
const send = (message, callback = () => {}) => {
  if (!process.connected) return false;
  return process.send(message, callback);
};
const close = () => {
  if (closing) return;
  closing = true;
  try {
    terminal?.kill();
  } catch {
    /* The shell may have already exited. */
  }
  // A native ConPTY worker may retain handles after exit. The process owns them all.
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('disconnect', close);
process.on('SIGTERM', close);
process.on('message', (message) => {
  try {
    if (message.type === 'open' && !terminal && !closing) {
      const windows = process.platform === 'win32';
      const shell = windows
        ? path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          )
        : process.env.SHELL || '/bin/bash';
      terminal = spawn(shell, windows ? ['-NoLogo', '-NoProfile', '-NoExit'] : ['-i'], {
        name: 'xterm-256color',
        cwd: message.cwd,
        cols: message.cols,
        rows: message.rows,
        env: process.env,
      });
      terminal.onData((data) => {
        if (closing) return;
        pending++;
        const available = send({ type: 'data', data }, () => {
          pending--;
          if (!closing && pending === 0) terminal.resume();
        });
        if (!available) terminal.pause();
      });
      terminal.onExit(({ exitCode }) => {
        send({ type: 'exit', code: exitCode }, close);
      });
      send({ type: 'ready' });
    } else if (message.type === 'input' && !closing) terminal?.write(message.data);
    else if (message.type === 'resize' && !closing) terminal?.resize(message.cols, message.rows);
    else if (message.type === 'close') close();
  } catch {
    send({ type: 'exit', code: -1 }, close);
  }
});
