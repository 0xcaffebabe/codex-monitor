import { Sun } from 'lucide-react';
import { useScreenWakeLock } from './useScreenWakeLock';

const messages = {
  requesting: ['正在启用常亮', '正在启用屏幕常亮。'],
  active: ['屏幕常亮', '停留在会话详情时保持屏幕常亮，离开详情或切到后台后恢复自动锁屏。'],
  paused: ['重试常亮', '屏幕常亮已暂停，点按重试；如仍无法启用，请检查低电量模式或浏览器设置。'],
  insecure: ['常亮需 HTTPS', '请使用 HTTPS 地址打开，才能保持屏幕常亮。'],
  unsupported: ['常亮不可用', '当前浏览器不支持屏幕常亮，请使用支持此功能的 iOS Safari。'],
};

export function ScreenWakeLockIndicator() {
  const { status, retry } = useScreenWakeLock();
  if (status === 'inactive') return null;
  const [label, description] = messages[status];
  return (
    <span className="screen-wake-lock" data-state={status} role="status" title={description}>
      <Sun size={12} aria-hidden="true" />
      {status === 'paused' ? (
        <button type="button" onClick={retry} aria-label={description}>
          {label}
        </button>
      ) : (
        <span aria-label={description}>{label}</span>
      )}
    </span>
  );
}
