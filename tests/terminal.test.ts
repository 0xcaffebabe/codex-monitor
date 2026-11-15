import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';
import type { TerminalOutput } from '../src/terminal-types.js';

const windows = process.platform === 'win32';
const { Terminal } = headless;
const quote = (value: string) => "'" + value.replaceAll("'", windows ? "''" : "'\\''") + "'";
const readProcessId = (file: string) => {
  if (!existsSync(file)) return 0;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
};

async function terminalFixture() {
  const f = fixture();
  const cwd = path.join(f.root, '项目 with spaces');
  mkdirSync(path.join(cwd, 'child'), { recursive: true });
  f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(cwd, ids.modern);
  f.state
    .prepare('UPDATE threads SET cwd=? WHERE id=?')
    .run(path.join(f.root, 'missing'), ids.legacy);
  const service = createApp(f.config, { control: new FixtureDesktop(f) });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'terminal-test-password!');
  const token = service.auth.issue(owner, 'terminal test').token;
  const request = (route: string, method = 'GET', body?: unknown, bearer = token) =>
    fetch(url + route, {
      method,
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  const id = randomUUID(),
    base = `/api/sessions/${ids.modern}/terminal`,
    endpoint = `${base}/${id}`;
  let cursor = 0,
    output = '';
  const screen = new Terminal({ cols: 100, rows: 30, scrollback: 7000, allowProposedApi: true });
  let replies = Promise.resolve();
  const input = async (data: string) => {
    const response = await request(endpoint + '/input', 'POST', { data });
    assert.equal(response.status, 204, await response.text());
  };
  screen.onData((data) => {
    replies = replies.then(() => input(data));
  });
  const read = async () => {
    const response = await request(endpoint + `?after=${cursor}`);
    assert.equal(response.status, 200);
    const result = (await response.json()) as TerminalOutput;
    cursor = result.next;
    if (result.truncated) screen.reset();
    await new Promise<void>((resolve) => screen.write(result.data, resolve));
    await replies;
    output = '';
    const buffer = screen.buffer.active;
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)!;
      output += (line.isWrapped ? '' : '\n') + line.translateToString(true);
    }
    return result;
  };
  const until = async (predicate: () => boolean, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await read();
      if (predicate()) return output;
      await delay(50);
    }
    assert.fail('Terminal output timed out: ' + output.slice(-3000));
  };
  const open = async () => {
    const response = await request(base, 'POST', { id, cols: 100, rows: 30 });
    assert.equal(response.status, 201, await response.clone().text());
    // Readiness comes from an actual round trip, independent of shell prompt/theme.
    await input(
      windows
        ? "Write-Output ('PTY_'+'READY')\r"
        : "export PS1='CM_TEST_PROMPT> '; printf 'PTY_%s\\n' READY\r",
    );
    await until(() => output.includes('PTY_READY'));
    return response.json();
  };
  return {
    f,
    cwd,
    service,
    owner,
    token,
    request,
    id,
    base,
    endpoint,
    open,
    input,
    until,
    read,
    screen,
    output: () => output,
    async close() {
      screen.dispose();
      await replies.catch(() => {});
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      // ConPTY finishes draining asynchronously after the shell exits.
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(f.root, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 40) throw error;
          await delay(100);
        }
      }
    },
  };
}

test(
  'project terminal runs a real persistent shell, streams Unicode, resizes, interrupts, and exits',
  { timeout: 45000 },
  async () => {
    const f = await terminalFixture();
    try {
      const opened = await f.open();
      assert.equal(opened.cwd, f.cwd);
      const duplicate = await f.request(f.base, 'POST', { id: f.id, cols: 80, rows: 24 });
      assert.equal((await duplicate.json()).id, f.id);
      await f.input(
        windows
          ? "$env:PTY_VALUE='中文'; Set-Location child\r"
          : "export PTY_VALUE='中文'; cd child\r",
      );
      await f.input(
        windows
          ? "Write-Output ('VALUE_' + $env:PTY_VALUE); Write-Output ('DIR_' + (Get-Location).Path)\r"
          : 'printf \'VALUE_%s\\nDIR_%s\\n\' "$PTY_VALUE" "$PWD"\r',
      );
      await f.until(
        () =>
          f.output().includes('VALUE_中文') &&
          f.output().includes('DIR_' + path.join(f.cwd, 'child')),
      );
      f.screen.resize(70, 20);
      assert.equal(
        (await f.request(f.endpoint + '/resize', 'POST', { cols: 70, rows: 20 })).status,
        204,
      );
      await f.input(
        windows
          ? "Write-Output ('STREAM_'+'BEGIN'); Start-Sleep 30; Write-Output ('SHOULD_'+'NOT_RUN')\r"
          : "printf 'STREAM_%s\\n' BEGIN; sleep 30; printf 'SHOULD_%s\\n' NOT_RUN\r",
      );
      await f.until(() => f.output().includes('STREAM_BEGIN'));
      await f.input('\x03');
      await f.until(() =>
        windows
          ? /STREAM_BEGIN[\s\S]*PS /.test(f.output())
          : /STREAM_BEGIN[\s\S]*CM_TEST_PROMPT> /.test(f.output()),
      );
      await f.input(
        windows ? "Write-Output ('INTERRUPT_'+'READY')\r" : "printf 'INTERRUPT_%s\\n' READY\r",
      );
      await f.until(() => f.output().includes('INTERRUPT_READY'));
      await f.input(
        windows ? "Write-Output ('AFTER_'+'INTERRUPT')\r" : "printf 'AFTER_%s\\n' INTERRUPT\r",
      );
      await f.until(() => f.output().includes('AFTER_INTERRUPT'));
      assert.ok(!f.output().includes('SHOULD_NOT_RUN'));
      await f.input('exit 7\r');
      let result: TerminalOutput;
      const exitDeadline = Date.now() + 10000;
      do {
        result = await f.read();
        if (result.running) await delay(50);
      } while (result.running && Date.now() < exitDeadline);
      assert.equal(result.running, false);
      assert.equal(result.exitCode, 7);
      assert.equal(
        (await f.request(f.endpoint + '/input', 'POST', { data: 'echo ignored\r' })).status,
        409,
      );
      assert.equal((await f.request(f.endpoint, 'DELETE')).status, 204);
      assert.equal((await f.request(f.endpoint + '?after=0')).status, 404);
    } finally {
      await f.close();
    }
  },
);

test(
  'macOS terminals choose UTF-8 when no locale is inherited',
  { skip: process.platform !== 'darwin' },
  async () => {
    const names = ['LANG', 'LC_ALL', 'LC_CTYPE'];
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) delete process.env[name];
    const f = await terminalFixture();
    try {
      await f.open();
      await f.input("printf 'LOCALE_%s\\n' \"$LANG\"; printf '中文终端\\n'\r");
      await f.until(
        () => f.output().includes('LOCALE_en_US.UTF-8') && f.output().includes('中文终端'),
      );
      assert.equal(
        f.output().includes('\ufffd'),
        false,
        'UTF-8 input echo must not contain replacement characters',
      );
    } finally {
      await f.close();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

test(
  'terminal API enforces device ownership, roles, trusted project paths, and revoked access',
  { timeout: 30000 },
  async () => {
    const f = await terminalFixture();
    try {
      const body = { id: f.id, cols: 80, rows: 24 };
      assert.equal((await f.request(f.base, 'POST', body, '')).status, 401);
      assert.equal(
        (
          await f.request('/api/users', 'POST', {
            username: 'viewer',
            password: 'viewer-terminal-password!',
            role: 'viewer',
          })
        ).status,
        201,
      );
      const viewer = (await f.service.auth.login('viewer', 'viewer-terminal-password!'))!;
      const viewerToken = f.service.auth.issue(viewer, 'viewer').token;
      assert.equal((await f.request(f.base, 'POST', body, viewerToken)).status, 403);
      assert.equal((await f.request(f.base, 'POST', { ...body, cwd: f.cwd })).status, 400);
      assert.equal((await f.request(f.base, 'POST', { ...body, shell: 'arbitrary' })).status, 400);
      assert.equal((await f.request(f.base, 'POST', { ...body, cols: 0 })).status, 400);
      assert.equal(
        (await f.request(`/api/sessions/${randomUUID()}/terminal`, 'POST', body)).status,
        404,
      );
      assert.equal(
        (await f.request(`/api/sessions/${ids.legacy}/terminal`, 'POST', body)).status,
        409,
      );
      await f.open();
      const otherDevice = f.service.auth.issue(f.owner, 'other device').token;
      for (const route of [
        f.endpoint + '?after=0',
        f.endpoint + '/input',
        f.endpoint + '/resize',
        f.endpoint,
      ]) {
        const method =
          route.includes('/input') || route.includes('/resize')
            ? 'POST'
            : route.includes('?')
              ? 'GET'
              : 'DELETE';
        assert.equal(
          (
            await f.request(
              route,
              method,
              method === 'POST' ? { data: 'echo forbidden\r' } : undefined,
              viewerToken,
            )
          ).status,
          403,
        );
        const body = route.includes('/input')
          ? { data: 'echo forbidden\r' }
          : route.includes('/resize')
            ? { cols: 80, rows: 24 }
            : undefined;
        assert.equal((await f.request(route, method, body, otherDevice)).status, 404);
      }
      assert.equal(
        (await f.request(f.endpoint + '/input', 'POST', { data: 'x'.repeat(16385) })).status,
        400,
      );
      assert.equal((await f.request(f.endpoint + '?after=-1')).status, 400);
      // Process cleanup is observable independently of authorization middleware.
      const pidFile = path.join(f.cwd, 'shell.pid');
      await f.input(
        windows
          ? `[IO.File]::WriteAllText(${quote(pidFile)}, [string]$PID)\r`
          : `echo $$ > '${pidFile.replaceAll("'", "'\\''")}'\r`,
      );
      // Redirection creates the file before writing its PID. An empty read is 0,
      // which makes process.kill(0, 0) check the test's whole process group.
      await f.until(() => readProcessId(pidFile) > 0);
      const pid = readProcessId(pidFile);
      f.service.auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.owner.id);
      const deadline = Date.now() + 8000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(50);
      }
      assert.equal(alive, false, 'revoking login must terminate the shell');
    } finally {
      await f.close();
    }
  },
);

test(
  'closing the workspace terminates a terminal and its child process',
  { timeout: 45000 },
  async () => {
    const f = await terminalFixture();
    try {
      await f.open();
      const pidFile = path.join(f.cwd, 'child.pid');
      const program = `eval(Buffer.from('${Buffer.from(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`).toString('base64')}','base64').toString())`;
      const command = windows
        ? `& ${quote(process.execPath)} -e ${quote(program)}\r`
        : `${quote(process.execPath)} -e ${quote(program)}\r`;
      await f.input(command);
      await f.until(() => readProcessId(pidFile) > 0);
      const pid = readProcessId(pidFile);
      f.service.terminals.closeAll();
      const deadline = Date.now() + 8000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(50);
      }
      assert.equal(alive, false, 'workspace disconnect must terminate child processes');
    } finally {
      await f.close();
    }
  },
);

test(
  'large terminal output is bounded and reports a cursor gap instead of retaining unlimited data',
  { timeout: 45000 },
  async () => {
    const f = await terminalFixture();
    try {
      await f.open();
      await f.input(
        windows
          ? "[Console]::Write(('x' * 350000)); Write-Output ('OUTPUT_'+'END')\r"
          : "head -c 350000 /dev/zero | tr '\\0' x; printf 'OUTPUT_%s\\n' END\r",
      );
      await f.until(() => f.output().includes('OUTPUT_END'), 30000);
      const response = await f.request(f.endpoint + '?after=0');
      const result = (await response.json()) as TerminalOutput;
      assert.equal(result.truncated, true);
      assert.ok(result.data.length <= 64 * 1024);
      assert.ok(result.next > result.data.length);
      assert.equal((await f.request(f.endpoint + '?after=9007199254740991')).status, 400);
    } finally {
      await f.close();
    }
  },
);
