import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { migrate, openDatabase } from './backend/persistence/database.mjs';
import { backupDatabase, verifyBackup, exportRestore } from './backend/operations/backup.mjs';
import { operationalStatus } from './backend/operations/status.mjs';
import { inspectIntegrity } from './backend/operations/integrity.mjs';
import { queryRecords } from './backend/persistence/query.mjs';
import { createAuth } from './backend/security/auth.mjs';
test('加密备份、独立副本、恢复校验及损坏密文拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fba-backup-test-')),
    db = openDatabase(join(dir, 'source.sqlite')),
    secret = randomBytes(32).toString('base64'),
    directory = join(dir, 'backups'),
    remoteDirectory = join(dir, 'remote');
  try {
    const status = await backupDatabase(db, {
      directory,
      remoteDirectory,
      secret,
      production: true
    });
    const file = join(directory, status.file);
    assert.equal(status.encrypted, true);
    assert.equal(status.remoteCopied, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await verifyBackup(file, { secret })).ok, true);
    assert.equal(operationalStatus(db, { backupDir: directory, production: true }).ok, true);
    const data = readFileSync(file);
    data[data.length - 1] ^= 1;
    writeFileSync(file, data);
    await assert.rejects(verifyBackup(file, { secret }));
    await assert.rejects(backupDatabase(db, { directory, production: true }), /必须配置/);
    assert.equal(
      readFileSync(join(remoteDirectory, status.file)).subarray(0, 7).toString(),
      'FBABAK1'
    );
    const restoredFile = join(dir, 'restored.sqlite');
    assert.equal(
      (await exportRestore(join(remoteDirectory, status.file), restoredFile, { secret })).ok,
      true
    );
    const sentinel = join(dir, 'do-not-overwrite.txt');
    writeFileSync(sentinel, 'preserve');
    await assert.rejects(exportRestore('missing-source', sentinel, { secret }));
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    const corruptTarget = join(dir, 'corrupt-target.sqlite');
    await assert.rejects(exportRestore(file, corruptTarget, { secret }));
    assert.equal(existsSync(corruptTarget), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('关系迁移发现错误归属会整体回滚，原始文档保留', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,body TEXT);CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,action TEXT,object TEXT)'
  );
  const put = (kind, row) =>
    db.prepare('INSERT INTO records VALUES(?,?,?)').run(row.id, kind, JSON.stringify(row));
  put('admin:customer', { id: 'A', status: 'active' });
  put('admin:customer', { id: 'B', status: 'active' });
  put('replica:shipment', { id: 'S', customer_id: 'A', status: 'ready' });
  put('replica:invoice', {
    id: 'I',
    customer_id: 'B',
    currency: 'USD',
    totalCents: 100,
    allocatedCents: 0,
    lines: [{ shipmentId: 'S' }]
  });
  try {
    assert.throws(() => migrate(db), /CHECK constraint/);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 4);
    assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get(), undefined);
  } finally {
    db.close();
  }
});
test('SQL分页按客户、状态、日期和关键字筛选，不泄漏其他客户计数', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const put = (kind, row) =>
    db.prepare('INSERT INTO records VALUES(?,?,?)').run(row.id, kind, JSON.stringify(row));
  for (const id of ['A', 'B']) put('admin:customer', { id, status: 'active' });
  for (let i = 0; i < 75; i++)
    put('replica:shipment', {
      id: 'S' + i,
      customer_id: i < 70 ? 'A' : 'B',
      status: i % 2 ? 'ready' : 'picked',
      created: '2026-10-23',
      shipment_number: 'N' + i,
      parcels: []
    });
  try {
    const search = new URLSearchParams({
      page: '2',
      pageSize: '10',
      status: 'ready',
      filter: JSON.stringify({ created_from: '2026-01-01' })
    });
    const result = queryRecords(
      db,
      'replica:shipment',
      { role: 'customer', customerId: 'A' },
      search
    );
    assert.equal(result.total, 35);
    assert.equal(result.items.length, 10);
    assert.equal(result.counts.ready, 35);
    assert(result.items.every((r) => r.customer_id === 'A' && r.status === 'ready'));
    assert.throws(
      () => queryRecords(db, 'replica:shipment', null, new URLSearchParams({ pageSize: '100000' })),
      /分页/
    );
    assert.throws(
      () =>
        queryRecords(
          db,
          'replica:shipment',
          null,
          new URLSearchParams({ filter: JSON.stringify({ "bad' OR 1=1": 'x' }) })
        ),
      /字段/
    );
    assert.equal(inspectIntegrity(db).ok, true);
  } finally {
    db.close();
  }
});
test('成功登录不能清除同IP跨账号失败次数', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const auth = createAuth(db),
    password = randomBytes(24).toString('base64url');
  try {
    await auth.createUser({
      username: 'valid-account',
      displayName: '测试',
      role: 'admin',
      password
    });
    for (let i = 0; i < 9; i++)
      await assert.rejects(
        auth.login({ username: 'bad-' + i, password }, 'shared-ip'),
        (e) => e.status === 401
      );
    await auth.login({ username: 'valid-account', password }, 'shared-ip');
    await assert.rejects(
      auth.login({ username: 'another-bad', password }, 'shared-ip'),
      (e) => e.status === 401
    );
    await assert.rejects(
      auth.login({ username: 'valid-account', password }, 'shared-ip'),
      (e) => e.status === 429
    );
  } finally {
    db.close();
  }
});
