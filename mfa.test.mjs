import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { migrate } from './backend/persistence/database.mjs';
import { base32, totp, newMfaSecret, enrollMfa } from './backend/security/mfa.mjs';
import { createAuth } from './backend/security/auth.mjs';
test('TOTP通过RFC6238 SHA1八位测试向量（包括2038年之后）', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [time, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ])
    assert.equal(totp(secret, time * 1000, 8), expected);
});
test('生产员工必须MFA，秘密加密存储、一次验证码不能重放、重置撤销会话', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  let now = 10000000;
  const key = randomBytes(32).toString('base64'),
    auth = createAuth(db, { clock: () => now, requireStaffMfa: true, mfaKey: key }),
    password = randomBytes(24).toString('base64url');
  try {
    const user = await auth.createUser({
      username: 'mfa-staff',
      displayName: '测试员工',
      role: 'admin',
      password
    });
    await assert.rejects(
      auth.login({ username: user.username, password }, 'mfa-ip'),
      (e) => e.status === 403
    );
    const secret = newMfaSecret();
    enrollMfa(db, {
      userId: user.id,
      secret,
      otp: totp(secret, now),
      key,
      now,
      reason: '本人验证器绑定'
    });
    assert(!JSON.stringify(db.prepare('SELECT * FROM auth_mfa').get()).includes(secret));
    now += 30000;
    await assert.rejects(
      auth.login({ username: user.username, password, otp: 'bad-code' }, 'mfa-ip'),
      (e) => e.status === 401
    );
    const otp = totp(secret, now),
      session = await auth.login({ username: user.username, password, otp }, 'mfa-ip');
    assert.equal(session.user.mfaEnabled, true);
    await assert.rejects(
      auth.login({ username: user.username, password, otp }, 'mfa-ip'),
      (e) => e.status === 401
    );
    assert(auth.session({ headers: { cookie: session.cookie.split(';')[0] } }));
    const replacement = newMfaSecret();
    enrollMfa(db, {
      userId: user.id,
      secret: replacement,
      otp: totp(replacement, now),
      key,
      now,
      replace: true,
      reason: '遗失后由运维核验身份重置'
    });
    assert.equal(auth.session({ headers: { cookie: session.cookie.split(';')[0] } }), null);
    assert.equal(db.prepare('SELECT count(*) n FROM mfa_enrollment_audit').get().n, 2);
    now += 30000;
    const wrongKey = createAuth(db, {
      clock: () => now,
      requireStaffMfa: true,
      mfaKey: randomBytes(32).toString('base64')
    });
    await assert.rejects(
      wrongKey.login(
        { username: user.username, password, otp: totp(replacement, now) },
        'other-ip'
      ),
      (e) => e.status === 503
    );
  } finally {
    db.close();
  }
});
