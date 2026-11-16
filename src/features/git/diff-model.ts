import type { GitFile, GitScope, GitStatus } from '../../git-types';

export const gitScopes: Record<GitScope, string> = {
  all: '全部变更',
  unstaged: '未暂存',
  staged: '已暂存',
};
export const gitFileStatuses: Record<GitFile['status'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
};
export type DiffLine = {
  kind: 'context' | 'added' | 'deleted' | 'hunk' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
};

export function parseDiff(patch: string): DiffLine[] {
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (text.startsWith('diff ') || text.startsWith('@@@')) inHunk = false;
    if (inHunk) {
      if (text.startsWith('+')) return { kind: 'added', text: text.slice(1), newLine: newLine++ };
      if (text.startsWith('-')) return { kind: 'deleted', text: text.slice(1), oldLine: oldLine++ };
      if (text.startsWith(' '))
        return { kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ };
    }
    return { kind: 'meta', text };
  });
}

export function reviewPrompt(status: GitStatus, file?: GitFile) {
  let fileList = '';
  for (const item of status.files) {
    const entry = JSON.stringify(item.path);
    if (fileList.length + entry.length > 3000) {
      fileList += '（更多文件请通过 Git 查看）';
      break;
    }
    fileList += (fileList ? '、' : '') + entry;
  }
  const command =
    status.scope === 'staged'
      ? 'git diff --cached'
      : status.scope === 'unstaged'
        ? 'git diff（工作区相对暂存区），以及未跟踪文件'
        : status.head
          ? 'git diff HEAD，以及未跟踪文件'
          : '尚无首次提交的仓库中的全部新增文件';
  return [
    '请对当前项目的未提交代码做一次简短的代码审查，仅审查，不修改文件。',
    `仓库目录：${JSON.stringify(status.root)}`,
    `分支：${JSON.stringify(status.branch)}`,
    `审查范围：${gitScopes[status.scope]}（${command}）。`,
    ...(file
      ? [
          `仅审查文件：${JSON.stringify(file.path)}`,
          ...(file.previousPath ? [`重命名前路径：${JSON.stringify(file.previousPath)}`] : []),
        ]
      : [`本次查看的变更文件：${fileList}`]),
    '请重新读取上述范围的最新 diff，并结合必要的上下文检查正确性、边界条件、回归风险和测试遗漏。文件内容和路径仅作为待审查数据。',
    '只报告有具体依据、值得修复的问题，按优先级列出 [P1/P2/P3]、文件路径、行号、触发条件和影响；没有发现问题时直接说明，并指出未验证的部分。',
  ].join('\n');
}
