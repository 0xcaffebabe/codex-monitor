import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function registeredStorePackages(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  if (process.platform !== 'win32') return [];
  try {
    // WindowsApps usually denies directory enumeration. Package metadata still
    // gives this user's exact, readable installation path.
    const { stdout } = await execute(
      path.join(
        env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' +
          'Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | ' +
          'Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, signal },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => path.isAbsolute(line));
  } catch {
    return [];
  }
}

function children(directory: string) {
  return readdir(directory).catch(() => []);
}

async function isFile(file: string) {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

async function newestCli(candidates: string[]) {
  const files = await Promise.all(
    candidates.map(async (candidate) => {
      const info = await stat(candidate).catch(() => undefined);
      return info?.isFile() ? { candidate, modified: info.mtimeMs } : undefined;
    }),
  );
  return files.filter((file) => file !== undefined).sort((a, b) => b.modified - a.modified)[0]
    ?.candidate;
}

async function* windowsPathClis(
  env: NodeJS.ProcessEnv,
  arch: NodeJS.Architecture,
  signal?: AbortSignal,
) {
  const entries = (env.PATH ?? env.Path ?? '').split(path.win32.delimiter);
  if (env.APPDATA) entries.push(path.join(env.APPDATA, 'npm'));
  const target =
    arch === 'x64'
      ? 'x86_64-pc-windows-msvc'
      : arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : undefined;
  for (const entry of entries) {
    if (signal?.aborted) return;
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(directory, 'codex.exe');
    if (await isFile(executable)) yield executable;

    // npm shims launch a platform-specific executable. Use the executable directly
    // so app-server's pipes and process lifetime belong to the same process.
    if (
      !target ||
      (!(await isFile(path.join(directory, 'codex.cmd'))) &&
        !(await isFile(path.join(directory, 'codex.ps1'))))
    )
      continue;
    const modules =
      path.basename(directory) === '.bin'
        ? path.dirname(directory)
        : path.join(directory, 'node_modules');
    const packages = path.join(modules, '@openai');
    const codex = path.join(packages, 'codex');
    const platformPackage = `codex-win32-${arch}`;
    for (const root of [
      path.join(codex, 'node_modules', '@openai', platformPackage),
      path.join(packages, platformPackage),
      codex,
    ]) {
      for (const folder of ['bin', 'codex']) {
        const binary = path.join(root, 'vendor', target, folder, 'codex.exe');
        if (await isFile(binary)) yield binary;
      }
    }
  }
}

/** Check desktop installations first for compatibility with their session protocol. */
export async function* windowsCliPaths(
  env: NodeJS.ProcessEnv = process.env,
  {
    signal,
    storePackages,
    arch = process.arch,
  }: {
    signal?: AbortSignal;
    storePackages?: () => Promise<string[]>;
    arch?: NodeJS.Architecture;
  } = {},
): AsyncGenerator<string> {
  if (env.MONITOR_CODEX_DESKTOP) {
    const configured = await newestCli([
      path.join(path.dirname(env.MONITOR_CODEX_DESKTOP), 'resources', 'codex.exe'),
    ]);
    if (configured) yield configured;
  }
  if (signal?.aborted) return;
  const locations = await (storePackages?.() ?? registeredStorePackages(env, signal));
  if (signal?.aborted) return;
  const registered = await newestCli(
    locations.map((location) => path.join(location, 'app', 'resources', 'codex.exe')),
  );
  if (registered) yield registered;
  const candidates: string[] = [];
  if (env.LOCALAPPDATA)
    for (const directory of ['Programs', 'OpenAI'])
      candidates.push(path.join(env.LOCALAPPDATA, directory, 'Codex', 'resources', 'codex.exe'));
  if (env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'Codex', 'resources', 'codex.exe'));
    const store = path.join(env.ProgramFiles, 'WindowsApps');
    for (const name of await children(store))
      if (name.startsWith('OpenAI.Codex_'))
        candidates.push(path.join(store, name, 'app', 'resources', 'codex.exe'));
  }
  // Old copied runtimes can survive desktop upgrades. Prefer the installed app.
  const installed = await newestCli(candidates);
  if (installed) yield installed;
  yield* windowsPathClis(env, arch, signal);
  if (signal?.aborted) return;
  if (env.LOCALAPPDATA) {
    const cache = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const cached = await newestCli([
      ...(await children(cache)).map((name) => path.join(cache, name, 'codex.exe')),
      path.join(cache, 'codex.exe'),
    ]);
    if (cached) yield cached;
  }
}
