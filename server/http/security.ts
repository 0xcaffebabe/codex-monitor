import compression from 'compression';
import type { Express } from 'express';
import express from 'express';
import helmet from 'helmet';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.js';
import { fail } from './access.js';
import { MAX_JSON_BODY } from '../transport/protocol.js';
import { buildId } from '../build-info.js';

function requestRejection(config: Config) {
  const hosts = new Set([
    'localhost',
    '127.0.0.1',
    '159.75.6.20',
    '::1',
    os.hostname().toLowerCase(),
    ...Object.values(os.networkInterfaces()).flatMap((n) => n?.map((x) => x.address) ?? []),
  ]);
  for (const origin of config.origins) {
    try {
      hosts.add(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
    } catch {
      throw new Error('MONITOR_ORIGINS must contain valid origins');
    }
  }
  return (req: Pick<IncomingMessage, 'headers'>, pageNavigation = false) => {
    try {
      const host = new URL(`http://${req.headers.host}`).hostname
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (!hosts.has(host)) return '此主机名未获授权';
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin)) {
        const url = new URL(origin);
        if (url.host !== req.headers.host || !['http:', 'https:'].includes(url.protocol))
          return '请求来源未获授权';
      }
      if (
        req.headers['sec-fetch-site'] === 'cross-site' &&
        !pageNavigation &&
        !config.origins.includes(origin || '')
      )
        return '不允许跨站请求';
    } catch {
      return '请求来源未获授权';
    }
  };
}

export function requestGuard(config: Config) {
  const rejection = requestRejection(config);
  return (req: Pick<IncomingMessage, 'headers'>) => !rejection(req);
}

export function installHttpSecurity(app: Express, config: Config) {
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
      strictTransportSecurity: config.secure ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  const rejection = requestRejection(config);
  app.use((req, res, next) => {
    const pageNavigation =
      req.method === 'GET' &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      !req.path.startsWith('/api');
    const error = rejection(req, pageNavigation);
    if (error) return fail(res, 403, error);
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    compression({
      level: 4,
      filter: (req, res) => {
        if (
          req.path.endsWith('/stream') ||
          req.path.startsWith('/api/auth') ||
          req.path.startsWith('/api/users')
        )
          return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: MAX_JSON_BODY, type: 'application/json' }));
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, app: 'codex-monitor', version: '1.0.0', buildId }),
  );
}
