export class ControlError extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public status = 503,
    public code?: 'compacting' | 'desktop_busy' | 'no_owner' | 'owner_unavailable',
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

export function activeWriterError(message: string) {
  return /already has an active writer/i.test(message)
    ? new ControlError('会话正在其他客户端中使用，请在原客户端处理后重试。', false, 409)
    : undefined;
}
