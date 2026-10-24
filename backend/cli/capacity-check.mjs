// Isolated local capacity smoke test. Never opens the user's DB_PATH or production server.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../persistence/database.mjs';
import { createAuth } from '../security/auth.mjs';
import { createApplication } from '../application.mjs';
import { configuration } from '../config.mjs';
import { inspectIntegrity } from '../operations/integrity.mjs';
const rowCount = Number(process.env.CAPACITY_ROWS || 10000),
  requests = 200,
  concurrency = 10;
if (!Number.isInteger(rowCount) || rowCount < 100 || rowCount > 100000)
  throw Error('CAPACITY_ROWS须为100至100000');
const dir = mkdtempSync(join(tmpdir(), 'fba-capacity-')),
  db = openDatabase(join(dir, 'test.sqlite')),
  config = { ...configuration({}), silent: true },
  server = createApplication({ db, config });
try {
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?)');
  insert.run(
    'customer',
    'admin:customer',
    JSON.stringify({ id: 'customer', name: 'Synthetic capacity fixture', status: 'active' })
  );
  db.exec('BEGIN IMMEDIATE');
  for (let n = 0; n < rowCount; n++) {
    const id = 'synthetic-' + n;
    insert.run(
      id,
      'replica:shipment',
      JSON.stringify({
        id,
        customer_id: 'customer',
        version: 1,
        status: n % 2 ? 'ready' : 'picked',
        shipment_number: 'TEST-' + n,
        client_reference: 'REF-' + n,
        created: '2026-10-23',
        country: 'US',
        parcels: [{ number: '1', client_weight: 10 }]
      })
    );
  }
  db.exec('COMMIT');
  const password = randomBytes(24).toString('base64url');
  await createAuth(db).createUser({
    username: 'capacity-admin',
    displayName: 'Synthetic test',
    role: 'admin',
    password
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port;
  config.origin = 'http://127.0.0.1:' + config.port;
  config.publicHost = '127.0.0.1:' + config.port;
  const login = await fetch(config.origin + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'capacity-admin', password })
  });
  if (!login.ok) throw Error('容量测试登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0],
    latencies = [];
  let next = 0,
    failures = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < requests) {
        const n = next++,
          start = performance.now();
        const response = await fetch(
          config.origin +
            '/api/admin/shipments?' +
            new URLSearchParams({
              page: String((n % Math.ceil(rowCount / 30)) + 1),
              pageSize: '30'
            }),
          { headers: { Cookie: cookie, Origin: config.origin } }
        );
        const body = await response.json();
        latencies.push(performance.now() - start);
        if (!response.ok || body.total !== rowCount || body.items.length > 30) failures++;
      }
    })
  );
  const elapsed = performance.now() - started;
  latencies.sort((a, b) => a - b);
  const integrity = inspectIntegrity(db),
    report = {
      version: '0.8.1',
      checkedAt: new Date().toISOString(),
      scope: 'Isolated loopback HTTP read workload, synthetic data; not a production SLA',
      node: process.version,
      rows: rowCount,
      requests,
      concurrency,
      failures,
      elapsedMs: Math.round(elapsed),
      requestsPerSecond: Math.round(requests / (elapsed / 1000)),
      p50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]),
      p95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]),
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      integrityPassed: integrity.ok
    };
  mkdirSync('output', { recursive: true });
  writeFileSync(resolve('output/capacity-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures || !integrity.ok) process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
