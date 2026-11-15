import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ids } from '../fixture.js';
import { previewPng } from '../image-preview-fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
declare global {
  interface Window {
    __imagePreviewBlobs: Record<string, { size: number; digest?: string }>;
  }
}
async function token(request: APIRequestContext) {
  const configured = (await (await request.get('/api/auth/status')).json()).configured;
  const response = await request.post(configured ? '/api/auth/login' : '/api/auth/setup', {
    data: {
      username: 'owner',
      password: 'monitor-e2e-password!',
      ...(!configured
        ? { setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim() }
        : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token as string;
}

for (const format of ['avif', 'webp', 'original'] as const) {
  test(`image previews use ${format}, load full size on demand and preserve original access`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      window.__imagePreviewBlobs = {};
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = create(object);
        if (object instanceof Blob) {
          const entry: { size: number; digest?: string } = { size: object.size };
          window.__imagePreviewBlobs[url] = entry;
          void object.arrayBuffer().then(async (bytes) => {
            entry.digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
              .map((value) => value.toString(16).padStart(2, '0'))
              .join('');
          });
        }
        return url;
      };
    });
    if (format !== 'avif') {
      await page.addInitScript((format) => {
        const NativeImage = window.Image;
        window.Image = class extends NativeImage {
          override set src(value: string) {
            const blocked =
              value.startsWith('data:image/avif;') ||
              (format === 'original' && value.startsWith('data:image/webp;'));
            super.src = blocked ? 'data:image/png;base64,invalid' : value;
          }
          override get src() {
            return super.src;
          }
        };
      }, format);
    }
    const history = new DatabaseSync(path.join(root, 'codex/thread_history_1.sqlite'));
    const itemId = 'compressed-browser-' + format,
      name = '压缩测试 ' + format;
    const file = path.join(root, itemId + '.png'),
      original = await previewPng();
    writeFileSync(file, original);
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        itemId,
        300,
        Date.now(),
        JSON.stringify({ type: 'agentMessage', text: `![${name}](${pathToFileURL(file).href})` }),
        null,
        null,
      );
    const observed: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/images/${itemId}?`)) observed.push(request.url());
    });
    try {
      const authorization = await token(request);
      await page.addInitScript(
        (value) => localStorage.setItem('codex-monitor.auth.v1', value),
        authorization,
      );
      await page.goto('/');
      const thumbnailResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/images/${itemId}?`) &&
          response.url().includes('variant=thumbnail'),
      );
      await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
      const response = await thumbnailResponse;
      expect(response.headers()['content-type']).toContain(
        `image/${format === 'original' ? 'png' : format}`,
      );
      const thumbnail = page.getByRole('button', { name: '放大查看图片：' + name, exact: true });
      await expect(thumbnail.locator('img')).toHaveJSProperty(
        'naturalWidth',
        format === 'original' ? 3200 : 720,
      );
      expect(observed.every((url) => url.includes('variant=thumbnail'))).toBeTruthy();
      if (format !== 'original') {
        const size = await thumbnail
          .locator('img')
          .evaluate((image: HTMLImageElement) => window.__imagePreviewBlobs[image.src].size);
        expect(size).toBeLessThan(original.length);
      }
      const fullResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/images/${itemId}?`) &&
          response.url().includes('variant=preview'),
      );
      await thumbnail.click();
      const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
      await expect(dialog).toBeVisible();
      await fullResponse;
      await expect(dialog.getByRole('img', { name, exact: true })).toHaveJSProperty(
        'naturalWidth',
        format === 'original' ? 3200 : 2560,
      );
      await page.screenshot({
        path: test.info().outputPath('compressed-preview.png'),
        fullPage: true,
      });
      const originalResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/images/${itemId}?`) &&
          response.url().includes('variant=original'),
      );
      const beforeOriginal = await dialog
        .getByRole('img', { name, exact: true })
        .getAttribute('src');
      await dialog.getByRole('button', { name: '查看原图', exact: true }).click();
      expect((await originalResponse).status()).toBe(200);
      await expect(dialog.getByRole('img', { name, exact: true })).not.toHaveAttribute(
        'src',
        beforeOriginal!,
      );
      await expect(dialog.getByRole('img', { name, exact: true })).toHaveJSProperty(
        'naturalWidth',
        3200,
      );
      await expect
        .poll(() =>
          dialog
            .getByRole('img', { name, exact: true })
            .evaluate((image: HTMLImageElement) => window.__imagePreviewBlobs[image.src]?.digest),
        )
        .toBe(createHash('sha256').update(original).digest('hex'));
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const reopenResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/images/${itemId}?`) &&
          response.url().includes('variant=original'),
      );
      await thumbnail.click();
      await reopenResponse;
      await expect(dialog.getByRole('img', { name, exact: true })).toHaveJSProperty(
        'naturalWidth',
        3200,
      );
      await expect(dialog.getByRole('status')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
    } finally {
      history.prepare('DELETE FROM thread_items WHERE item_id=?').run(itemId);
      history.close();
    }
  });
}
