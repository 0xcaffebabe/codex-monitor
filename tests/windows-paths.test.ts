import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsBundledCli } from '../server/windows-paths.js';

function findCli(env: NodeJS.ProcessEnv) {
  return windowsBundledCli(env, () => []);
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-windows-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (relative: string, modified = 100) => {
    const candidate = path.join(root, relative);
    mkdirSync(path.dirname(candidate), { recursive: true });
    writeFileSync(candidate, 'fixture executable, never launched');
    utimesSync(candidate, modified, modified);
    return candidate;
  };
  return { root, file };
}

test('Windows uses the configured desktop runtime before a different cached version', (t) => {
  const f = fixture(t);
  const desktop = f.file('custom/ChatGPT.exe');
  const cli = f.file('custom/resources/codex.exe');
  f.file('local/OpenAI/Codex/bin/new/codex.exe', 200);
  assert.equal(
    findCli({
      MONITOR_CODEX_DESKTOP: desktop,
      LOCALAPPDATA: path.join(f.root, 'local'),
    }),
    cli,
  );
});

test('Windows keeps cached CLI discovery and chooses the newest valid executable', (t) => {
  const f = fixture(t);
  f.file('local/OpenAI/Codex/bin/old/codex.exe');
  const cli = f.file('local/OpenAI/Codex/bin/new/codex.exe', 200);
  f.file('local/OpenAI/Codex/bin/incomplete/download.tmp', 300);
  mkdirSync(path.join(f.root, 'local/OpenAI/Codex/bin/not-a-file/codex.exe'), { recursive: true });
  assert.equal(findCli({ LOCALAPPDATA: path.join(f.root, 'local') }), cli);
});

test('Windows discovers the CLI in a standalone desktop installation without launching its GUI', (t) => {
  const f = fixture(t);
  f.file('local/Programs/Codex/ChatGPT.exe', 300);
  const cli = f.file('local/Programs/Codex/resources/codex.exe');
  f.file('local/OpenAI/Codex/bin/stale-cache/codex.exe', 400);
  assert.equal(findCli({ LOCALAPPDATA: path.join(f.root, 'local') }), cli);
});

test('Windows discovers Store runtimes while excluding other packages and GUI executables', (t) => {
  const f = fixture(t);
  f.file('programs/WindowsApps/OpenAI.Codex_old/app/resources/codex.exe');
  const cli = f.file('programs/WindowsApps/OpenAI.Codex_new/app/resources/codex.exe', 200);
  f.file('programs/WindowsApps/Other.Codex_new/app/resources/codex.exe', 300);
  f.file('programs/WindowsApps/OpenAI.Codex_gui/app/Codex.exe', 400);
  f.file('local/OpenAI/Codex/bin/stale-cache/codex.exe', 500);
  assert.equal(
    findCli({
      ProgramFiles: path.join(f.root, 'programs'),
      LOCALAPPDATA: path.join(f.root, 'local'),
    }),
    cli,
  );
});

test('Windows returns no CLI for missing or GUI-only installations', (t) => {
  const f = fixture(t);
  const desktop = f.file('custom/Codex.exe');
  assert.equal(
    findCli({
      MONITOR_CODEX_DESKTOP: desktop,
      LOCALAPPDATA: path.join(f.root, 'missing-local'),
      ProgramFiles: path.join(f.root, 'missing-programs'),
    }),
    undefined,
  );
  assert.equal(findCli({}), undefined);
});

test('Windows uses registered Store package metadata when WindowsApps cannot be enumerated', (t) => {
  const f = fixture(t);
  const cli = f.file('registered-package/app/resources/codex.exe');
  f.file('local/OpenAI/Codex/bin/stale-cache/codex.exe', 500);
  assert.equal(
    windowsBundledCli(
      {
        LOCALAPPDATA: path.join(f.root, 'local'),
        ProgramFiles: path.join(f.root, 'inaccessible-programs'),
      },
      () => [path.join(f.root, 'registered-package')],
    ),
    cli,
  );
});
