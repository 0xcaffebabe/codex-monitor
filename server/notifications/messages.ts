import type { NotificationEvent } from './events.js';

export function notificationMessage(
  event: Exclude<NotificationEvent, { kind: 'session.input_resolved' }>,
  workspace: { id: string; name: string },
  publicUrl: string,
) {
  const completed = event.kind === 'session.completed';
  const lines = [
    completed ? '✅ Codex 本轮已结束' : '🙋 Codex 需要你选择或回答',
    `工作空间：${workspace.name}`,
    `会话：${event.title}`,
    `项目：${event.project}`,
  ];
  if (completed) {
    const date = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(event.occurredAt);
    lines.push(`完成时间：${date} (UTC+8)`);
  }
  // Keep navigation outside summaries that may be truncated inside a code block.
  if (publicUrl) {
    const url = new URL(publicUrl);
    url.searchParams.set('session', event.sessionId);
    url.searchParams.set('workspace', workspace.id);
    url.searchParams.set('view', 'attention');
    if (completed) url.searchParams.set('result', event.turnId);
    else url.searchParams.set('request', event.requestId);
    lines.push('', `[${completed ? '查看本轮结果' : '查看会话'}](<${url.href}>)`);
  }
  if (completed) {
    if (event.summary.trim()) lines.push('', `回复摘要：\n${event.summary}`);
  } else {
    event.questions.forEach((question, index) => {
      lines.push('', `${index + 1}. ${question.title}`);
      question.options.forEach((option, i) => lines.push(`  ${i + 1}) ${option}`));
    });
    lines.push('', '请在 Codex 中选择或回复。');
  }
  return lines.join('\n');
}
