import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
let buildCommitAt = null;
try {
  const seconds = execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const timestamp = Number.parseInt(seconds, 10) * 1000;
  if (timestamp >= 0 && Number.isFinite(new Date(timestamp).getTime())) buildCommitAt = timestamp;
} catch {
  // Builds from source archives may not have Git metadata.
}

await build({
  absWorkingDir: root,
  entryPoints: { server: 'server/index.ts', 'terminal-worker': 'server/terminal-worker.mjs' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: { __MONITOR_BUILD_COMMIT_AT__: JSON.stringify(buildCommitAt) },
  logLevel: 'info',
});
