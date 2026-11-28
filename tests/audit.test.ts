import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendAudit } from '../server/audit.js';
import { AuthStore } from '../server/auth.js';

test('audit appends preserve field values and participate in the caller transaction', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'monitor-audit-'));
  const auth = new AuthStore(directory);
  try {
    const before = Date.now();
    auth.log('login', "用户'--", '::1');
    appendAudit(auth.db, 'session_created', 'owner', 'Lark');
    const after = Date.now();
    const rows = auth.db.prepare('SELECT at,action,username,ip FROM audit ORDER BY id').all();
    assert.deepEqual(
      rows.map(({ at, ...entry }) => {
        assert.ok(Number(at) >= before && Number(at) <= after);
        return entry;
      }),
      [
        { action: 'login', username: "用户'--", ip: '::1' },
        { action: 'session_created', username: 'owner', ip: 'Lark' },
      ],
    );
    auth.db.exec('BEGIN');
    appendAudit(auth.db, 'rolled_back', 'owner', '127.0.0.1');
    auth.db.exec('ROLLBACK');
    assert.equal(auth.db.prepare('SELECT count(*) AS n FROM audit').get()!.n, 2);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
