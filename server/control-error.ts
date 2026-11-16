export class ControlError extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public status = 503,
    public code?: 'compacting' | 'no_owner' | 'owner_unavailable',
  ) {
    super(message);
  }
}

export function compactingError(message: string) {
  return /ActiveTurnNotSteerable[\s\S]{0,200}\bCompact\b|turn_kind["']?\s*:\s*["']?Compact\b/i.test(
    message,
  )
    ? new ControlError('会话正在压缩上下文，消息将排队等待。', false, 409, 'compacting')
    : undefined;
}
