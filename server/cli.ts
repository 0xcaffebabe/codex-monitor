import { parseArgs } from 'node:util';
import { configFromEnv } from './config.js';
import { clientConnectionFromEnv } from './client/config.js';

const optionEnv = {
  mode: 'MONITOR_MODE',
  'server-url': 'MONITOR_SERVER_URL',
  'workspace-id': 'MONITOR_WORKSPACE_ID',
  'client-key': 'MONITOR_CLIENT_KEY',
  'client-key-file': 'MONITOR_CLIENT_KEY_FILE',
  'codex-home': 'CODEX_HOME',
  'data-dir': 'MONITOR_DATA_DIR',
  'poll-ms': 'MONITOR_POLL_MS',
  'pricing-file': 'MONITOR_PRICING_FILE',
  'codex-autostart': 'MONITOR_CODEX_AUTOSTART',
  'codex-check-ms': 'MONITOR_CODEX_CHECK_MS',
  'codex-desktop': 'MONITOR_CODEX_DESKTOP',
  'codex-cli': 'MONITOR_CODEX_CLI',
  'codex-pipe': 'MONITOR_CODEX_PIPE',
  host: 'HOST',
  port: 'PORT',
} as const;

export const startupHelp = `Codex Monitor

Usage:
  npm start -- [options]
  npm run client -- --server-url <url> --workspace-id <id> --client-key <key>
  node dist/server.mjs --mode client [options]

Connection:
  --mode <standalone|server|client>  Run mode (default: standalone)
  --server-url <url>               Server http(s) or ws(s) origin
  --workspace-id <id>              Workspace ID from Manage workspaces
  --client-key <key>               Workspace AES key (43 base64url characters)
  --client-key-file <path>         Read the AES key from a private text file

Client settings:
  --codex-home <path>              Codex home (default: ~/.codex)
  --data-dir <path>                Private data (client default: .monitor-client)
  --poll-ms <milliseconds>         History polling interval (default: 1500, min: 500)
  --pricing-file <path>            Model pricing JSON file
  --codex-autostart <true|false>   Monitor/start the Windows desktop (default: true)
  --codex-check-ms <milliseconds>  Desktop check interval (default: 15000)
  --codex-desktop <absolute-path>  Desktop GUI executable
  --codex-cli <path>              Codex CLI executable for native RPCs
  --codex-pipe <path>             Select a desktop app pipe

Server settings:
  --host <address>                Listen address (default: 0.0.0.0)
  --port <number>                 Listen port (default: 4317)

  --check-config                  Validate configuration and exit without starting
  -h, --help                      Show this help without starting

Command-line options override environment variables. npm start does not load .env;
the Windows start.ps1/start.cmd launchers load it as a fallback.
--client-key and --client-key-file cannot be supplied together. Either explicit
option replaces the inherited key source. Paths are relative to the working directory.
`;

export function startupFromArgs(args: string[], inherited: NodeJS.ProcessEnv = process.env) {
  // A valid base64url key may begin with '-', which parseArgs otherwise treats as an option.
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client-key' && /^[A-Za-z0-9_-]{43}$/.test(args[i + 1] || ''))
      normalized.push(`--client-key=${args[++i]}`);
    else normalized.push(args[i]);
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: normalized,
      options: {
        ...Object.fromEntries(
          Object.keys(optionEnv).map((name) => [name, { type: 'string' as const }]),
        ),
        help: { type: 'boolean', short: 'h' },
        'check-config': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // Parser errors can include supplied values, including the AES key.
    throw new Error('Invalid command-line arguments: unknown option or missing value. Use --help.');
  }
  if (values.help) return { help: true as const };
  if (values['client-key'] !== undefined && values['client-key-file'] !== undefined)
    throw new Error('Use either --client-key or --client-key-file, not both');
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(inherited).map(([name, value]) => [
      process.platform === 'win32' ? name.toUpperCase() : name,
      value,
    ]),
  );
  for (const [name, variable] of Object.entries(optionEnv)) {
    const value = values[name];
    if (typeof value !== 'string') continue;
    if (!value.trim()) throw new Error(`--${name} requires a non-empty value`);
    env[variable] = value;
  }
  if (values['client-key'] !== undefined) delete env.MONITOR_CLIENT_KEY_FILE;
  if (values['client-key-file'] !== undefined) delete env.MONITOR_CLIENT_KEY;
  const config = configFromEnv(env);
  return {
    help: false as const,
    checkConfig: values['check-config'] === true,
    config,
    client: config.mode === 'client' ? clientConnectionFromEnv(env) : undefined,
    env,
  };
}
