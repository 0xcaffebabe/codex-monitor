import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ImagePreviews } from '../server/image-previews.js';
import { animatedPng, previewPng } from './image-preview-fixture.js';

test('AVIF and WebP previews reduce transfer bytes and bound dimensions without modifying originals', async () => {
  const previews = new ImagePreviews();
  const data = await previewPng(),
    original = { data, mime: 'image/png' };
  for (const format of ['avif', 'webp'] as const) {
    for (const [variant, width] of [
      ['thumbnail', 720],
      ['preview', 2560],
    ] as const) {
      const result = await previews.render(original, variant, format);
      assert.ok('data' in result);
      assert.equal(result.mime, `image/${format}`);
      assert.ok(result.data.length < data.length);
      const metadata = await sharp(result.data).metadata();
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, width / 2);
    }
  }
  assert.strictEqual(await previews.render(original), original);
  assert.strictEqual(await previews.render(original, 'original', 'avif'), original);
  assert.strictEqual(await previews.render(original, 'preview', 'original'), original);
  assert.strictEqual(await previews.render(original, 'preview'), original);
  assert.deepEqual(data, await previewPng());
  previews.close();
});

test('preview cache deduplicates concurrent encodes and invalidates changed or removed local files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-monitor-image-cache-'));
  const file = path.join(directory, 'source.png'),
    previews = new ImagePreviews();
  const original = { file, mime: 'image/png' },
    input = await previewPng(1200, 600);
  await writeFile(file, input);
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => previews.render(original, 'thumbnail', 'avif')),
    );
    for (const result of results) assert.strictEqual(result, results[0]);
    assert.strictEqual(await previews.render(original, 'thumbnail', 'avif'), results[0]);
    assert.deepEqual(await readFile(file), input);
    await writeFile(file, await previewPng(1000, 500, '#bf3651'));
    await utimes(file, new Date(), new Date(Date.now() + 2000));
    const changed = await previews.render(original, 'thumbnail', 'avif');
    assert.notStrictEqual(changed, results[0]);
    assert.ok('data' in changed && 'data' in results[0]);
    assert.notDeepEqual(changed.data, results[0].data);
    await rm(file);
    await assert.rejects(previews.render(original, 'thumbnail', 'avif'), /ENOENT/);
  } finally {
    previews.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('encoding preserves transparency and falls back for animation, malformed or larger results', async () => {
  const previews = new ImagePreviews();
  const tiny = {
    mime: 'image/png',
    data: await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff00' } })
      .png()
      .toBuffer(),
  };
  assert.strictEqual(await previews.render(tiny, 'thumbnail', 'avif'), tiny);
  const corrupt = { mime: 'image/png', data: Buffer.from('89504e470d0a1a0a0000', 'hex') };
  assert.strictEqual(await previews.render(corrupt, 'thumbnail', 'avif'), corrupt);
  const alpha = {
    mime: 'image/png',
    data: await sharp(await previewPng(1200, 600))
      .removeAlpha()
      .ensureAlpha(0.5)
      .png()
      .toBuffer(),
  };
  for (const format of ['avif', 'webp'] as const) {
    const result = await previews.render(alpha, 'thumbnail', format);
    assert.ok('data' in result);
    assert.equal((await sharp(result.data).metadata()).hasAlpha, true);
  }
  const raw = Buffer.alloc(64 * 128 * 3, 200);
  raw.fill(40, 64 * 64 * 3);
  for (const format of ['gif', 'webp'] as const) {
    const data = await sharp(raw, { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } })
      [format]({ delay: [100, 100] })
      .toBuffer();
    assert.equal((await sharp(data).metadata()).pages, 2);
    const animated = { data, mime: `image/${format}` };
    assert.strictEqual(await previews.render(animated, 'thumbnail', 'avif'), animated);
  }
  const apng = { data: await animatedPng(), mime: 'image/png' };
  assert.strictEqual(await previews.render(apng, 'thumbnail', 'avif'), apng);
  previews.close();
});

test('preview memory budget evicts derivatives and closed workspaces stop encoding', async () => {
  const data = await previewPng(1200, 600),
    original = { data, mime: 'image/png' };
  const probe = new ImagePreviews();
  const result = await probe.render(original, 'thumbnail', 'avif');
  assert.ok('data' in result);
  const limited = new ImagePreviews(result.data.length - 1);
  const one = await limited.render(original, 'thumbnail', 'avif');
  const two = await limited.render(original, 'thumbnail', 'avif');
  assert.notStrictEqual(one, two);
  limited.close();
  assert.strictEqual(await limited.render(original, 'preview', 'avif'), original);
  probe.close();
});
