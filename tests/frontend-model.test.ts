import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTimelineEvents, mergeSessionPage } from '../src/features/session/session-model.js';
import {
  mergeWorkspaceSessions,
  runningProjects,
  sessionRows,
  type WorkspaceSession,
} from '../src/features/workspace/session-list-model.js';
import type { Session, SessionPage, TimelineEvent } from '../src/types.js';
import { relative } from '../src/shared/format.js';

test('activity time shows seconds on request and crosses minute and hour boundaries', () => {
  const now = new Date(2026, 10, 16, 12).getTime();
  const activity = (age: number) => relative(now - age, { now, seconds: true });
  assert.equal(activity(-1000), '刚刚');
  assert.equal(activity(999), '刚刚');
  assert.equal(activity(1000), '1 秒前');
  assert.equal(activity(59000), '59 秒前');
  assert.equal(activity(60000), '1 分钟前');
  assert.equal(activity(3599999), '59 分钟前');
  assert.equal(activity(3600000), '1 小时前');
  assert.equal(relative(now - 5000, { now }), '刚刚');
});

const session = (id: string, values: Partial<Session> = {}): Session => ({
  id,
  title: id,
  cwd: '',
  project: 'work',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  model: '',
  tokens: 0,
  preview: '',
  status: 'idle',
  statusSource: 'rollout',
  ...values,
});
const event = (
  id: string,
  timestamp: number,
  values: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id,
  timestamp,
  kind: 'assistant',
  text: id,
  ...values,
});
const page = (
  events: TimelineEvent[],
  before: number | null = 70,
  id = 'session',
): SessionPage => ({
  session: session(id),
  events,
  before,
  version: 'version',
  warnings: [],
  total: 200,
});

test('realtime refresh retains loaded history, replaces overlapping events and drops pending calls', () => {
  const history = event('history', 1);
  const previous = page(
    [history, event('overlap', 2), event('pending', 3, { transient: true })],
    10,
  );
  const refreshed = page([event('overlap', 2, { text: 'updated' }), event('new', 4)]);
  const result = mergeSessionPage(previous, refreshed, false);
  assert.deepEqual(
    result.events.map((item) => [item.id, item.text]),
    [
      ['history', 'history'],
      ['overlap', 'updated'],
      ['new', 'new'],
    ],
  );
  assert.equal(result.before, 10);
  assert.equal(previous.events.length, 3);
});

test('older pages retain the current copy of overlaps and advance the historical cursor', () => {
  const current = page([event('overlap', 20, { text: 'current' }), event('new', 30)]);
  const older = page([event('old', 10), event('overlap', 20, { text: 'outdated' })], null);
  const result = mergeSessionPage(current, older, true);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ['old', 'overlap', 'new'],
  );
  assert.equal(result.events[1].text, 'current');
  assert.equal(result.before, null);
});

test('switching sessions and missing a complete recent window reset incompatible history', () => {
  const previous = page([event('old', 1)], 0);
  const other = page([event('other', 2)], 70, 'other');
  const disconnected = page([event('new', 20)], 140);
  assert.equal(mergeSessionPage(previous, other, false), other);
  assert.equal(mergeSessionPage(previous, disconnected, false), disconnected);
  const complete = page([event('complete', 30)], null);
  assert.deepEqual(
    mergeSessionPage(previous, complete, false).events.map((item) => item.id),
    ['old', 'complete'],
  );
});

test('activity groups respect turn and message boundaries and images retain separate previews', () => {
  const events = [
    event('tool', 1, { kind: 'tool', turnId: 'first' }),
    event('reason', 2, { kind: 'reasoning', turnId: 'first' }),
    event('next-turn', 3, { kind: 'tool', turnId: 'second' }),
    event('image-1', 4, { kind: 'tool', image: { id: '1', name: '1.png' } }),
    event('image-2', 5, { kind: 'tool', image: { id: '2', name: '2.png' } }),
    event('reply', 6),
    event('after-reply', 7, { kind: 'tool', turnId: 'second' }),
  ];
  const blocks = groupTimelineEvents(events);
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.id]),
    [
      ['activity', 'tool'],
      ['activity', 'next-turn'],
      ['images', 'image-1'],
      ['event', 'reply'],
      ['activity', 'after-reply'],
    ],
  );
  assert.equal(blocks[0].kind !== 'event' && blocks[0].events.length, 2);
  assert.equal(blocks[2].kind !== 'event' && blocks[2].events.length, 2);
  assert.equal(events.length, 7);
  assert.deepEqual(groupTimelineEvents([]), []);
});

test('session grouping preserves time order, sorts project copies and only labels group starts', () => {
  const now = new Date(2026, 10, 14, 12).getTime();
  const sessions = [
    session('running', { status: 'running', project: 'B', updatedAt: now }),
    session('today-1', { project: 'A', updatedAt: now - 1000 }),
    session('today-2', { project: 'A', updatedAt: now - 2000 }),
    session('yesterday', { project: 'B', updatedAt: now - 86400000 }),
  ];
  const timed = sessionRows(sessions, 'time', now);
  assert.deepEqual(
    timed.slice(0, 3).map((row) => row.heading),
    ['正在进行', '今天', undefined],
  );
  const projects = sessionRows(sessions, 'project', now);
  assert.deepEqual(
    projects.map((row) => row.session.id),
    ['today-1', 'today-2', 'running', 'yesterday'],
  );
  assert.deepEqual(
    projects.map((row) => row.heading),
    ['A', undefined, 'B', undefined],
  );
  assert.equal(sessions[0].id, 'running');
});

test('running project shortcuts count full paths across workspaces and ignore inactive sessions', () => {
  const sessions = [
    session('same-id', { status: 'running', cwd: '/work/app', project: 'app' }),
    session('same-id', { status: 'running', cwd: '/work/app', project: 'app' }),
    session('another-path', { status: 'running', cwd: '/other/app', project: 'app' }),
    session('completed', { cwd: '/completed', project: 'completed', status: 'completed' }),
    session('archived', {
      cwd: '/archived',
      project: 'archived',
      status: 'running',
      archived: true,
    }),
    session('no-path', { status: 'running' }),
  ];
  const expected = [
    { path: '/other/app', name: 'app', count: 1 },
    { path: '/work/app', name: 'app', count: 2 },
  ];
  assert.deepEqual(runningProjects(sessions), expected);
  assert.deepEqual(runningProjects([...sessions].reverse()), expected);
});

test('running project shortcuts retain the selected path when its last session finishes', () => {
  assert.deepEqual(runningProjects([], 'D:\\project\\finished-project'), [
    { path: 'D:\\project\\finished-project', name: 'finished-project', count: 0 },
  ]);
  assert.deepEqual(runningProjects([], '/work/finished-project/'), [
    { path: '/work/finished-project/', name: 'finished-project', count: 0 },
  ]);
  assert.deepEqual(runningProjects([]), []);
});

test('global session ordering keeps identical IDs in separate workspaces and puts live sessions first', () => {
  const scoped = (
    workspaceId: string,
    id: string,
    values: Partial<Session> = {},
  ): WorkspaceSession => ({
    ...session(id, values),
    workspaceId,
    workspaceName: workspaceId,
  });
  const input = [
    scoped('local', 'same', { updatedAt: 20 }),
    scoped('remote', 'same', { updatedAt: 30 }),
    scoped('remote', 'running', { status: 'running', updatedAt: 5 }),
    scoped('local', 'same', { title: 'refreshed', updatedAt: 40 }),
  ];
  const merged = mergeWorkspaceSessions(input);
  assert.deepEqual(
    merged.map((item) => [item.workspaceId, item.id]),
    [
      ['remote', 'running'],
      ['local', 'same'],
      ['remote', 'same'],
    ],
  );
  assert.equal(merged[1].title, 'refreshed');
  assert.equal(input.length, 4);
  const tied = [scoped('local', 'z', { updatedAt: 10 }), scoped('local', 'a', { updatedAt: 10 })];
  assert.deepEqual(
    mergeWorkspaceSessions(tied).map((item) => item.id),
    ['z', 'a'],
  );
});
