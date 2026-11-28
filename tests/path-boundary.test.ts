import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathWithin } from '../server/path-boundary.js';

test('path containment accepts the root and descendants but rejects parent and sibling paths', () => {
  const root = path.resolve('project with spaces');
  for (const candidate of [
    root,
    root + path.sep,
    path.join(root, 'nested', 'file.txt'),
    path.join(root, '..hidden', 'file.txt'),
    path.join(root, 'nested', '..', 'file.txt'),
  ])
    assert.equal(isPathWithin(root, candidate), true, candidate);
  for (const candidate of [
    path.dirname(root),
    path.join(root, '..', 'outside.txt'),
    root + '-sibling',
    path.join(root + '-sibling', 'file.txt'),
  ])
    assert.equal(isPathWithin(root, candidate), false, candidate);
});

test('path containment preserves the host platform drive and case rules', () => {
  if (process.platform === 'win32') {
    assert.equal(isPathWithin('C:\\project', 'D:\\project\\file.txt'), false);
    assert.equal(isPathWithin('C:\\project', 'c:\\PROJECT\\file.txt'), true);
    assert.equal(isPathWithin('\\\\server\\share', '\\\\other\\share\\file.txt'), false);
    assert.equal(isPathWithin('\\\\server\\share', '\\\\server\\share\\file.txt'), true);
  } else {
    assert.equal(isPathWithin('/project', '/Project/file.txt'), false);
    assert.equal(isPathWithin('/project', '/project/file.txt'), true);
  }
});
