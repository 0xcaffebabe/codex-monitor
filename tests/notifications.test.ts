import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { createApp } from '../server/app.js';
import { notificationMessage } from '../server/notifications/messages.js';
import {
  LarkDeliveryError,
  larkCard,
  larkRequest,
  type LarkTransport,
} from '../server/notifications/lark.js';
import { fixture, ids } from './fixture.js';

const input = {
  completionMode: 'all',
  enabled: true,
  provider: 'lark',
  appId: 'cli_monitor',
  appSecret: 'test-app-secret',
  replyOpenIds: ['ou_test'],
  publicUrl: 'https://monitor.example.com/',
} satisfies import('../server/notifications/store.js').NotificationInput & { provider: 'lark' };

function complete(
  f: ReturnType<typeof fixture>,
  threadId = ids.modern,
  status = 'completed',
  text = '本轮已完成',
) {
  const turnId = randomUUID(),
    now = Math.floor(Date.now() / 1000);
  const ordinal = Number(
    f.hist
      .prepare('SELECT COALESCE(MAX(rollout_ordinal),0)+1 AS n FROM thread_turns WHERE thread_id=?')
      .get(threadId)!.n,
  );
  f.hist
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(threadId, turnId, ordinal, status, now - 5, now);
  f.hist
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
    .run(
      threadId,
      turnId,
      randomUUID(),
      ordinal,
      Date.now(),
      JSON.stringify({ type: 'agentMessage', phase: 'final_answer', text }),
      null,
      null,
    );
  return turnId;
}

function appTransport(transport: LarkTransport): LarkTransport {
  return async (url, init) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname.endsWith('/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (endpoint.pathname.endsWith('/files'))
      return Response.json({ code: 0, data: { file_key: 'file_test' } });
    if (JSON.parse(String(init?.body)).msg_type === 'file')
      return Response.json({ code: 0 });
    assert.equal(endpoint.searchParams.get('receive_id_type'), 'open_id');
    return transport(url, init);
  };
}

async function harness(transport: LarkTransport) {
  const f = fixture();
  f.config.pollMs = 60000;
  const service = createApp(f.config, { larkTransport: appTransport(transport) });
  const user = await service.auth.setup('owner', 'notification-test-password');
  const token = service.auth.issue(user, 'notification test').token;
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (url: string, method = 'GET', body?: unknown, credential = token) =>
    fetch(base + url, {
      method,
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    f,
    service,
    request,
    async close() {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    },
  };
}

test('Lark transport rejects redirects and masks failed requests', async () => {
  const endpoint = 'https://open.larksuite.com/open-apis/im/v1/messages';
  const signal = new AbortController().signal;
  await assert.rejects(
    larkRequest(endpoint, {}, signal, async (_url, init) => {
      assert.equal(init?.redirect, 'error');
      throw new Error('private request details');
    }),
    (error) => {
      assert.ok(error instanceof LarkDeliveryError && error.retryable);
      assert.doesNotMatch(error.message, /private request details/);
      return true;
    },
  );
  await assert.rejects(
    larkRequest(endpoint, {}, signal, async () => new Response('invalid')),
    LarkDeliveryError,
  );
});

test('Lark Markdown cards preserve formatting and code while neutralizing mention tags', () => {
  const markdown = [
    '# 完成结果',
    '',
    '**加粗**、*斜体*、~~删除线~~、`行内代码`',
    '',
    '- 列表项',
    '  - 子列表',
    '',
    '> 引用内容',
    '',
    '[查看文档](https://example.com/docs?a=1&b=2)',
    '<https://example.com/>',
    '',
    '```bash',
    'if [ "$count" -gt 0 ]; then echo "<result>" > output.txt; fi',
    '```',
    '',
    '| 项目 | 状态 |',
    '| --- | --- |',
    '| 检查 | 完成 |',
  ].join('\n');
  const card = larkCard(
    markdown + '\n<at id=all></at> <at user_id="someone">用户</at> <AT id=all></AT>',
  );
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].tag, 'markdown');
  assert.equal(
    card.body.elements[0].content,
    markdown + '\n＜at id=all＞＜/at＞ ＜at user_id="someone"＞用户＜/at＞ ＜AT id=all＞＜/AT＞',
  );
});

test('session links remain clickable when the reply summary ends in a truncated code block', () => {
  const summary = '**执行结果**\n\n```bash\necho "内容未完';
  const message = notificationMessage(
    {
      kind: 'session.completed',
      sessionId: ids.modern,
      title: 'Markdown 通知',
      project: '测试项目',
      turnId: 'markdown-turn',
      occurredAt: Date.now(),
      summary,
    },
    { id: 'local', name: '本机工作空间' },
    'https://monitor.example.com/path(with-parentheses)',
  );
  const parsed = fromMarkdown(message);
  const link = parsed.children
    .flatMap((node) => (node.type === 'paragraph' ? node.children : []))
    .find((node) => node.type === 'link');
  assert.equal(
    link?.url,
    `https://monitor.example.com/path(with-parentheses)?session=${ids.modern}&workspace=local&view=attention&result=markdown-turn`,
  );
  assert.ok(message.endsWith(summary));
  const code = parsed.children.find((node) => node.type === 'code');
  assert.equal(code?.value, 'echo "内容未完');
});

test('card capacity accounts for captions after converting Markdown images', () => {
  const link = '[查看本轮结果](https://monitor.example.com/)';
  const text = `${link}\n\n${'![要点摘要](/a)\n\n'.repeat(1500)}`;
  const card = larkCard(text);
  const content = card.body.elements[0].content;
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 20 * 1024);
  assert.ok(content.startsWith(`${link}\n\n要点摘要`));
  assert.ok(content.endsWith('…（回复过长，部分内容已省略）'));
});

test('notification APIs enforce admin access, validation, secret masking, test result and throttling', async () => {
  let requests = 0;
  const h = await harness(async () => {
    requests++;
    return Response.json({ code: 0 });
  });
  try {
    const viewerId = randomUUID();
    h.service.auth.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run(viewerId, 'viewer', 'unused', 'viewer', Date.now());
    const viewer = h.service.auth.issue(
      { id: viewerId, username: 'viewer', role: 'viewer' },
      'viewer',
    ).token;
    for (const credential of ['', viewer]) {
      const expected = credential ? 403 : 401;
      for (const [url, method, body] of [
        ['/api/notifications', 'GET', undefined],
        ['/api/notifications', 'PUT', input],
        ['/api/notifications/test', 'POST', {}],
      ] as const)
        assert.equal((await h.request(url, method, body, credential)).status, expected);
    }
    assert.equal((await h.request('/api/notifications/test', 'POST', {})).status, 400);
    assert.equal(
      (
        await h.request('/api/notifications', 'PUT', {
          ...input,
          webhookUrl: 'http://localhost/hook',
        })
      ).status,
      400,
    );
    assert.equal(
      (await h.request('/api/notifications', 'PUT', { ...input, publicUrl: 'javascript:alert(1)' }))
        .status,
      400,
    );
    const saved = await h.request('/api/notifications', 'PUT', input);
    assert.equal(saved.status, 200);
    const state = await saved.json();
    assert.equal(state.settings.appSecretConfigured, true);
    assert.doesNotMatch(JSON.stringify(state), /test-app-secret/);
    assert.equal((await h.request('/api/notifications/test', 'POST', {})).status, 200);
    assert.equal((await h.request('/api/notifications/test', 'POST', {})).status, 429);
    assert.equal(requests, 1);
    assert.equal(h.service.notifications.state().deliveries[0].status, 'sent');
    assert.equal(
      (
        await h.request('/api/notifications', 'PUT', {
          enabled: false,
          provider: 'lark',
          publicUrl: '',
        })
      ).status,
      200,
    );
    assert.equal(h.service.notifications.store.config().appSecret, input.appSecret);
  } finally {
    await h.close();
  }
});

test('background completion outbox delivers fast turns over real HTTP without SSE and deduplicates after restart', async () => {
  const received: any[] = [];
  const receiver = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const message = JSON.parse(body);
    received.push({ ...message, card: JSON.parse(message.content) });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"code":0}');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const transport: LarkTransport = (_url, init) =>
    fetch(`http://127.0.0.1:${(receiver.address() as { port: number }).port}`, init);
  const h = await harness(transport);
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    complete(h.f); // Completion already present in the enabling second must be ignored.
    assert.equal((await h.request('/api/notifications', 'PUT', input)).status, 200);
    await h.service.pollNotifications();
    assert.equal(received.length, 0);
    const summary = [
      '**第一轮完成摘要**',
      '检查记录与日志一致。'.repeat(110),
      '| 时间 | 结果 |\n| --- | --- |\n| 10:36 | 完成 |',
      '```bash\necho "完成" > result.txt\n```',
      '[微软说明](https://learn.microsoft.com/windows/)\n\n第一轮结论。',
    ].join('\n\n');
    const first = complete(h.f, ids.modern, 'completed', summary);
    const second = complete(h.f, ids.modern, 'completed', '第二轮独立摘要');
    complete(h.f, ids.modern, 'failed');
    complete(h.f, ids.legacy, 'interrupted');
    complete(h.f, ids.child);
    complete(h.f, ids.archived);
    await h.service.pollNotifications();
    await h.service.pollNotifications();
    await h.service.pollNotifications();
    assert.equal(received.length, 2);
    assert.equal(received[0].msg_type, 'interactive');
    assert.equal(received[0].card.schema, '2.0');
    assert.deepEqual(received[0].card.header, {
      title: { tag: 'plain_text', content: 'Codex 本轮已结束' },
      template: 'green',
    });
    const [{ content }] = received[0].card.body.elements;
    assert.deepEqual(received[0].card.body.elements.map(({ tag }: { tag: string }) => tag), ['markdown', 'form', 'column_set']);
    assert.match(content, /^\*\*工作空间\*\* .+\n\*\*会话\*\* .+\n\*\*项目\*\* .+\n\*\*完成时间\*\* .+/);
    assert.match(content, new RegExp(`result=${first}`));
    assert.ok(content.endsWith(`\n\n**回复内容**\n\n${summary}`));
    assert.doesNotMatch(content, /本轮已结束|第二轮独立摘要/);
    assert.match(received[1].card.body.elements[0].content, new RegExp(`result=${second}`));
    assert.match(
      received[1].card.body.elements[0].content,
      /https:\/\/monitor.example.com\/\?session=/,
    );
    assert.equal(h.service.notifications.state().deliveries.length, 2);
    await h.service.close();
    complete(h.f, ids.modern, 'completed', '服务停止期间完成');
    restarted = createApp(h.f.config, { larkTransport: appTransport(transport) });
    await restarted.pollNotifications();
    await restarted.pollNotifications();
    assert.equal(received.length, 3);
    assert.match(received[2].card.body.elements[0].content, /服务停止期间完成/);
    assert.equal(restarted.notifications.state().settings.enabled, true);
    assert.equal(
      restarted.notifications.state().deliveries.filter((d) => d.status === 'sent').length,
      3,
    );
  } finally {
    await restarted?.close();
    await h.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

test('delivery retry is persisted, provider rejection fails visibly, disabling cancels queued work', async () => {
  let status = 503,
    calls = 0;
  const h = await harness(async () => {
    calls++;
    return Response.json({ code: status === 200 ? 19024 : 0 }, { status });
  });
  try {
    await h.service.notifications.configure(input);
    complete(h.f);
    await h.service.pollNotifications();
    let delivery = h.service.notifications.state().deliveries[0];
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 1);
    await h.service.pollNotifications();
    assert.equal(calls, 1, 'retry respects its backoff');
    h.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    status = 200;
    await h.service.pollNotifications();
    delivery = h.service.notifications.state().deliveries[0];
    assert.equal(delivery.status, 'failed');
    assert.match(delivery.error, /19024/);
    complete(h.f);
    status = 503;
    await h.service.pollNotifications();
    await h.service.notifications.configure({ ...input, enabled: false });
    assert.equal(h.service.notifications.state().deliveries[0].status, 'cancelled');
    const before = calls;
    complete(h.f);
    await h.service.pollNotifications();
    assert.equal(calls, before);
    await h.service.notifications.configure(input);
    await h.service.pollNotifications();
    assert.equal(
      calls,
      before,
      'reenabling does not backfill completions from the disabled interval',
    );
  } finally {
    await h.close();
  }
});

test('legacy JSONL completion events work without opening a detail page', async () => {
  const messages: string[] = [];
  const h = await harness(async (_url, init) => {
    messages.push(JSON.parse(JSON.parse(String(init!.body)).content).body.elements[0].content);
    return Response.json({ code: 0 });
  });
  try {
    await h.service.notifications.configure(input);
    const file = path.join(h.f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
    appendFileSync(
      file,
      [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'legacy-new-turn' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  '[旧版完成摘要](https://example.com/result)\n\n' +
                  '```text\n' +
                  '超长内容😀\n'.repeat(2000) +
                  '```\n\n代码块后续内容',
              },
            ],
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'legacy-new-turn' } },
      ]
        .map((record) => JSON.stringify({ ...record, timestamp: new Date().toISOString() }))
        .join('\n') + '\n',
    );
    await h.service.pollNotifications();
    await h.service.pollNotifications();
    assert.equal(messages.length, 1);
    assert.ok(
      messages[0].endsWith(
        '[旧版完成摘要](https://example.com/result)\n\n…（回复过长，部分内容已省略）',
      ),
    );
    assert.match(messages[0], /result=legacy-new-turn/);
  } finally {
    await h.close();
  }
});

test('queued retries survive restart and still deliver while the completion source is unavailable', async () => {
  let calls = 0;
  const transport: LarkTransport = async () =>
    Response.json({ code: 0 }, { status: ++calls === 1 ? 503 : 200 });
  const h = await harness(transport);
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    await h.service.notifications.configure(input);
    complete(h.f);
    await h.service.pollNotifications();
    assert.equal(h.service.notifications.state().deliveries[0].status, 'pending');
    await h.service.close();
    restarted = createApp(h.f.config, { larkTransport: appTransport(transport) });
    await restarted.pollNotifications();
    restarted.source.completions = async () => {
      throw new Error('Source temporarily unavailable');
    };
    restarted.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await restarted.pollNotifications();
    assert.equal(calls, 2);
    assert.equal(restarted.notifications.state().deliveries[0].status, 'sent');
    assert.ok(restarted.notifications.state().settings.monitorError);
  } finally {
    await restarted?.close();
    await h.close();
  }
});

test('admin revocation during asynchronous notification authorization prevents saving or enabling it', async () => {
  const h = await harness(async () => Response.json({ code: 0 }));
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const user = h.service.auth.db.prepare("SELECT * FROM users WHERE username='owner'").get()!;
    const token = h.service.auth.issue(
      { id: String(user.id), username: 'owner', role: 'admin' },
      'revoked',
    ).token;
    const pending = h.service.notifications.configure(input, async () => {
      entered();
      await wait;
      return h.service.auth.authenticate(token)?.user.role === 'admin';
    });
    const rejected = assert.rejects(pending, /权限已失效/);
    await started;
    h.service.auth.db.prepare('DELETE FROM sessions').run();
    release();
    await rejected;
    assert.equal(h.service.notifications.state().settings.enabled, false);
    assert.equal(h.service.notifications.state().settings.appSecretConfigured, false);
  } finally {
    release();
    await h.close();
  }
});
