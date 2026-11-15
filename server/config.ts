import path from 'node:path';
import os from 'node:os';
export interface Config {
  mode?: 'standalone' | 'server' | 'client';
  codexHome: string;
  dataDir: string;
  host: string;
  port: number;
  origins: string[];
  sessionDays: number;
  pollMs: number;
  secure: boolean;
  pricingFile?: string;
  desktopAutoStart?: boolean;
  desktopCheckMs?: number;
  desktopExecutable?: string;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.MONITOR_MODE || 'standalone';
  if (!['standalone', 'server', 'client'].includes(mode))
    throw new Error('MONITOR_MODE must be standalone, server or client');
  const port = Number(env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const desktopAutoStart = env.MONITOR_CODEX_AUTOSTART;
  if (desktopAutoStart !== undefined && !['true', 'false'].includes(desktopAutoStart))
    throw new Error('MONITOR_CODEX_AUTOSTART must be true or false');
  const desktopCheckMs = Number(env.MONITOR_CODEX_CHECK_MS || 15000);
  if (!Number.isInteger(desktopCheckMs) || desktopCheckMs < 1000 || desktopCheckMs > 300000)
    throw new Error('MONITOR_CODEX_CHECK_MS must be 1000–300000');
  const desktopExecutable = env.MONITOR_CODEX_DESKTOP || undefined;
  if (desktopExecutable && !path.isAbsolute(desktopExecutable))
    throw new Error('MONITOR_CODEX_DESKTOP must be an absolute executable path');
  const pollMs = Number(env.MONITOR_POLL_MS || 1500);
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 2147483647)
    throw new Error('MONITOR_POLL_MS must be 500–2147483647');
  return {
    mode: mode as Config['mode'],
    codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    dataDir: path.resolve(
      env.MONITOR_DATA_DIR || (mode === 'client' ? '.monitor-client' : '.monitor'),
    ),
    host: env.HOST || '0.0.0.0',
    port,
    origins: (env.MONITOR_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionDays: 90,
    pollMs,
    secure: env.MONITOR_HTTPS === 'true',
    pricingFile: path.resolve(env.MONITOR_PRICING_FILE || 'config/model-pricing.json'),
    desktopAutoStart:
      mode !== 'server' && process.platform === 'win32' && desktopAutoStart !== 'false',
    desktopCheckMs,
    desktopExecutable,
  };
}
