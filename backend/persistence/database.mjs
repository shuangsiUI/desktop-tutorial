import { migrateOwnership } from './ownership-migration.mjs';
import { invoiceJournal } from '../modules/commercial/ledger.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { context } from './context.mjs';
import { migrateCommercial, installCommercialAudit } from './commercial-migration.mjs';
export function openDatabase(path = process.env.DB_PATH || 'data/logistics.sqlite') {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  try {
    migrate(db, full);
    chmodSync(full, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function migrate(db, file) {
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT,action TEXT,object TEXT);CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);'
  );
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) {
    if (file && db.prepare('SELECT count(*) n FROM records').get().n) {
      const backup = file + '.before-security-' + Date.now() + '.sqlite';
      if (!existsSync(backup)) db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
      chmodSync(backup, 0o600);
    }
    db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE auth_users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','finance','customer')),customer_id TEXT,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,CHECK((role='customer' AND customer_id IS NOT NULL) OR (role<>'customer' AND customer_id IS NULL)));
   CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
   CREATE TABLE auth_attempts(bucket TEXT PRIMARY KEY,failures INTEGER NOT NULL,window_start INTEGER NOT NULL);
   CREATE TABLE security_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT,request_id TEXT NOT NULL);
   CREATE INDEX records_customer_kind ON records(kind,json_extract(body,'$.customer_id'));
   ALTER TABLE audit ADD COLUMN actor_id TEXT;
   ALTER TABLE audit ADD COLUMN customer_id TEXT;
   ALTER TABLE audit ADD COLUMN request_id TEXT;
   INSERT INTO schema_migrations VALUES(1,datetime('now'));COMMIT;`);
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=2').get())
    db.exec(
      `BEGIN IMMEDIATE;CREATE TRIGGER customer_session_revoke AFTER UPDATE OF body ON records WHEN NEW.kind='admin:customer' AND json_extract(NEW.body,'$.status')='disabled' BEGIN DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM auth_users WHERE customer_id=NEW.id);END;INSERT INTO schema_migrations VALUES(2,datetime('now'));COMMIT;`
    );
  db.function('request_actor', () => context().principal?.id || null);
  db.function('request_customer', () => context().principal?.customerId || null);
  db.function('request_id', () => context().requestId || null);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS audit_actor AFTER INSERT ON audit BEGIN UPDATE audit SET actor_id=request_actor(),customer_id=request_customer(),request_id=request_id() WHERE id=NEW.id;END;`
  );
  db.function('request_reason', () => context().reason || null);
  if (
    !db.prepare('SELECT version FROM schema_migrations WHERE version=3').get() &&
    file &&
    db.prepare('SELECT count(*) n FROM records').get().n
  ) {
    const backup = file + '.before-commercial-' + Date.now() + '.sqlite';
    db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
    chmodSync(backup, 0o600);
  }
  try {
    migrateCommercial(db);
    if (
      !db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get() &&
      file &&
      db.prepare('SELECT count(*) n FROM records').get().n
    ) {
      const backup = file + '.before-ownership-' + Date.now() + '.sqlite';
      db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
      chmodSync(backup, 0o600);
    }
    migrateOwnership(db);
    installCommercialAudit(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db
        .prepare(
          "SELECT r.body FROM records r WHERE r.kind='replica:invoice' AND json_extract(r.body,'$.customer_id') IS NOT NULL AND COALESCE(json_extract(r.body,'$.lifecycle'),'issued')<>'void' AND NOT EXISTS(SELECT 1 FROM ledger_transactions t WHERE t.invoice_id=r.id)"
        )
        .all()) {
        const invoice = JSON.parse(row.body);
        invoiceJournal(db, invoice, invoice, '迁移期初应收');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
