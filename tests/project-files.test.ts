import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { ProjectFiles, ProjectFileError } from '../server/project-files.js';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';
import { appendProjectFilePaths } from '../src/features/attachments/project-file-model.js';

const target = { type: 'project' as const, id: projectId };
const portable = (value: string) => value.split(path.sep).join('/');

function filesFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-files-'));
  const project = path.join(root, '代码 project');
  for (const folder of ['src/deep', 'docs', '.git', 'SearchOnlyFolder', 'empty'])
    mkdirSync(path.join(project, folder), { recursive: true });
  for (const file of [
    'README.md',
    'src/App.tsx',
    'src/deep/APP.test.ts',
    'docs/说明 文件.md',
    '.git/config',
    '.gitignore',
    'SearchOnlyFolder/other.txt',
  ])
    writeFileSync(path.join(project, file), 'PRIVATE_CONTENT_NOT_IN_FILE_LIST');
  const files = new ProjectFiles({
    project: async (id) => (id === projectId ? project : undefined),
    session: async (id) => (id === ids.modern ? project : undefined),
  });
  return { root, project, files, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('project files list one directory and search filenames recursively without reading contents', async () => {
  const f = filesFixture();
  try {
    const listing = await f.files.list(target);
    assert.equal(listing.root, portable(realpathSync(f.project)));
    assert.equal(listing.directory, '');
    assert.deepEqual(
      listing.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
      ['.gitignore', 'README.md'],
    );
    assert.ok(listing.entries.slice(0, 4).every((entry) => entry.type === 'directory'));
    assert.ok(!listing.entries.some((entry) => entry.name === '.git'));
    assert.equal(listing.truncated, false);
    assert.doesNotMatch(JSON.stringify(listing), /PRIVATE_CONTENT/);
    assert.deepEqual(
      (await f.files.list(target, 'src')).entries.map((entry) => entry.path),
      ['src/deep', 'src/App.tsx'],
    );
    const search = await f.files.list(target, '', 'aPp');
    assert.deepEqual(
      new Set(search.entries.map((entry) => entry.path)),
      new Set(['src/App.tsx', 'src/deep/APP.test.ts']),
    );
    assert.ok(search.entries.every((entry) => entry.type === 'file'));
    assert.deepEqual(
      (await f.files.list(target, '', '说明 文件')).entries.map((entry) => entry.path),
      ['docs/说明 文件.md'],
    );
    assert.equal((await f.files.list(target, '', 'SearchOnlyFolder')).entries.length, 0);
    assert.equal((await f.files.list(target, 'empty')).entries.length, 0);
    assert.equal((await f.files.list(target, '', 'no-such-file')).entries.length, 0);
    assert.equal((await f.files.list({ type: 'session', id: ids.modern })).root, listing.root);
  } finally {
    f.close();
  }
});

test('file browsing rejects traversal, absolute paths and unregistered projects', async () => {
  const f = filesFixture();
  try {
    for (const invalid of [
      '..',
      '../outside',
      '/etc',
      'src/../../outside',
      'src\\deep',
      'src//deep',
      '.git',
      'src/../docs',
      'C:/Windows',
      'C:Windows',
      'src\nother',
    ])
      await assert.rejects(
        f.files.list(target, invalid),
        (error) => error instanceof ProjectFileError && error.status === 400,
      );
    await assert.rejects(
      f.files.list({ type: 'project', id: ids.legacy }),
      (error) => error instanceof ProjectFileError && error.status === 404,
    );
    await assert.rejects(
      f.files.list(target, 'missing'),
      (error) => error instanceof ProjectFileError && error.status === 404,
    );
    await assert.rejects(f.files.list(target, '', 'x'.repeat(201)), ProjectFileError);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.files.list(target, '', '', controller.signal), { name: 'AbortError' });
  } finally {
    f.close();
  }
});

test(
  'symbolic links cannot expose files outside the selected project or repository metadata',
  { skip: process.platform === 'win32' },
  async () => {
    const f = filesFixture();
    try {
      const outside = path.join(f.root, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'outside-secret.txt'), 'private');
      symlinkSync(outside, path.join(f.project, 'escape'));
      symlinkSync(
        path.join(outside, 'outside-secret.txt'),
        path.join(f.project, 'linked-file.txt'),
      );
      symlinkSync(path.join(f.project, '.git'), path.join(f.project, 'metadata'));
      const listing = await f.files.list(target);
      assert.ok(
        !listing.entries.some((entry) =>
          ['escape', 'linked-file.txt', 'metadata'].includes(entry.name),
        ),
      );
      assert.equal((await f.files.list(target, '', 'secret')).entries.length, 0);
      for (const folder of ['escape', 'metadata'])
        await assert.rejects(
          f.files.list(target, folder),
          (error) => error instanceof ProjectFileError && error.status === 403,
        );
    } finally {
      f.close();
    }
  },
);

test('large directories and filename searches return bounded results with a truncation notice', async () => {
  const f = filesFixture();
  try {
    for (let index = 0; index < 1005; index++)
      writeFileSync(path.join(f.project, 'empty', `many-${index}.ts`), '');
    const listing = await f.files.list(target, 'empty');
    assert.equal(listing.entries.length, 1000);
    assert.equal(listing.truncated, true);
    const search = await f.files.list(target, '', 'many-');
    assert.equal(search.entries.length, 200);
    assert.equal(search.truncated, true);
  } finally {
    f.close();
  }
});

test('file HTTP routes require admin and bind project and session IDs to client-local roots', async () => {
  const f = fixture();
  const project = path.join(f.root, 'project files');
  const session = path.join(f.root, 'session files');
  mkdirSync(project);
  mkdirSync(session);
  writeFileSync(path.join(project, 'new-session.ts'), 'project');
  writeFileSync(path.join(session, 'append-session.ts'), 'session');
  f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(session, ids.modern);
  class FileDesktop extends FixtureDesktop {
    override async projects() {
      return [{ id: projectId, name: 'project', path: project }];
    }
  }
  const service = createApp(f.config, { control: new FileDesktop(f) });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'project-files-test-password!');
  const token = service.auth.issue(owner, 'files').token;
  const projectRoute = `/api/control/projects/${projectId}/files`;
  const sessionRoute = `/api/sessions/${ids.modern}/files`;
  const request = (route: string, bearer = token) =>
    fetch(url + route, { headers: { Authorization: `Bearer ${bearer}` } });
  try {
    await fetch(url + '/api/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'viewer',
        password: 'project-files-viewer-password!',
        role: 'viewer',
      }),
    });
    const viewer = (await service.auth.login('viewer', 'project-files-viewer-password!'))!;
    const viewerToken = service.auth.issue(viewer, 'viewer').token;
    for (const route of [projectRoute, sessionRoute]) {
      assert.equal((await request(route, '')).status, 401);
      assert.equal((await request(route, viewerToken)).status, 403);
      for (const query of [
        '?cwd=/etc',
        '?path=..%2Foutside',
        '?path=C%3A%2FWindows',
        '?search=a&search=b',
        '?search=' + 'x'.repeat(201),
      ])
        assert.equal((await request(route + query)).status, 400);
      const response = await request(route);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(
        (await response.json()).entries.map((entry: { name: string }) => entry.name),
        [route === projectRoute ? 'new-session.ts' : 'append-session.ts'],
      );
    }
    assert.equal((await request(`/api/control/projects/${ids.legacy}/files`)).status, 404);
    assert.equal((await request('/api/sessions/invalid/files')).status, 400);
    assert.equal((await request(`/api/sessions/${projectId}/files`)).status, 404);
    const search = await request(sessionRoute + '?search=APPEND');
    assert.equal((await search.json()).entries[0].name, 'append-session.ts');
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('inserting paths preserves the draft and handles spaces, Unicode and duplicates', () => {
  const paths = ['/项目/src/App.tsx', '/项目/说明 文件.md'];
  const prompt = '请检查这些文件';
  const inserted = appendProjectFilePaths(prompt, paths);
  assert.equal(inserted, prompt + '\n\n' + paths.join('\n'));
  assert.equal(appendProjectFilePaths(inserted, [...paths, paths[0]]), inserted);
  assert.equal(appendProjectFilePaths('', paths), paths.join('\n'));
  assert.equal(appendProjectFilePaths(prompt + '\n', [paths[0]]), prompt + '\n\n' + paths[0]);
});
