import type { DatabaseSync } from 'node:sqlite';
import type { DesktopControl } from './desktop.js';
import { ControlError } from './control-error.js';
import { validId } from './source/session.js';
import type { Receipt, SessionGoal } from '../src/control-types.js';

export type CreationReceipt = Omit<Receipt, 'state' | 'requestId'> & {
  mode: 'create';
  threadId: string;
  acceptedAt: number;
};

export function creationReceipt(value: unknown): CreationReceipt | undefined {
  const result = value as CreationReceipt | null;
  if (
    result?.mode === 'create' &&
    typeof result.threadId === 'string' &&
    validId(result.threadId) &&
    typeof result.acceptedAt === 'number'
  )
    return result;
}

/** A known created thread must survive a restart during the separate goal write. */
export function restoreControlRequests(db: DatabaseSync) {
  const update = db.prepare('UPDATE control_requests SET state=?,result_json=? WHERE id=?');
  for (const row of db
    .prepare("SELECT id,result_json FROM control_requests WHERE state='pending'")
    .all()) {
    let result: unknown;
    try {
      result = JSON.parse(String(row.result_json));
    } catch {}
    const created = creationReceipt(result);
    update.run(
      created ? 'succeeded' : 'unknown',
      JSON.stringify(
        created
          ? {
              ...created,
              ...(created.goalObjective
                ? {
                    goalState: 'unknown',
                    goalError: '服务已重启，请确认目标保存结果。',
                    message: '会话已创建，目标保存状态待确认。',
                  }
                : {}),
            }
          : { error: '服务已重启，发送结果待确认，请检查会话记录，勿重复发送。' },
      ),
      row.id!,
    );
  }
}

function goalReceipt(receipt: CreationReceipt, goal: SessionGoal): CreationReceipt {
  if (goal.objective !== receipt.goalObjective)
    return {
      ...receipt,
      goal,
      goalState: 'conflict',
      goalError: '会话已有其他目标，请打开会话查看。',
      message: '会话已创建，现有目标已保留。',
    };
  return {
    ...receipt,
    goal,
    goalState: 'saved',
    goalError: undefined,
    message: '会话已创建并发送，目标已保存。',
  };
}

/** The first /goal prompt already starts work; saving must never send another turn. */
export async function saveCreationGoal(
  bridge: Pick<DesktopControl, 'goal'>,
  receipt: CreationReceipt,
  authorize: () => Promise<unknown>,
): Promise<CreationReceipt> {
  try {
    await authorize();
    const current = await bridge.goal(receipt.threadId, 'get');
    // The first turn may have already created, completed, paused or replaced the goal.
    if (current) return goalReceipt(receipt, current);
    await authorize();
    const goal = await bridge.goal(receipt.threadId, 'set', receipt.goalObjective);
    if (!goal) throw new ControlError('无法确认目标保存结果。', true, 502);
    return goalReceipt(receipt, goal);
  } catch (error) {
    return {
      ...receipt,
      goalState: error instanceof ControlError && !error.uncertain ? 'failed' : 'unknown',
      goalError: error instanceof ControlError ? error.message : '目标保存结果待确认。',
      message: '会话已创建并发送，请确认目标保存结果。',
    };
  }
}
