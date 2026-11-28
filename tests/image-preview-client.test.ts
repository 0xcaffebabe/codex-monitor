import test from 'node:test';
import assert from 'node:assert/strict';
import { api, apiBlob, ApiError, getToken, saveToken } from '../src/api.js';
import { fetchImagePreview } from '../src/shared/image-preview.js';
import { currentWorkspace, initializeWorkspace } from '../src/workspace-scope.js';

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('image previews use the authenticated API transport and preserve workspace ownership', async (t) => {
  const originalWorkspace = currentWorkspace();
  const events = new EventTarget();
  let finishProbe!: () => void;
  const probes: string[] = [];
  let logouts = 0;
  events.addEventListener('monitor:logout', () => {
    logouts++;
  });
  const globals = {
    window: events,
    localStorage: storage(),
    sessionStorage: storage(),
    Image: class {
      naturalWidth = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        probes.push(value);
        finishProbe = () => this.onload?.();
      }
    },
  };
  const original = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    initializeWorkspace(originalWorkspace);
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  await t.test(
    'switching workspaces during codec detection never sends the old preview',
    async (t) => {
      initializeWorkspace('first');
      const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('image'));
      const preview = fetchImagePreview(
        '/api/sessions/session/images/image',
        'thumbnail',
        new AbortController().signal,
      );
      initializeWorkspace('second');
      finishProbe();
      await assert.rejects(preview, { name: 'AbortError' });
      assert.equal(fetch.mock.callCount(), 0);
    },
  );

  await t.test(
    'previews keep query parameters, negotiate once, and send the current bearer token',
    async (t) => {
      initializeWorkspace('workspace/one');
      saveToken('preview-token', false);
      const fetch = t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response('image', {
            headers: { 'Content-Type': 'image/avif' },
          }),
      );
      const blob = await fetchImagePreview(
        '/api/sessions/session/images/image?index=2',
        'preview',
        new AbortController().signal,
      );
      assert.equal(await blob.text(), 'image');
      assert.equal(blob.type, 'image/avif');
      const [url, options] = fetch.mock.calls[0].arguments;
      assert.equal(
        url,
        '/api/workspaces/workspace%2Fone/sessions/session/images/image?index=2&variant=preview&format=avif',
      );
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer preview-token');
      assert.equal(options?.cache, 'no-store');
      assert.equal(probes.length, 1);
      assert.match(probes[0], /^data:image\/avif;base64,/);
      await fetchImagePreview('/api/uploads/file', 'original', new AbortController().signal);
      assert.equal(
        fetch.mock.calls[1].arguments[0],
        '/api/workspaces/workspace%2Fone/uploads/file?variant=original&format=original',
      );
      assert.equal(probes.length, 1);
    },
  );

  await t.test(
    'server errors remain authoritative and image defaults do not change other API errors',
    async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () =>
        Response.json({ error: '原图已移除', state: 'missing' }, { status: 404 }),
      );
      await assert.rejects(
        fetchImagePreview('/api/uploads/file', 'original', new AbortController().signal),
        (error: unknown) =>
          error instanceof ApiError &&
          error.message === '原图已移除' &&
          error.status === 404 &&
          error.state === 'missing',
      );
      fetch.mock.mockImplementation(async () => new Response('proxy failure', { status: 502 }));
      await assert.rejects(
        fetchImagePreview('/api/uploads/file', 'original', new AbortController().signal),
        { message: '图片加载失败' },
      );
      await assert.rejects(api('/api/status'), { message: '请求失败，请稍后重试' });
      await assert.rejects(apiBlob('/api/status'), { message: '请求失败，请稍后重试' });
    },
  );

  await t.test(
    'unauthorized previews clear authentication and emit the shared logout event',
    async (t) => {
      saveToken('expired-token');
      t.mock.method(globalThis, 'fetch', async () =>
        Response.json({ error: '登录已过期' }, { status: 401 }),
      );
      await assert.rejects(
        fetchImagePreview('/api/uploads/file', 'original', new AbortController().signal),
        { message: '登录已过期' },
      );
      assert.equal(getToken(), '');
      assert.equal(logouts, 1);
    },
  );

  await t.test('a workspace change while consuming a blob discards the old image', async (t) => {
    initializeWorkspace('before-body');
    const reached = gate(),
      proceed = gate();
    const response = new Response('image');
    t.mock.method(response, 'blob', async () => {
      reached.release();
      await proceed.promise;
      return new Blob(['image']);
    });
    const fetch = t.mock.method(globalThis, 'fetch', async () => response);
    const preview = fetchImagePreview(
      '/api/uploads/file',
      'original',
      new AbortController().signal,
    );
    await reached.promise;
    initializeWorkspace('after-body');
    proceed.release();
    await assert.rejects(preview, { name: 'AbortError' });
    assert.equal(fetch.mock.calls[0].arguments[1]?.signal?.aborted, true);
  });

  await t.test(
    'a stale unauthorized response cannot log out the newly selected workspace',
    async (t) => {
      initializeWorkspace('before-error');
      saveToken('valid-token');
      const reached = gate(),
        proceed = gate();
      const response = new Response('', { status: 401 });
      t.mock.method(response, 'json', async () => {
        reached.release();
        await proceed.promise;
        return { error: 'stale response' };
      });
      t.mock.method(globalThis, 'fetch', async () => response);
      const preview = fetchImagePreview(
        '/api/uploads/file',
        'original',
        new AbortController().signal,
      );
      await reached.promise;
      initializeWorkspace('after-error');
      proceed.release();
      await assert.rejects(preview, { name: 'AbortError' });
      assert.equal(getToken(), 'valid-token');
      assert.equal(logouts, 1);
    },
  );

  await t.test(
    'explicit workspace previews keep their own lifetime across document navigation',
    async (t) => {
      const reached = gate(),
        proceed = gate();
      const response = new Response('image');
      t.mock.method(response, 'blob', async () => {
        reached.release();
        await proceed.promise;
        return new Blob(['remote image']);
      });
      const fetch = t.mock.method(globalThis, 'fetch', async () => response);
      const controller = new AbortController();
      const preview = fetchImagePreview(
        '/api/workspaces/remote/uploads/file',
        'original',
        controller.signal,
      );
      await reached.promise;
      initializeWorkspace('another-document-workspace');
      proceed.release();
      assert.equal(await (await preview).text(), 'remote image');
      assert.equal(fetch.mock.calls[0].arguments[1]?.signal, controller.signal);
    },
  );
});
