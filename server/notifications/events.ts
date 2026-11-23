import { z } from 'zod';

export const COMPLETION_REPLY_BYTES = 12 * 1024;
export const LEGACY_COMPLETION_SUMMARY_LIMIT = 1000;

export function fitsCompletionReply(reply: string) {
  return Buffer.byteLength(JSON.stringify(reply)) <= COMPLETION_REPLY_BYTES;
}

const identifier = z.string().min(1).max(200);
const occurredAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const session = {
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().max(500),
  project: z.string().max(200),
};

export const completionEventSchema = z
  .object({
    kind: z.literal('session.completed'),
    ...session,
    turnId: identifier,
    occurredAt,
    summary: z.string().max(COMPLETION_REPLY_BYTES).refine(fitsCompletionReply),
  })
  .strict();
export type CompletionEvent = z.infer<typeof completionEventSchema>;

export const notificationEventSchema = z.discriminatedUnion('kind', [
  completionEventSchema,
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
    completionSince: occurredAt.optional(),
  })
  .strict();
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;
export const notificationReportSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    events: z.array(notificationEventSchema).max(4),
    completions: z.array(completionEventSchema).max(4).optional(),
    monitorError: z.enum(['', '完成事件暂时不可读，后台正在重试']),
  })
  .strict()
  .refine((report) => report.events.length + (report.completions?.length ?? 0) <= 4);
export type NotificationReport = z.infer<typeof notificationReportSchema>;

export function notificationKey(event: NotificationEvent) {
  return event.kind === 'session.completed'
    ? `${event.sessionId}:${event.turnId}`
    : `input:${event.sessionId}:${event.requestId}`;
}
export function reportKey(event: NotificationEvent) {
  return `${event.kind}:${notificationKey(event)}`;
}
