import { createCommercialRouter } from './http/commercial.mjs';
import { isIP } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { configuration } from './config.mjs';
import { openDatabase } from './persistence/database.mjs';
import { requestContext } from './persistence/context.mjs';
import { createAuth } from './security/auth.mjs';
import { requirePermission } from './security/policy.mjs';
import { createAdminRouter, invoke } from './http/admin.mjs';
import { createReplicaRouter } from './http/client.mjs';
import { createLegacyRouter } from './http/legacy.mjs';
import { staticFiles } from './http/static.mjs';
import { json, readJson, httpError } from './http/io.mjs';
export function createApplication({ db, config }) {
  const auth = createAuth(db, {
      secure: config.secure,
      requireStaffMfa: config.production,
      mfaKey: config.mfaEncryptionKey
    }),
    admin = createAdminRouter(db),
    client = createReplicaRouter(db),
    legacy = createLegacyRouter(db),
    commercial = createCommercialRouter(db),
    rates = new Map();
  const files = {
    ...staticFiles,
    '/login': 'login.html',
    '/login.js': 'login.js',
    '/login.css': 'login.css',
    '/auth-client.js': 'auth-client.js'
  };
  const redirect = (res, path) => {
    res.writeHead(303, { Location: path, 'Cache-Control': 'no-store' });
    res.end();
  };
  return http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    const requestId = randomUUID(),
      started = Date.now(),
      ctx = { requestId };
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    );
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.once('finish', () => {
      if (!config.silent && process.env.NODE_ENV !== 'test')
        console.log(
          JSON.stringify({
            requestId,
            method: req.method,
            status: res.statusCode,
            durationMs: Date.now() - started
          })
        );
    });
    await requestContext.run(ctx, async () => {
      try {
        if (req.headers.host !== config.publicHost) throw httpError(403, '请求站点不匹配');
        if (
          config.production &&
          !req.socket.encrypted &&
          !(
            config.trustedProxyIPs.has(req.socket.remoteAddress) &&
            req.headers['x-forwarded-proto'] === 'https'
          )
        )
          throw httpError(400, '必须通过受信HTTPS入口访问');
        const url = new URL(req.url, config.origin);
        if (req.headers.origin && req.headers.origin !== config.origin)
          throw httpError(403, '来源不允许');
        if (req.headers['sec-fetch-site'] === 'cross-site' && url.pathname.startsWith('/api/'))
          throw httpError(403, '来源不允许');
        const forwarded = req.headers['x-forwarded-for'];
        const peer = req.socket.remoteAddress;
        const clientIP =
          config.trustedProxyIPs.has(peer) && typeof forwarded === 'string' && isIP(forwarded)
            ? forwarded
            : peer;
        const now = Date.now(),
          rateKey = clientIP;
        if (rates.size > 10000) for (const [key, b] of rates) if (b.until < now) rates.delete(key);
        let rate = rates.get(rateKey);
        if (!rate || rate.until < now) {
          rate = { count: 0, until: now + 60000 };
          rates.set(rateKey, rate);
        }
        if (++rate.count > 1200) throw httpError(429, '请求过于频繁');
        if (['/healthz', '/readyz'].includes(url.pathname) && req.method === 'GET') {
          db.prepare('SELECT 1').get();
          json(res, 200, { status: 'ok' });
          return;
        }
        const session = auth.session(req);
        ctx.principal = session?.user;
        if (session && url.pathname.startsWith('/api/')) {
          const key = 'user:' + session.user.id + ':' + req.method;
          let b = rates.get(key);
          if (!b || b.until < now) {
            b = { count: 0, until: now + 60000 };
            rates.set(key, b);
          }
          if (++b.count > (req.method === 'POST' ? 60 : 300))
            throw httpError(429, '操作过于频繁，请稍后重试');
        }
        if (url.pathname.startsWith('/api/')) {
          res.setHeader('Cache-Control', 'no-store');
          if (!['GET', 'POST'].includes(req.method)) throw httpError(405, '不支持的方法');
          if (req.method === 'POST' && req.headers.origin !== config.origin)
            throw httpError(403, '来源校验失败');
          if (url.pathname === '/api/auth/login' && req.method === 'POST') {
            const input = await readJson(req, 16384);
            const result = await auth.login(input, clientIP);
            if (session) auth.logout(session);
            res.setHeader('Set-Cookie', result.cookie);
            json(res, 200, { user: result.user, csrf: result.csrf });
            return;
          }
          if (url.pathname === '/api/auth/status' && req.method === 'GET') {
            json(res, 200, {
              setupRequired: !db.prepare('SELECT id FROM auth_users LIMIT 1').get()
            });
            return;
          }
          if (!session) throw httpError(401, '请先登录');
          ctx.assertSession = () => {
            const live = auth.session(req);
            if (!live || live.user.version !== session.user.version)
              throw httpError(401, '登录状态已失效');
          };
          if (req.method === 'POST') auth.verifyCsrf(req, session);
          if (url.pathname === '/api/auth/session' && req.method === 'GET') {
            json(res, 200, { user: session.user, csrf: session.csrf });
            return;
          }
          if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
            res.setHeader('Set-Cookie', auth.logout(session));
            json(res, 200, { success: true });
            return;
          }
          if (url.pathname === '/api/auth/password' && req.method === 'POST') {
            const body = await readJson(req, 16384);
            await auth.changePassword(session.user.id, body.oldPassword, body.newPassword);
            res.setHeader('Set-Cookie', auth.logout(session));
            json(res, 200, { success: true });
            return;
          }
          if (url.pathname === '/api/auth/users') {
            requirePermission(session.user, 'users:manage');
            if (req.method === 'GET') {
              json(res, 200, auth.users());
              return;
            }
            const body = await readJson(req, 16384);
            const result = body.id
              ? auth.updateUser(body, session.user)
              : await auth.createUser(body);
            json(res, 200, result);
            return;
          }
          if (await commercial(req, res, url, session.user)) return;
          if (await admin(req, res, url, session.user)) return;
          if (await client(req, res, url, session.user)) return;
          if (config.production) throw httpError(410, '旧版接口已停用');
          if (await invoke(() => legacy(req, res, url, session.user))) return;
          throw httpError(404, '接口不存在');
        }
        if (req.method !== 'GET') throw httpError(405, '不支持的方法');
        const page =
          url.pathname === '/' ||
          url.pathname.startsWith('/tms/wos/') ||
          ['/admin', '/admin/'].includes(url.pathname);
        if (page && !session) {
          redirect(res, '/login');
          return;
        }
        if (['/admin', '/admin/'].includes(url.pathname) && session?.user.role === 'customer')
          throw httpError(403, '没有管理端权限');
        if (url.pathname === '/replica-config.json' && !session) throw httpError(401, '请先登录');
        if (!Object.hasOwn(files, url.pathname) && !url.pathname.startsWith('/tms/wos/'))
          throw httpError(404, '页面不存在');
        const file = files[url.pathname] || 'index.html';
        const type =
          file.endsWith('.js') || file.endsWith('.mjs')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.json')
                ? 'application/json'
                : file.endsWith('.png')
                  ? 'image/png'
                  : file.endsWith('.woff')
                    ? 'font/woff'
                    : file.endsWith('.xls')
                      ? 'application/vnd.ms-excel'
                      : 'text/html;charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(readFileSync(new URL('../public/' + file, import.meta.url)));
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status === 413) req.resume();
        json(res, status, {
          error: status >= 500 ? '服务暂时不可用，请联系管理员' : error.message,
          requestId
        });
      }
    });
  });
}
export function startServer() {
  process.umask(0o077);
  const config = configuration(),
    db = openDatabase(config.dbPath),
    server = createApplication({ db, config });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.listen(config.port, config.host, () => console.log('物流预览 ' + config.origin));
  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}
