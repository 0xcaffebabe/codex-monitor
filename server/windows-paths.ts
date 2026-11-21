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

/** Find the CLI runtime, keeping GUI executables out of app-server launches. */
export async function windowsBundledCli(
  env: NodeJS.ProcessEnv = process.env,
  { signal, storePackages }: { signal?: AbortSignal; storePackages?: () => Promise<string[]> } = {},
): Promise<string | undefined> {
  if (env.MONITOR_CODEX_DESKTOP) {
    const configured = await newestCli([
      path.join(path.dirname(env.MONITOR_CODEX_DESKTOP), 'resources', 'codex.exe'),
    ]);
    if (configured) return configured;
  }
  if (signal?.aborted) return undefined;
  const locations = await (storePackages?.() ?? registeredStorePackages(env, signal));
  if (signal?.aborted) return undefined;
  const registered = await newestCli(
    locations.map((location) => path.join(location, 'app', 'resources', 'codex.exe')),
  );
  if (registered) return registered;
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
  if (installed) return installed;
  if (env.LOCALAPPDATA) {
    const cache = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    return newestCli([
      ...(await children(cache)).map((name) => path.join(cache, name, 'codex.exe')),
      path.join(cache, 'codex.exe'),
    ]);
  }
  return undefined;
}
