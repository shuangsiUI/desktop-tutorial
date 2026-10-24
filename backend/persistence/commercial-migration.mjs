// Relational projections constrain the legacy JSON documents during incremental migration.
export function migrateCommercial(db) {
  if (db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) return;
  db.exec(`BEGIN IMMEDIATE;
 CREATE UNIQUE INDEX shipment_reference_owner ON records(COALESCE(json_extract(body,'$.customer_id'),''),json_extract(body,'$.client_reference')) WHERE kind='replica:shipment' AND COALESCE(json_extract(body,'$.client_reference'),'')<>'';
 CREATE UNIQUE INDEX invoice_reference ON records(json_extract(body,'$.reference')) WHERE kind='replica:invoice';
 CREATE TRIGGER record_valid_insert BEFORE INSERT ON records WHEN NOT json_valid(NEW.body) OR json_extract(NEW.body,'$.id') IS NOT NEW.id BEGIN SELECT RAISE(ABORT,'记录ID与文档不一致'); END;
 CREATE TRIGGER record_valid_update BEFORE UPDATE ON records WHEN NOT json_valid(NEW.body) OR json_extract(NEW.body,'$.id') IS NOT NEW.id BEGIN SELECT RAISE(ABORT,'记录ID与文档不一致'); END;
 CREATE INDEX records_status ON records(kind,json_extract(body,'$.status'));
 CREATE INDEX allocation_invoice ON records(json_extract(body,'$.invoiceId')) WHERE kind='replica:allocation';
 CREATE TABLE auth_mfa(user_id TEXT PRIMARY KEY REFERENCES auth_users(id),encrypted_secret TEXT NOT NULL,last_counter INTEGER NOT NULL,enrolled_at TEXT NOT NULL);
 CREATE TABLE mfa_enrollment_audit(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE business_customers(id TEXT PRIMARY KEY REFERENCES records(id),status TEXT NOT NULL);
 CREATE TABLE business_shipments(id TEXT PRIMARY KEY REFERENCES records(id),customer_id TEXT REFERENCES business_customers(id),status TEXT NOT NULL);
 CREATE TABLE business_invoices(id TEXT PRIMARY KEY REFERENCES records(id),customer_id TEXT REFERENCES business_customers(id),currency TEXT NOT NULL,total_cents INTEGER NOT NULL CHECK(total_cents>0),allocated_cents INTEGER NOT NULL CHECK(allocated_cents>=0 AND allocated_cents<=total_cents));
 CREATE TABLE invoice_shipments(invoice_id TEXT NOT NULL REFERENCES business_invoices(id),shipment_id TEXT NOT NULL REFERENCES business_shipments(id),PRIMARY KEY(invoice_id,shipment_id));
 CREATE INDEX business_shipments_customer ON business_shipments(customer_id,status);
 CREATE INDEX business_invoices_customer ON business_invoices(customer_id,currency);
 CREATE INDEX invoice_shipments_shipment ON invoice_shipments(shipment_id);
 INSERT INTO business_customers SELECT id,json_extract(body,'$.status') FROM records WHERE kind='admin:customer';
 INSERT INTO business_shipments SELECT id,NULLIF(json_extract(body,'$.customer_id'),''),COALESCE(json_extract(body,'$.status'),'ready') FROM records WHERE kind='replica:shipment';
 INSERT INTO business_invoices SELECT id,NULLIF(json_extract(body,'$.customer_id'),''),json_extract(body,'$.currency'),json_extract(body,'$.totalCents'),json_extract(body,'$.allocatedCents') FROM records WHERE kind='replica:invoice';
 INSERT OR IGNORE INTO invoice_shipments SELECT r.id,json_extract(l.value,'$.shipmentId') FROM records r,json_each(r.body,'$.lines') l WHERE r.kind='replica:invoice' AND NULLIF(json_extract(l.value,'$.shipmentId'),'') IS NOT NULL;
 CREATE TABLE commercial_migration_validation(n INTEGER CHECK(n=0));
 INSERT INTO commercial_migration_validation SELECT count(*) FROM invoice_shipments l JOIN business_shipments s ON s.id=l.shipment_id JOIN business_invoices i ON i.id=l.invoice_id WHERE s.customer_id IS NOT i.customer_id;
 DROP TABLE commercial_migration_validation;
 CREATE TRIGGER customer_projection_insert AFTER INSERT ON records WHEN NEW.kind='admin:customer' BEGIN INSERT INTO business_customers VALUES(NEW.id,json_extract(NEW.body,'$.status')); END;
 CREATE TRIGGER customer_projection_update AFTER UPDATE ON records WHEN NEW.kind='admin:customer' BEGIN UPDATE business_customers SET status=json_extract(NEW.body,'$.status') WHERE id=NEW.id; END;
 CREATE TRIGGER immutable_record_kind BEFORE UPDATE ON records WHEN OLD.kind<>NEW.kind OR OLD.id<>NEW.id BEGIN SELECT RAISE(ABORT,'记录种类及ID不可修改'); END;
 CREATE TRIGGER immutable_customer_owner BEFORE UPDATE ON records WHEN OLD.kind IN ('replica:shipment','replica:invoice','replica:address','replica:product','replica:vat','replica:store','replica:booking','replica:cabin') AND NULLIF(json_extract(OLD.body,'$.customer_id'),'') IS NOT NULL AND COALESCE(json_extract(NEW.body,'$.customer_id'),'')<>json_extract(OLD.body,'$.customer_id') BEGIN SELECT RAISE(ABORT,'已有客户归属，不能直接转移'); END;
 CREATE TRIGGER shipment_projection_insert AFTER INSERT ON records WHEN NEW.kind='replica:shipment' BEGIN INSERT INTO business_shipments VALUES(NEW.id,NULLIF(json_extract(NEW.body,'$.customer_id'),''),COALESCE(json_extract(NEW.body,'$.status'),'ready')); END;
 CREATE TRIGGER shipment_projection_update AFTER UPDATE ON records WHEN NEW.kind='replica:shipment' BEGIN UPDATE business_shipments SET customer_id=NULLIF(json_extract(NEW.body,'$.customer_id'),''),status=json_extract(NEW.body,'$.status') WHERE id=NEW.id; SELECT CASE WHEN EXISTS(SELECT 1 FROM invoice_shipments l JOIN business_invoices i ON i.id=l.invoice_id WHERE l.shipment_id=NEW.id AND i.customer_id IS NOT (SELECT customer_id FROM business_shipments WHERE id=NEW.id)) THEN RAISE(ABORT,'运单与账单客户不一致') END; END;
 CREATE TRIGGER invoice_projection_insert AFTER INSERT ON records WHEN NEW.kind='replica:invoice' BEGIN
 INSERT INTO business_invoices VALUES(NEW.id,NULLIF(json_extract(NEW.body,'$.customer_id'),''),json_extract(NEW.body,'$.currency'),json_extract(NEW.body,'$.totalCents'),json_extract(NEW.body,'$.allocatedCents'));
 INSERT OR IGNORE INTO invoice_shipments SELECT NEW.id,json_extract(value,'$.shipmentId') FROM json_each(NEW.body,'$.lines') WHERE NULLIF(json_extract(value,'$.shipmentId'),'') IS NOT NULL;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM invoice_shipments l JOIN business_shipments s ON s.id=l.shipment_id WHERE l.invoice_id=NEW.id AND s.customer_id IS NOT (SELECT customer_id FROM business_invoices WHERE id=NEW.id)) THEN RAISE(ABORT,'运单与账单客户不一致') END; END;
 CREATE TRIGGER invoice_projection_update AFTER UPDATE ON records WHEN NEW.kind='replica:invoice' BEGIN
 UPDATE business_invoices SET customer_id=NULLIF(json_extract(NEW.body,'$.customer_id'),''),currency=json_extract(NEW.body,'$.currency'),total_cents=json_extract(NEW.body,'$.totalCents'),allocated_cents=json_extract(NEW.body,'$.allocatedCents') WHERE id=NEW.id;
 DELETE FROM invoice_shipments WHERE invoice_id=NEW.id;
 INSERT OR IGNORE INTO invoice_shipments SELECT NEW.id,json_extract(value,'$.shipmentId') FROM json_each(NEW.body,'$.lines') WHERE NULLIF(json_extract(value,'$.shipmentId'),'') IS NOT NULL;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM invoice_shipments l JOIN business_shipments s ON s.id=l.shipment_id WHERE l.invoice_id=NEW.id AND s.customer_id IS NOT (SELECT customer_id FROM business_invoices WHERE id=NEW.id)) THEN RAISE(ABORT,'运单与账单客户不一致') END; END;
 CREATE TABLE ledger_transactions(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES business_customers(id),currency TEXT NOT NULL CHECK(length(currency)=3),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),invoice_id TEXT REFERENCES business_invoices(id),source_id TEXT,bank_reference TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','posted')));
 CREATE TABLE ledger_lines(transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),account TEXT NOT NULL CHECK(account IN ('bank','customer_credit','receivable','revenue','opening_balance')),debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents>=0),credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents>=0),CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0)),PRIMARY KEY(transaction_id,account));
 CREATE UNIQUE INDEX ledger_bank_reference ON ledger_transactions(kind,bank_reference) WHERE kind IN ('receipt','refund');
 CREATE TRIGGER ledger_draft_insert BEFORE INSERT ON ledger_transactions WHEN NEW.status<>'draft' BEGIN SELECT RAISE(ABORT,'凭证须先暂存再校验过账'); END;
 CREATE TRIGGER ledger_invoice_owner BEFORE INSERT ON ledger_transactions WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_invoices i WHERE i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.currency=NEW.currency) BEGIN SELECT RAISE(ABORT,'凭证账单客户或币种不一致'); END;
 CREATE INDEX ledger_customer ON ledger_transactions(customer_id,currency,created_at);
 CREATE INDEX ledger_source ON ledger_transactions(source_id,kind);
 CREATE TRIGGER ledger_post_check BEFORE UPDATE ON ledger_transactions WHEN OLD.status='draft' AND NEW.status='posted' BEGIN SELECT CASE WHEN (SELECT count(*) FROM ledger_lines WHERE transaction_id=NEW.id)<>2 OR (SELECT sum(debit_cents) FROM ledger_lines WHERE transaction_id=NEW.id)<>NEW.amount_cents OR (SELECT sum(credit_cents) FROM ledger_lines WHERE transaction_id=NEW.id)<>NEW.amount_cents THEN RAISE(ABORT,'分录不平衡') END; END;
 CREATE TRIGGER ledger_immutable_update BEFORE UPDATE ON ledger_transactions WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'已过账凭证不可修改'); END;
 CREATE TRIGGER ledger_immutable_delete BEFORE DELETE ON ledger_transactions BEGIN SELECT RAISE(ABORT,'凭证不可删除'); END;
 CREATE TRIGGER ledger_line_insert BEFORE INSERT ON ledger_lines WHEN (SELECT status FROM ledger_transactions WHERE id=NEW.transaction_id)<>'draft' BEGIN SELECT RAISE(ABORT,'已过账分录不可追加'); END;
 CREATE TRIGGER ledger_line_update BEFORE UPDATE ON ledger_lines BEGIN SELECT RAISE(ABORT,'分录不可修改'); END;
 CREATE TRIGGER ledger_line_delete BEFORE DELETE ON ledger_lines BEGIN SELECT RAISE(ABORT,'分录不可删除'); END;
 CREATE TABLE shipment_fees(id TEXT PRIMARY KEY,shipment_id TEXT NOT NULL REFERENCES business_shipments(id),customer_id TEXT NOT NULL REFERENCES business_customers(id),currency TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),pricing_snapshot TEXT NOT NULL,shipment_version INTEGER NOT NULL,invoice_id TEXT REFERENCES business_invoices(id),created_at TEXT NOT NULL,UNIQUE(shipment_id));
 CREATE TABLE commercial_requests(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('pricing','measurement','invoice_void','refund','invoice_adjustment')),object_id TEXT NOT NULL,base_version INTEGER NOT NULL,proposal TEXT NOT NULL,reason TEXT NOT NULL,maker_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),version INTEGER NOT NULL DEFAULT 1,reviewer_id TEXT,note TEXT,created_at TEXT NOT NULL,reviewed_at TEXT);
 CREATE UNIQUE INDEX commercial_request_pending ON commercial_requests(kind,object_id) WHERE status='pending';
 CREATE TABLE record_changes(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,object_id TEXT NOT NULL,actor_id TEXT,customer_id TEXT,request_id TEXT,reason TEXT,before_json TEXT,after_json TEXT);
 CREATE INDEX record_changes_object ON record_changes(object_id,id);
 INSERT INTO schema_migrations VALUES(3,datetime('now'));COMMIT;`);
}

export function installCommercialAudit(db) {
  const snapshot = (prefix) =>
    `json_object('version',json_extract(${prefix}.body,'$.version'),'customer_id',json_extract(${prefix}.body,'$.customer_id'),'status',json_extract(${prefix}.body,'$.status'),'currency',json_extract(${prefix}.body,'$.currency'),'totalCents',json_extract(${prefix}.body,'$.totalCents'),'allocatedCents',json_extract(${prefix}.body,'$.allocatedCents'),'actual_weight',json_extract(${prefix}.body,'$.actual_weight'),'channel_id',json_extract(${prefix}.body,'$.channel_id'),'rateCents',json_extract(${prefix}.body,'$.rateCents'),'creditCents',json_extract(${prefix}.body,'$.creditCents'),'settlement',json_extract(${prefix}.body,'$.settlement'),'changed_fields',json((SELECT json_group_array(key) FROM json_each(${prefix}.body))))`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS record_change_insert AFTER INSERT ON records BEGIN INSERT INTO record_changes(at,kind,object_id,actor_id,customer_id,request_id,reason,after_json) VALUES(datetime('now'),NEW.kind,NEW.id,request_actor(),COALESCE(json_extract(NEW.body,'$.customer_id'),CASE WHEN NEW.kind='admin:customer' THEN NEW.id END),request_id(),request_reason(),${snapshot('NEW')}); END;
 CREATE TRIGGER IF NOT EXISTS record_change_update AFTER UPDATE ON records BEGIN INSERT INTO record_changes(at,kind,object_id,actor_id,customer_id,request_id,reason,before_json,after_json) VALUES(datetime('now'),NEW.kind,NEW.id,request_actor(),COALESCE(json_extract(NEW.body,'$.customer_id'),CASE WHEN NEW.kind='admin:customer' THEN NEW.id END),request_id(),request_reason(),${snapshot('OLD')},${snapshot('NEW')}); END;
 CREATE TRIGGER IF NOT EXISTS record_changes_no_update BEFORE UPDATE ON record_changes BEGIN SELECT RAISE(ABORT,'变更审计不可修改'); END;
 CREATE TRIGGER IF NOT EXISTS record_changes_no_delete BEFORE DELETE ON record_changes BEGIN SELECT RAISE(ABORT,'变更审计不可删除'); END;`);
}
