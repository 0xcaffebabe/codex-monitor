import path from 'node:path';

/** Lexical containment, including the root itself. Callers must resolve symlinks separately. */
export function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
