import { execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitFile, GitFileDiff, GitScope, GitStatus } from '../src/git-types.js';
import type { CodexSource } from './source.js';

const LIST_LIMIT = 2 * 1024 * 1024;
const PATCH_LIMIT = 512 * 1024;
const FILE_LIMIT = 1000;

export class GitError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

const statuses: Record<string, GitFile['status']> = {
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflicted',
};
const fileStatus = (code: string): GitFile['status'] => statuses[code[0]] ?? 'modified';
const emptyFile = (file: string, status: GitFile['status']): GitFile => ({
  path: file,
  status,
  additions: null,
  deletions: null,
  binary: false,
});
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};
export const validGitPath = (file: string) =>
  !!file &&
  file.length <= 4096 &&
  !path.isAbsolute(file) &&
  !/[\x00\\]/.test(file) &&
  !file
    .split('/')
    .some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git');

/** Read-only Git commands are always rooted in a known session on this workspace client. */
export class ProjectGit {
  private children = new Set<ChildProcess>();
  private pending = 0;
  private closed = false;
  constructor(private source: Pick<CodexSource, 'get' | 'refresh'>) {}

  private run(cwd: string, args: string[], patch = false, allowed = [0]) {
    if (this.closed) throw new GitError('工作空间正在关闭', 503);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    // A launcher may itself be running inside a Git hook or with a different index.
    for (const key of Object.keys(env)) {
      if (
        /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS)$/.test(
          key,
        )
      )
        delete env[key as keyof typeof env];
    }
    return new Promise<{ text: string; code: number; truncated: boolean }>((resolve, reject) => {
      const child = execFile(
        'git',
        [
          '--no-pager',
          '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.quotePath=false',
          ...args,
        ],
        {
          cwd,
          env,
          encoding: 'utf8',
          maxBuffer: patch ? PATCH_LIMIT : LIST_LIMIT,
          timeout: 15000,
          windowsHide: true,
        },
        (error, stdout) => {
          this.children.delete(child);
          const code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            if (patch) return resolve({ text: stdout, code, truncated: true });
            return reject(
              new GitError('变更文件过多，暂时无法读取，请缩小仓库中的未提交变更。', 413),
            );
          }
          if (error?.code === 'ENOENT')
            return reject(new GitError('工作空间未安装 Git，或 Git 不在 PATH 中。'));
          if (error?.killed) return reject(new GitError('Git 读取超时，请稍后重试。', 504));
          if (!allowed.includes(code))
            return reject(new GitError('Git 读取失败，请检查仓库权限并刷新重试。'));
          resolve({ text: stdout, code, truncated: false });
        },
      );
      this.children.add(child);
    });
  }

  private async repository(id: string) {
    await this.source.refresh(true);
    const session = await this.source.get(id);
    if (!session) throw new GitError('找不到此会话', 404);
    if (!session.cwd || !path.isAbsolute(session.cwd))
      throw new GitError('此会话没有可用的项目目录。');
    let cwd: string;
    try {
      cwd = await realpath(session.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error();
    } catch {
      throw new GitError('项目目录不存在或无法访问，请检查工作空间中的目录。');
    }
    const location = await this.run(cwd, ['rev-parse', '--show-toplevel'], false, [0, 128]);
    if (location.code !== 0) throw new GitError('此会话的项目目录不是可读取的 Git 仓库。');
    const root = location.text.replace(/\r?\n$/, '');
    const [head, branch] = await Promise.all([
      this.run(root, ['rev-parse', '--verify', 'HEAD'], false, [0, 128]),
      this.run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], false, [0, 1]),
    ]);
    return {
      root,
      head: head.code === 0 ? head.text.trim() : null,
      branch: branch.code === 0 ? branch.text.trim() : head.text.trim().slice(0, 8) || 'HEAD',
    };
  }

  private diffArgs(scope: GitScope, head: string | null) {
    return [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--find-renames',
      ...(scope === 'staged' ? ['--cached'] : scope === 'all' && head ? [head] : []),
    ];
  }

  private async list(
    repo: Awaited<ReturnType<ProjectGit['repository']>>,
    scope: GitScope,
  ): Promise<GitStatus> {
    const args = this.diffArgs(scope, repo.head);
    const [names, counts, status] = await Promise.all([
      this.run(repo.root, [...args, '--name-status', '-z', '--']),
      this.run(repo.root, [...args, '--numstat', '-z', '--']),
      this.run(repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const files = new Map<string, GitFile>();
    const namesParts = names.text.split('\0');
    for (let i = 0; i < namesParts.length - 1;) {
      const code = namesParts[i++];
      const first = namesParts[i++];
      const renamed = /^[RC]/.test(code);
      const file = emptyFile(renamed ? namesParts[i++] : first, fileStatus(code));
      if (renamed) file.previousPath = first;
      files.set(file.path, file);
    }
    const countParts = counts.text.split('\0');
    for (let i = 0; i < countParts.length - 1;) {
      const item = countParts[i++];
      const firstTab = item.indexOf('\t'),
        secondTab = item.indexOf('\t', firstTab + 1);
      const added = item.slice(0, firstTab),
        removed = item.slice(firstTab + 1, secondTab);
      let filePath = item.slice(secondTab + 1);
      if (!filePath) {
        i++;
        filePath = countParts[i++];
      }
      const file = files.get(filePath);
      if (file) {
        file.binary = added === '-' || removed === '-';
        file.additions = file.binary ? null : Number(added);
        file.deletions = file.binary ? null : Number(removed);
      }
    }
    const statusParts = status.text.split('\0');
    for (let i = 0; i < statusParts.length - 1;) {
      const entry = statusParts[i++],
        code = entry.slice(0, 2),
        filePath = entry.slice(3).replace(/\/$/, '');
      if (/[RC]/.test(code)) i++;
      if (code === '??' && scope !== 'staged')
        files.set(filePath, emptyFile(filePath, 'untracked'));
      else if (!repo.head && scope === 'all') {
        if (code[1] === 'D') files.delete(filePath);
        else files.set(filePath, emptyFile(filePath, 'added'));
      } else if (code.includes('U') || code === 'AA' || code === 'DD') {
        const file = files.get(filePath);
        if (file) file.status = 'conflicted';
      }
    }
    if (files.size > FILE_LIMIT)
      throw new GitError(`变更超过 ${FILE_LIMIT} 个文件，请缩小未提交变更后重试。`, 413);
    return {
      ...repo,
      scope,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private async request<T>(
    id: string,
    action: (repo: Awaited<ReturnType<ProjectGit['repository']>>) => Promise<T>,
  ) {
    if (this.pending >= 4) throw new GitError('Git 读取请求过多，请稍后重试。', 429);
    this.pending++;
    try {
      return await action(await this.repository(id));
    } finally {
      this.pending--;
    }
  }

  status(id: string, scope: GitScope) {
    return this.request(id, (repo) => this.list(repo, scope));
  }

  diff(id: string, scope: GitScope, filePath: string) {
    if (!validGitPath(filePath)) throw new GitError('文件路径无效', 400);
    return this.request(id, async (repo): Promise<GitFileDiff> => {
      const status = await this.list(repo, scope);
      const file = status.files.find((item) => item.path === filePath);
      if (!file) throw new GitError('该文件已不在当前变更中，请刷新文件列表。', 404);
      let result: { text: string; truncated: boolean };
      if (file.status === 'untracked' || (!repo.head && scope === 'all')) {
        result = await this.newFile(repo.root, filePath);
      } else {
        result = await this.run(
          repo.root,
          [
            ...this.diffArgs(scope, repo.head),
            '--unified=3',
            '--',
            ...(file.previousPath ? [file.previousPath] : []),
            file.path,
          ],
          true,
        );
      }
      // New-file patches add prefixes and headers, so bound the generated patch as well.
      const bytes = Buffer.from(result.text);
      const oversized = bytes.length > PATCH_LIMIT;
      const lines = (
        oversized ? bytes.subarray(0, PATCH_LIMIT).toString('utf8') : result.text
      ).split('\n');
      // A byte limit may cut a code point or a line in half. Only display complete lines.
      if (lines.at(-1) === '' || result.truncated || oversized) lines.pop();
      const truncated = result.truncated || oversized || lines.length > 5000;
      const patch = lines.slice(0, 5000).join('\n');
      return { file, patch, truncated, binary: file.binary || /^Binary files /m.test(patch) };
    });
  }

  private async newFile(root: string, filePath: string) {
    const full = path.join(root, filePath);
    try {
      if (!within(root, await realpath(path.dirname(full))))
        throw new GitError('文件目录超出当前仓库范围。', 403);
      const info = await lstat(full);
      let content: Buffer;
      let truncated = false;
      if (info.isSymbolicLink()) content = Buffer.from(await readlink(full));
      else {
        if (!info.isFile())
          return { text: '此变更是目录或嵌套仓库，请在对应项目中查看。\n', truncated: false };
        if (!within(root, await realpath(full))) throw new GitError('文件超出当前仓库范围。', 403);
        const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (!(await handle.stat()).isFile()) throw new GitError('此变更不是普通文本文件。');
          content = Buffer.alloc(PATCH_LIMIT + 1);
          const { bytesRead } = await handle.read(content, 0, content.length, 0);
          truncated = bytesRead > PATCH_LIMIT;
          content = content.subarray(0, Math.min(bytesRead, PATCH_LIMIT));
        } finally {
          await handle.close();
        }
      }
      if (content.includes(0))
        return { text: 'Binary files /dev/null and b/' + filePath + ' differ\n', truncated: false };
      const text = content.toString('utf8');
      const lines = text.split('\n');
      if (text.endsWith('\n') || !text) lines.pop();
      if (truncated) lines.pop();
      return {
        text: [
          `diff --git a/${filePath} b/${filePath}`,
          'new file mode ' +
            (info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'),
          '--- /dev/null',
          `+++ b/${filePath}`,
          ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`] : []),
          ...lines.map((line) => '+' + line),
          ...(!truncated && text && !text.endsWith('\n') ? ['\\ No newline at end of file'] : []),
          '',
        ].join('\n'),
        truncated,
      };
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError('文件已移动、删除或无法访问，请刷新变更列表。', 404);
    }
  }

  close() {
    this.closed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
