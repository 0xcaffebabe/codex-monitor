import { readFileSync } from 'node:fs';

export interface ClientConnectionConfig {
  serverUrl: string;
  workspaceId: string;
  key: string;
}

/** Validate before creating local databases or starting the desktop watchdog. */
export function clientConnectionUrl({ serverUrl, workspaceId, key }: ClientConnectionConfig) {
  if (!serverUrl) throw new Error('Client requires --server-url (MONITOR_SERVER_URL)');
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('--server-url (MONITOR_SERVER_URL) must be an http(s) or ws(s) origin');
  }
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('--server-url (MONITOR_SERVER_URL) must be an http(s) or ws(s) origin');
  if (
    !/^(?:local|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(workspaceId)
  )
    throw new Error('Client requires a valid --workspace-id (MONITOR_WORKSPACE_ID)');
  if (!/^[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error('Client requires a 43-character base64url --client-key (MONITOR_CLIENT_KEY)');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = '/api/clients/connect';
  url.searchParams.set('workspace', workspaceId);
  return url;
}

export function clientConnectionFromEnv(env: NodeJS.ProcessEnv): ClientConnectionConfig {
  let key = env.MONITOR_CLIENT_KEY || '';
  if (env.MONITOR_CLIENT_KEY_FILE) {
    try {
      key = readFileSync(env.MONITOR_CLIENT_KEY_FILE, 'utf8').trim();
    } catch {
      throw new Error('Cannot read --client-key-file (MONITOR_CLIENT_KEY_FILE)');
    }
  }
  const connection = {
    serverUrl: env.MONITOR_SERVER_URL || '',
    workspaceId: env.MONITOR_WORKSPACE_ID || '',
    key,
  };
  clientConnectionUrl(connection);
  return connection;
}
