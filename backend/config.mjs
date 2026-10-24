import { encryptionKey } from './security/mfa.mjs';
export function configuration(env = process.env) {
  const port = Number(env.PORT || 4188);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT无效');
  const production = env.NODE_ENV === 'production';
  if (production && !env.PUBLIC_ORIGIN) throw Error('生产环境必须配置PUBLIC_ORIGIN');
  const origin = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !['http:', 'https:'].includes(origin.protocol)
  )
    throw Error('PUBLIC_ORIGIN须为站点根地址');
  if (production && origin.protocol !== 'https:') throw Error('生产环境必须使用HTTPS');
  if (production) encryptionKey(env.MFA_ENCRYPTION_KEY);
  const host = env.HOST || '127.0.0.1';
  if (!production && host !== '127.0.0.1') throw Error('开发环境仅监听127.0.0.1');
  return {
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY,
    port,
    host,
    origin: origin.origin,
    publicHost: origin.host,
    secure: origin.protocol === 'https:',
    production,
    trustedProxyIPs: new Set(
      (env.TRUSTED_PROXY_IPS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
    dbPath: env.DB_PATH || 'data/logistics.sqlite'
  };
}
