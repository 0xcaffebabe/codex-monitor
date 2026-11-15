import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const occurredAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const session = {
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().max(500),
  project: z.string().max(200),
};

export const notificationEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session.completed'),
      ...session,
      turnId: identifier,
      occurredAt,
      summary: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session.input_required'),
      ...session,
      requestId: identifier,
      occurredAt,
      questions: z
        .array(
          z
            .object({
              title: z.string().max(600),
              options: z.array(z.string().max(150)).max(5),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session.input_resolved'),
      sessionId: session.sessionId,
      requestId: identifier,
    })
    .strict(),
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/** The server sends collection boundaries only; webhook credentials never cross the tunnel. */
export const notificationPolicySchema = z
  .object({
    enabled: z.boolean(),
    enabledAt: occurredAt,
    inputSince: occurredAt,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;
export const notificationReportSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    events: z.array(notificationEventSchema).max(4),
    monitorError: z.enum(['', '完成事件暂时不可读，后台正在重试']),
  })
  .strict();
export type NotificationReport = z.infer<typeof notificationReportSchema>;

export function notificationKey(event: NotificationEvent) {
  return event.kind === 'session.completed'
    ? `${event.sessionId}:${event.turnId}`
    : `input:${event.sessionId}:${event.requestId}`;
}
export function reportKey(event: NotificationEvent) {
  return `${event.kind}:${notificationKey(event)}`;
}
