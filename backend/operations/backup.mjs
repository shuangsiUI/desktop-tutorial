import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  renameSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  createReadStream,
  createWriteStream
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectIntegrity } from './integrity.mjs';
function key(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').length !== 32
  )
    throw Error('BACKUP_ENCRYPTION_KEY须为32字节Base64密钥');
  return Buffer.from(value, 'base64');
}
const syncFile = (file) => {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function decryptTo(file, target, secret, onCreate = () => {}) {
  const header = Buffer.alloc(35),
    fd = openSync(file, 'r');
  let size;
  try {
    size = readSync(fd, header, 0, 35, 0);
  } finally {
    closeSync(fd);
  }
  if (size >= 35 && header.subarray(0, 7).toString() === 'FBABAK1') {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), header.subarray(7, 19));
    decipher.setAuthTag(header.subarray(19, 35));
    const output = openSync(target, 'wx', 0o600);
    onCreate();
    await pipeline(
      createReadStream(file, { start: 35 }),
      decipher,
      createWriteStream(null, { fd: output, autoClose: true })
    );
  } else {
    const output = openSync(target, 'wx', 0o600);
    onCreate();
    await pipeline(
      createReadStream(file),
      createWriteStream(null, { fd: output, autoClose: true })
    );
  }
  syncFile(target);
}
export async function verifyBackup(file, { secret, workDir } = {}) {
  const snapshot = join(
    resolve(workDir || dirname(file)),
    '.restore-check-' + randomBytes(12).toString('hex') + '.sqlite'
  );
  let db,
    created = false;
  try {
    await decryptTo(file, snapshot, secret, () => {
      created = true;
    });
    db = new DatabaseSync(snapshot, { readOnly: true });
    return inspectIntegrity(db);
  } finally {
    db?.close();
    if (created) rmSync(snapshot, { force: true });
  }
}
export async function exportRestore(file, target, { secret } = {}) {
  // A new file only: this command never overwrites the live database.
  let created = false,
    db;
  try {
    await decryptTo(file, target, secret, () => {
      created = true;
    });
    db = new DatabaseSync(target, { readOnly: true });
    const report = inspectIntegrity(db);
    if (!report.ok) throw Error('备份完整性检查失败');
    return report;
  } catch (error) {
    if (created) rmSync(target, { force: true });
    throw error;
  } finally {
    db?.close();
  }
}
export async function backupDatabase(
  db,
  {
    directory = 'data/backups',
    remoteDirectory,
    secret,
    production = false,
    retentionDays = 30
  } = {}
) {
  if (production && (!secret || !remoteDirectory))
    throw Error('生产备份必须配置加密密钥及异地挂载目录');
  if (secret) key(secret);
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650)
    throw Error('备份保留期须为7至3650天');
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (remoteDirectory && resolve(remoteDirectory) === dir)
    throw Error('异地副本目录不能与本地相同');
  const name = 'logistics-' + Date.now() + '-' + randomBytes(4).toString('hex'),
    raw = join(dir, '.' + name + '.sqlite'),
    file = join(dir, name + (secret ? '.enc' : '.sqlite'));
  try {
    if (!inspectIntegrity(db).ok) throw Error('数据库完整性检查失败，禁止标记备份成功');
    db.exec("VACUUM INTO '" + raw.replaceAll("'", "''") + "'");
    if (secret) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key(secret), iv);
      writeFileSync(file, Buffer.concat([Buffer.from('FBABAK1'), iv, Buffer.alloc(16)]), {
        mode: 0o600,
        flag: 'wx'
      });
      await pipeline(
        createReadStream(raw),
        cipher,
        createWriteStream(file, { flags: 'a', mode: 0o600 })
      );
      const fd = openSync(file, 'r+');
      try {
        writeSync(fd, cipher.getAuthTag(), 0, 16, 19);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      await pipeline(createReadStream(raw), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      syncFile(file);
    }
    if (!(await verifyBackup(file, { secret, workDir: dir })).ok) throw Error('备份恢复校验失败');
    const manifest = {
      file: name + (secret ? '.enc' : '.sqlite'),
      sha256: await digestFile(file),
      bytes: statSync(file).size,
      createdAt: new Date().toISOString(),
      encrypted: !!secret,
      restoreVerified: true,
      remoteCopied: false
    };
    if (remoteDirectory) {
      const remote = resolve(remoteDirectory);
      mkdirSync(remote, { recursive: true, mode: 0o700 });
      const target = join(remote, manifest.file);
      await pipeline(
        createReadStream(file),
        createWriteStream(target, { flags: 'wx', mode: 0o600 })
      );
      syncFile(target);
      if ((await digestFile(target)) !== manifest.sha256) throw Error('异地副本校验失败');
      manifest.remoteCopied = true;
      writeFileSync(target + '.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
      syncFile(target + '.json');
    }
    writeFileSync(file + '.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
    syncFile(file + '.json');
    const statusTemp = join(dir, '.status-' + name);
    writeFileSync(statusTemp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    syncFile(statusTemp);
    renameSync(statusTemp, join(dir, 'status.json'));
    for (const entry of readdirSync(dir).filter((n) =>
      /^logistics-\d+-[a-f0-9]{8}\.(enc|sqlite)\.json$/.test(n)
    )) {
      const path = join(dir, entry);
      if (statSync(path).mtimeMs < Date.now() - retentionDays * 86400000) {
        rmSync(path.slice(0, -5), { force: true });
        rmSync(path, { force: true });
      }
    }
    return manifest;
  } finally {
    rmSync(raw, { force: true });
  }
}
