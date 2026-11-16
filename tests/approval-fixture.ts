import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { NativeApprovals } from '../server/native-approvals.js';
import { FixtureDesktop } from './control-fixture.js';
import type { fixture } from './fixture.js';
import type { SessionModelSettings } from '../src/types.js';

/** A disposable execution target for browser approval flows; all writes stay in the fixture. */
export class ApprovalFixtureDesktop extends FixtureDesktop {
  readonly approvals = new NativeApprovals();
  readonly creationPermissions = true;
  private closed = false;
  constructor(
    private data: ReturnType<typeof fixture>,
    compactMs = 0,
  ) {
    super(data, compactMs);
  }
  override async send(
    context: string,
    id: string,
    prompt: string,
    settings: SessionModelSettings = {},
  ) {
    const result = await super.send(context, id, prompt, settings);
    if (!prompt.startsWith('APPROVAL_TEST:')) return result;
    const turnId = String(
      this.data.hist
        .prepare(
          'SELECT turn_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
        )
        .get(id)!.turn_id,
    );
    this.data.hist
      .prepare(
        "UPDATE thread_turns SET status='inProgress',completed_at=NULL WHERE thread_id=? AND turn_id=?",
      )
      .run(id, turnId);
    const directory = path.join(this.data.root, 'approval-output');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, id + '.txt');
    const mode = prompt.slice('APPROVAL_TEST:'.length);
    const params = {
      threadId: id,
      turnId,
      itemId: 'approval-item',
      cwd: directory,
      reason: '测试需要写入此临时文件，并验证网络权限显示。',
    };
    const method =
      mode === 'command'
        ? 'item/commandExecution/requestApproval'
        : mode === 'file'
          ? 'item/fileChange/requestApproval'
          : 'item/permissions/requestApproval';
    const input =
      method === 'item/permissions/requestApproval'
        ? { ...params, permissions: { network: { enabled: true }, fileSystem: { write: [file] } } }
        : method === 'item/fileChange/requestApproval'
          ? { ...params, grantRoot: directory }
          : {
              ...params,
              command: `printf 'approved\\n' >> '${file}'`,
              networkApprovalContext: { host: '127.0.0.1', protocol: 'http' },
            };
    void this.approvals
      .request(
        method,
        input,
        new AbortController().signal,
        method === 'item/fileChange/requestApproval'
          ? [{ path: file, diff: '+approved\n', kind: { type: 'add' } }]
          : undefined,
      )
      .then(async (reply: any) => {
        if (this.closed) return;
        const allowed =
          reply.decision === 'accept' || reply.permissions?.fileSystem?.write?.includes(file);
        if (allowed) appendFileSync(file, 'approved\n');
        await super.send(context, id, allowed ? 'APPROVAL_ALLOWED' : 'APPROVAL_DECLINED');
      })
      .catch(() => {});
    return result;
  }
  override async interrupt(id: string, turnId: string) {
    const result = await super.interrupt(id, turnId);
    if (result.interruptedTurnId) this.approvals.cancelTurn(id, turnId);
    return result;
  }
  close() {
    this.closed = true;
    this.approvals.close();
  }
}
