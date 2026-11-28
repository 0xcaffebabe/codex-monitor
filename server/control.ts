import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DesktopBridge, ControlError, hasUnconfirmedWriter, type DesktopControl } from './desktop.js';
import { validId, type CodexSource } from './source.js';
import { MessageQueue } from './message-queue.js';
import { createKeyedExecutor } from './keyed-executor.js';
import { appendAudit } from './audit.js';
import type { UploadStore } from './uploads.js';
import { MAX_ATTACHMENTS } from '../src/attachment-types.js';
import { imageMime } from './media.js';
import { LARK_REPLY_MAX_ERROR_LENGTH, type LarkReplyAttachment, type LarkReplyResult, type LarkStartProject, type LarkStartResult } from './notifications/lark-replies.js';
import { reasoningEfforts, type SessionModelSettings } from '../src/types.js';
import { validateModelSettings } from './model-settings.js';
import { sessionPermissionModes } from '../src/approval-types.js';
import type { SessionCreationSettings } from '../src/types.js';
import { isAuthorizedDevice, type ControlAuthorization } from './authorization.js';
import { ProjectFiles } from './project-files.js';
import { installProjectFileRoutes } from './http/project-file-routes.js';
import { installAttentionRoute } from './http/attention-route.js';
import {
  creationReceipt,
  restoreControlRequests,
  saveCreationGoal,
  type CreationReceipt,
} from './creation-goal.js';

type ClientLarkStartResult = LarkStartResult & {
  result: 'sent' | 'failed' | 'unknown' | 'unavailable' | 'attachmentFailed' | 'projectMissing' | 'projectAmbiguous';
};
type ClientLarkReplyResult = LarkReplyResult & {
  result: 'sent' | 'queued' | 'unavailable' | 'failed' | 'unknown' | 'imageFailed' | 'attachmentFailed';
};

export function installControl(
  app: Express,
  db: DatabaseSync,
  source: CodexSource,
  bridge: DesktopControl = new DesktopBridge({
    codexHome: source.home,
    activity: (id) => source.activity(id),
  }),
  uploads?: UploadStore,
  authorization?: ControlAuthorization,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS control_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL
  )`);
  restoreControlRequests(db);
  const recentRequests = db.prepare(`SELECT id,state,result_json,created_at FROM control_requests
    WHERE user_id=? AND created_at>=? ORDER BY
    CASE WHEN state IN ('unknown','pending','queued') THEN 0 ELSE 1 END, created_at DESC LIMIT 30`);
  const active = new Map<string, Promise<void>>();
  const goalRetries = new Map<string, Promise<CreationReceipt>>();
  const inLane = createKeyedExecutor();
  let closed = false;
  // An authenticated request can wait behind another operation or a desktop RPC.
  // Recheck the device and role immediately before dispatching a side effect.
  const authorize = async (req: Request) => {
    if (closed) throw new ControlError('服务正在停止，请稍后查询原请求结果。', true, 503);
    const identity = req.identity!;
    const allowed = await isAuthorizedDevice(db, identity, authorization, () => !closed);
    if (closed) throw new ControlError('服务正在停止，请稍后查询原请求结果。', true, 503);
    if (!allowed) throw new ControlError('登录或操作权限已失效，请重新登录。', false, 403);
  };
  const writable = async (req: Request, id: string) => {
    await authorize(req);
    await source.refresh(true);
    const session = await source.get(id);
    await authorize(req);
    if (!session || session.archived || session.subagent)
      throw new ControlError('此会话已不可操作，请刷新会话列表。', false, 409);
    return session;
  };
  const admin = (req: Request, res: Response, next: NextFunction) =>
    req.identity?.user.role === 'admin'
      ? next()
      : res.status(403).json({ error: '发送消息和新建会话需要管理员权限' });
  const schema = z
    .object({
      requestId: z.uuid(),
      prompt: z.string().trim().max(12000),
      attachments: z
        .array(z.uuid())
        .max(MAX_ATTACHMENTS)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
    })
    .strict();
  const hasContent = (input: { prompt: string; attachments?: string[] }) =>
    !!input.prompt || !!input.attachments?.length;
  const modelFields = {
    model: z.string().trim().min(1).max(150).optional(),
    thinking: z.enum(reasoningEfforts).optional(),
  };
  const hasModelForThinking = (input: SessionModelSettings) => !input.thinking || !!input.model;
  const compose = (
    req: Request,
    input: { requestId: string; prompt: string; attachments?: string[] },
  ) => {
    if (!uploads && input.attachments?.length)
      throw new ControlError('附件上传暂不可用。', false, 503);
    return (
      uploads?.compose(req.identity!.user.id, input.requestId, input.prompt, input.attachments) ??
      input.prompt
    );
  };
  const context = async (target?: string, desktop = false) => {
    if (bridge.contextRequired === false && !desktop) return target || '';
    const inherited = process.env.CODEX_THREAD_ID;
    if (inherited && validId(inherited) && (await source.get(inherited))) return inherited;
    if (target) return target;
    const latest = await source.list({ limit: 1 });
    if (!latest.sessions[0]) throw new ControlError('请先在 Codex 桌面版打开一个本机会话。');
    return latest.sessions[0].id;
  };
  const messages = new MessageQueue(db, source, bridge, context, inLane, authorization?.user);
  const adminUser = db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'");
  const larkRequests = new Map<string, ReturnType<typeof submitLarkReply>>();
  const larkReceipt = db.prepare('SELECT user_id, state, result_json FROM control_requests WHERE id=?');
  const creationRequest = db.prepare('SELECT user_id,fingerprint,state,result_json FROM control_requests WHERE id=?');
  const finishRequest = db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?');
  const larkResult = (state: unknown, reason?: unknown): ClientLarkReplyResult => {
    if (state === 'succeeded') return { result: 'sent' };
    if (state === 'queued' || state === 'pending') return { result: 'queued' };
    const error = typeof reason === 'string' ? reason.trim().slice(0, LARK_REPLY_MAX_ERROR_LENGTH) : '';
    return { result: state === 'unknown' ? 'unknown' : 'failed', ...(error && { error }) };
  };
  function larkReplyStatus(userId: string, requestId: string) {
    const receipt = larkReceipt.get(requestId);
    if (receipt?.user_id !== userId) return { result: 'unavailable' as const };
    const details = receipt.result_json ? JSON.parse(String(receipt.result_json)) : {};
    return larkResult(receipt.state, details.error ?? (receipt.state === 'cancelled' ? details.message : undefined));
  }
  async function uploadLarkFiles(
    userId: string, files: LarkReplyAttachment[], attachments: string[], signal: AbortSignal,
  ) {
    for (const [index, { data, name }] of files.entries()) {
      const mime = name ? 'application/octet-stream' : imageMime(data.subarray(0, 16));
      if (!mime || !uploads) throw new ControlError('附件上传暂不可用。', false, 503);
      const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
      const uploaded = await uploads.receiveStream(
        Readable.from([data]), userId, name ?? `lark-${index + 1}.${ext}`, mime, signal,
      );
      attachments.push(uploaded.id);
    }
  }
  function removeLarkFiles(userId: string, attachments: string[]) {
    for (const attachment of attachments) {
      try {
        uploads?.remove(userId, attachment);
      } catch {}
    }
  }
  async function submitLarkReply(
    userId: string,
    id: string,
    { requestId, prompt, nextTurn }: { requestId: string; prompt: string; nextTurn?: true },
    files: LarkReplyAttachment[],
    signal: AbortSignal,
  ): Promise<ClientLarkReplyResult> {
    if (closed || signal.aborted) return { result: 'failed' };
    if (!adminUser.get(userId)) return larkResult('failed', '发送权限已失效。');
    const previous = larkReceipt.get(requestId);
    if (previous) return larkReplyStatus(userId, requestId);
    const session = validId(id) ? await source.get(id) : undefined;
    if (!session || session.archived || session.subagent) return { result: 'unavailable' };
    if (closed || signal.aborted) return { result: 'failed' };
    const attachments: string[] = [];
    const attachmentError = files.some(({ name }) => !!name) ? 'attachmentFailed' : 'imageFailed';
    try {
      await uploadLarkFiles(userId, files, attachments, signal);
      if (closed || signal.aborted) return { result: 'failed' };
      if (!adminUser.get(userId)) return larkResult('failed', '发送权限已失效。');
      // Lark replies are conversation text, including text that starts with a slash.
      const { state, error } = await messages.submit(userId, 'Lark', id, {
        requestId,
        prompt: uploads?.compose(userId, requestId, prompt, attachments) ?? prompt,
        nextTurn,
      });
      return larkResult(state, error);
    } catch (error) {
      if (files.length && !larkReceipt.get(requestId)) return { result: attachmentError };
      if (error instanceof ControlError) return larkResult(error.uncertain ? 'unknown' : 'failed', error.message);
      if (signal.aborted) return { result: 'failed' };
      throw error;
    } finally {
      if (!closed && attachments.length && !larkReceipt.get(requestId)) removeLarkFiles(userId, attachments);
    }
  }
  function sendLarkReply(
    userId: string,
    id: string,
    input: { requestId: string; prompt: string; nextTurn?: true },
    files: LarkReplyAttachment[],
    signal: AbortSignal,
  ) {
    const key = `${userId}:${input.requestId}`;
    const pending = larkRequests.get(key);
    if (pending) return pending;
    const job = submitLarkReply(userId, id, input, files, signal).finally(() => larkRequests.delete(key));
    larkRequests.set(key, job);
    return job;
  }
  async function createSession(
    caller: string, projectId: string, objective: string, options: SessionCreationSettings,
    requestId: string, goalObjective?: string, projectName?: string,
  ) {
    const result = await bridge.create(caller, projectId, objective, options);
    if (!validId(result.threadId))
      throw new ControlError('新会话回执无效，请检查桌面应用，勿重复创建。', true, 502);
    if (closed) throw new ControlError('服务正在停止，请稍后查询原请求结果。', true, 503);
    const receipt: CreationReceipt & { projectName?: string } = {
      ...result,
      mode: 'create',
      acceptedAt: Date.now(),
      ...(goalObjective ? { goalObjective, goalState: 'pending' } : {}),
      ...(projectName ? { projectName } : {}),
    };
    source.include(result.threadId);
    db.prepare('UPDATE control_requests SET result_json=? WHERE id=?').run(JSON.stringify(receipt), requestId);
    try {
      await source.refresh(true);
    } catch {
      // The accepted creation remains known while its index catches up.
    }
    return receipt;
  }
  async function startLarkSession(
    user: { id: string; username: string },
    target: LarkStartProject,
    { requestId, prompt }: { requestId: string; prompt: string },
    files: LarkReplyAttachment[],
    signal: AbortSignal,
  ): Promise<ClientLarkStartResult> {
    const userId = user.id;
    if (closed || signal.aborted || !adminUser.get(userId)) return { result: 'failed' };
    const fingerprint = `lark:create:${target.projectId ?? `name:${target.projectName}`}`;
    const previous = creationRequest.get(requestId);
    if (previous) {
      if (previous.user_id !== userId || previous.fingerprint !== fingerprint) return { result: 'failed' };
      const data = JSON.parse(String(previous.result_json)) as (CreationReceipt & { projectName?: string }) | null;
      if (data && creationReceipt(data)) return { result: 'sent', sessionId: data.threadId, projectName: data.projectName };
      return { result: previous.state === 'failed' ? 'failed' : 'unknown' };
    }
    db.prepare('INSERT INTO control_requests VALUES(?,?,?,?,?,?)')
      .run(requestId, userId, fingerprint, 'pending', null, Date.now());
    const attachments: string[] = [];
    let dispatched = false;
    try {
      const caller = await context();
      const projects = await bridge.projects(caller);
      const matches = projects.filter(({ id, name }) => target.projectId ? id === target.projectId : name === target.projectName);
      const project = matches[0];
      if (!project || (target.projectName && matches.some(({ id }) => id !== project.id))) {
        if (!closed) finishRequest.run('failed', JSON.stringify({ error: '项目不可用或名称重复。' }), requestId);
        return { result: target.projectId ? 'unavailable' : project ? 'projectAmbiguous' : 'projectMissing' };
      }
      return await inLane(`project:${project.id}`, async (): Promise<ClientLarkStartResult> => {
        if (closed || signal.aborted) throw new ControlError('会话未创建。', false, 503);
        try {
          await uploadLarkFiles(userId, files, attachments, signal);
        } catch {
          if (!closed) finishRequest.run('failed', JSON.stringify({ error: '附件上传失败。' }), requestId);
          return { result: 'attachmentFailed' };
        }
        if (closed || signal.aborted || !adminUser.get(userId) || (authorization && !(await authorization.user(userId))))
          throw new ControlError('操作权限已失效。', false, 403);
        signal.throwIfAborted();
        if (closed || !adminUser.get(userId)) throw new ControlError('操作权限已失效。', false, 403);
        const objective = uploads?.compose(userId, requestId, prompt, attachments) ?? prompt;
        dispatched = true;
        const receipt = await createSession(caller, project.id, objective, {}, requestId, undefined, project.name.slice(0, 500));
        if (!closed) {
          finishRequest.run('succeeded', JSON.stringify(receipt), requestId);
          appendAudit(db, 'session_created', user.username, 'Lark');
        }
        return { result: 'sent', sessionId: receipt.threadId, projectName: receipt.projectName };
      });
    } catch (error) {
      const unknown = dispatched && (!(error instanceof ControlError) || error.uncertain);
      if (!closed) finishRequest.run(unknown ? 'unknown' : 'failed', JSON.stringify({ error: unknown
        ? '创建结果待确认，请检查会话记录。'
        : '会话创建失败。' }), requestId);
      return { result: unknown ? 'unknown' : 'failed' };
    } finally {
      if (!closed && !dispatched) removeLarkFiles(userId, attachments);
    }
  }
  const projectPath = async (id: string) =>
    (await bridge.projects(await context())).find((project) => project.id === id)?.path;
  installProjectFileRoutes(
    app,
    new ProjectFiles({
      session: async (id) => {
        await source.refresh(true);
        return (await source.get(id))?.cwd;
      },
      project: projectPath,
    }),
  );
  app.get('/api/control', admin, async (_req, res) => {
    try {
      res.json({
        available: true,
        projects: await bridge.projects(await context()),
        creationPermissions: !!bridge.creationPermissions,
        desktopChannel: !!bridge.desktopChannel,
      });
    } catch (error) {
      res.json({
        available: false,
        projects: [],
        reason: error instanceof ControlError ? error.message : '暂时无法连接 Codex 桌面版',
      });
    }
  });
  app.get('/api/control/models', admin, async (_req, res) => {
    try {
      res.json({ available: true, models: await bridge.models() });
    } catch (error) {
      res.json({
        available: false,
        models: [],
        reason: error instanceof ControlError ? error.message : '暂时无法读取 Codex 模型列表',
      });
    }
  });
  installAttentionRoute(app, source, bridge.approvals, authorize, (userId, since) =>
    recentRequests.all(userId, since).map((row) => {
      const result = row.result_json ? JSON.parse(String(row.result_json)) : {};
      return {
        id: String(row.id), at: Number(row.created_at), state: String(row.state),
        threadId: typeof result.threadId === 'string' && validId(result.threadId) ? result.threadId : undefined,
        operation: typeof result.mode === 'string' ? result.mode : '',
        detail: result.goalState === 'unknown' || result.goalState === 'pending'
          ? '目标保存结果待确认，请查看原会话。' : undefined,
      };
    }),
  );
  app.get('/api/sessions/:id/approvals', admin, async (req, res) => {
    try {
      await authorize(req);
      const id = String(req.params.id);
      if (!(await source.get(id))) return res.status(404).json({ error: '找不到此会话' });
      res.json({ available: !!bridge.approvals, requests: bridge.approvals?.list(id) ?? [] });
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.get('/api/sessions/:id/approvals/:approval', admin, async (req, res) => {
    try {
      await authorize(req);
      const id = String(req.params.id);
      if (!(await source.get(id))) return res.status(404).json({ error: '找不到此会话' });
      if (!bridge.approvals) throw new ControlError('此 client 暂不支持网页审批。', false, 409);
      res.json(bridge.approvals.get(id, String(req.params.approval)));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.post('/api/sessions/:id/approvals/:approval', admin, async (req, res) => {
    const parsed = z
      .object({ decision: z.enum(['accept', 'decline']) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success || !validId(String(req.params.approval)))
      return res.status(400).json({ error: '审批答复无效。' });
    try {
      const id = String(req.params.id);
      await writable(req, id);
      if (!bridge.approvals) throw new ControlError('此 client 暂不支持网页审批。', false, 409);
      const before = bridge.approvals.get(id, String(req.params.approval));
      const result = bridge.approvals.answer(id, before.id, parsed.data.decision);
      if (before.state === 'pending')
        appendAudit(
          db,
          `approval_${parsed.data.decision}:${before.id}`,
          req.identity!.user.username,
          req.ip ?? '',
        );
      res.json(result);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.get('/api/sessions/:id/control', admin, async (req, res) => {
    const id = String(req.params.id);
    const session = await source.get(id);
    if (!session) return res.status(404).json({ error: '找不到此会话' });
    if (session.archived || session.subagent)
      return res.json({
        available: false,
        reason: session.archived
          ? '归档会话需先在 Codex 中恢复。'
          : '内部子代理会话不支持从网页发送消息。',
      });
    try {
      const state = await bridge.state(await context(id), id, { inspectOwner: true });
      if (state.compacting)
        return res.json({
          available: true,
          desktopChannel: !!bridge.desktopChannel,
          owner: state.owner,
          compacting: true,
          running: false,
          turnId: state.turnId,
          reason: '正在压缩上下文，发送的消息会排队，完成后自动提交。',
        });
      if (hasUnconfirmedWriter(state, session.status))
        return res.json({
          available: false,
          reason: '该会话正在其他客户端中执行，当前桌面版无法追加消息。',
        });
      res.json({
        available: true,
        desktopChannel: !!bridge.desktopChannel,
        owner: state.owner,
        messagePermissions:
          !!bridge.messagePermissions && state.owner !== 'desktop' &&
          (state.status === 'idle' || state.status === 'notLoaded'),
        permissionMode: state.permissionMode,
        running: state.status === 'active',
        turnId: state.turnId,
      });
    } catch (error) {
      res.json({
        available: false,
        reason: error instanceof ControlError ? error.message : '无法确认会话状态，请稍后重试。',
      });
    }
  });
  app.get('/api/control/requests/:id', admin, (req, res) => {
    const row = db
      .prepare('SELECT state,result_json FROM control_requests WHERE id=? AND user_id=?')
      .get(String(req.params.id), req.identity!.user.id);
    if (!row) return res.status(404).json({ error: '找不到该发送请求' });
    const { httpStatus: _status, ...result } = row.result_json
      ? JSON.parse(String(row.result_json))
      : {};
    res.json({ state: row.state, requestId: String(req.params.id), ...result });
  });
  app.post('/api/control/requests/:id/goal', admin, async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id) || !z.object({}).strict().safeParse(req.body).success)
      return res.status(400).json({ error: '目标保存请求无效。' });
    try {
      await authorize(req);
      await active.get(id);
      const row = db
        .prepare('SELECT result_json FROM control_requests WHERE id=? AND user_id=?')
        .get(id, req.identity!.user.id);
      if (!row) return res.status(404).json({ error: '找不到该创建请求' });
      const receipt = creationReceipt(JSON.parse(String(row.result_json)));
      if (!receipt?.goalObjective)
        return res.status(409).json({ error: '该请求没有需要补存的目标。' });
      let job = goalRetries.get(id);
      if (!job) {
        job = inLane(receipt.threadId, async () => {
          await authorize(req);
          const latest = creationReceipt(
            JSON.parse(
              String(
                db.prepare('SELECT result_json FROM control_requests WHERE id=?').get(id)!
                  .result_json,
              ),
            ),
          )!;
          if (latest.goalState === 'saved') return latest;
          await writable(req, latest.threadId);
          db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?').run(
            'pending',
            JSON.stringify({ ...latest, goalState: 'pending' }),
            id,
          );
          const result = await saveCreationGoal(bridge, latest, () =>
            writable(req, latest.threadId),
          );
          if (closed) throw new ControlError('服务正在停止，请稍后查询原请求结果。', true, 503);
          db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?').run(
            'succeeded',
            JSON.stringify(result),
            id,
          );
          appendAudit(
            db,
            'creation_goal_retried',
            req.identity!.user.username,
            req.ip ?? '',
          );
          return result;
        });
        goalRetries.set(id, job);
      }
      try {
        const result = await job;
        res.json({ ...result, state: 'succeeded', requestId: id });
      } finally {
        if (goalRetries.get(id) === job) goalRetries.delete(id);
      }
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.post('/api/control/requests/:id/cancel', admin, (req, res) => {
    try {
      const { httpStatus, ...receipt } = messages.cancel(
        req.identity!.user.id,
        String(req.params.id),
      );
      res.status(httpStatus).json(receipt);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.get('/api/sessions/:id/goal', admin, async (req, res) => {
    const id = String(req.params.id);
    if (!(await source.get(id))) return res.status(404).json({ error: '找不到此会话' });
    try {
      res.json({ goal: await bridge.goal(id, 'get') });
    } catch (error) {
      res
        .status(503)
        .json({ error: error instanceof ControlError ? error.message : '暂时无法读取目标。' });
    }
  });
  async function command(req: Request, id: string, name: string, prompt?: string, turnId?: string) {
    const caller = await context(id),
      state = await bridge.state(caller, id, name === 'compact' ? { inspectOwner: true } : undefined);
    const session = await writable(req, id);
    if (state.status === 'notLoaded' && session.status === 'running')
      throw new ControlError('该会话正在其他客户端执行，无法在这里操作。', false, 409);
    if (state.compacting && ['goal.set', 'goal.resume'].includes(name))
      throw new ControlError('请等待上下文压缩完成后再启动目标。', false, 409);
    if (name === 'interrupt') {
      if (!turnId || state.turnId !== turnId)
        throw new ControlError('当前轮次已发生变化，请刷新状态后重试。', false, 409);
      if (state.status !== 'active')
        return { threadId: id, mode: 'interrupt', message: '该轮次已结束，无需停止。' };
      const result = await bridge.interrupt(id, turnId);
      return {
        threadId: id,
        mode: 'interrupt',
        message:
          (result.interruptedTurnId ? '已停止当前执行。' : '该轮次已结束，无需停止。') +
          (result.goalPauseError ? '目标暂停失败，请手动暂停目标。' : ''),
      };
    }
    if (name === 'compact') {
      if (state.compacting || state.status === 'active')
        throw new ControlError('请等待本轮执行结束后再压缩上下文。', false, 409);
      await bridge.compact(id, { desktopOwned: state.owner === 'desktop' });
      return {
        threadId: id,
        mode: 'compact',
        message: '已提交上下文压缩，请等待会话中的完成记录。',
      };
    }
    if (name === 'help')
      return {
        threadId: id,
        mode: 'help',
        message:
          '可用指令：/compact 压缩上下文；/goal 查看目标；/goal 目标内容 设置并执行；/goal pause 暂停；/goal resume 继续；/goal clear 清除。',
      };
    const action = name.slice('goal.'.length) as 'get' | 'set' | 'pause' | 'resume' | 'clear';
    const goal = await bridge.goal(id, action, prompt);
    if (action === 'set' || action === 'resume') {
      try {
        await writable(req, id);
        await bridge.send(
          caller,
          id,
          action === 'set'
            ? `本会话的持续目标已设置为：\n${prompt}\n请执行当前目标，并在完成后按目标规则确认结果。`
            : '请继续执行本会话当前的持续目标，并在完成后按目标规则确认结果。',
        );
      } catch {
        throw new ControlError(
          '目标已保存，但执行指令的结果待确认。请检查会话与当前目标，勿重复提交。',
          true,
          502,
        );
      }
    }
    return {
      threadId: id,
      mode: 'goal',
      goal,
      message:
        action === 'get'
          ? goal
            ? `当前目标：${goal.objective}（${goal.status}）`
            : '此会话尚未设置目标。'
          : action === 'pause'
            ? '目标已暂停；当前轮次会继续执行。'
            : action === 'clear'
              ? '目标已清除。'
              : '目标已更新，Codex 已接收执行指令。',
    };
  }
  const commandSchema = z
    .object({
      requestId: z.uuid(),
      command: z.enum([
        'compact',
        'interrupt',
        'help',
        'goal.get',
        'goal.set',
        'goal.pause',
        'goal.resume',
        'goal.clear',
      ]),
      prompt: z.string().trim().max(4000).optional(),
      turnId: z.string().trim().min(1).max(150).optional(),
    })
    .strict();
  app.post('/api/sessions/:id/commands', admin, async (req, res) => {
    const id = String(req.params.id),
      parsed = commandSchema.safeParse(req.body),
      session = await source.get(id);
    if (!parsed.success || (parsed.data.command === 'goal.set' && !parsed.data.prompt))
      return res.status(400).json({ error: '指令无效，目标需 1–4000 字符。' });
    if (parsed.data.command === 'interrupt' && !parsed.data.turnId)
      return res.status(400).json({ error: '停止操作需指定当前轮次。' });
    if (!session) return res.status(404).json({ error: '找不到此会话' });
    if (session.archived || session.subagent)
      return res.status(409).json({ error: '归档或内部子代理会话不能执行指令。' });
    await mutate(
      req,
      res,
      {
        requestId: parsed.data.requestId,
        prompt: parsed.data.prompt || '',
        turnId: parsed.data.turnId,
      },
      `command:${id}:${parsed.data.command}`,
      () => command(req, id, parsed.data.command, parsed.data.prompt, parsed.data.turnId),
    );
  });
  async function mutate(
    req: Request,
    res: Response,
    input: {
      requestId: string;
      prompt: string;
      attachments?: string[];
      turnId?: string;
      asGoal?: boolean;
    } & SessionCreationSettings,
    target: string,
    operation: () => Promise<unknown>,
  ) {
    const user = req.identity!.user;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          target,
          input.prompt,
          ...(input.attachments?.length ? [input.attachments] : []),
          ...(input.model ? [{ model: input.model, thinking: input.thinking }] : []),
          ...(input.turnId ? [{ turnId: input.turnId }] : []),
          ...(input.asGoal ? [{ asGoal: true }] : []),
          ...(input.permissionMode ? [{ permissionMode: input.permissionMode }] : []),
        ]),
      )
      .digest('hex');
    let row = db.prepare('SELECT * FROM control_requests WHERE id=?').get(input.requestId);
    if (row) {
      if (row.user_id !== user.id || row.fingerprint !== fingerprint)
        return res.status(409).json({ error: '请求 ID 已被使用，请刷新后重试。' });
      await active.get(input.requestId);
      if (closed)
        return res.status(503).json({
          state: 'unknown',
          requestId: input.requestId,
          error: '服务正在停止，请稍后查询原请求结果。',
        });
      row = db.prepare('SELECT * FROM control_requests WHERE id=?').get(input.requestId)!;
      const result = row.result_json
        ? JSON.parse(String(row.result_json))
        : { error: '发送结果待确认，请检查会话记录，勿重复发送。' };
      return res
        .status(
          row.state === 'succeeded'
            ? 200
            : row.state === 'pending'
              ? 202
              : row.state === 'unknown'
                ? 409
                : 502,
        )
        .json({ ...result, state: row.state, requestId: input.requestId });
    }
    db.prepare('INSERT INTO control_requests VALUES(?,?,?,?,?,?)').run(
      input.requestId,
      user.id,
      fingerprint,
      'pending',
      null,
      Date.now(),
    );
    // Stopping must remain available while a message is awaiting its receipt.
    const laneKey = target.endsWith(':interrupt')
      ? `interrupt:${target.split(':')[1]}`
      : target.startsWith('command:')
        ? target.split(':')[1]
        : target;
    const job = inLane(laneKey, async () => {
      try {
        await authorize(req);
        const result = await operation();
        if (closed) throw new ControlError('服务正在停止，请稍后查询原请求结果。', true, 503);
        db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?').run(
          'succeeded',
          JSON.stringify(result),
          input.requestId,
        );
        appendAudit(
          db,
          target.startsWith('project:')
            ? 'session_created'
            : target.startsWith('command:')
              ? 'session_command'
              : 'message_sent',
          user.username,
          req.ip ?? '',
        );
        res
          .status(200)
          .json({ state: 'succeeded', requestId: input.requestId, ...(result as object) });
      } catch (error) {
        // The persisted pending receipt becomes unknown on the next startup.
        // Never touch a database that the application has already closed.
        if (closed) {
          res.status(503).json({
            state: 'unknown',
            requestId: input.requestId,
            error: '服务正在停止，请稍后查询原请求结果。',
          });
          return;
        }
        const failure =
          error instanceof ControlError
            ? error
            : new ControlError('请求失败，发送结果待确认。请检查会话记录，勿重复发送。', true, 502);
        const state = failure.uncertain ? 'unknown' : 'failed';
        const result = { error: failure.message };
        db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?').run(
          state,
          JSON.stringify(result),
          input.requestId,
        );
        res.status(failure.status).json({ state, requestId: input.requestId, ...result });
      }
    });
    active.set(input.requestId, job);
    try {
      await job;
    } finally {
      active.delete(input.requestId);
    }
  }
  app.post('/api/sessions/:id/messages', admin, async (req, res) => {
    const parsed = schema
        .extend({
          ...modelFields,
          channel: z.literal('desktop').optional(),
          permissionMode: z.enum(sessionPermissionModes).optional(),
        })
        .refine(hasModelForThinking)
        .safeParse(req.body),
      id = String(req.params.id);
    if (!parsed.success || !hasContent(parsed.data) || !validId(id))
      return res
        .status(400)
        .json({ error: '请输入最多 12000 字符的消息或上传附件，并提供有效请求 ID。' });
    const session = await source.get(id);
    if (!session) return res.status(404).json({ error: '找不到此会话' });
    if (session.archived || session.subagent)
      return res.status(409).json({ error: '归档或内部子代理会话不能发送消息。' });
    if (parsed.data.channel && !bridge.desktopChannel)
      return res
        .status(409)
        .json({ state: 'failed', error: '此客户端暂不支持桌面通道，请更新客户端后重试。' });
    const permissionMode = parsed.data.permissionMode === 'inherit' ? undefined : parsed.data.permissionMode;
    if (permissionMode && (!bridge.messagePermissions || parsed.data.channel === 'desktop'))
      return res.status(400).json({ error: '仅 Monitor 通道支持切换会话权限。' });
    const text = parsed.data.prompt;
    if (text.startsWith('/')) {
      if (parsed.data.channel)
        return res.status(400).json({ error: '桌面通道用于普通消息，请取消勾选后使用斜杠指令。' });
      if (parsed.data.model)
        return res
          .status(400)
          .json({ error: '斜杠指令不能切换模型，请使用普通消息或沿用当前会话设置。' });
      if (permissionMode)
        return res.status(400).json({ error: '斜杠指令不能切换会话权限，请发送普通消息。' });
      if (parsed.data.attachments?.length)
        return res.status(400).json({ error: '斜杠指令不支持附件，请使用普通消息发送。' });
      let name: string | undefined, objective: string | undefined;
      if (text === '/compact') name = 'compact';
      else if (text === '/help') name = 'help';
      else if (/^\/goal(?:\s|$)/.test(text)) {
        const argument = text.slice(5).trim();
        name =
          !argument || argument === 'status'
            ? 'goal.get'
            : ['pause', 'resume', 'clear'].includes(argument)
              ? 'goal.' + argument
              : 'goal.set';
        if (name === 'goal.set') objective = argument;
      }
      if (!name || (objective?.length ?? 0) > 4000)
        return res.status(400).json({
          error:
            '可用指令：/compact、/goal、/goal 目标内容、/goal pause|resume|clear、/help。目标最多 4000 字符。',
        });
      return mutate(req, res, parsed.data, id, () => command(req, id, name!, objective));
    }
    try {
      await authorize(req);
      const { httpStatus, ...receipt } = await messages.submit(
        req.identity!.user.id,
        req.ip ?? '',
        id,
        {
          requestId: parsed.data.requestId,
          prompt: compose(req, parsed.data),
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
          ...(parsed.data.thinking ? { thinking: parsed.data.thinking } : {}),
          ...(parsed.data.channel ? { channel: parsed.data.channel } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        },
      );
      res.status(httpStatus).json(receipt);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.post('/api/sessions', admin, async (req, res) => {
    const parsed = schema
      .extend({
        projectId: z.uuid(),
        asGoal: z.boolean().optional(),
        permissionMode: z.enum(sessionPermissionModes).optional(),
        ...modelFields,
        channel: z.literal('desktop').optional(),
      })
      .refine(hasModelForThinking)
      .safeParse(req.body);
    if (!parsed.success || !hasContent(parsed.data))
      return res.status(400).json({ error: '请选择项目，并输入最多 12000 字符的消息或上传附件。' });
    const goalCommand = /^\/goal(?:\s|$)/.test(parsed.data.prompt);
    const asGoal = !!parsed.data.asGoal || goalCommand;
    const prompt = goalCommand ? parsed.data.prompt.slice(5).trim() : parsed.data.prompt;
    if (
      asGoal &&
      (!prompt ||
        prompt.length > 4000 ||
        (goalCommand && ['status', 'pause', 'resume', 'clear'].includes(prompt)))
    )
      return res.status(400).json({ error: '新会话目标需 1–4000 字符，请填写目标内容。' });
    const input = { ...parsed.data, prompt, asGoal };
    if (input.channel && !bridge.desktopChannel)
      return res
        .status(409)
        .json({ state: 'failed', error: '此客户端暂不支持桌面通道，请更新客户端后重试。' });
    if (input.channel === 'desktop' && input.permissionMode && input.permissionMode !== 'inherit')
      return res.status(400).json({ error: '桌面通道沿用 Codex 桌面端的权限设置。' });
    if (input.permissionMode && !bridge.creationPermissions && input.channel !== 'desktop')
      return res
        .status(409)
        .json({ error: '此 client 暂不支持会话权限设置，请更新 client 或沿用本机配置。' });
    await mutate(req, res, input, 'project:' + input.projectId, async () => {
      const caller = await context(undefined, input.channel === 'desktop');
      const projects = await bridge.projects(caller);
      if (!projects.some((p) => p.id === parsed.data.projectId))
        throw new ControlError('项目不可用，请刷新项目列表。', false, 400);
      const { model, thinking } = parsed.data;
      await validateModelSettings(bridge, { model, thinking });
      await authorize(req);
      const objective = compose(req, input);
      const receipt = await createSession(
        caller,
        input.projectId,
        asGoal ? `/goal ${objective}` : objective,
        {
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.channel ? { channel: input.channel } : {}),
        },
        input.requestId,
        asGoal ? objective : undefined,
      );
      return asGoal ? saveCreationGoal(bridge, receipt, () => authorize(req)) : receipt;
    });
  });
  const close = () => {
    closed = true;
    messages.close();
    bridge.close?.();
  };
  return { close, projectPath, sendLarkReply, larkReplyStatus, startLarkSession };
}
