import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopBridge, ControlError } from '../server/desktop.js';
import { CodexSource } from '../server/source.js';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';

async function desktop(reply: (tool: string, args: any) => unknown) {
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\monitor-state-test-${randomUUID()}`
      : path.join(os.tmpdir(), `monitor-state-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4 || bytes.length < bytes.readUInt32LE() + 4) return;
      const request = JSON.parse(bytes.subarray(4).toString());
      const result = reply(request.params.tool, request.params.arguments);
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            success: true,
            contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
          },
        }),
      );
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      socket.end(frame);
    });
  });
  server.listen(pipe);
  await once(server, 'listening');
  return {
    pipe,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('oversized turn contents cannot disable control, live status, or compaction queuing', async () => {
  const f = fixture();
  f.hist.exec(
    "ALTER TABLE thread_items ADD COLUMN item_type TEXT; UPDATE thread_items SET item_type=json_extract(item_json,'$.type')",
  );
  // A body over the native history limit must never be read or parsed by a
  // status check. Deliberately invalid JSON also detects accidental parsing.
  f.hist
    .prepare(
      'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,item_json,item_type) VALUES(?,?,?,?,?,?)',
    )
    .run(
      ids.modern,
      'turn-1',
      'large-tool',
      1000,
      'unparsed:' + 'x'.repeat(20 * 1024 * 1024),
      'mcpToolCall',
    );
  const source = new CodexSource(f.home);
  let status = 'active',
    sends = 0;
  const tools: string[] = [];
  const remote = await desktop((tool, args) => {
    tools.push(tool);
    if (tool === 'send_message_to_thread') {
      sends++;
      return { threadId: args.threadId };
    }
    assert.equal(tool, 'list_threads');
    return { threads: [{ id: ids.modern, kind: 'codex', hostId: 'local', status }] };
  });
  const bridge = new DesktopBridge({ pipe: remote.pipe, activity: (id) => source.activity(id) });
  const application = createApp(f.config, { control: bridge });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const token = application.auth.issue(
    await application.auth.setup('owner', 'a-long-password'),
    'large-turn-test',
  ).token;
  const api = (route: string, body?: object) =>
    fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const controlRoute = `/api/sessions/${ids.modern}/control`;
  const sendRoute = `/api/sessions/${ids.modern}/messages`;
  try {
    assert.deepEqual(await bridge.state(ids.modern, ids.modern), {
      status: 'active',
      turnId: 'turn-1',
      compacting: false,
    });
    assert.equal((await (await api(controlRoute)).json()).running, true);
    const append = await api(sendRoute, { requestId: randomUUID(), prompt: 'append to long turn' });
    assert.equal(append.status, 200);
    assert.equal((await append.json()).mode, 'append');
    assert.equal(sends, 1);

    // Persisted inProgress alone must not override the desktop's live state.
    status = 'notLoaded';
    assert.equal((await (await api(controlRoute)).json()).available, false);
    assert.equal(
      (await api(sendRoute, { requestId: randomUUID(), prompt: 'must not send' })).status,
      409,
    );
    assert.equal(sends, 1);
    status = 'idle';
    const idle = await api(sendRoute, { requestId: randomUUID(), prompt: 'continue idle' });
    assert.equal(idle.status, 200);
    assert.equal((await idle.json()).mode, 'start');
    assert.equal(sends, 2);

    f.hist
      .prepare(
        'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,item_type) VALUES(?,?,?,?,?)',
      )
      .run(ids.modern, 'turn-1', 'compact', 1001, 'contextCompaction');
    status = 'active';
    assert.equal((await (await api(controlRoute)).json()).compacting, true);
    const requestId = randomUUID();
    const queued = await api(sendRoute, { requestId, prompt: 'wait for compaction' });
    assert.equal(queued.status, 202);
    assert.equal((await queued.json()).state, 'queued');
    assert.equal(sends, 2);
    assert.equal(
      (await (await api(`/api/control/requests/${requestId}/cancel`, {})).json()).state,
      'cancelled',
    );
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    assert.equal((await bridge.state(ids.modern, ids.modern)).compacting, false);
    assert.ok(!tools.includes('read_thread'));
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await remote.close();
    source.close();
    f.close();
    assert.ok(path.resolve(f.root).startsWith(path.join(os.tmpdir(), 'codex-monitor-test-')));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('live state follows list pagination and rejects missing, remote, and unrecognized state', async () => {
  let mode = 'paged';
  const calls: any[] = [];
  const remote = await desktop((tool, args) => {
    assert.equal(tool, 'list_threads');
    assert.equal(args.mode, 'history');
    assert.equal(args.source, 'codex');
    assert.equal(args.hostId, 'local');
    assert.equal(args.archived, false);
    calls.push(args);
    if (mode === 'loop') return { threads: [], nextCursor: 'repeated' };
    if (mode === 'missing') return { threads: [] };
    if (mode === 'remote')
      return { threads: [{ id: ids.modern, kind: 'codex', hostId: 'other', status: 'active' }] };
    if (mode === 'unknown')
      return {
        threads: [{ id: ids.modern, kind: 'codex', hostId: 'local', status: 'unexpected' }],
      };
    return args.cursor
      ? { threads: [{ id: ids.modern, kind: 'codex', hostId: 'local', status: 'active' }] }
      : {
          threads: [{ id: ids.legacy, kind: 'codex', hostId: 'local', status: 'idle' }],
          nextCursor: 'older',
        };
  });
  const bridge = new DesktopBridge({ pipe: remote.pipe });
  try {
    assert.equal((await bridge.state(ids.modern, ids.modern)).status, 'active');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cursor, 'older');
    for (mode of ['missing', 'remote', 'unknown', 'loop'])
      await assert.rejects(
        bridge.state(ids.modern, ids.modern),
        (error: unknown) => error instanceof ControlError && !error.uncertain,
      );
  } finally {
    bridge.close();
    await remote.close();
  }
});

test('legacy item schemas preserve compaction detection and only use the newest turn', () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  try {
    assert.equal(source.activity(ids.legacy), undefined);
    f.hist
      .prepare(
        'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,item_json) VALUES(?,?,?,?,?)',
      )
      .run(
        ids.modern,
        'turn-1',
        'compact-old',
        1000,
        JSON.stringify({ type: 'context_compaction' }),
      );
    assert.equal(source.activity(ids.modern)?.compacting, true);
    f.hist
      .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
      .run(ids.modern, 'turn-2', 2000, 'inProgress', Date.now(), null);
    assert.deepEqual(source.activity(ids.modern), { turnId: 'turn-2', compacting: false });
    f.hist
      .prepare(
        'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,item_json) VALUES(?,?,?,?,?)',
      )
      .run(
        ids.modern,
        'turn-2',
        'compact-new',
        2001,
        JSON.stringify({ type: 'contextCompaction' }),
      );
    assert.equal(source.activity(ids.modern)?.compacting, true);
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE turn_id='turn-2'").run();
    assert.equal(source.activity(ids.modern)?.compacting, false);
  } finally {
    source.close();
    f.close();
    assert.ok(path.resolve(f.root).startsWith(path.join(os.tmpdir(), 'codex-monitor-test-')));
    rmSync(f.root, { recursive: true, force: true });
  }
});
