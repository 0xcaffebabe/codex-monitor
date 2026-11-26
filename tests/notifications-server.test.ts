import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { AuthStore } from '../server/auth.js';
import { NotificationStore } from '../server/notifications/store.js';
import type { WebhookTransport } from '../server/notifications/lark.js';
import type { LarkReplyListener } from '../server/notifications/lark-replies.js';
import { CHUNK_BYTES, frameSchema, workspacePath } from '../server/transport/protocol.js';

const webhook =
  'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const settings = {
  completionMode: 'all',
  enabled: true,
  provider: 'lark',
  webhookUrl: webhook,
  signingSecret: 'server-only-signing-secret',
  publicUrl: 'https://monitor.example.com/',
} as const;

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Notification integration timed out');
    await delay(20);
  }
}
function complete(f: ReturnType<typeof fixture>, turnId: string, text: string) {
  const now = Math.floor(Date.now() / 1000);
  f.hist
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(ids.modern, turnId, 100, 'completed', now - 1, now);
  f.hist
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
    .run(
      ids.modern,
      turnId,
      randomUUID(),
      100,
      Date.now(),
      JSON.stringify({ type: 'agentMessage', phase: 'final_answer', text }),
      null,
      null,
    );
}
async function central(
  f: ReturnType<typeof fixture>,
  transport: WebhookTransport,
  port = 0,
  larkReplyListener?: LarkReplyListener,
) {
  const service = createMonitorServer(
    {
      ...f.config,
      dataDir: path.join(f.root, 'central'),
      codexHome: path.join(f.root, 'server-has-no-codex'),
      pollMs: 60000,
    },
    { webhookTransport: transport, larkReplyListener },
  );
  const server = createServer(service.app);
  service.gateway.attach(server, () => true);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const actualPort = (server.address() as { port: number }).port;
  return {
    service,
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('authorized Lark quotes target the card workspace and reuse the Monitor message queue', async () => {
  const a = fixture(), b = fixture();
  a.config.pollMs = b.config.pollMs = 40;
  const desks = [new FixtureDesktop(a), new FixtureDesktop(b)];
  const reactions = new Map<string, string>();
  const image = await sharp(randomBytes(256 * 256 * 3), {
    raw: { width: 256, height: 256, channels: 3 },
  }).png().toBuffer();
  assert.ok(image.length > CHUNK_BYTES);
  const uploadedPaths = new Set<string>();
  const historyPages = new Map<string, unknown>();
  const file = Buffer.from('内容来自此前的文件消息');
  const exportedFile = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('云文档附件')]);
  const exportRequests: { token: string; type: string; file_extension: string }[] = [];
  let exportPolls = 0;
  const downloaded: string[] = [];
  let cardCount = 0;
  let receive!: (event: unknown) => Promise<void>;
  let slowImageSignal: AbortSignal | undefined;
  let closed = false;
  const server = await central(a, async (url, init) => {
    const endpoint = new URL(String(url));
    const { pathname } = endpoint;
    if (pathname.includes('/auth/'))
      return Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 });
    if (pathname === '/open-apis/drive/v1/export_tasks' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      exportRequests.push(body);
      if (body.token === 'NoAccess')
        return Response.json({ code: 1069902 }, { status: 403 });
      return Response.json({ code: 0, data: { ticket: 'ticketDoc' } });
    }
    if (pathname === '/open-apis/drive/v1/export_tasks/ticketDoc') {
      assert.equal(init?.method, 'GET');
      assert.equal(endpoint.searchParams.get('token'), 'DocToken');
      return Response.json({
        code: 0,
        data: { result: ++exportPolls === 1
          ? { job_status: 2 }
          : { job_status: 0, file_token: 'exportToken', file_name: '会议记录.docx', file_size: exportedFile.length } },
      });
    }
    if (pathname === '/open-apis/drive/v1/export_tasks/file/exportToken/download') {
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test');
      return new Response(new Uint8Array(exportedFile));
    }
    if (init?.method === 'GET' && pathname.endsWith('/messages')) {
      assert.equal(endpoint.searchParams.get('container_id_type'), 'chat');
      assert.equal(endpoint.searchParams.get('container_id'), 'oc_team');
      assert.equal(endpoint.searchParams.get('sort_type'), 'ByCreateTimeDesc');
      const page = historyPages.get(endpoint.searchParams.get('page_token') ?? '');
      assert.ok(page);
      return Response.json({ code: 0, data: page });
    }
    const messageId = /^\/open-apis\/im\/v1\/messages\/(om_[^/]+)\/reactions$/.exec(pathname)?.[1];
    if (messageId) {
      const body = JSON.parse(String(init?.body));
      const emoji = body.reaction_type.emoji_type;
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test');
      assert.deepEqual(body, { reaction_type: { emoji_type: emoji } });
      if (reactions.has(messageId)) assert.equal(reactions.get(messageId), emoji);
      reactions.set(messageId, emoji);
      return Response.json({ code: 0 });
    }
    if (pathname.includes('/resources/')) {
      assert.equal(init?.method, 'GET');
      const resource = pathname.split('/').at(-1)!;
      downloaded.push(pathname);
      if (resource === 'file_history') {
        assert.equal(endpoint.searchParams.get('type'), 'file');
        return new Response(new Uint8Array(file));
      }
      assert.equal(endpoint.searchParams.get('type'), 'image');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test');
      if (pathname.endsWith('/img_too_large'))
        return new Response(new Uint8Array(image), { headers: { 'Content-Length': String(21 * 1024 * 1024) } });
      if (pathname.endsWith('/img_missing')) return new Response(null, { status: 404 });
      if (pathname.endsWith('/img_slow')) {
        const signal = slowImageSignal = init?.signal ?? undefined;
        assert.ok(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return new Response(new Uint8Array(image), { headers: { 'Content-Type': 'image/png' } });
    }
    assert.equal(pathname, '/open-apis/im/v1/messages');
    return Response.json({ code: 0, data: { message_id: 'om_card_' + ++cardCount } });
  }, 0, (_config, handler) => {
    receive = handler;
    return {
      close: () => { closed = true; },
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    };
  });
  const clients: MonitorClient[] = [];
  try {
    const owner = await server.service.auth.setup('owner', 'central-notification-password');
    const headers = {
      Authorization: `Bearer ${server.service.auth.issue(owner, 'test').token}`,
      'Content-Type': 'application/json',
    };
    const workspaces = [server.service.gateway.store.create('A'), server.service.gateway.store.create('B')];
    for (const [index, item] of [a, b].entries()) {
      clients.push(await MonitorClient.start({
        config: item.config,
        serverUrl: server.base,
        workspaceId: workspaces[index].workspace.id,
        key: workspaces[index].key,
        services: { control: desks[index] },
      }));
    }
    await until(() => clients.every((client) => client.connected));
    const save = (replyOpenIds: string[]) => fetch(server.base + '/api/notifications', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        provider: 'lark', mode: 'app', appId: 'cli_monitor', appSecret: 'test',
        chatId: 'oc_team', enabled: true, completionMode: 'all', publicUrl: '', replyOpenIds,
      }),
    });
    assert.equal((await save(['bad-id'])).status, 400);
    const response = await save(['ou_allowed']);
    assert.equal(response.status, 200);
    const { settings: config } = await response.json();
    assert.equal(config.replyConnection, 'connected');
    for (const [index, item] of [a, b].entries()) {
      complete(item, `lark-turn-${index}`, 'original response');
      await until(async () => {
        await server.service.notifications.poll();
        return server.service.notifications.store.history().some(
          ({ workspaceId, status }) => workspaceId === workspaces[index].workspace.id && status === 'sent',
        );
      });
    }
    const event = (id: string, message: Record<string, unknown> = {}, openId = 'ou_allowed') => ({
      app_id: 'cli_monitor',
      sender: { sender_type: 'user', sender_id: { open_id: openId } },
      message: {
        message_id: id, chat_id: 'oc_team', chat_type: 'group', message_type: 'text',
        parent_id: 'om_card_2',
        mentions: [{ key: '@_user_1' }],
        content: JSON.stringify({ text: '@_user_1 请继续\n补充说明' }),
        ...message,
      },
    });
    await receive(event('om_wrong_user', {}, 'ou_other'));
    await receive(event('om_wrong_chat', { chat_id: 'oc_other' }));
    await receive(event('om_plain', { parent_id: undefined }));
    await receive(event('om_unknown_card', { parent_id: 'om_other_card' }));
    assert.equal(reactions.size, 0);
    assert.deepEqual(desks.map(({ sends }) => sends), [0, 0]);

    const store = server.service.notifications.store;
    store.recordLarkReceipt(
      store.config().larkDestination,
      'om_previous_receipt',
      '暂时无法确认发送结果，请在 Monitor 中查看会话和发送回执。',
    );
    await receive(event('om_previous_receipt'));
    await until(() => reactions.has('om_previous_receipt'));
    assert.equal(reactions.get('om_previous_receipt'), 'THINKING');
    assert.deepEqual(desks.map(({ sends }) => sends), [0, 0]);

    const first = event('om_user_reply');
    await Promise.all([receive(first), receive(first)]);
    await until(() => reactions.has('om_user_reply'));
    assert.equal(reactions.get('om_user_reply'), 'CheckMark');
    await receive(first);
    assert.deepEqual(desks.map(({ sends }) => sends), [0, 1]);
    assert.ok(b.hist.prepare("SELECT 1 FROM thread_items WHERE thread_id=? AND item_json LIKE ?")
      .get(ids.modern, '%请继续%补充说明%'));
    assert.equal(b.hist.prepare("SELECT 1 FROM thread_items WHERE item_json LIKE ?")
      .get('%@_user_1%'), undefined);

    desks[1].compacting = true;
    await receive(event('om_addendum', { parent_id: 'om_user_reply', root_id: 'om_card_2' }));
    await until(() => reactions.has('om_addendum'));
    assert.equal(reactions.get('om_addendum'), 'OneSecond');
    assert.equal(desks[1].sends, 1);
    desks[1].compacting = false;
    await until(() => desks[1].sends === 2);

    const prompts = b.hist.prepare(
      "SELECT item_json FROM thread_items WHERE thread_id=? AND item_json LIKE '%lark-%.png%' AND json_extract(item_json, '$.type')='userMessage'",
    );
    const assertImages = () => {
      const inputs = prompts.all(ids.modern).map((row) => JSON.parse(String(row.item_json)).content[0].text as string);
      for (const input of inputs) {
        const files = input.split('\n').filter((line) => line.startsWith('- '));
        for (const file of files) {
          uploadedPaths.add(file.slice(2));
          assert.deepEqual(readFileSync(file.slice(2)), image);
        }
      }
      return inputs;
    };
    await receive(event('om_image', { message_type: 'image', content: JSON.stringify({ image_key: 'img_test' }) }));
    await until(() => reactions.has('om_image'));
    assert.equal(reactions.get('om_image'), 'CheckMark');
    assert.equal(assertImages().length, 1);
    await receive(event('om_post', {
      message_type: 'post',
      content: JSON.stringify({ content: [[{ tag: 'text', text: '看这两张图' }], [
        { tag: 'img', image_key: 'img_test' },
        { tag: 'img', image_key: 'img_second' },
      ]] }),
    }));
    await until(() => reactions.has('om_post'));
    assert.equal(reactions.get('om_post'), 'CheckMark');
    assert.match(assertImages().find((input) => input.includes('看这两张图'))!, /lark-1\.png\n- .*lark-2\.png/);
    for (const imageKey of ['img_missing', 'img_too_large']) {
      const id = 'om_' + imageKey;
      await receive(event(id, { message_type: 'image', content: JSON.stringify({ image_key: imageKey }) }));
      await until(() => reactions.has(id));
      assert.equal(reactions.get(id), 'CrossMark');
    }
    assert.deepEqual(desks.map(({ sends }) => sends), [0, 4]);

    const historicalMessage = (id: string, msgType: string, content: object, sender = 'ou_allowed') => ({
      message_id: id,
      chat_id: 'oc_team',
      msg_type: msgType,
      sender: { id: sender, id_type: 'open_id', sender_type: 'user' },
      body: { content: JSON.stringify(content) },
    });
    historyPages.set('', {
      items: [
        historicalMessage('om_later', 'text', { text: '较晚的消息' }),
        historicalMessage('om_history_reply', 'text', { text: '请分析这些资料' }),
        historicalMessage('om_history_image', 'image', { image_key: 'img_history' }),
      ],
      has_more: true,
      page_token: 'older',
    });
    historyPages.set('older', {
      items: [
        historicalMessage('om_history_file', 'file', { file_key: 'file_history', file_name: '资料.txt' }),
        historicalMessage('om_history_text', 'post', { content: [[
          { tag: 'text', text: '这是此前的说明 ' },
          { tag: 'a', text: '会议记录', href: 'https://example.larksuite.com/docx/DocToken' },
        ]] }),
        historicalMessage('om_other_sender', 'text', { text: '其他人的内容' }, 'ou_other'),
        historicalMessage('om_beyond_boundary', 'text', { text: '边界之外的内容' }),
      ],
    });
    const readState = desks[1].state.bind(desks[1]);
    let stateReads = 0;
    desks[1].state = async (...args) => {
      if (++stateReads === 2) {
        b.hist.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
          .run(ids.modern, 'existing-active-turn', 1001, 'inProgress', Math.floor(Date.now() / 1000), null);
      }
      return readState(...args);
    };
    await receive(event('om_history_reply', {
      create_time: String(Date.now()),
      content: JSON.stringify({
        text: '请分析这些资料 https://example.larksuite.com/docx/DocToken https://larksuite.com.evil.example/docx/Ignore',
      }),
    }));
    await until(() => reactions.has('om_history_reply'));
    assert.equal(reactions.get('om_history_reply'), 'OneSecond');
    assert.equal(desks[1].sends, 4);
    assert.ok(stateReads >= 2);
    assert.ok(downloaded.some((url) => url.endsWith('/om_history_image/resources/img_history')));
    assert.ok(downloaded.some((url) => url.endsWith('/om_history_file/resources/file_history')));

    // Restart the workspace client while the aggregated prompt is still queued.
    await clients.pop()!.close();
    clients.push(await MonitorClient.start({
      config: b.config,
      serverUrl: server.base,
      workspaceId: workspaces[1].workspace.id,
      key: workspaces[1].key,
      services: { control: desks[1] },
    }));
    await until(() => !!clients[1]?.connected);
    b.hist.prepare("UPDATE thread_turns SET status='completed',completed_at=? WHERE turn_id=?")
      .run(Math.floor(Date.now() / 1000), 'existing-active-turn');
    await until(() => desks[1].sends === 5);
    await until(() => !!b.hist.prepare("SELECT 1 FROM thread_items WHERE item_json LIKE '%请分析这些资料%'").get());
    const aggregate = b.hist.prepare(
      "SELECT item_json,turn_id FROM thread_items WHERE thread_id=? AND item_json LIKE '%请分析这些资料%' AND json_extract(item_json, '$.type')='userMessage'",
    ).get(ids.modern)!;
    assert.notEqual(aggregate.turn_id, 'existing-active-turn');
    const combined = JSON.parse(String(aggregate.item_json)).content[0].text as string;
    assert.match(combined, /^这是此前的说明 会议记录\n\n请分析这些资料/);
    assert.doesNotMatch(combined, /较晚的消息|其他人的内容|边界之外的内容/);
    const paths = combined.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
    assert.equal(paths.length, 3);
    for (const path of paths) uploadedPaths.add(path);
    assert.match(paths[0], /会议记录\.docx$/);
    assert.deepEqual(readFileSync(paths[0]), exportedFile);
    assert.match(paths[1], /资料\.txt$/);
    assert.deepEqual(readFileSync(paths[1]), file);
    assert.deepEqual(readFileSync(paths[2]), image);
    assert.deepEqual(exportRequests, [{ token: 'DocToken', type: 'docx', file_extension: 'docx' }]);
    assert.equal(exportPolls, 2);

    await receive(event('om_no_document_access', {
      content: JSON.stringify({ text: 'https://example.larksuite.com/docx/NoAccess' }),
    }));
    await until(() => reactions.has('om_no_document_access'));
    assert.equal(reactions.get('om_no_document_access'), 'CrossMark');
    assert.match(store.larkReceipt(store.config().larkDestination, 'om_no_document_access')!, /无法导出/);
    await receive(event('om_mixed_attachment_failed', {
      message_type: 'post',
      content: JSON.stringify({ content: [[
        { tag: 'img', image_key: 'img_missing' },
        { tag: 'a', text: '会议记录', href: 'https://example.larksuite.com/docx/DocToken' },
      ]] }),
    }));
    await until(() => reactions.has('om_mixed_attachment_failed'));
    assert.match(store.larkReceipt(store.config().larkDestination, 'om_mixed_attachment_failed')!, /无法读取或保存/);
    assert.equal(desks[1].sends, 5);

    await receive(event('om_revoked', {
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_slow' }),
    }));
    await until(() => !!slowImageSignal);
    assert.equal((await save(['ou_replacement'])).status, 200);
    assert.equal(slowImageSignal?.aborted, true);
    assert.equal(reactions.has('om_revoked'), false);
    assert.equal(desks[1].sends, 5);
    assert.equal((await save(['ou_allowed'])).status, 200);

    await clients.pop()!.close();
    await until(() => !server.service.gateway.list().find((item) => item.id === workspaces[1].workspace.id)?.online);
    await receive(event('om_offline'));
    await until(() => reactions.has('om_offline'));
    assert.equal(reactions.get('om_offline'), 'CrossMark');

    assert.equal((await save([])).status, 200);
    assert.equal(closed, true);
    await receive(event('om_disabled'));
    assert.equal(reactions.has('om_disabled'), false);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    for (const file of uploadedPaths) unlinkSync(file);
    for (const item of [a, b]) {
      item.state.close();
      item.hist.close();
      rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test('Lark app settings send cards, native images and files from a remote workspace', async () => {
  const f = fixture();
  const project = path.join(f.root, 'project');
  mkdirSync(project);
  f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(project, ids.modern);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xf2sAAAAASUVORK5CYII=',
    'base64',
  );
  const report = Buffer.alloc(120000, 'a');
  writeFileSync(path.join(project, 'shot.png'), png);
  writeFileSync(path.join(project, '测试报告.txt'), report);
  writeFileSync(path.join(project, '.env'), 'PRIVATE_VALUE');
  f.config.pollMs = 40;
  const uploads: { name: string; data: Buffer }[] = [];
  const messages: { receive_id: string; uuid: string; msg_type: string; content: string }[] = [];
  let tokenRequests = 0;
  const server = await central(f, async (url, init) => {
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin, 'https://open.larksuite.com');
    if (endpoint.pathname.includes('/auth/')) {
      tokenRequests++;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        app_id: 'cli_monitor',
        app_secret: 'server-only-app-secret',
      });
      return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tenant-token');
    if (endpoint.pathname.endsWith('/messages')) {
      assert.equal(endpoint.searchParams.get('receive_id_type'), 'chat_id');
      messages.push(JSON.parse(String(init?.body)));
      return Response.json({ code: 0 });
    }
    assert.ok(init?.body instanceof FormData);
    const image = endpoint.pathname.endsWith('/images');
    const file = init.body.get(image ? 'image' : 'file');
    assert.ok(file instanceof File);
    assert.equal(init.body.get(image ? 'image_type' : 'file_type'), image ? 'message' : 'stream');
    uploads.push({ name: file.name, data: Buffer.from(await file.arrayBuffer()) });
    return Response.json({
      code: 0,
      data: image ? { image_key: 'img_test' } : { file_key: 'file_test' },
    });
  });
  let client: MonitorClient | undefined;
  try {
    const owner = await server.service.auth.setup('owner', 'central-notification-password');
    const headers = {
      Authorization: `Bearer ${server.service.auth.issue(owner, 'test').token}`,
      'Content-Type': 'application/json',
    };
    const save = (enabled: boolean, appSecret?: string) =>
      fetch(server.base + '/api/notifications', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          provider: 'lark',
          mode: 'app',
          appRegion: 'lark',
          appId: 'cli_monitor',
          appSecret,
          chatId: 'oc_team',
          enabled,
          completionMode: 'all',
          publicUrl: '',
        }),
      });
    assert.equal((await save(true)).status, 400);
    const saved = await save(false, 'server-only-app-secret');
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.doesNotMatch(body, /server-only-app-secret/);
    assert.equal(JSON.parse(body).settings.appSecretConfigured, true);
    const tested = await fetch(server.base + '/api/notifications/test', {
      method: 'POST',
      headers,
    });
    assert.equal(tested.status, 200, await tested.text());
    assert.deepEqual(
      messages.map((item) => item.msg_type),
      ['interactive', 'file'],
    );
    assert.equal(uploads[0].name, 'codex-monitor-test.txt');

    const work = server.service.gateway.store.create('远程电脑');
    client = await MonitorClient.start({
      config: f.config,
      serverUrl: server.base,
      workspaceId: work.workspace.id,
      key: work.key,
    });
    await until(() => !!client?.connected);
    assert.equal((await save(true)).status, 200);
    complete(
      f,
      'app-turn',
      [
        '![截图](shot.png) [配置](.env) [截图副本](shot.png)',
        '正文'.repeat(600),
        '[测试报告](测试报告.txt) [代码](secret.txt#L3) [网页](https://example.com/artifact)',
      ].join('\n\n'),
    );
    await until(async () => {
      await server.service.notifications.poll();
      return server.service.notifications.store
        .history()
        .some(
          (delivery) => delivery.workspaceId === work.workspace.id && delivery.status === 'sent',
        );
    });
    assert.equal(tokenRequests, 1);
    assert.ok(messages.every((item) => item.receive_id === 'oc_team' && item.uuid.length <= 50));
    assert.deepEqual(
      messages.slice(2).map((item) => item.msg_type),
      ['interactive', 'image', 'file'],
    );
    assert.match(messages[2].content, /截图/);
    assert.doesNotMatch(messages[2].content, /shot\.png|\.env/);
    assert.deepEqual(JSON.parse(messages[3].content), { image_key: 'img_test' });
    assert.deepEqual(JSON.parse(messages[4].content), { file_key: 'file_test' });
    assert.deepEqual(uploads.slice(1), [
      { name: 'shot.png', data: png },
      { name: '测试报告.txt', data: report },
    ]);
    assert.match(server.service.notifications.store.history()[0].error, /部分附件无法读取/);
  } finally {
    await client?.close();
    await server.close();
    f.state.close();
    f.hist.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Server owns one configuration and delivers events from two encrypted clients with workspace-scoped identities', async () => {
  const a = fixture(),
    b = fixture();
  a.config.pollMs = b.config.pollMs = 40;
  const received: any[] = [];
  const receiver = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"code":0}');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const server = await central(a, (url, init) => {
    assert.equal(url, webhook);
    return fetch(`http://127.0.0.1:${(receiver.address() as { port: number }).port}`, init);
  });
  const clients: MonitorClient[] = [];
  try {
    const owner = await server.service.auth.setup('owner', 'central-notification-password');
    const headers = {
      Authorization: `Bearer ${server.service.auth.issue(owner, 'test').token}`,
      'Content-Type': 'application/json',
    };
    // Settings and test delivery are available before any workspace has connected.
    assert.equal((await fetch(server.base + '/api/notifications')).status, 401);
    const saved = await fetch(server.base + '/api/notifications', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...settings, enabled: false }),
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /server-only-signing-secret|aaaaaaaa-bbbb/);
    assert.equal(
      (await fetch(server.base + '/api/notifications/test', { method: 'POST', headers })).status,
      200,
    );
    assert.equal(received.length, 1);

    // Upgrade retires a previous remote client's sender and clears its provider credentials.
    const legacy = new AuthStore(a.config.dataDir);
    const oldNotifications = new NotificationStore(legacy.db);
    oldNotifications.save(
      { ...settings, webhookUrl: webhook.replace('aaaaaaaa', 'bbbbbbbb') },
      Date.now(),
      true,
    );
    oldNotifications.enqueue(
      { key: 'old', kind: 'session.completed', title: 'old', message: 'old' },
      1,
    );
    legacy.close();
    const wa = server.service.gateway.store.create('电脑 A'),
      wb = server.service.gateway.store.create('电脑 B');
    for (const [f, workspace] of [
      [a, wa],
      [b, wb],
    ] as const)
      clients.push(
        await MonitorClient.start({
          config: f.config,
          serverUrl: server.base,
          workspaceId: workspace.workspace.id,
          key: workspace.key,
        }),
      );
    await until(() => clients.every((client) => client.connected));
    await server.service.notifications.configure(settings);
    const clientDb = new DatabaseSync(path.join(a.config.dataDir, 'monitor.sqlite'), {
      readOnly: true,
    });
    try {
      const retired = clientDb
        .prepare('SELECT enabled,webhook_url,signing_secret FROM notification_settings')
        .get()!;
      assert.equal(retired.enabled, 0);
      assert.equal(retired.webhook_url, '');
      assert.equal(retired.signing_secret, '');
      assert.equal(
        clientDb.prepare('SELECT status FROM notification_deliveries WHERE event_key=?').get('old')!
          .status,
        'cancelled',
      );
    } finally {
      clientDb.close();
    }
    assert.equal(
      (await fetch(`${server.base}/api/workspaces/${wa.workspace.id}/notifications`, { headers }))
        .status,
      404,
    );

    const turnId = randomUUID();
    const longReply =
      'A 的完成结果\n\n' +
      '处理记录。'.repeat(250) +
      '\n\n[结果说明](https://example.com/result)';
    complete(a, turnId, longReply);
    complete(b, turnId, 'B 的完成结果');
    await until(
      () =>
        server.service.notifications
          .state()
          .deliveries.filter((d) => d.kind === 'session.completed').length === 2,
    );
    await server.service.notifications.poll();
    await server.service.notifications.poll();
    assert.equal(received.length, 3, 'both clients use the server transport');
    const deliveries = server.service.notifications
      .state()
      .deliveries.filter((d) => d.kind === 'session.completed');
    assert.deepEqual(
      new Set(deliveries.map((d) => d.workspaceId)),
      new Set([wa.workspace.id, wb.workspace.id]),
    );
    assert.ok(deliveries.every((d) => d.status === 'sent'));
    assert.ok(
      received.some(
        (message) =>
          message.card.body.elements[0].content.includes('电脑 A') &&
          message.card.body.elements[0].content.endsWith(longReply) &&
          message.card.body.elements[0].content.includes(`workspace=${wa.workspace.id}`),
      ),
    );
    assert.ok(
      received.some(
        (message) =>
          message.card.body.elements[0].content.includes('电脑 B') &&
          message.card.body.elements[0].content.includes('B 的完成结果') &&
          message.card.body.elements[0].content.includes(`workspace=${wb.workspace.id}`),
      ),
    );
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    for (const f of [a, b]) {
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('lost report acknowledgements replay safely after both sides restart and Server retries with Client stopped', async () => {
  const f = fixture();
  f.config.pollMs = 60000;
  let calls = 0;
  const transport: WebhookTransport = async () =>
    Response.json({ code: 0 }, { status: ++calls === 1 ? 503 : 200 });
  let server = await central(f, transport);
  let client: MonitorClient | undefined;
  try {
    const workspace = server.service.gateway.store.create('持久上报测试');
    client = await MonitorClient.start({
      config: f.config,
      serverUrl: server.base,
      workspaceId: workspace.workspace.id,
      key: workspace.key,
      reconnectMs: 5000,
    });
    await until(() => client!.connected);
    await server.service.notifications.configure(settings);
    const receive = server.service.notifications.receive.bind(server.service.notifications);
    let dropped = false;
    server.service.notifications.receive = (origin, report) => {
      const accepted = receive(origin, report);
      if (!dropped && report.events.some((event) => event.kind === 'session.completed')) {
        dropped = true;
        server.service.gateway.disconnect(origin.id); // Durable insert succeeded; its acknowledgement is lost.
      }
      return accepted;
    };
    complete(f, randomUUID(), '确认丢失后也只推送一次');
    await until(async () => {
      await client!.notifications.poll();
      return dropped && !client!.connected;
    });
    assert.equal(client.notifications.store.pending().length, 1);
    await client.close();
    client = undefined;
    await server.service.notifications.poll();
    assert.equal(server.service.notifications.state().deliveries[0].status, 'pending');
    assert.equal(calls, 1);
    const port = server.port;
    await server.close();
    server = await central(f, transport, port);
    client = await MonitorClient.start({
      config: f.config,
      serverUrl: server.base,
      workspaceId: workspace.workspace.id,
      key: workspace.key,
    });
    await until(() => client!.connected && client!.notifications.store.pending().length === 0);
    assert.equal(
      server.service.notifications.state().deliveries.length,
      1,
      'replayed event is deduplicated durably',
    );
    await client.close();
    client = undefined;
    server.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await server.service.notifications.poll();
    assert.equal(calls, 2);
    assert.equal(server.service.notifications.state().deliveries[0].status, 'sent');
    assert.equal(server.service.notifications.state().deliveries[0].attempts, 2);
  } finally {
    await client?.close();
    await server.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('notification frames carry bounded events only and cannot override the authenticated workspace or destination', () => {
  const frame = {
    type: 'notification-report',
    id: randomUUID(),
    report: {
      revision: 1,
      monitorError: '',
      events: [
        {
          kind: 'session.completed',
          sessionId: ids.modern,
          title: '完成',
          project: '测试',
          turnId: 'turn-1',
          occurredAt: Date.now(),
          summary: '结果',
        },
      ],
    },
  };
  assert.ok(frameSchema.safeParse(frame).success);
  assert.equal(
    frameSchema.safeParse({ ...frame, report: { ...frame.report, webhookUrl: webhook } }).success,
    false,
  );
  assert.equal(
    frameSchema.safeParse({
      ...frame,
      report: {
        ...frame.report,
        events: [{ ...frame.report.events[0], workspaceId: randomUUID() }],
      },
    }).success,
    false,
  );
  assert.equal(
    frameSchema.safeParse({
      ...frame,
      report: { ...frame.report, events: Array(5).fill(frame.report.events[0]) },
    }).success,
    false,
  );
  assert.equal(workspacePath('GET', '/api/notifications'), false);
  assert.equal(workspacePath('POST', '/api/notifications/test'), false);
});

test('upgrading an existing standalone database preserves its configuration, pending deliveries and deduplication keys', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE notification_settings (
      id INTEGER PRIMARY KEY, enabled INTEGER, webhook_url TEXT, signing_secret TEXT, public_url TEXT,
      enabled_at INTEGER, scan_at INTEGER, revision INTEGER, input_since INTEGER
    );
    CREATE TABLE notification_deliveries (
      id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT, session_id TEXT, title TEXT, message TEXT,
      status TEXT, attempts INTEGER, error TEXT, created_at INTEGER, sent_at INTEGER, next_attempt_at INTEGER, revision INTEGER
    );`);
    db.prepare('INSERT INTO notification_settings VALUES(1,1,?,?,?,1000,2000,7,1001)').run(
      webhook,
      settings.signingSecret,
      settings.publicUrl,
    );
    db.prepare(
      "INSERT INTO notification_deliveries VALUES('old','session:turn','session.completed','session','title','body','pending',1,'',1000,NULL,5000,7)",
    ).run();
    let store = new NotificationStore(db);
    assert.equal(store.config().webhookUrl, webhook);
    assert.equal(store.config().signingSecret, settings.signingSecret);
    assert.equal(store.config().revision, 7);
    assert.equal(store.has('local:session:turn'), true);
    assert.equal(store.history()[0].status, 'pending');
    assert.equal(store.history()[0].workspaceId, 'local');
    assert.equal(store.history()[0].attempts, 1);
    store = new NotificationStore(db);
    assert.equal(store.has('local:session:turn'), true, 'migration does not namespace a key twice');
    assert.equal(store.has('local:local:session:turn'), false);
  } finally {
    db.close();
  }
});
