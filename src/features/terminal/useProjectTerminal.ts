import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, post } from '../../api';
import type { ProjectTerminal, TerminalOutput } from '../../terminal-types';
import { newRequestId } from '../control/request-id';

export function useProjectTerminal(sessionId: string) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<Terminal | undefined>(undefined);
  const write = useRef<(data: string) => void>(() => {});
  const [info, setInfo] = useState<ProjectTerminal>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'opening' | 'ready' | 'exited' | 'error'>('opening');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const id = newRequestId();
    const base = `/api/sessions/${sessionId}/terminal`;
    const url = `${base}/${id}`;
    let disposed = false,
      failed = false,
      cursor = 0,
      pending = '';
    let sending = false;
    let resizeQueue = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSize = '';
    const controller = new AbortController();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      screenReaderMode: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace',
      theme: {
        background: '#101a20',
        foreground: '#e0e9e8',
        cursor: '#7cd6ae',
        selectionBackground: '#366055',
      },
      disableStdin: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    screen.current = terminal;
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    const fitSize = () => {
      fit.fit();
      return {
        cols: Math.max(10, Math.min(500, terminal.cols)),
        rows: Math.max(2, Math.min(200, terminal.rows)),
      };
    };
    const stop = (reason: string) => {
      if (disposed || failed) return;
      failed = true;
      pending = '';
      terminal.options.disableStdin = true;
      setError(reason);
      setStatus('error');
    };
    const sendPending = async () => {
      if (sending || disposed || failed || !pending) return;
      sending = true;
      try {
        while (pending && !disposed && !failed) {
          const data = pending.slice(0, 16384);
          pending = pending.slice(data.length);
          // Input is never automatically retried: an uncertain request may have executed.
          await post(url + '/input', { data });
        }
      } catch (error) {
        stop(`${(error as Error).message} 输入可能已送达，请重新打开终端后检查执行结果。`);
      } finally {
        sending = false;
      }
    };
    write.current = (data) => {
      if (disposed || failed || terminal.options.disableStdin) return;
      if (pending.length + data.length > 64 * 1024) {
        stop('待发送的终端输入过多，请重新打开终端。');
        return;
      }
      pending += data;
      void sendPending();
    };
    const input = terminal.onData((data) => write.current(data));
    // Device-status replies (for example PowerShell's cursor query) must reach the shell.
    const binary = terminal.onBinary((data) => write.current(data));
    const close = () => api(url, { method: 'DELETE', keepalive: true }).catch(() => {});
    const poll = async () => {
      try {
        const output = await api<TerminalOutput>(url + `?after=${cursor}`, {
          signal: controller.signal,
        });
        if (disposed || failed) return;
        if (output.truncated) {
          terminal.reset();
          terminal.writeln('\x1b[33m[较早的输出已截断]\x1b[0m');
        }
        if (output.data) await new Promise<void>((resolve) => terminal.write(output.data, resolve));
        if (disposed || failed) return;
        cursor = output.next;
        if (!output.running) {
          // Drain all buffered output before showing the exit status.
          if (output.data.length >= 64 * 1024 - 1) {
            timer = setTimeout(() => void poll(), 0);
            return;
          }
          terminal.options.disableStdin = true;
          terminal.writeln(`\r\n[进程已退出，退出码 ${output.exitCode}]`);
          setInfo(output);
          setStatus('exited');
          return;
        }
        timer = setTimeout(() => void poll(), output.data ? 100 : 400);
      } catch (error) {
        if (!controller.signal.aborted) stop((error as Error).message);
      }
    };
    let ready = false;
    const resize = () => {
      const size = fitSize();
      const key = `${size.cols}:${size.rows}`;
      if (!ready || failed || key === lastSize) return;
      lastSize = key;
      resizeQueue = resizeQueue
        .then(async () => {
          if (!disposed && !failed) await post(url + '/resize', size);
        })
        .catch((error) => stop((error as Error).message));
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        resize();
      }, 100);
    });
    observer.observe(host.current!);
    setInfo(undefined);
    setError('');
    setStatus('opening');
    const initialSize = fitSize();
    lastSize = `${initialSize.cols}:${initialSize.rows}`;
    void post<ProjectTerminal>(base, { id, ...initialSize })
      .then(async (opened) => {
        if (disposed) {
          await close();
          return;
        }
        ready = true;
        setInfo(opened);
        setStatus('ready');
        terminal.options.disableStdin = false;
        resize();
        terminal.focus();
        void poll();
      })
      .catch((error) => stop((error as Error).message));
    const pageHide = () => {
      void close();
    };
    window.addEventListener('pagehide', pageHide);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener('pagehide', pageHide);
      input.dispose();
      binary.dispose();
      terminal.dispose();
      screen.current = undefined;
      write.current = () => {};
      if (ready) void close();
    };
  }, [sessionId, generation]);
  const send = useCallback((data: string) => write.current(data), []);
  const execute = useCallback((command: string) => {
    const terminal = screen.current;
    if (!terminal || terminal.options.disableStdin) return;
    terminal.paste(command);
    write.current('\r');
  }, []);
  const clear = useCallback(() => screen.current?.clear(), []);
  return {
    host,
    info,
    status,
    error,
    send,
    execute,
    clear,
    restart: () => setGeneration((value) => value + 1),
  };
}
