import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMonitorServer } from './server-app.js';
import { MonitorClient } from './client/connection.js';
import { startupFromArgs, startupHelp } from './cli.js';
import { requestGuard } from './http/security.js';
import { PROTOCOL_VERSION } from './transport/protocol.js';

const startup = (() => {
  try {
    return startupFromArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Startup failed: ${(error as Error).message}`);
    process.exit(1);
  }
})();
if (startup.help) {
  console.log(startupHelp);
  process.exit(0);
}
if (startup.checkConfig) {
  console.log(`Configuration valid (${startup.config.mode}).`);
  process.exit(0);
}
// Native RPCs and desktop helpers also consume the effective environment.
Object.assign(process.env, startup.env);
if (!startup.env.MONITOR_CLIENT_KEY_FILE) delete process.env.MONITOR_CLIENT_KEY_FILE;
if (!startup.env.MONITOR_CLIENT_KEY) delete process.env.MONITOR_CLIENT_KEY;
const config = startup.config;
let client: MonitorClient | undefined;
let service: ReturnType<typeof createMonitorServer> | undefined;
let server: ReturnType<typeof createServer> | undefined;
if (config.mode === 'client') {
  client = await MonitorClient.start({
    config,
    ...startup.client!,
    onStatus: (status, reason) => console.log(`Client ${status}${reason ? ': ' + reason : ''}`),
  });
  console.log(`Codex Monitor client: ${config.codexHome}`);
  console.log(
    `  Server: ${startup.client!.serverUrl}\n  Workspace: ${startup.client!.workspaceId}\n  Protocol: ${PROTOCOL_VERSION}\n  Data: ${config.dataDir}`,
  );
} else {
  service = createMonitorServer(config);
  const cert = process.env.MONITOR_TLS_CERT,
    key = process.env.MONITOR_TLS_KEY;
  if (config.secure && (!cert || !key))
    throw new Error('HTTPS requires MONITOR_TLS_CERT and MONITOR_TLS_KEY');
  server = config.secure
    ? createHttpsServer({ cert: readFileSync(cert!), key: readFileSync(key!) }, service.app)
    : createServer(service.app);
  service.gateway.attach(server, requestGuard(config));
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(config.port, config.host, resolve);
  });
  const scheme = config.secure ? 'https' : 'http';
  console.log(
    `\n  Codex Monitor (${config.mode || 'standalone'})\n  Local: ${scheme}://localhost:${config.port}\n  Protocol: ${PROTOCOL_VERSION}\n  Data: ${config.dataDir}`,
  );
  for (const x of Object.values(os.networkInterfaces()).flat())
    if (x?.family === 'IPv4' && !x.internal)
      console.log(`  LAN: ${scheme}://${x.address}:${config.port}`);
  if (service.auth.setupKey)
    console.log(
      `\n  First setup (private): ${scheme}://localhost:${config.port}/#setup=${service.auth.setupKey}\n`,
    );
  if (config.mode !== 'server') {
    const keyFile = path.join(config.dataDir, 'local-client-key');
    let key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';
    if (!service.gateway.store.get('local'))
      key = service.gateway.store.create('本机工作空间', 'local').key;
    else if (service.gateway.store.key('local') !== key) key = service.gateway.store.key('local')!;
    writeFileSync(keyFile, key, { mode: 0o600 });
    const connectHost = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host;
    client = await MonitorClient.start({
      config,
      serverUrl: `${scheme}://${connectHost}:${config.port}`,
      workspaceId: 'local',
      key,
      services: { store: service.auth },
      onStatus: (status, reason) =>
        console.log(`Local client ${status}${reason ? ': ' + reason : ''}`),
    });
  }
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 5000);
  deadline.unref();
  await client?.close();
  await service?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  clearTimeout(deadline);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
