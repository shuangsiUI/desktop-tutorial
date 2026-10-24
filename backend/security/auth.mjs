import { consumeOtp } from './mfa.mjs';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { transaction } from '../persistence/transaction.mjs';
import { permissions } from './policy.mjs';
import { context } from '../persistence/context.mjs';
import { httpError } from '../http/io.mjs';
const derive = promisify(scrypt),
  hash = (s) => createHash('sha256').update(s).digest('hex');
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let active = 0;
async function kdf(password, salt) {
  if (active >= 4) throw httpError(429, '登录繁忙，请稍后重试');
  active++;
  try {
    return await derive(password, salt, 32, params);
  } finally {
    active--;
  }
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 256)
    throw httpError(400, '密码须为15至256个字符');
  const salt = randomBytes(16).toString('hex'),
    result = await kdf(password, salt);
  return `scrypt$32768$8$3$${salt}$${result.toString('hex')}`;
}
async function verify(password, encoded) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$3') return false;
  const key = await kdf(password, parts[4]);
  const expected = Buffer.from(parts[5], 'hex');
  return expected.length === key.length && timingSafeEqual(key, expected);
}
const dummy = 'scrypt$32768$8$3$00112233445566778899aabbccddeeff$' + '00'.repeat(32);
export function createAuth(
  db,
  {
    secure = false,
    clock = Date.now,
    requireStaffMfa = false,
    mfaKey = process.env.MFA_ENCRYPTION_KEY
  } = {}
) {
  const name = secure ? '__Host-fba_session' : 'fba_session';
  const event = (action, actor) =>
    db
      .prepare('INSERT INTO security_events(at,action,actor_id,request_id) VALUES(?,?,?,?)')
      .run(
        new Date(clock()).toISOString(),
        action,
        actor || null,
        context().requestId || randomUUID()
      );
  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    customerId: u.customer_id,
    enabled: !!u.enabled,
    version: u.version,
    permissions: permissions(u.role),
    mfaEnabled: !!db.prepare('SELECT 1 FROM auth_mfa WHERE user_id=?').get(u.id)
  });
  const cookie = (token, maxAge) =>
    `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const validateCustomer = (role, id) => {
    if (role === 'customer') {
      const row = db
        .prepare("SELECT body FROM records WHERE kind='admin:customer' AND id=?")
        .get(id || '');
      if (!row || JSON.parse(row.body).status !== 'active')
        throw httpError(400, '请选择启用的客户');
    } else if (id) throw httpError(400, '员工账号不可绑定客户');
  };
  return {
    users() {
      return db.prepare('SELECT * FROM auth_users ORDER BY created_at').all().map(publicUser);
    },
    async createUser(input) {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !['username', 'displayName', 'role', 'customerId', 'password'].includes(k)
        )
      )
        throw httpError(400, '账号字段无效');
      const { username, displayName, role, customerId, password } = input;
      if (
        typeof username !== 'string' ||
        !/^[a-zA-Z0-9_.@-]{3,80}$/.test(username) ||
        typeof displayName !== 'string' ||
        !displayName.trim() ||
        displayName.length > 200 ||
        !['admin', 'operator', 'finance', 'customer'].includes(role)
      )
        throw httpError(400, '账号资料无效');
      validateCustomer(role, customerId);
      const encoded = await passwordHash(password);
      return transaction(db, () => {
        context().assertSession?.();
        if (db.prepare('SELECT id FROM auth_users WHERE username=?').get(username))
          throw httpError(409, '账号已存在');
        const id = randomUUID();
        db.prepare(
          'INSERT INTO auth_users(id,username,display_name,password_hash,role,customer_id,created_at) VALUES(?,?,?,?,?,?,?)'
        ).run(id, username, displayName.trim(), encoded, role, customerId || null, clock());
        event('user:create', context().principal?.id);
        return publicUser(db.prepare('SELECT * FROM auth_users WHERE id=?').get(id));
      });
    },
    updateUser(input, actor) {
      return transaction(db, () => {
        context().assertSession?.();
        if (
          Object.keys(input).some(
            (k) => !['id', 'version', 'role', 'customerId', 'enabled', 'displayName'].includes(k)
          )
        )
          throw httpError(400, '账号字段无效');
        const u = db.prepare('SELECT * FROM auth_users WHERE id=?').get(input.id || '');
        if (!u) throw httpError(404, '账号不存在');
        if (u.version !== input.version) throw httpError(409, '账号已更新');
        if (
          typeof input.enabled !== 'boolean' ||
          !['admin', 'operator', 'finance', 'customer'].includes(input.role) ||
          typeof input.displayName !== 'string' ||
          !input.displayName.trim() ||
          input.displayName.length > 200
        )
          throw httpError(400, '账号资料无效');
        if (u.id === actor.id && (!input.enabled || input.role !== 'admin'))
          throw httpError(400, '不能停用或降级当前管理员');
        if (
          u.role === 'admin' &&
          u.enabled &&
          (!input.enabled || input.role !== 'admin') &&
          db.prepare("SELECT count(*) n FROM auth_users WHERE role='admin' AND enabled=1").get()
            .n <= 1
        )
          throw httpError(400, '必须保留启用的管理员');
        validateCustomer(input.role, input.customerId);
        db.prepare(
          'UPDATE auth_users SET display_name=?,role=?,customer_id=?,enabled=?,version=version+1 WHERE id=?'
        ).run(
          input.displayName.trim(),
          input.role,
          input.customerId || null,
          Number(input.enabled),
          u.id
        );
        db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(u.id);
        event('user:update', actor.id);
        return publicUser(db.prepare('SELECT * FROM auth_users WHERE id=?').get(u.id));
      });
    },
    async changePassword(userId, oldPassword, newPassword) {
      const u = db.prepare('SELECT * FROM auth_users WHERE id=? AND enabled=1').get(userId);
      if (
        !u ||
        typeof oldPassword !== 'string' ||
        oldPassword.length > 256 ||
        !(await verify(oldPassword, u.password_hash))
      )
        throw httpError(400, '原密码错误');
      const encoded = await passwordHash(newPassword);
      transaction(db, () => {
        context().assertSession?.();
        db.prepare('UPDATE auth_users SET password_hash=?,version=version+1 WHERE id=?').run(
          encoded,
          userId
        );
        db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
        event('password:change', userId);
      });
    },
    async login({ username, password, otp }, ip) {
      if (
        typeof username !== 'string' ||
        username.length > 80 ||
        typeof password !== 'string' ||
        password.length > 256
      )
        throw httpError(400, '登录资料无效');
      const now = clock(),
        buckets = [hash('ip:' + ip), hash('account:' + username.toLowerCase())];
      db.prepare('DELETE FROM auth_attempts WHERE window_start<?').run(now - 900000);
      for (const bucket of buckets) {
        const b = db.prepare('SELECT * FROM auth_attempts WHERE bucket=?').get(bucket);
        if (b && b.failures >= 10) throw httpError(429, '尝试次数过多，请15分钟后重试');
      }
      const u = db.prepare('SELECT * FROM auth_users WHERE username=?').get(username);
      const valid = await verify(password, u?.password_hash || dummy);
      if (!u || !valid || !u.enabled) {
        for (const bucket of buckets)
          db.prepare(
            'INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET failures=failures+1'
          ).run(bucket, now);
        event('login:failed');
        throw httpError(401, '账号或密码错误');
      }
      if (u.role === 'customer') {
        const c = db
          .prepare("SELECT body FROM records WHERE id=? AND kind='admin:customer'")
          .get(u.customer_id);
        if (!c || JSON.parse(c.body).status !== 'active') throw httpError(401, '账号或密码错误');
      }
      const enrolled = !!db.prepare('SELECT 1 FROM auth_mfa WHERE user_id=?').get(u.id);
      if (requireStaffMfa && u.role !== 'customer' && !enrolled)
        throw httpError(403, '员工账号必须先由运维启用双重验证');
      if (enrolled && !consumeOtp(db, u.id, otp, mfaKey, now)) {
        for (const bucket of buckets)
          db.prepare(
            'INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET failures=failures+1'
          ).run(bucket, now);
        event('login:failed-mfa', u.id);
        throw httpError(401, '账号、密码或验证码错误');
      }
      const token = randomBytes(32).toString('base64url'),
        csrf = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM auth_sessions WHERE expires_at<? OR last_seen<?').run(
        now,
        now - 1800000
      );
      db.prepare(
        'DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 4)'
      ).run(u.id);
      db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?)').run(
        hash(token),
        u.id,
        csrf,
        now,
        now,
        now + 8 * 3600000
      );
      db.prepare('DELETE FROM auth_attempts WHERE bucket=?').run(buckets[1]);
      event('login:success', u.id);
      return { user: publicUser(u), csrf, cookie: cookie(token, 8 * 3600) };
    },
    session(req) {
      const cookies = String(req.headers.cookie || '')
        .split(';')
        .map((v) => v.trim().split('='));
      const pair = cookies.find(([key]) => key === name);
      if (!pair || !/^[A-Za-z0-9_-]{43}$/.test(pair[1] || '')) return null;
      const tokenHash = hash(pair[1]),
        s = db
          .prepare(
            'SELECT s.*,u.username,u.display_name,u.role,u.customer_id,u.enabled,u.version FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=?'
          )
          .get(tokenHash),
        now = clock();
      if (!s || !s.enabled || s.expires_at <= now || s.last_seen <= now - 1800000) {
        db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash);
        return null;
      }
      if (
        requireStaffMfa &&
        s.role !== 'customer' &&
        !db.prepare('SELECT 1 FROM auth_mfa WHERE user_id=?').get(s.user_id)
      )
        return null;
      if (s.role === 'customer') {
        const c = db
          .prepare("SELECT body FROM records WHERE kind='admin:customer' AND id=?")
          .get(s.customer_id);
        if (!c || JSON.parse(c.body).status !== 'active') return null;
      }
      db.prepare('UPDATE auth_sessions SET last_seen=? WHERE token_hash=?').run(now, tokenHash);
      return { user: publicUser({ ...s, id: s.user_id }), csrf: s.csrf, tokenHash };
    },
    verifyCsrf(req, session) {
      const value = req.headers['x-csrf-token'];
      if (
        typeof value !== 'string' ||
        Buffer.byteLength(value) !== Buffer.byteLength(session.csrf) ||
        !timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf))
      )
        throw httpError(403, '请求校验失败，请刷新页面');
    },
    logout(session) {
      if (session)
        db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(session.tokenHash);
      event('logout', session?.user.id);
      return cookie('', 0);
    }
  };
}
