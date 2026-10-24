import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { transaction } from '../persistence/transaction.mjs';
import { httpError } from '../http/io.mjs';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(data) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(text) {
  if (typeof text !== 'string' || !/^[A-Z2-7]{32}$/.test(text)) throw Error('TOTP密钥格式无效');
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of text) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret, time = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = createHmac('sha1', decode(secret)).update(counter).digest(),
    offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
function match(secret, otp, now, lastCounter = -1) {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1])
    if (
      counter >= 0 &&
      counter > lastCounter &&
      timingSafeEqual(Buffer.from(otp), Buffer.from(totp(secret, counter * 30000)))
    )
      return counter;
  return null;
}
export function encryptionKey(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').length !== 32
  )
    throw Error('MFA_ENCRYPTION_KEY须为独立的32字节Base64密钥');
  return Buffer.from(value, 'base64');
}
function encrypt(secret, userId, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(userId));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value, userId, key) {
  const data = Buffer.from(value, 'base64'),
    cipher = createDecipheriv('aes-256-gcm', encryptionKey(key), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
export const newMfaSecret = () => base32(randomBytes(20));
export function enrollMfa(
  db,
  { userId, secret, otp, key, now = Date.now(), replace = false, reason }
) {
  const counter = match(secret, otp, now);
  if (counter === null) throw httpError(400, '验证码无效，未启用双重验证');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
    throw Error('需要记录启用或重置原因');
  return transaction(db, () => {
    const user = db.prepare('SELECT id FROM auth_users WHERE id=? AND enabled=1').get(userId);
    if (!user) throw Error('启用账号不存在');
    if (db.prepare('SELECT 1 FROM auth_mfa WHERE user_id=?').get(userId) && !replace)
      throw Error('已启用MFA，重置需明确--replace并记录原因');
    db.prepare(
      'INSERT INTO auth_mfa VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,last_counter=excluded.last_counter,enrolled_at=excluded.enrolled_at'
    ).run(userId, encrypt(secret, userId, key), counter, new Date(now).toISOString());
    db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
    db.prepare('INSERT INTO security_events(at,action,actor_id,request_id) VALUES(?,?,?,?)').run(
      new Date(now).toISOString(),
      replace ? 'mfa:reset' : 'mfa:enroll',
      userId,
      'cli-mfa'
    );
    db.prepare('INSERT INTO mfa_enrollment_audit(user_id,reason,at) VALUES(?,?,?)').run(
      userId,
      reason.trim(),
      new Date(now).toISOString()
    );
    return { enabled: true };
  });
}
export function consumeOtp(db, userId, otp, key, now) {
  const row = db.prepare('SELECT * FROM auth_mfa WHERE user_id=?').get(userId);
  if (!row) return false;
  let secret;
  try {
    secret = decrypt(row.encrypted_secret, userId, key);
  } catch {
    throw httpError(503, '双重验证配置不可用，请联系运维');
  }
  const counter = match(secret, otp, now, row.last_counter);
  if (counter === null) return false;
  return (
    db
      .prepare('UPDATE auth_mfa SET last_counter=? WHERE user_id=? AND last_counter<?')
      .run(counter, userId, counter).changes === 1
  );
}
