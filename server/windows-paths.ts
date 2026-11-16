import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function registeredStorePackages(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [];
  try {
    // WindowsApps usually denies directory enumeration. Package metadata still
    // gives this user's exact, readable installation path.
    const output = execFileSync(
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
      { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => path.isAbsolute(line));
  } catch {
    return [];
  }
}

function children(directory: string) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function newestCli(candidates: string[]) {
  return candidates
    .flatMap((candidate) => {
      try {
        const info = statSync(candidate);
        return info.isFile() ? [{ candidate, modified: info.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.modified - a.modified)[0]?.candidate;
}

/** Find the CLI runtime, keeping GUI executables out of app-server launches. */
export function windowsBundledCli(
  env: NodeJS.ProcessEnv = process.env,
  storePackages: () => string[] = () => registeredStorePackages(env),
): string | undefined {
  if (env.MONITOR_CODEX_DESKTOP) {
    const configured = newestCli([
      path.join(path.dirname(env.MONITOR_CODEX_DESKTOP), 'resources', 'codex.exe'),
    ]);
    if (configured) return configured;
  }
  const registered = newestCli(
    storePackages().map((location) => path.join(location, 'app', 'resources', 'codex.exe')),
  );
  if (registered) return registered;
  const candidates: string[] = [];
  if (env.LOCALAPPDATA)
    for (const directory of ['Programs', 'OpenAI'])
      candidates.push(path.join(env.LOCALAPPDATA, directory, 'Codex', 'resources', 'codex.exe'));
  if (env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'Codex', 'resources', 'codex.exe'));
    const store = path.join(env.ProgramFiles, 'WindowsApps');
    for (const name of children(store))
      if (name.startsWith('OpenAI.Codex_'))
        candidates.push(path.join(store, name, 'app', 'resources', 'codex.exe'));
  }
  // Old copied runtimes can survive desktop upgrades. Prefer the installed app.
  const installed = newestCli(candidates);
  if (installed) return installed;
  if (env.LOCALAPPDATA) {
    const cache = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    return newestCli([
      ...children(cache).map((name) => path.join(cache, name, 'codex.exe')),
      path.join(cache, 'codex.exe'),
    ]);
  }
  return undefined;
}
