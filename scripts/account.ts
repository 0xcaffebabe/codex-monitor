import { AuthStore, passwordHash } from '../server/auth.js';
import { configFromEnv } from '../server/config.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const config = configFromEnv(),
  auth = new AuthStore(config.dataDir);
const [command, username = 'admin'] = process.argv.slice(2);
if (!['bootstrap', 'reset'].includes(command) || !/^[\p{L}\p{N}_.@-]{2,40}$/u.test(username)) {
  console.error('Usage: npm run account -- bootstrap|reset [username]');
  auth.close();
  process.exit(1);
}
try {
  const password = randomBytes(24).toString('base64url');
  if (command === 'bootstrap') {
    if (auth.configured())
      throw new Error('Workspace already configured. Use reset to recover access.');
    await auth.setup(username, password);
  } else {
    const row = auth.db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (!row) throw new Error('Account not found');
    const encoded = await passwordHash(password);
    auth.db.exec('BEGIN IMMEDIATE');
    try {
      auth.db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded, row.id!);
      auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id!);
      auth.db.exec('COMMIT');
    } catch (e) {
      auth.db.exec('ROLLBACK');
      throw e;
    }
  }
  const output = path.join(config.dataDir, 'initial-credentials.txt');
  writeFileSync(
    output,
    `Codex Monitor — private credentials\nURL: http://localhost:${config.port}\nUsername: ${username}\nPassword: ${password}\n\nStored only on this computer. Change the password in Settings after first login.\n`,
    { mode: 0o600 },
  );
  console.log(`Account ready: ${username}\nCredentials written privately to: ${output}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  auth.close();
}
