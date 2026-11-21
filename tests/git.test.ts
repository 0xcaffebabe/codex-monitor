import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';
import { CodexSource } from '../server/source.js';
import { ProjectGit, GitError } from '../server/git.js';
import { createApp } from '../server/app.js';
import { parseDiff, reviewPrompt } from '../src/features/git/diff-model.js';

function projectFixture(commit = true) {
  const f = fixture();
  const repo = path.join(f.root, '代码 review project');
  const globalConfig = path.join(f.root, 'empty-gitconfig');
  writeFileSync(globalConfig, '');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  const command = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig },
    });
  command('init', '-b', 'review-test');
  command('config', 'user.name', 'Git review test');
  command('config', 'user.email', 'review@example.invalid');
  command('config', 'commit.gpgsign', 'false');
  command('config', 'core.autocrlf', 'false');
  const write = (file: string, text: string | Buffer) => writeFileSync(path.join(repo, file), text);
  if (commit) {
    write('src/app.ts', 'export const value = 1;\n');
    write('rename old.ts', 'export const rename = true;\n');
    write('deleted.ts', 'export const removed = true;\n');
    write('literal[1].ts', 'literal old\n');
    write('literal1.ts', 'unrelated\n');
    write('binary.bin', Buffer.from([0, 1, 2]));
    write('.gitignore', 'ignored.txt\n');
    command('add', '.');
    command('commit', '-m', 'initial');
  }
  f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(repo, ids.modern);
  const source = new CodexSource(f.home);
  const git = new ProjectGit(source);
  return {
    f,
    repo,
    command,
    write,
    git,
    close() {
      git.close();
      source.close();
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    },
  };
}

test('Git scopes reflect HEAD, index and working tree, preserve rename paths and never update the index', async () => {
  const f = projectFixture();
  try {
    f.write('src/app.ts', 'export const value = 2;\n');
    f.command('add', 'src/app.ts');
    f.write('src/app.ts', 'export const value = 3;\n');
    f.command('mv', 'rename old.ts', '中文 renamed.ts');
    unlinkSync(path.join(f.repo, 'deleted.ts'));
    f.write('new 中文.ts', 'export const fresh = true;\n');
    f.write('ignored.txt', 'secret ignored\n');
    const index = readFileSync(path.join(f.repo, '.git/index'));
    const all = await f.git.status(ids.modern, 'all');
    assert.equal(all.branch, 'review-test');
    assert.equal(path.normalize(all.root), realpathSync(f.repo));
    assert.ok(all.head);
    assert.equal(
      all.files.find((file) => file.path === '中文 renamed.ts')?.previousPath,
      'rename old.ts',
    );
    assert.equal(all.files.find((file) => file.path === 'deleted.ts')?.status, 'deleted');
    assert.equal(all.files.find((file) => file.path === 'new 中文.ts')?.status, 'untracked');
    assert.ok(!all.files.some((file) => file.path === 'ignored.txt'));
    assert.equal(all.files.find((file) => file.path === 'src/app.ts')?.additions, 1);
    const staged = await f.git.diff(ids.modern, 'staged', 'src/app.ts');
    assert.match(staged.patch, /-export const value = 1;/);
    assert.match(staged.patch, /\+export const value = 2;/);
    const unstaged = await f.git.diff(ids.modern, 'unstaged', 'src/app.ts');
    assert.match(unstaged.patch, /-export const value = 2;/);
    assert.match(unstaged.patch, /\+export const value = 3;/);
    const combined = await f.git.diff(ids.modern, 'all', 'src/app.ts');
    assert.match(combined.patch, /-export const value = 1;/);
    assert.match(combined.patch, /\+export const value = 3;/);
    const rename = await f.git.diff(ids.modern, 'all', '中文 renamed.ts');
    assert.match(rename.patch, /rename from rename old.ts/);
    assert.match(rename.patch, /rename to 中文 renamed.ts/);
    assert.ok(
      !(await f.git.status(ids.modern, 'staged')).files.some((file) => file.status === 'untracked'),
    );
    assert.deepEqual(readFileSync(path.join(f.repo, '.git/index')), index);
  } finally {
    f.close();
  }
});

test('Git scopes hide ignored tracked files and honor nested ignore exceptions', async () => {
  const f = projectFixture();
  try {
    mkdirSync(path.join(f.repo, 'scripts/__pycache__'), { recursive: true });
    const ignored = ['scripts/__pycache__/tracked.pyc', 'scripts/generated 中文.tmp', 'deleted.ts'];
    const visible = 'scripts/keep [1].tmp';
    for (const file of [...ignored, visible]) f.write(file, `original ${file}\n`);
    f.command('add', '.');
    f.command('commit', '-m', 'tracked generated files');
    f.write('.gitignore', 'ignored.txt\n__pycache__/\ndeleted.ts\n');
    f.write('scripts/.gitignore', '*.tmp\n!keep*.tmp\n');
    for (const file of [...ignored.slice(0, 2), visible]) f.write(file, `staged ${file}\n`);
    f.command('add', '-u');
    f.command('rm', 'deleted.ts');
    for (const file of [...ignored.slice(0, 2), visible]) f.write(file, `working ${file}\n`);
    f.write('scripts/__pycache__/untracked.pyc', 'ignored untracked cache\n');
    f.write('scripts/__pycache__/forced.pyc', 'force-added cache\n');
    f.command('add', '-f', 'scripts/__pycache__/forced.pyc');
    f.write('scripts/generated untracked.tmp', 'ignored by nested rule\n');
    const index = readFileSync(path.join(f.repo, '.git/index'));
    for (const scope of ['all', 'unstaged', 'staged'] as const) {
      const status = await f.git.status(ids.modern, scope);
      assert.ok(
        status.files.some((file) => file.path === visible),
        scope,
      );
      assert.deepEqual(
        status.files.filter((file) => ignored.includes(file.path) || file.path.endsWith('.pyc')),
        [],
        scope,
      );
      assert.ok(!status.files.some((file) => file.path === 'scripts/generated untracked.tmp'));
      await assert.rejects(f.git.diff(ids.modern, scope, ignored[0]), { status: 404 });
    }
    assert.deepEqual(readFileSync(path.join(f.repo, '.git/index')), index);
    f.write('scripts/.gitignore', '!*.tmp\n');
    assert.ok(
      (await f.git.status(ids.modern, 'all')).files.some(
        (file) => file.path === 'scripts/generated 中文.tmp',
      ),
    );
  } finally {
    f.close();
  }
});

test('an unborn repository shows current additions, staged content and empty new files', async () => {
  const f = projectFixture(false);
  try {
    f.write('first.ts', 'staged\n');
    f.write('removed-before-commit.ts', 'removed\n');
    f.write('.gitignore', 'ignored.log\n');
    f.write('ignored.log', 'ignored staged\n');
    f.command('add', '.');
    f.command('add', '-f', 'ignored.log');
    f.write('first.ts', 'working\n');
    f.write('ignored.log', 'ignored working\n');
    unlinkSync(path.join(f.repo, 'removed-before-commit.ts'));
    f.write('empty.ts', '');
    const status = await f.git.status(ids.modern, 'all');
    assert.equal(status.head, null);
    assert.deepEqual(
      status.files.map((file) => file.path),
      ['.gitignore', 'empty.ts', 'first.ts'],
    );
    assert.match((await f.git.diff(ids.modern, 'all', 'first.ts')).patch, /\+working/);
    assert.match((await f.git.diff(ids.modern, 'staged', 'first.ts')).patch, /\+staged/);
    assert.ok(!(await f.git.diff(ids.modern, 'all', 'empty.ts')).truncated);
    const emptyStaged = await f.git.status(ids.modern, 'unstaged');
    assert.ok(emptyStaged.files.some((file) => file.path === 'empty.ts'));
    assert.ok(!emptyStaged.files.some((file) => file.path === 'ignored.log'));
    assert.ok(
      !(await f.git.status(ids.modern, 'staged')).files.some((file) => file.path === 'ignored.log'),
    );
  } finally {
    f.close();
  }
});

test('Git diffs handle literal pathspecs, binary files, missing files and bounded large patches', async () => {
  const f = projectFixture();
  try {
    f.write('literal[1].ts', 'literal new\n');
    f.write('literal1.ts', 'UNRELATED_NEW\n');
    const literal = await f.git.diff(ids.modern, 'all', 'literal[1].ts');
    assert.match(literal.patch, /\+literal new/);
    assert.doesNotMatch(literal.patch, /UNRELATED_NEW/);
    f.write('binary.bin', Buffer.from([0, 9, 8]));
    f.write('new-binary.bin', Buffer.from([0, 9, 8]));
    assert.equal((await f.git.diff(ids.modern, 'all', 'binary.bin')).binary, true);
    assert.equal((await f.git.diff(ids.modern, 'all', 'new-binary.bin')).binary, true);
    f.write('large.ts', '你好 world\n'.repeat(90000));
    f.command('add', 'large.ts');
    for (const scope of ['staged', 'all'] as const) {
      const diff = await f.git.diff(ids.modern, scope, 'large.ts');
      assert.equal(diff.truncated, true);
      assert.ok(diff.patch.split('\n').length <= 5000);
      assert.ok(Buffer.byteLength(diff.patch) <= 512 * 1024);
    }
    f.write('untracked-large.ts', 'x\n'.repeat(6000));
    assert.equal((await f.git.diff(ids.modern, 'all', 'untracked-large.ts')).truncated, true);
    // Prefixing a nearly-limit-sized single line must not exceed the response cap.
    f.write('long-line.ts', 'x'.repeat(512 * 1024 - 1));
    const longLine = await f.git.diff(ids.modern, 'all', 'long-line.ts');
    assert.equal(longLine.truncated, true);
    assert.ok(Buffer.byteLength(longLine.patch) <= 512 * 1024);
    for (const file of [
      '../private.jsonl',
      '.git/config',
      '/etc/passwd',
      'src/../../secret',
      'src\\secret',
    ])
      assert.throws(
        () => f.git.diff(ids.modern, 'all', file),
        (error) => error instanceof GitError && error.status === 400,
      );
    await assert.rejects(
      f.git.diff(ids.modern, 'all', '.gitignore'),
      (error) => error instanceof GitError && error.status === 404,
    );
  } finally {
    f.close();
  }
});

test(
  'untracked symlinks show only their target text, not file contents outside the repository',
  { skip: process.platform === 'win32' },
  async () => {
    const f = projectFixture();
    try {
      const outside = path.join(f.f.root, 'private-secret.txt');
      writeFileSync(outside, 'SECRET_OUTSIDE_REPOSITORY');
      symlinkSync(outside, path.join(f.repo, 'link.txt'));
      const diff = await f.git.diff(ids.modern, 'all', 'link.txt');
      assert.match(diff.patch, /new file mode 120000/);
      assert.ok(diff.patch.includes(outside));
      assert.doesNotMatch(diff.patch, /SECRET_OUTSIDE_REPOSITORY/);
    } finally {
      f.close();
    }
  },
);

test('clean, detached, linked worktrees and conflicted repositories remain readable', async () => {
  const f = projectFixture();
  try {
    assert.deepEqual((await f.git.status(ids.modern, 'all')).files, []);
    f.command('checkout', '--detach');
    const detached = await f.git.status(ids.modern, 'all');
    assert.equal(detached.branch, detached.head!.slice(0, 8));
    const worktree = path.join(f.f.root, 'linked worktree');
    f.command('worktree', 'add', '-b', 'linked', worktree);
    writeFileSync(path.join(worktree, 'linked.ts'), 'linked change\n');
    f.f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(worktree, ids.modern);
    assert.ok(
      (await f.git.status(ids.modern, 'all')).files.some((file) => file.path === 'linked.ts'),
    );
    f.f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(f.repo, ids.modern);
    f.command('checkout', 'review-test');
    f.command('checkout', '-b', 'other');
    f.write('src/app.ts', 'other branch\n');
    f.command('add', '.');
    f.command('commit', '-m', 'other');
    f.command('checkout', 'review-test');
    f.write('src/app.ts', 'main branch\n');
    f.command('add', '.');
    f.command('commit', '-m', 'main');
    assert.throws(() => f.command('merge', 'other'));
    const conflict = await f.git.diff(ids.modern, 'unstaged', 'src/app.ts');
    assert.equal(conflict.file.status, 'conflicted');
    assert.match(conflict.patch, /<<<<<<< HEAD/);
  } finally {
    f.close();
  }
});

test('Git HTTP endpoints require admin, validate queries and resolve only the session project', async () => {
  const f = projectFixture();
  const service = createApp(f.f.config, { control: new FixtureDesktop(f.f) });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await service.auth.setup('owner', 'git-review-test-password!');
  const token = service.auth.issue(user, 'git review').token;
  const request = (query = '', bearer = token, id = ids.modern) =>
    fetch(`${url}/api/sessions/${id}/git${query}`, {
      headers: { Authorization: 'Bearer ' + bearer },
    });
  const switchBranch = (body: unknown, bearer = token, query = '') =>
    fetch(`${url}/api/sessions/${ids.modern}/git/branch${query}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    f.write('new.ts', 'new content\n');
    assert.equal((await request('', '')).status, 401);
    await fetch(url + '/api/users', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'viewer',
        password: 'git-viewer-password!',
        role: 'viewer',
      }),
    });
    const viewer = (await service.auth.login('viewer', 'git-viewer-password!'))!;
    const viewerToken = service.auth.issue(viewer, 'viewer').token;
    assert.equal((await request('', viewerToken)).status, 403);
    assert.equal((await request('/branches', '')).status, 401);
    assert.equal((await request('/branches', viewerToken)).status, 403);
    assert.equal((await switchBranch({ branch: 'review-test' }, '')).status, 401);
    assert.equal((await switchBranch({ branch: 'review-test' }, viewerToken)).status, 403);
    assert.equal((await request('?scope=invalid')).status, 400);
    assert.equal((await request('?cwd=/etc')).status, 400);
    assert.equal((await request('/diff?path=..%2Fprivate.jsonl')).status, 400);
    assert.equal((await request('/diff?path=.git%2Fconfig')).status, 400);
    assert.equal((await request('', token, '99999999-9999-4999-8999-999999999999')).status, 404);
    const response = await request('/diff?path=new.ts&scope=all');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match((await response.json()).patch, /\+new content/);
    const branches = await request('/branches');
    assert.equal(branches.headers.get('cache-control'), 'no-store');
    assert.equal((await branches.json()).branch, 'review-test');
    assert.equal((await request('/branches?cwd=/etc')).status, 400);
    for (const body of [
      {},
      { branch: '--force' },
      { branch: 'a\nb' },
      { branch: 'review-test', cwd: '/etc' },
    ])
      assert.equal((await switchBranch(body)).status, 400);
    assert.equal((await switchBranch({ branch: 'review-test' }, token, '?force=true')).status, 400);
    assert.equal((await switchBranch({ branch: 'missing' })).status, 404);
    f.command('branch', 'feature/中文');
    const switched = await switchBranch({ branch: 'feature/中文' });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).branch, 'feature/中文');
    assert.equal(f.command('branch', '--show-current').trim(), 'feature/中文');
    assert.equal((await request('/branches')).status, 200);
    f.f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(f.f.root, ids.modern);
    assert.match((await (await request()).json()).error, /不是.*Git 仓库/);
    assert.equal((await request('/branches')).status, 409);
    assert.equal((await switchBranch({ branch: 'review-test' })).status, 409);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('branch switching preserves staged and untracked changes and refuses overwriting local edits', async () => {
  const f = projectFixture();
  const authorize = async () => {};
  try {
    f.command('switch', '-c', 'feature/中文');
    f.write('src/app.ts', 'feature branch\n');
    f.command('add', '.');
    f.command('commit', '-m', 'feature');
    f.command('switch', 'review-test');
    f.command('tag', 'review-test');
    f.f.state
      .prepare('UPDATE threads SET cwd=? WHERE id=?')
      .run(path.join(f.repo, 'src'), ids.modern);
    const branches = await f.git.branches(ids.modern);
    assert.equal(path.normalize(branches.root), realpathSync(f.repo));
    assert.equal(branches.branch, 'review-test');
    assert.equal(branches.detached, false);
    assert.deepEqual(
      branches.branches.map((branch) => [branch.name, branch.current]),
      [
        ['feature/中文', false],
        ['review-test', true],
      ],
    );
    f.write('src/app.ts', 'local work\n');
    f.write('literal1.ts', 'staged local work\n');
    f.command('add', 'literal1.ts');
    f.write('keep untracked.ts', 'untracked work\n');
    const index = readFileSync(path.join(f.repo, '.git/index'));
    await assert.rejects(
      () => f.git.switchBranch(ids.modern, 'feature/中文', authorize),
      (error: unknown) =>
        error instanceof GitError && error.status === 409 && /src\/app.ts/.test(error.message),
    );
    assert.equal(f.command('branch', '--show-current').trim(), 'review-test');
    assert.equal(readFileSync(path.join(f.repo, 'src/app.ts'), 'utf8'), 'local work\n');
    assert.equal(readFileSync(path.join(f.repo, 'keep untracked.ts'), 'utf8'), 'untracked work\n');
    assert.deepEqual(readFileSync(path.join(f.repo, '.git/index')), index);
    f.write('src/app.ts', 'export const value = 1;\n');
    const switched = await f.git.switchBranch(ids.modern, 'feature/中文', authorize);
    assert.equal(switched.branch, 'feature/中文');
    assert.equal(readFileSync(path.join(f.repo, 'src/app.ts'), 'utf8'), 'feature branch\n');
    assert.match(f.command('diff', '--cached'), /staged local work/);
    assert.equal(readFileSync(path.join(f.repo, 'keep untracked.ts'), 'utf8'), 'untracked work\n');
    f.command('tag', 'tag-only');
    for (const branch of ['tag-only', 'HEAD', '@{-1}', 'missing'])
      await assert.rejects(() => f.git.switchBranch(ids.modern, branch, authorize), {
        status: 404,
      });
    assert.throws(() => f.git.switchBranch(ids.modern, '--force', authorize), { status: 400 });
  } finally {
    f.close();
  }
});

test('branch discovery handles unborn and detached HEAD and branches occupied by linked worktrees', async () => {
  const f = projectFixture(false);
  const authorize = async () => {};
  try {
    const unborn = await f.git.branches(ids.modern);
    assert.equal(unborn.branch, 'review-test');
    assert.equal(unborn.head, null);
    assert.equal(unborn.detached, false);
    assert.deepEqual(unborn.branches, []);
    f.write('src/app.ts', 'initial\n');
    f.command('add', '.');
    f.command('commit', '-m', 'initial');
    const worktree = path.join(f.f.root, 'linked worktree 中文');
    f.command('worktree', 'add', '-b', 'linked', worktree);
    const linked = (await f.git.branches(ids.modern)).branches.find(
      (branch) => branch.name === 'linked',
    );
    assert.ok(linked?.worktree);
    assert.equal(path.normalize(linked.worktree), realpathSync(worktree));
    await assert.rejects(() => f.git.switchBranch(ids.modern, 'linked', authorize), {
      status: 409,
    });
    f.command('checkout', '--detach');
    const detached = await f.git.branches(ids.modern);
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, detached.head!.slice(0, 8));
    assert.ok(detached.branches.every((branch) => !branch.current));
    assert.equal((await f.git.switchBranch(ids.modern, 'review-test', authorize)).detached, false);
    f.f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(worktree, ids.modern);
    f.command('branch', 'available');
    assert.equal((await f.git.branches(ids.modern)).branch, 'linked');
    assert.equal(
      (await f.git.switchBranch(ids.modern, 'available', authorize)).branch,
      'available',
    );
    assert.equal(f.command('branch', '--show-current').trim(), 'review-test');
  } finally {
    f.close();
  }
});

test('branch switching rechecks device authorization immediately before changing the worktree', async () => {
  const f = projectFixture();
  let checks = 0;
  let revoke: (() => void) | undefined;
  const service = createApp(f.f.config, {
    control: new FixtureDesktop(f.f),
    authorization: {
      device: async () => {
        if (++checks === 2) revoke?.();
        return true;
      },
      user: async () => true,
    },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const user = await service.auth.setup('owner', 'git-switch-test-password!');
    const { token } = service.auth.issue(user, 'git switch');
    const identity = service.auth.authenticate(token)!;
    revoke = () => service.auth.revoke(user.id, identity.sessionId);
    f.command('branch', 'other');
    const response = await fetch(`${url}/api/sessions/${ids.modern}/git/branch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'other' }),
    });
    assert.equal(response.status, 403);
    assert.equal(checks, 2);
    assert.equal(f.command('branch', '--show-current').trim(), 'review-test');
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('unified diff parsing counts both sides, multiple hunks and header-like code correctly', () => {
  const lines = parseDiff(
    [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -4,2 +4,2 @@',
      ' context',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '@@ -20 +30 @@',
      '---code',
      '+++code',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === 'context'),
    [{ kind: 'context', text: 'context', oldLine: 4, newLine: 4 }],
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === 'added'),
    [
      { kind: 'added', text: 'new', newLine: 5 },
      { kind: 'added', text: '++code', newLine: 30 },
    ],
  );
  assert.equal(lines.filter((line) => line.kind === 'deleted').at(-1)?.oldLine, 20);
});

test('review prompts retain the exact scope and selected file and fit the composer limit', () => {
  const status = {
    root: '/project',
    branch: 'main',
    head: 'abc123',
    scope: 'staged' as const,
    files: Array.from({ length: 1000 }, (_, index) => ({
      path: `long-directory-${'a'.repeat(50)}/${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      binary: false,
    })),
  };
  const all = reviewPrompt(status);
  assert.match(all, /git diff --cached/);
  assert.match(all, /不修改文件/);
  assert.ok(all.length < 12000);
  const file = reviewPrompt(status, status.files[100]);
  assert.ok(file.includes(JSON.stringify(status.files[100].path)));
  assert.ok(!file.includes(JSON.stringify(status.files[101].path)));
});
