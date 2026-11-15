import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail } from './access.js';

export function installFrontend(app: Express, publicDir: string) {
  app.use('/api', (_req, res) => fail(res, 404, '接口不存在'));
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) =>
      res.setHeader('Cache-Control', 'no-cache').sendFile(path.join(publicDir, 'index.html')),
    );
  } else
    app.get('/', (_req, res) =>
      res.status(503).send('请先运行 npm run build，或使用 npm run dev:web 启动开发界面。'),
    );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    fail(
      res,
      error?.type === 'entity.parse.failed' ? 400 : error?.status === 413 ? 413 : 500,
      error?.status === 413
        ? '请求内容过大'
        : error?.type === 'entity.parse.failed'
          ? 'JSON 格式无效'
          : '服务暂时不可用，请稍后重试',
    );
  });
}
