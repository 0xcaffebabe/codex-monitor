import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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
export function windowsBundledCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MONITOR_CODEX_DESKTOP) {
    const configured = newestCli([
      path.join(path.dirname(env.MONITOR_CODEX_DESKTOP), 'resources', 'codex.exe'),
    ]);
    if (configured) return configured;
  }
  if (env.LOCALAPPDATA) {
    const cache = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const cached = newestCli([
      ...children(cache).map((name) => path.join(cache, name, 'codex.exe')),
      path.join(cache, 'codex.exe'),
    ]);
    if (cached) return cached;
  }
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
  return newestCli(candidates);
}
