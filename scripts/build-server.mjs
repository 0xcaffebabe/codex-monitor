import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dependencyHash = createHash('sha256');
for (const name of ['package.json', 'package-lock.json']) {
  dependencyHash.update(readFileSync(path.join(root, name))).update('\0');
}
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
  outdir: process.env.MONITOR_BUILD_DIR || 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: {
    __MONITOR_BUILD_COMMIT_AT__: JSON.stringify(buildCommitAt),
    __MONITOR_BUILD_DEPENDENCIES__: JSON.stringify(dependencyHash.digest('hex')),
  },
  logLevel: 'info',
});
