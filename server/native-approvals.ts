import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ControlError } from './control-error.js';
import type { ApprovalControl, ApprovalDecision, ApprovalRequest } from '../src/approval-types.js';

const text = z.string().max(24000);
const optionalText = text.nullish();
const filePath = z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'), path: text }).strict(),
  z.object({ type: z.literal('glob_pattern'), pattern: text }).strict(),
  z
    .object({
      type: z.literal('special'),
      value: z.object({ kind: text, path: optionalText, subpath: optionalText }).strict(),
    })
    .strict(),
]);
const permissionProfile = z
  .object({
    network: z.object({ enabled: z.boolean().nullish() }).strict().nullish(),
    fileSystem: z
      .object({
        read: z.array(text).max(200).nullish(),
        write: z.array(text).max(200).nullish(),
        entries: z
          .array(z.object({ access: z.enum(['read', 'write', 'deny']), path: filePath }).strict())
          .max(200)
          .nullish(),
        globScanMaxDepth: z.number().int().min(1).nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict();
const base = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  reason: optionalText,
  cwd: optionalText,
});
type Entry = {
  view: ApprovalRequest;
  reply: (allow: boolean) => unknown;
  resolve: (result: unknown) => void;
  cleanup: () => void;
};
const fileDetailLabels = new Set(['文件', '修改类型', '移动到', '修改内容', '待审批差异']);
function fileDetails(changes: unknown): ApprovalRequest['details'] {
  if (changes === undefined)
    return [{ label: '待审批差异', value: '正在读取文件差异，读取完成后才能允许修改。' }];
  const parsed = z
    .array(
      z.object({
        path: text,
        diff: z.string().max(512000),
        kind: z
          .object({ type: z.enum(['add', 'delete', 'update']), move_path: optionalText })
          .strict(),
      }),
    )
    .max(200)
    .parse(changes);
  const details: ApprovalRequest['details'] = [];
  for (const change of parsed) {
    details.push(
      { label: '文件', value: change.path },
      {
        label: '修改类型',
        value: { add: '新增', delete: '删除', update: '修改' }[change.kind.type],
      },
    );
    if (change.kind.move_path) details.push({ label: '移动到', value: change.kind.move_path });
    details.push({ label: '修改内容', value: change.diff });
  }
  if (!parsed.length)
    return [{ label: '待审批差异', value: '尚未收到文件差异，请在原生客户端确认。' }];
  if (details.reduce((size, detail) => size + detail.value.length, 0) > 1000000)
    throw new ControlError('文件差异过长，请在原生客户端确认。');
  return details;
}

/** Human decisions remain tied to the original CLI callback, never replayed on another runtime. */
export class NativeApprovals implements ApprovalControl {
  private entries = new Map<string, Entry>();
  constructor(private timeoutMs = 15 * 60 * 1000) {}

  request(method: string, raw: unknown, signal: AbortSignal, changes?: unknown): Promise<unknown> {
    if (signal.aborted) throw new ControlError('审批请求已失效。', false, 410);
    if (JSON.stringify(raw).length > 64000)
      throw new ControlError('审批内容过长，请在原生客户端确认。');
    const params = base.parse(raw);
    const details: ApprovalRequest['details'] = [];
    const add = (label: string, value: string | null | undefined) => {
      if (value) details.push({ label, value });
    };
    add('工作目录', params.cwd);
    const permissions = (profile: z.infer<typeof permissionProfile>) => {
      if (profile.network?.enabled != null)
        add('网络访问', profile.network.enabled ? '允许访问网络' : '禁止访问网络');
      for (const path of profile.fileSystem?.read ?? []) add('读取路径', path);
      for (const path of profile.fileSystem?.write ?? []) add('写入路径', path);
      for (const entry of profile.fileSystem?.entries ?? []) {
        const path = entry.path;
        const labels = {
          root: '整个文件系统',
          minimal: '最小系统路径',
          project_roots: '项目目录',
          tmpdir: '系统临时目录',
          slash_tmp: '/tmp',
        };
        const value =
          path.type === 'path'
            ? path.path
            : path.type === 'glob_pattern'
              ? path.pattern
              : `${labels[path.value.kind as keyof typeof labels] ?? path.value.path ?? path.value.kind}${path.value.subpath ? '/' + path.value.subpath : ''}`;
        add({ read: '读取路径', write: '写入路径', deny: '禁止访问路径' }[entry.access], value);
      }
      if (profile.fileSystem?.globScanMaxDepth != null)
        add('路径匹配深度', String(profile.fileSystem.globScanMaxDepth));
    };
    let kind: ApprovalRequest['kind'],
      title: string,
      scope: string,
      canAccept = true;
    let reply: Entry['reply'];
    if (method === 'item/commandExecution/requestApproval') {
      const command = base
        .extend({
          command: optionalText,
          kind: z.enum(['command', 'writeStdin', 'humanCommand']).optional(),
          availableDecisions: z.array(z.unknown()).nullish(),
          networkApprovalContext: z.object({ host: text, protocol: text }).nullish(),
          additionalPermissions: permissionProfile.nullish(),
        })
        .parse(raw);
      kind = 'command';
      title = command.kind === 'writeStdin' ? '向终端发送输入' : '执行命令';
      scope = '仅允许本次操作';
      add('命令', command.command);
      if (command.networkApprovalContext)
        add(
          '连接目标',
          `${command.networkApprovalContext.protocol}://${command.networkApprovalContext.host}`,
        );
      if (command.additionalPermissions) permissions(command.additionalPermissions);
      const choices = command.availableDecisions;
      canAccept = !choices || choices.includes('accept');
      const reject =
        !choices || choices.includes('decline')
          ? 'decline'
          : choices.includes('cancel')
            ? 'cancel'
            : undefined;
      if (!reject) throw new ControlError('此审批需要原生客户端支持的答复。');
      reply = (allow) => ({ decision: allow ? 'accept' : reject });
    } else if (method === 'item/fileChange/requestApproval') {
      const file = base.extend({ grantRoot: optionalText }).parse(raw);
      kind = 'file-change';
      title = '修改文件';
      scope = '仅允许本次文件修改';
      add('申请写入目录', file.grantRoot);
      const files = fileDetails(changes);
      details.push(...files);
      canAccept = files.some((detail) => detail.label === '文件');
      reply = (allow) => ({ decision: allow ? 'accept' : 'decline' });
    } else if (method === 'item/permissions/requestApproval') {
      const profile = base.extend({ permissions: permissionProfile }).parse(raw).permissions;
      kind = 'permissions';
      title = '申请额外权限';
      scope = '仅本轮有效';
      permissions(profile);
      reply = (allow) => ({ permissions: allow ? profile : {}, scope: 'turn' });
    } else throw new ControlError('此交互请求暂不支持，请在原生客户端处理。');
    if (details.reduce((size, detail) => size + detail.value.length, 0) > 1024000)
      throw new ControlError('审批内容过长，请在原生客户端确认。');
    if ([...this.entries.values()].filter((entry) => entry.view.state === 'pending').length >= 64)
      throw new ControlError('待审批请求过多，请先处理已有请求。');
    for (const [id, entry] of this.entries) {
      if (this.entries.size < 256) break;
      if (entry.view.state !== 'pending') this.entries.delete(id);
    }
    return new Promise((resolve) => {
      const id = randomUUID(),
        createdAt = Date.now();
      const abort = () => this.finish(id, 'cancelled');
      const timer = setTimeout(() => this.finish(id, 'expired'), this.timeoutMs);
      timer.unref();
      const entry: Entry = {
        view: {
          id,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          kind,
          title,
          reason: params.reason ?? undefined,
          details,
          scope,
          canAccept,
          createdAt,
          expiresAt: createdAt + this.timeoutMs,
          state: 'pending',
        },
        reply,
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        },
      };
      this.entries.set(id, entry);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  list(threadId?: string) {
    return [...this.entries.values()]
      .filter((entry) =>
        (!threadId || entry.view.threadId === threadId) &&
        entry.view.state === 'pending' && entry.view.expiresAt > Date.now(),
      )
      .map((entry) => structuredClone(entry.view));
  }
  get(threadId: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.view.threadId !== threadId)
      throw new ControlError('找不到此审批请求。', false, 404);
    if (entry.view.state === 'pending' && entry.view.expiresAt <= Date.now())
      this.finish(id, 'expired');
    return structuredClone(entry.view);
  }
  answer(threadId: string, id: string, decision: ApprovalDecision) {
    const view = this.get(threadId, id);
    if (view.state === 'answered') {
      if (view.decision !== decision)
        throw new ControlError('该请求已答复，不能更改审批结果。', false, 409);
      return view;
    }
    if (view.state !== 'pending')
      throw new ControlError('审批已过期或取消，请查看当前会话。', false, 410);
    if (decision === 'accept' && !view.canAccept)
      throw new ControlError('此请求不支持单次允许，请在原生客户端处理。', false, 409);
    this.finish(id, 'answered', decision);
    return this.get(threadId, id);
  }
  cancelTurn(threadId: string, turnId: string) {
    for (const [id, entry] of this.entries)
      if (entry.view.threadId === threadId && entry.view.turnId === turnId)
        this.finish(id, 'cancelled');
  }
  updateFileChanges(threadId: string, turnId: string, itemId: string, changes: unknown) {
    const details = fileDetails(changes);
    for (const entry of this.entries.values()) {
      const view = entry.view;
      if (
        view.state === 'pending' &&
        view.kind === 'file-change' &&
        view.threadId === threadId &&
        view.turnId === turnId &&
        view.itemId === itemId
      ) {
        view.details = [
          ...view.details.filter((detail) => !fileDetailLabels.has(detail.label)),
          ...details,
        ];
        view.canAccept = details.some((detail) => detail.label === '文件');
      }
    }
  }
  close() {
    for (const id of this.entries.keys()) this.finish(id, 'cancelled');
  }
  private finish(id: string, state: ApprovalRequest['state'], decision?: ApprovalDecision) {
    const entry = this.entries.get(id);
    if (!entry || entry.view.state !== 'pending') return;
    entry.cleanup();
    entry.view.state = state;
    entry.view.decision = decision;
    entry.resolve(entry.reply(decision === 'accept'));
  }
}
