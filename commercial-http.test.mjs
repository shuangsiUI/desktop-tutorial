import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { migrate } from './backend/persistence/database.mjs';
import { createAdminService } from './backend/modules/operations/service.mjs';
import { createAuth } from './backend/security/auth.mjs';
import { createApplication } from './backend/application.mjs';
import { configuration } from './backend/config.mjs';
test('商用HTTP入口：收款权限、CSRF、租户流水隔离、分页与运维检查', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const admin = createAdminService(db),
    a = admin.saveCustomer({ name: 'A', status: 'active', currency: 'USD' }),
    b = admin.saveCustomer({ name: 'B', status: 'active', currency: 'USD' }),
    auth = createAuth(db),
    password = randomBytes(24).toString('base64url');
  for (const [username, role, customerId] of [
    ['staff', 'finance', null],
    ['owner', 'customer', a.id],
    ['other', 'customer', b.id],
    ['ops', 'operator', null],
    ['root', 'admin', null]
  ])
    await auth.createUser({ username, role, customerId, displayName: username, password });
  const config = { ...configuration({}), silent: true },
    server = createApplication({ db, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port;
  config.origin = 'http://127.0.0.1:' + config.port;
  config.publicHost = '127.0.0.1:' + config.port;
  const call = (path, body, headers = {}) =>
    fetch(config.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: config.origin, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  const login = async (username) => {
    const r = await call('/api/auth/login', { username, password });
    assert.equal(r.status, 200);
    const s = await r.json();
    return { Cookie: r.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': s.csrf };
  };
  try {
    const staff = await login('staff'),
      owner = await login('owner'),
      other = await login('other'),
      ops = await login('ops'),
      root = await login('root');
    const input = {
      customerId: a.id,
      currency: 'USD',
      amountCents: 1000,
      reference: 'R',
      bankReference: 'BANK-R',
      account: 'BANK-1',
      reason: '确认实际到账'
    };
    assert.equal((await call('/api/admin/commercial/receipt', input)).status, 401);
    assert.equal((await call('/api/admin/commercial/receipt', input, owner)).status, 403);
    assert.equal((await call('/api/admin/commercial/receipt', input, ops)).status, 403);
    assert.equal(
      (await call('/api/admin/commercial/receipt', input, { Cookie: staff.Cookie })).status,
      403
    );
    const receipt = await call('/api/admin/commercial/receipt', input, staff);
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).amount_cents, 1000);
    const own = await call('/api/replica/ledger/transactions', undefined, owner);
    assert.equal(own.status, 200);
    assert.equal((await own.json()).total, 1);
    assert.equal(
      (
        await (
          await call('/api/replica/ledger/transactions?customerId=' + a.id, undefined, other)
        ).json()
      ).total,
      0
    );
    assert.equal((await call('/api/replica/ledger/receipt', input, owner)).status, 403);
    assert.equal((await call('/api/admin/commercial/integrity', undefined, staff)).status, 403);
    assert.equal((await call('/api/admin/commercial/integrity', undefined, root)).status, 200);
    assert.equal(
      (await call('/api/replica/ledger/transactions?pageSize=10000', undefined, owner)).status,
      400
    );
    const customers = await call('/api/admin/customers?page=1&pageSize=1', undefined, root);
    assert.equal(customers.status, 200);
    const paged = await customers.json();
    assert.equal(paged.items.length, 1);
    assert.equal(paged.total, 2);
    assert.equal((await call('/commercial-ui.js')).status, 200);
    const changes = await (await call('/api/admin/commercial/changes', undefined, root)).json();
    assert.equal(changes.total, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
  }
});
