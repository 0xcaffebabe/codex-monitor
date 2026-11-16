import { createRequire } from 'node:module';
import { existsSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';

// node-pty's macOS prebuilt helper may arrive without its executable bit.
// Restore only owner execute permission on the helper from our installed package.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const file of [
    path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build/Release/spawn-helper'),
  ]) {
    if (existsSync(file)) {
      const stat = statSync(file);
      if (stat.isFile() && !(stat.mode & 0o100)) chmodSync(file, stat.mode | 0o100);
    }
  }
}
