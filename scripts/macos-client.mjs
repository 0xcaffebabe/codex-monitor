import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const [command = 'start', ...args] = process.argv.slice(2);
const entry = path.join(root, 'dist/server.mjs');
const env = { ...process.env };
// .env is data, never shell code. Explicit environment values win.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?((?:MONITOR_[A-Z0-9_]+|CODEX_HOME))\s*=\s*(.*?)\s*$/,
    );
    if (!match || env[match[1]] !== undefined) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[match[1]] = value;
  }
}
const dataArg =
  args.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length) ??
  (args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : undefined);
const dataDir = path.resolve(dataArg || env.MONITOR_DATA_DIR || '.monitor-client');
const recordFile = path.join(dataDir, 'client-process.json');
const logFile = path.join(dataDir, 'client.log');

function identity(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=,command='], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}
function current() {
  try {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    return Number.isSafeInteger(record.pid) &&
      record.pid > 1 &&
      record.uid === process.getuid?.() &&
      record.identity &&
      identity(record.pid) === record.identity
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

try {
  if (process.platform !== 'darwin') throw new Error('This launcher is for macOS.');
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Node.js 24+ is required. Set MONITOR_NODE to its absolute path.');
  if (!['start', 'stop', 'status'].includes(command))
    throw new Error(
      'Usage: start.sh [client options] | stop.sh [--data-dir path] | scripts/macos-client.sh status',
    );
  const running = current();
  if (command === 'status')
    console.log(
      running ? `Client running (PID ${running.pid}). Log: ${logFile}` : 'Client is stopped.',
    );
  else if (command === 'stop') {
    if (!running) console.log('Client is already stopped.');
    else {
      process.kill(running.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 60 && current(); attempt++) await delay(100);
      if (current()) throw new Error('Client has not exited; inspect its log before retrying.');
      fs.rmSync(recordFile, { force: true });
      console.log('Client stopped.');
    }
  } else if (running) console.log(`Client already running (PID ${running.pid}).`);
  else {
    if (!fs.existsSync(entry)) throw new Error('Run npm ci && npm run build first.');
    const effectiveArgs = [...args, '--mode', 'client', '--data-dir', dataDir];
    // Validate using the actual built CLI, without starting watchers or databases.
    execFileSync(process.execPath, [entry, ...effectiveArgs, '--check-config'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(dataDir, 'client-start.lock');
    const lock = fs.openSync(lockFile, 'wx', 0o600);
    try {
      if (current()) throw new Error('Client is already running.');
      const log = fs.openSync(logFile, 'a', 0o600);
      let child;
      try {
        child = spawn(
          process.execPath,
          ['--disable-warning=ExperimentalWarning', entry, ...effectiveArgs],
          { env, detached: true, stdio: ['ignore', log, log] },
        );
      } finally {
        fs.closeSync(log);
      }
      let launchError;
      child.once('error', (error) => {
        launchError = error;
      });
      child.unref();
      await delay(700);
      const childIdentity = child.pid ? identity(child.pid) : '';
      if (launchError || !childIdentity)
        throw new Error(`Client failed to start. Inspect ${logFile}`);
      fs.writeFileSync(
        recordFile,
        JSON.stringify({ pid: child.pid, uid: process.getuid?.(), identity: childIdentity }) + '\n',
        { mode: 0o600 },
      );
      console.log(`Client started (PID ${child.pid}). Log: ${logFile}`);
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockFile, { force: true });
    }
  }
} catch (error) {
  // Validation errors may include a supplied key; don't echo child command/arguments.
  console.error(
    error instanceof Error && !('cmd' in error)
      ? error.message
      : 'Invalid client configuration. Run npm run client -- --check-config with a private key file.',
  );
  process.exitCode = 1;
}
