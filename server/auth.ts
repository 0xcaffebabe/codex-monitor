import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { User } from '../src/types.js';
const derive = promisify(scrypt);
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const result = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${result.toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const check = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === check.length && timingSafeEqual(check, expected);
}
export class AuthStore {
  db: DatabaseSync;
  setupKey?: string;
  private keyFile: string;
  constructor(
    public dataDir: string,
    private days = 90,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, 'monitor.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, username TEXT, ip TEXT);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
    this.keyFile = path.join(dataDir, 'setup-key.txt');
    if (!this.configured()) {
      this.setupKey = existsSync(this.keyFile)
        ? readFileSync(this.keyFile, 'utf8').trim()
        : randomBytes(32).toString('base64url');
      writeFileSync(this.keyFile, this.setupKey, { mode: 0o600 });
    } else if (existsSync(this.keyFile)) unlinkSync(this.keyFile);
    try {
      chmodSync(path.join(dataDir, 'monitor.sqlite'), 0o600);
    } catch {
      /* Windows permissions use the launch script. */
    }
  }
  configured() {
    return Number(this.db.prepare('SELECT count(*) AS n FROM users').get()!.n) > 0;
  }
  validSetupKey(key: string) {
    return (
      !!this.setupKey &&
      timingSafeEqual(Buffer.from(hashToken(key)), Buffer.from(hashToken(this.setupKey)))
    );
  }
  async setup(username: string, password: string) {
    const encoded = await passwordHash(password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.configured()) throw new Error('Already configured');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO users VALUES (?,?,?,?,?)')
        .run(id, username, encoded, 'admin', Date.now());
      this.db.exec('COMMIT');
      this.setupKey = undefined;
      if (existsSync(this.keyFile)) unlinkSync(this.keyFile);
      return { id, username, role: 'admin' } as User;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async login(username: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    // Use the same expensive hash on missing users to limit username timing leaks.
    const encoded =
      (row?.password as string) || '00000000000000000000000000000000:' + '00'.repeat(64);
    if (!(await passwordMatches(password, encoded)) || !row) return null;
    return {
      id: row.id as string,
      username: row.username as string,
      role: row.role as User['role'],
    };
  }
  issue(user: User, device: string) {
    const token = randomBytes(32).toString('base64url'),
      id = randomUUID(),
      now = Date.now(),
      expiresAt = now + this.days * 86400000;
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)')
      .run(id, hashToken(token), user.id, device.slice(0, 160), now, now, expiresAt);
    return { token, user, expiresAt, sessionId: id };
  }
  authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db
      .prepare(
        'SELECT s.id AS sid,s.expires_at,s.last_seen,u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?',
      )
      .get(hashToken(token), Date.now());
    if (!row) return null;
    if (Date.now() - Number(row.last_seen) > 60000)
      this.db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(Date.now(), row.sid!);
    return {
      user: {
        id: row.id as string,
        username: row.username as string,
        role: row.role as User['role'],
      },
      sessionId: row.sid as string,
      expiresAt: Number(row.expires_at),
    };
  }
  devices(userId: string) {
    return this.db
      .prepare(
        'SELECT id,device,created_at AS createdAt,last_seen AS lastSeen,expires_at AS expiresAt FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC',
      )
      .all(userId, Date.now());
  }
  revoke(userId: string, id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(id, userId);
  }
  log(action: string, username: string, ip: string) {
    this.db
      .prepare('INSERT INTO audit(at,action,username,ip) VALUES(?,?,?,?)')
      .run(Date.now(), action, username, ip);
  }
  async changePassword(userId: string, password: string, currentSession: string) {
    const hash = await passwordHash(password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.db
          .prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?')
          .get(currentSession, userId, Date.now())
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(userId, currentSession);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
