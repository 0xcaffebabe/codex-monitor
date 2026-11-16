import test from 'node:test';
import assert from 'node:assert/strict';
import { macOSUsedMemory } from '../server/client/macos-memory.js';

const totalBytes = 32 * 2 ** 30;
// Low free memory with 6.25 GiB of reusable cache must not look like 99% usage.
const snapshot = (
  pageSize: number,
) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free: ${2 ** 28 / pageSize}.
Pages active: ${(10 * 2 ** 30) / pageSize}.
Pages inactive: ${(11 * 2 ** 30) / pageSize}.
Pages speculative: ${2 ** 26 / pageSize}.
Pages wired down: ${(4 * 2 ** 30) / pageSize}.
Pages purgeable: ${2 ** 28 / pageSize}.
File-backed pages: ${(6 * 2 ** 30) / pageSize}.
Anonymous pages: ${(15 * 2 ** 30) / pageSize}.
Pages stored in compressor: ${(20 * 2 ** 30) / pageSize}.
Pages occupied by compressor: ${(6 * 2 ** 30) / pageSize}.
`;

test('macOS memory excludes reusable cache, retains anonymous inactive memory and compressed RAM on Intel and Apple Silicon', () => {
  for (const pageSize of [4096, 16384]) {
    assert.equal(macOSUsedMemory(totalBytes, snapshot(pageSize)), 25.5 * 2 ** 30);
    assert.equal(
      macOSUsedMemory(totalBytes, snapshot(pageSize).replaceAll('\n', '\r\n')),
      25.5 * 2 ** 30,
    );
  }
});

test('missing, malformed and inconsistent macOS counters report unknown instead of a misleading percentage', () => {
  const valid = snapshot(16384);
  for (const output of [
    '',
    valid.replace('page size of 16384 bytes', 'page size unavailable'),
    valid.replace('page size of 16384', 'page size of 0'),
    valid.replace(/^File-backed pages:.*\n/m, ''),
    valid.replace(/^Pages free:.*$/m, 'Pages free: -1.'),
    valid.replace(/^Pages purgeable:.*$/m, 'Pages purgeable: 1.5.'),
    valid.replace(/^File-backed pages:.*$/m, 'File-backed pages: 9007199254740992.'),
    valid.replace(/^File-backed pages:.*$/m, 'File-backed pages: 2097152.'),
  ])
    assert.equal(macOSUsedMemory(totalBytes, output), null);
  for (const invalidTotal of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(macOSUsedMemory(invalidTotal, valid), null);
});

test('zero cache or fully available RAM remain valid memory samples', () => {
  const output = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 0.
File-backed pages: 0.
Pages purgeable: 0.
`;
  assert.equal(macOSUsedMemory(totalBytes, output), totalBytes);
  assert.equal(
    macOSUsedMemory(totalBytes, output.replace('Pages free: 0.', 'Pages free: 8388608.')),
    0,
  );
});
