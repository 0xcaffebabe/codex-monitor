import { z } from 'zod';
import { WebSocket } from 'ws';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { notificationPolicySchema, notificationReportSchema } from '../notifications/events.js';
import type { HostResourceSample } from '../../src/workspaces.js';

export const PROTOCOL_VERSION = 3;
export const MAX_BODY = 20 * 1024 * 1024;
export const MAX_JSON_BODY = 64 * 1024;
export const MAX_REQUESTS = 64;
export const MAX_PLAINTEXT = Math.ceil(MAX_JSON_BODY / 3) * 4 + 16384;
export const MAX_FRAME = Math.ceil(MAX_PLAINTEXT / 3) * 4 + 1024;
export const CHUNK_BYTES = 48 * 1024;
export const identitySchema = z.object({
  user: z.object({
    id: z.uuid(),
    username: z.string().min(1).max(40),
    role: z.enum(['admin', 'viewer']),
  }),
  sessionId: z.uuid(),
  expiresAt: z.number().finite(),
});
const id = z.uuid();
const headers = z.record(z.string().max(80), z.string().max(2048));
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hostResourceSchema: z.ZodType<HostResourceSample> = z
  .object({
    sampledAt: bytes,
    cpuPercent: z.number().finite().min(0).max(100).nullable(),
    memory: z
      .object({
        totalBytes: bytes.positive(),
        usedBytes: bytes,
        usedPercent: z.number().finite().min(0).max(100),
      })
      .strict()
      .refine(
        (memory) =>
          memory.usedBytes <= memory.totalBytes &&
          Math.abs(memory.usedPercent - (memory.usedBytes / memory.totalBytes) * 100) < 0.01,
      )
      .nullable(),
  })
  .strict();
export const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('host-resources'), sample: hostResourceSchema }).strict(),
  z.object({
    type: z.literal('notification-policy'),
    policy: notificationPolicySchema,
    baseline: z.boolean(),
  }),
  z.object({
    type: z.literal('notification-policy-ack'),
    revision: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('notification-report'), id, report: notificationReportSchema }),
  z.object({ type: z.literal('notification-report-ack'), id, accepted: z.boolean() }),
  z.object({
    type: z.literal('hello'),
    version: z.literal(PROTOCOL_VERSION),
    hostname: z.string().max(200),
    platform: z.string().max(80),
    capabilities: z.object({ completionNotifications: z.boolean().optional() }).optional(),
  }),
  z.object({
    type: z.literal('welcome'),
    version: z.literal(PROTOCOL_VERSION),
    workspaceId: z.string().max(100),
    capabilities: z.object({ hostResources: z.boolean().optional() }).optional(),
  }),
  z.object({
    type: z.literal('request'),
    id,
    grantId: id,
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path: z.string().max(8192),
    headers,
    body: z.string().max(Math.ceil(MAX_JSON_BODY / 3) * 4),
    bodySize: z.number().int().min(0).max(MAX_BODY).optional(),
  }),
  z.object({ type: z.literal('body'), id, data: z.string().max((CHUNK_BYTES / 3) * 4) }),
  z.object({ type: z.literal('body-ack'), id }),
  z.object({ type: z.literal('body-end'), id }),
  z.object({
    type: z.literal('response'),
    id,
    status: z.number().int().min(200).max(599),
    headers,
  }),
  z.object({ type: z.literal('data'), id, data: z.string().max((CHUNK_BYTES / 3) * 4) }),
  z.object({ type: z.literal('ack'), id }),
  z.object({ type: z.literal('end'), id }),
  z.object({ type: z.literal('cancel'), id }),
  z.object({ type: z.literal('error'), id, message: z.string().max(500) }),
  z.object({
    type: z.literal('authorize'),
    id,
    grantId: id.optional(),
    userId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal('authorized'),
    id,
    result: z.union([identitySchema, z.boolean(), z.null()]),
  }),
]);
export type Frame = z.infer<typeof frameSchema>;

const channels = new WeakMap<WebSocket, SecureChannel>();
const exchangeSchema = z
  .object({
    type: z.literal('channel'),
    version: z.literal(PROTOCOL_VERSION),
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const envelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    n: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    c: z.string().max(MAX_FRAME),
    t: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

export function connectionProof(
  key: string,
  workspaceId: string,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
) {
  const payload = `${workspaceId}\n${timestamp}\n${nonce}`;
  const signature = createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`codex-monitor/connect/v${PROTOCOL_VERSION}\n${payload}`)
    .digest('base64url');
  return `Monitor-HMAC ${timestamp}.${nonce}.${signature}`;
}

/** Fixed locally stored AES key; random IVs and connection-bound AAD protect every message. */
export class SecureChannel {
  private outbound = 0;
  private inbound = 0;
  private key: Buffer;
  private sendDirection: string;
  private receiveDirection: string;
  private context: string;
  constructor(
    key: string,
    connectionId: string,
    role: 'server' | 'client',
    handshakeProof: string,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !/^[A-Za-z0-9_-]{43}$/.test(connectionId))
      throw new Error('Invalid key material');
    this.key = Buffer.from(key, 'base64url');
    // Bind both peers' freshness: the cleartext server connection ID alone can be replayed.
    const handshake = createHash('sha256').update(handshakeProof).digest('base64url');
    this.context = `codex-monitor/ws/v${PROTOCOL_VERSION}/${connectionId}/${handshake}`;
    this.sendDirection = role === 'server' ? 'server-to-client' : 'client-to-server';
    this.receiveDirection = role === 'server' ? 'client-to-server' : 'server-to-client';
  }
  encode(frame: Frame) {
    const plaintext = Buffer.from(JSON.stringify(frame));
    if (plaintext.length > MAX_PLAINTEXT || this.outbound >= Number.MAX_SAFE_INTEGER)
      throw new Error('Frame too large');
    const n = ++this.outbound,
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.context}/${this.sendDirection}/${n}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      n,
      iv: iv.toString('base64url'),
      c: ciphertext.toString('base64url'),
      t: cipher.getAuthTag().toString('base64url'),
    });
  }
  decode(raw: string) {
    if (Buffer.byteLength(raw) > MAX_FRAME) throw new Error('Frame too large');
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    if (envelope.n !== this.inbound + 1) throw new Error('Invalid frame sequence');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`${this.context}/${this.receiveDirection}/${envelope.n}`));
    decipher.setAuthTag(Buffer.from(envelope.t, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.c, 'base64url')),
      decipher.final(),
    ]);
    if (plaintext.length > MAX_PLAINTEXT) throw new Error('Frame too large');
    const frame = frameSchema.parse(JSON.parse(plaintext.toString('utf8')));
    this.inbound = envelope.n;
    return frame;
  }
}
export function startServerChannel(socket: WebSocket, key: string, handshakeProof: string) {
  const connectionId = randomBytes(32).toString('base64url');
  channels.set(socket, new SecureChannel(key, connectionId, 'server', handshakeProof));
  socket.send(JSON.stringify({ type: 'channel', version: PROTOCOL_VERSION, connectionId }));
}
export function startClientChannel(
  socket: WebSocket,
  key: string,
  raw: string,
  handshakeProof: string,
) {
  if (channels.has(socket)) throw new Error('Channel already initialized');
  const exchange = exchangeSchema.parse(JSON.parse(raw));
  channels.set(socket, new SecureChannel(key, exchange.connectionId, 'client', handshakeProof));
}
export function readFrame(socket: WebSocket, data: Buffer | ArrayBuffer | Buffer[]): Frame {
  const channel = channels.get(socket);
  if (!channel) throw new Error('Encrypted channel required');
  return channel.decode(data.toString());
}
export function sendFrame(socket: WebSocket, frame: Frame): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Client connection closed'));
    const channel = channels.get(socket);
    if (!channel) return reject(new Error('Encrypted channel required'));
    let encoded: string;
    try {
      encoded = channel.encode(frame);
    } catch (error) {
      reject(error);
      return;
    }
    socket.send(encoded, (error) => (error ? reject(error) : resolve()));
  });
}

/** Only workspace capabilities can cross the tunnel. No auth or arbitrary URL forwarding. */
export function workspacePath(method: string, value: string) {
  if (
    !['GET', 'POST', 'PUT', 'DELETE'].includes(method) ||
    value.length > 8192 ||
    /[\\\x00-\x20\x7f#]/.test(value)
  )
    return false;
  const [pathname] = value.split('?');
  if (/%(?![0-9a-f]{2})/i.test(value) || /%2f|%5c|%2e|%00/i.test(pathname)) return false;
  return /^\/api\/(?:overview|sessions(?:\/[A-Za-z0-9_-]+)*|control(?:\/[A-Za-z0-9_-]+)*|uploads(?:\/[A-Za-z0-9_-]+)*|usage(?:\/[A-Za-z0-9_-]+)*|stream)$/.test(
    pathname,
  );
}
