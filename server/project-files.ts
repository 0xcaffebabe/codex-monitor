import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileEntry, ProjectFileListing } from '../src/project-file-types.js';
import { isPathWithin } from './path-boundary.js';

const LIST_LIMIT = 1000;
const SEARCH_LIMIT = 200;
const SCAN_LIMIT = 50000;
const DIRECTORY_LIMIT = 5000;
const excluded = new Set(['.git', '.hg', '.svn']);

export class ProjectFileError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const validProjectFilePath = (value: string) =>
  value.length <= 4096 &&
  !path.posix.isAbsolute(value) &&
  !path.win32.isAbsolute(value) &&
  !/^[a-z]:/i.test(value) &&
  !/[\x00-\x1f\x7f\\]/.test(value) &&
  (!value ||
    value
      .split('/')
      .every(
        (part) => !!part && part !== '.' && part !== '..' && !excluded.has(part.toLowerCase()),
      ));

const displayPath = (value: string) => value.split(path.sep).join('/');
const sortEntries = (entries: ProjectFileEntry[]) =>
  entries.sort((a, b) =>
    a.type === b.type
      ? a.path.localeCompare(b.path, 'zh-CN', { numeric: true })
      : a.type === 'directory'
        ? -1
        : 1,
  );

/** Enumerates names only, within a project resolved on the workspace client. */
export class ProjectFiles {
  private pending = 0;
  constructor(
    private roots: {
      session: (id: string) => Promise<string | undefined>;
      project: (id: string) => Promise<string | undefined>;
    },
  ) {}

  async list(
    target: { type: 'session' | 'project'; id: string },
    directory = '',
    search = '',
    signal?: AbortSignal,
  ): Promise<ProjectFileListing> {
    if (!validProjectFilePath(directory) || search.length > 200 || /[\x00-\x1f\x7f]/.test(search))
      throw new ProjectFileError('文件查询参数无效');
    if (this.pending >= 4) throw new ProjectFileError('文件查询过多，请稍后重试', 429);
    this.pending++;
    try {
      signal?.throwIfAborted();
      const configured = await this.roots[target.type](target.id);
      if (!configured) throw new ProjectFileError('找不到此项目', 404);
      if (!path.isAbsolute(configured) || /[\x00-\x1f\x7f]/.test(configured))
        throw new ProjectFileError('项目目录不可用', 404);
      const root = await realpath(configured);
      const folder = await realpath(path.join(root, directory));
      if (
        !isPathWithin(root, folder) ||
        !validProjectFilePath(displayPath(path.relative(root, folder)))
      )
        throw new ProjectFileError('只能选择当前项目内的文件', 403);
      if (!(await stat(folder)).isDirectory()) throw new ProjectFileError('此路径不是目录');
      const result: ProjectFileListing = {
        root: displayPath(root),
        directory,
        entries: [],
        truncated: false,
        incomplete: false,
      };
      const query = search.trim().toLocaleLowerCase();
      const limit = query ? SEARCH_LIMIT : LIST_LIMIT;
      const queue = [directory];
      const deadline = Date.now() + 5000;
      let scanned = 0;
      for (let index = 0; index < queue.length; index++) {
        signal?.throwIfAborted();
        if (index >= DIRECTORY_LIMIT || Date.now() >= deadline) {
          result.truncated = true;
          break;
        }
        // Re-resolve each directory so a replaced directory cannot point outside the project.
        try {
          const current = await realpath(path.join(root, queue[index]));
          if (
            !isPathWithin(root, current) ||
            !validProjectFilePath(displayPath(path.relative(root, current)))
          ) {
            result.incomplete = true;
            continue;
          }
          const handle = await opendir(current);
          for await (const entry of handle) {
            signal?.throwIfAborted();
            if (++scanned > SCAN_LIMIT || Date.now() >= deadline) {
              result.truncated = true;
              break;
            }
            const relative = queue[index] ? `${queue[index]}/${entry.name}` : entry.name;
            if (!validProjectFilePath(relative) || entry.isSymbolicLink()) continue;
            if (query) {
              if (entry.isDirectory()) queue.push(relative);
              else if (entry.isFile() && entry.name.toLocaleLowerCase().includes(query))
                result.entries.push({ name: entry.name, path: relative, type: 'file' });
            } else if (entry.isDirectory() || entry.isFile()) {
              result.entries.push({
                name: entry.name,
                path: relative,
                type: entry.isDirectory() ? 'directory' : 'file',
              });
            }
            if (result.entries.length > limit) {
              result.entries.length = limit;
              result.truncated = true;
              break;
            }
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (index === 0) throw error;
          result.incomplete = true;
        }
        if (result.truncated || !query) break;
      }
      sortEntries(result.entries);
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ProjectFileError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new ProjectFileError('项目目录不存在，请刷新后重试', 404);
      if (code === 'EACCES' || code === 'EPERM')
        throw new ProjectFileError('没有读取此目录的权限', 403);
      throw error;
    } finally {
      this.pending--;
    }
  }
}
