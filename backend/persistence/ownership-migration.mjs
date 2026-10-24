export function migrateOwnership(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()) return;
  db.exec(`BEGIN IMMEDIATE;
 ALTER TABLE business_shipments ADD COLUMN owner_key TEXT GENERATED ALWAYS AS(COALESCE(customer_id,'')) VIRTUAL;
 ALTER TABLE business_invoices ADD COLUMN owner_key TEXT GENERATED ALWAYS AS(COALESCE(customer_id,'')) VIRTUAL;
 CREATE UNIQUE INDEX shipment_owner_key ON business_shipments(id,owner_key);
 CREATE UNIQUE INDEX invoice_owner_key ON business_invoices(id,owner_key);
 DROP TRIGGER shipment_projection_update;
 DROP TRIGGER invoice_projection_insert;
 DROP TRIGGER invoice_projection_update;
 CREATE TABLE invoice_shipments_new(invoice_id TEXT NOT NULL,shipment_id TEXT NOT NULL,owner_key TEXT NOT NULL,PRIMARY KEY(invoice_id,shipment_id),FOREIGN KEY(invoice_id,owner_key) REFERENCES business_invoices(id,owner_key) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(shipment_id,owner_key) REFERENCES business_shipments(id,owner_key) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED);
 INSERT INTO invoice_shipments_new SELECT l.invoice_id,l.shipment_id,i.owner_key FROM invoice_shipments l JOIN business_invoices i ON i.id=l.invoice_id;
 DROP TABLE invoice_shipments;
 ALTER TABLE invoice_shipments_new RENAME TO invoice_shipments;
 CREATE INDEX invoice_shipments_shipment ON invoice_shipments(shipment_id);
 CREATE TRIGGER shipment_projection_update AFTER UPDATE ON records WHEN NEW.kind='replica:shipment' BEGIN UPDATE business_shipments SET customer_id=NULLIF(json_extract(NEW.body,'$.customer_id'),''),status=json_extract(NEW.body,'$.status') WHERE id=NEW.id; END;
 CREATE TRIGGER invoice_projection_insert AFTER INSERT ON records WHEN NEW.kind='replica:invoice' BEGIN
 INSERT INTO business_invoices(id,customer_id,currency,total_cents,allocated_cents) VALUES(NEW.id,NULLIF(json_extract(NEW.body,'$.customer_id'),''),json_extract(NEW.body,'$.currency'),json_extract(NEW.body,'$.totalCents'),json_extract(NEW.body,'$.allocatedCents'));
 INSERT OR IGNORE INTO invoice_shipments SELECT NEW.id,json_extract(value,'$.shipmentId'),COALESCE(json_extract(NEW.body,'$.customer_id'),'') FROM json_each(NEW.body,'$.lines') WHERE NULLIF(json_extract(value,'$.shipmentId'),'') IS NOT NULL; END;
 CREATE TRIGGER invoice_projection_update AFTER UPDATE ON records WHEN NEW.kind='replica:invoice' BEGIN
 UPDATE business_invoices SET customer_id=NULLIF(json_extract(NEW.body,'$.customer_id'),''),currency=json_extract(NEW.body,'$.currency'),total_cents=json_extract(NEW.body,'$.totalCents'),allocated_cents=json_extract(NEW.body,'$.allocatedCents') WHERE id=NEW.id;
 DELETE FROM invoice_shipments WHERE invoice_id=NEW.id;
 INSERT OR IGNORE INTO invoice_shipments SELECT NEW.id,json_extract(value,'$.shipmentId'),COALESCE(json_extract(NEW.body,'$.customer_id'),'') FROM json_each(NEW.body,'$.lines') WHERE NULLIF(json_extract(value,'$.shipmentId'),'') IS NOT NULL; END;
 INSERT INTO schema_migrations VALUES(4,datetime('now'));COMMIT;`);
}
