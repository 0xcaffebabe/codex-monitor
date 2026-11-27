import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, cp } from 'node:fs/promises';
import path from 'node:path';

const manifests = ['package.json', 'package-lock.json'];

export function dependencyHash(root: string) {
  const hash = createHash('sha256');
  for (const name of manifests) hash.update(readFileSync(path.join(root, name))).update('\0');
  return hash.digest('hex');
}

export async function prepareDependencyInstall(root: string, stage: string) {
  await Promise.all(
    manifests.map((name) => copyFile(path.join(root, name), path.join(stage, name))),
  );
  const npmConfig = path.join(root, '.npmrc');
  if (existsSync(npmConfig)) await copyFile(npmConfig, path.join(stage, '.npmrc'));
  await cp(path.join(root, 'scripts'), path.join(stage, 'scripts'), { recursive: true });
}
