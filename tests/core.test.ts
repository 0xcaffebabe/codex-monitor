import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { rmSync, appendFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { CodexSource } from '../server/source.js';
import { normalizeRecord, normalizeItem } from '../server/normalize.js';
import { fixture, ids } from './fixture.js';

test('extended Windows rollout paths retain context and still reject files outside session roots', async () => {
  const f = fixture(),
    rollout = path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
  f.state
    .prepare('UPDATE threads SET rollout_path=? WHERE id=?')
    .run(path.toNamespacedPath(rollout), ids.legacy);
  f.state
    .prepare('UPDATE threads SET rollout_path=? WHERE id=?')
    .run(path.toNamespacedPath(path.join(f.root, 'private.jsonl')), ids.outside);
  appendFileSync(
    rollout,
    JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 100000 }, model_context_window: 200000 },
      },
    }) + '\n',
  );
  const source = new CodexSource(f.home);
  try {
    const page = await source.detail(ids.legacy);
    assert.ok(page!.events.length > 0);
    assert.equal(page!.context!.percent, 50);
    assert.equal((await source.detail(ids.outside))!.events.length, 0);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('image previews require a recorded image operation and reject non-image files', async () => {
  const f = fixture(),
    application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await application.auth.setup('owner', 'a-long-password'),
    session = application.auth.issue(user, 'image test');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
    'base64',
  );
  mkdirSync(path.join(f.root, '.pictures'));
  const image = path.join(f.root, '.pictures', 'picture.png'),
    fake = path.join(f.root, 'fake.png');
  writeFileSync(image, png);
  writeFileSync(fake, 'not an image');
  const add = (id: string, file: string, ordinal: number) =>
    f.hist
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        id,
        ordinal,
        Date.now(),
        JSON.stringify({ type: 'imageView', id, path: file }),
        Date.now(),
        Date.now(),
      );
  add('image-allowed', image, 10);
  add('image-fake', fake, 11);
  add('image-network', '\\\\untrusted.invalid\\share\\picture.png', 12);
  add('image-secret', path.join(f.data, 'monitor.sqlite'), 13);
  add('image-saved', path.join(f.root, 'deleted.png'), 14);
  const pathA = path.join(f.root, 'deleted-a.png'),
    pathB = path.join(f.root, 'deleted-b.png'),
    pngB = Buffer.concat([png, Buffer.from('second-image')]);
  add('image-multi-a', pathA, 15);
  add('image-multi-b', pathB, 16);
  const rollout = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
  appendFileSync(
    rollout,
    [
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: Date.now(),
          item: { type: 'ImageView', id: 'image-saved', path: path.join(f.root, 'deleted.png') },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'image-wrapper',
          output: [
            { type: 'input_image', image_url: 'data:image/png;base64,' + png.toString('base64') },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  appendFileSync(
    rollout,
    [
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'multi-wrapper',
          name: 'functions.exec',
          input: `await tools.view_image({path:${JSON.stringify(pathA)}});await tools.view_image({path:${JSON.stringify(pathB)}});`,
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: 1,
          item: { type: 'ImageView', id: 'image-multi-b', path: pathB },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: 1,
          item: { type: 'ImageView', id: 'image-multi-a', path: pathA },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'multi-wrapper',
          output: [
            { type: 'input_image', image_url: 'data:image/png;base64,' + png.toString('base64') },
            { type: 'input_image', image_url: 'data:image/png;base64,' + pngB.toString('base64') },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const get = (id: string, authorized = true) =>
    fetch(`${base}/api/sessions/${ids.modern}/images/${id}`, {
      headers: authorized ? { Authorization: 'Bearer ' + session.token } : {},
    });
  try {
    assert.equal((await get('image-allowed', false)).status, 401);
    const response = await get('image-allowed');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /image\/png/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const saved = await get('image-saved');
    assert.equal(saved.status, 200);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
    assert.deepEqual(Buffer.from(await (await get('image-multi-a')).arrayBuffer()), png);
    assert.deepEqual(Buffer.from(await (await get('image-multi-b')).arrayBuffer()), pngB);
    assert.equal((await get('tool-1')).status, 404);
    assert.equal((await get('image-fake')).status, 415);
    assert.equal((await get('image-network')).status, 403);
    assert.equal((await get('image-secret')).status, 415);
    const page = await application.source.detail(ids.modern);
    assert.equal(
      page!.events.find((event) => event.id === 'image-allowed')!.image!.name,
      'picture.png',
    );
  } finally {
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tool summaries preserve both ends while session JSON is compressed and SSE remains immediate', async () => {
  const f = fixture(),
    application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await application.auth.setup('owner', 'a-long-password');
  const session = application.auth.issue(user, 'compression test');
  try {
    const command = 'COMMAND_START\n' + 'argument '.repeat(30000) + '\nCOMMAND_END';
    const output = 'OUTPUT_START\n' + 'result '.repeat(60000) + '\nOUTPUT_END';
    f.hist.prepare('UPDATE thread_items SET item_json=? WHERE item_id=?').run(
      JSON.stringify({
        type: 'commandExecution',
        id: 'tool-1',
        command,
        aggregatedOutput: output,
        status: 'completed',
      }),
      'tool-1',
    );
    const result = await new Promise<{ body: Buffer; encoding: unknown }>((resolve, reject) => {
      const req = httpRequest(
        base + `/api/sessions/${ids.modern}`,
        { headers: { Authorization: 'Bearer ' + session.token, 'Accept-Encoding': 'gzip' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ body: Buffer.concat(chunks), encoding: res.headers['content-encoding'] }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.encoding, 'gzip');
    const data = JSON.parse(gunzipSync(result.body).toString('utf8'));
    const tool = data.events.find((e: any) => e.id === 'tool-1');
    assert.ok(tool.text.startsWith('COMMAND_START'));
    assert.ok(tool.text.endsWith('COMMAND_END'));
    assert.match(tool.text, /中间已省略/);
    assert.ok(tool.text.length < 2100);
    assert.equal(tool.output, undefined);
    assert.ok(!JSON.stringify(data).includes('OUTPUT_START'));
    assert.ok(result.body.length < 3000);
    assert.ok(
      data.events.some((e: any) => e.kind === 'assistant' && e.text.includes('| 项目 | 结果 |')),
    );
    const controller = new AbortController();
    const stream = await fetch(base + '/api/stream', {
      headers: { Authorization: 'Bearer ' + session.token, 'Accept-Encoding': 'gzip' },
      signal: controller.signal,
    });
    assert.equal(stream.headers.get('content-encoding'), null);
    assert.match(
      new TextDecoder().decode((await stream.body!.getReader().read()).value),
      /event: ready/,
    );
    controller.abort();
  } finally {
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('authenticated API enforces setup, roles, ownership, revocation and input boundaries', async () => {
  const f = fixture(),
    application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (route: string, options: RequestInit = {}, token?: string) =>
    fetch(base + route, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...options.headers,
      },
    });
  const post = (route: string, body: unknown, token?: string) =>
    request(route, { method: 'POST', body: JSON.stringify(body) }, token);
  try {
    for (const route of [
      '/api/sessions',
      '/api/overview',
      `/api/sessions/${ids.modern}`,
      `/api/sessions/${ids.modern}/export`,
      `/api/sessions/${ids.modern}/outline`,
      '/api/stream',
      '/api/auth/devices',
      '/api/users',
    ])
      assert.equal((await request(route)).status, 401, route);
    assert.equal(
      (
        await post('/api/auth/setup', {
          username: 'owner',
          password: 'a-long-password',
          setupKey: 'wrong',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post('/api/auth/setup', {
          username: 'owner',
          password: 'short',
          setupKey: application.auth.setupKey,
        })
      ).status,
      400,
    );
    const setup = await post('/api/auth/setup', {
      username: 'owner',
      password: 'a-long-password',
      setupKey: application.auth.setupKey,
    });
    assert.equal(setup.status, 201);
    const owner = await setup.json();
    assert.ok(owner.token);
    assert.equal(application.auth.setupKey, undefined);
    assert.equal((await post('/api/auth/setup', {})).status, 409);
    assert.equal(
      (await post('/api/auth/login', { username: 'owner', password: 'incorrect' })).status,
      401,
    );
    assert.equal((await request('/api/overview', {}, 'forged-token')).status, 401);
    const overview = await (await request('/api/overview', {}, owner.token)).json();
    assert.equal(overview.total, 4);
    assert.equal(overview.running, 1);
    const listed = await (await request('/api/sessions?q=codex-monitor', {}, owner.token)).json();
    assert.equal(listed.sessions[0].id, ids.modern);
    const detail = await (
      await request(`/api/sessions/${ids.modern}?limit=2`, {}, owner.token)
    ).json();
    assert.equal(detail.events.length, 2);
    assert.ok(detail.before);
    assert.equal(detail.session.status, 'running');
    const outline = await (
      await request(`/api/sessions/${ids.modern}/outline`, {}, owner.token)
    ).json();
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0].id, 'user-1');
    assert.equal(outline.entries[0].tools, 2);
    assert.equal((await request('/api/sessions?limit=-1', {}, owner.token)).status, 400);
    assert.equal((await request('/api/sessions/nope', {}, owner.token)).status, 400);
    const outside = await (await request(`/api/sessions/${ids.outside}`, {}, owner.token)).json();
    assert.equal(outside.events.length, 0);
    assert.ok(!JSON.stringify(outside).includes('SECRET_OUTSIDE_FILE'));
    assert.equal(
      (
        await request(
          '/api/sessions',
          { headers: { Origin: 'https://attacker.invalid' } },
          owner.token,
        )
      ).status,
      403,
    );
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        base + '/api/sessions',
        { headers: { Host: 'attacker.invalid', Authorization: 'Bearer ' + owner.token } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(invalidHost, 403);
    assert.equal(
      (
        await post(
          '/api/users',
          { username: 'guest', password: 'a-guest-password', role: 'viewer' },
          owner.token,
        )
      ).status,
      201,
    );
    const guest = await (
      await post('/api/auth/login', { username: 'guest', password: 'a-guest-password' })
    ).json();
    assert.equal((await request('/api/users', {}, guest.token)).status, 403);
    assert.equal(
      (
        await post(
          '/api/users',
          { username: 'hacker', password: 'a-hacker-password', role: 'admin' },
          guest.token,
        )
      ).status,
      403,
    );
    const ownDevice = owner.sessionId;
    assert.equal(
      (await request('/api/auth/devices/' + ownDevice, { method: 'DELETE' }, guest.token)).status,
      204,
    );
    assert.equal((await request('/api/auth/me', {}, owner.token)).status, 200);
    const streamAbort = new AbortController();
    const stream = await request(
      '/api/stream?session=' + ids.modern,
      { signal: streamAbort.signal },
      guest.token,
    );
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    await request('/api/auth/devices/' + guest.sessionId, { method: 'DELETE' }, guest.token);
    assert.equal((await request('/api/auth/me', {}, guest.token)).status, 401);
    let received = '';
    const timeout = setTimeout(() => streamAbort.abort(), 3000);
    try {
      while (!received.includes('unauthorized')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
    } finally {
      clearTimeout(timeout);
      streamAbort.abort();
    }
    assert.match(received, /unauthorized/);
    const second = await (
      await post('/api/auth/login', { username: 'owner', password: 'a-long-password' })
    ).json();
    assert.equal(
      (
        await post(
          '/api/auth/password',
          { currentPassword: 'a-long-password', password: 'a-new-long-password' },
          owner.token,
        )
      ).status,
      204,
    );
    assert.equal((await request('/api/auth/me', {}, second.token)).status, 401);
    assert.equal((await request('/api/auth/me', {}, owner.token)).status, 200);
    assert.ok(
      !(await request('/api/users', {}, owner.token)).headers.get('access-control-allow-origin'),
    );
    const exported = await request(`/api/sessions/${ids.modern}/export`, {}, owner.token);
    assert.match(await exported.text(), /npm test/);
    await post('/api/auth/logout', {}, owner.token);
    assert.equal((await request('/api/sessions', {}, owner.token)).status, 401);
  } finally {
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('local source reads modern/legacy formats, history pagination and real appended events', async () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  try {
    const first = await source.detail(ids.modern, undefined, 2);
    assert.equal(first!.total, 5);
    assert.equal(first!.before, 4);
    const older = await source.detail(ids.modern, first!.before!, 2);
    assert.equal(older!.events[0].kind, 'assistant');
    assert.equal(older!.before, 2);
    const legacy = await source.detail(ids.legacy);
    assert.equal(legacy!.session.status, 'completed');
    assert.equal(legacy!.events.find((e) => e.kind === 'tool')!.output, undefined);
    assert.ok(!JSON.stringify(legacy).includes('legacy tests passed'));
    const v = await source.version(ids.modern);
    f.append('新到达的实时输出');
    assert.notEqual(await source.version(ids.modern), v);
    assert.ok((await source.detail(ids.modern))!.events.some((e) => e.text === '新到达的实时输出'));
    const rollout = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
    appendFileSync(
      rollout,
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'custom_tool_call',
          call_id: 'ongoing',
          name: 'functions.exec',
          input: 'long running command',
        },
      }) + '\n',
    );
    assert.ok(
      (await source.detail(ids.modern))!.events.some(
        (e) => e.transient && e.status === 'inProgress',
      ),
    );
    appendFileSync(
      rollout,
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date().toISOString(),
        payload: { type: 'custom_tool_call_output', call_id: 'ongoing', output: 'finished' },
      }) + '\n',
    );
    assert.ok(!(await source.detail(ids.modern))!.events.some((e) => e.transient));
    const archived = await source.list({ archived: 'true' });
    assert.equal(archived.total, 1);
    const children = await source.list({ subagents: 'true', archived: 'all' });
    assert.equal(children.total, 5);
    const recentTime = Date.now();
    f.state
      .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
      .run(recentTime - 1000, ids.modern);
    f.state
      .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
      .run(recentTime + 1000, ids.legacy);
    f.state
      .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
      .run(recentTime + 2000, ids.archived);
    await source.refresh(true);
    const recent = await source.list({ sort: 'recent', archived: 'all', limit: 2 });
    assert.deepEqual(
      recent.sessions.map((session) => session.id),
      [ids.archived, ids.legacy],
    );
    assert.equal((await source.list({ limit: 1 })).sessions[0].id, ids.modern);
    assert.equal(await source.detail('../../private.jsonl'), null);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('expired tokens are rejected and password attempts are rate limited', async () => {
  const f = fixture(),
    application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const user = await application.auth.setup('owner', 'a-long-password'),
      session = application.auth.issue(user, 'expired device');
    application.auth.db
      .prepare('UPDATE sessions SET expires_at=0 WHERE id=?')
      .run(session.sessionId);
    assert.equal(
      (
        await fetch(base + '/api/sessions', {
          headers: { Authorization: 'Bearer ' + session.token },
        })
      ).status,
      401,
    );
    let result: Response | undefined;
    for (let i = 0; i < 13; i++)
      result = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'wrong' }),
      });
    assert.equal(result!.status, 429);
    assert.ok(result!.headers.get('retry-after'));
  } finally {
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('JSONL-only installations, malformed records and partial writes remain readable', async () => {
  const f = fixture();
  f.close();
  for (const name of ['state_5.sqlite', 'thread_history_1.sqlite'])
    unlinkSync(path.join(f.home, name));
  const file = path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
  appendFileSync(file, '{broken}\n{"partial":');
  const source = new CodexSource(f.home);
  try {
    assert.ok((await source.list({})).total > 0);
    const page = await source.detail(ids.legacy);
    assert.ok(page!.events.some((e) => e.kind === 'assistant'));
    assert.equal((await source.overview()).source.database, false);
  } finally {
    source.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tool titles survive history, realtime and rollout reads independently of truncated arguments', async () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  const title = '读取源查询结果并继续同期商品核查',
    args = { code: 'x'.repeat(4000), title: `  ${title}  `, context: 'y'.repeat(4000) },
    stamp = Date.now();
  try {
    f.hist.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      ids.modern,
      'turn-1',
      'semantic-history',
      10,
      stamp,
      JSON.stringify({
        type: 'mcpToolCall',
        server: 'cua_repl',
        tool: 'js',
        arguments: args,
        status: 'completed',
        result: { content: [{ text: 'PRIVATE_TOOL_RESULT' }] },
      }),
      stamp,
      stamp,
    );
    f.hist.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)').run(
      ids.modern,
      'semantic-realtime',
      11,
      stamp + 1,
      JSON.stringify({
        type: 'mcpToolCall',
        server: 'node_repl',
        tool: 'js',
        arguments: JSON.stringify({ title: '核对实时查询结果' }),
        status: 'inProgress',
      }),
    );
    for (const [sessionId, callId] of [
      [ids.modern, 'semantic-pending'],
      [ids.legacy, 'semantic-legacy'],
    ]) {
      appendFileSync(
        path.join(f.home, 'sessions', `rollout-${sessionId}.jsonl`),
        JSON.stringify({
          type: 'response_item',
          timestamp: new Date(stamp + 2).toISOString(),
          payload: {
            type: 'function_call',
            namespace: 'mcp__cua_repl',
            name: 'js',
            call_id: callId,
            arguments: JSON.stringify(args),
          },
        }) + '\n',
      );
    }
    const modern = await source.detail(ids.modern),
      history = modern!.events.find((event) => event.id === 'semantic-history')!,
      realtime = modern!.events.find((event) => event.id === 'semantic-realtime')!,
      pending = modern!.events.find((event) => event.id === 'pending-semantic-pending')!,
      legacy = await source.detail(ids.legacy);
    assert.equal(history.title, title);
    assert.equal(history.name, 'js');
    assert.match(history.text, /中间已省略/);
    assert.ok(!history.text.includes(title));
    assert.ok(!JSON.stringify(modern).includes('PRIVATE_TOOL_RESULT'));
    assert.equal(realtime.title, '核对实时查询结果');
    assert.equal(pending.title, title);
    assert.equal(pending.transient, true);
    assert.equal(legacy!.events.find((event) => event.id === 'semantic-legacy')!.title, title);
    assert.equal(modern!.events.find((event) => event.id === 'tool-1')!.title, undefined);
    assert.match((await source.export(ids.modern))!, new RegExp(`## ${title} ·`));
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('normalizers handle Codex variants and never expose encrypted reasoning', () => {
  const unknown = normalizeItem(
    { type: 'someTool', result: 'PRIVATE_TOOL_RESULT', stdout: 'PRIVATE_TOOL_OUTPUT' },
    'unknown',
    1,
  );
  assert.equal(unknown!.text, '（无参数）');
  assert.ok(!JSON.stringify(unknown).includes('PRIVATE_TOOL'));
  assert.equal(normalizeItem({ type: 'reasoning', encrypted_content: 'secret' }, 'id', 1), null);
  const e = normalizeRecord(
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'c',
        name: 'functions.exec',
        input: 'console.log(1)',
      },
    },
    2,
  );
  assert.equal(e!.kind, 'tool');
  assert.equal(e!.text, 'console.log(1)');
  for (const title of ['', '  ', null, 42, { text: 'invalid' }]) {
    assert.equal(
      normalizeItem({ type: 'mcpToolCall', tool: 'js', arguments: { title } }, 'id', 1)!.title,
      undefined,
    );
  }
  const failed = normalizeItem(
    {
      type: 'CommandExecution',
      command: 'exit 1',
      exit_code: 1,
      aggregated_output: 'failure',
      duration: { secs: 2, nanos: 500000000 },
    },
    'id',
    1,
  );
  assert.equal(failed!.status, 'failed');
  assert.equal(failed!.durationMs, 2500);
  assert.equal(
    normalizeRecord(
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ text: 'hidden' }] },
      },
      1,
    ),
    null,
  );
});
