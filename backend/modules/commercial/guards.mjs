import { commercialEnabled } from './ledger.mjs';
import { httpError } from '../../http/io.mjs';
export function linkedInvoices(db, shipmentId) {
  return db
    .prepare(
      "SELECT DISTINCT r.body FROM records r,json_each(r.body,'$.lines') l WHERE r.kind='replica:invoice' AND json_extract(l.value,'$.shipmentId')=?"
    )
    .all(shipmentId)
    .map((r) => JSON.parse(r.body));
}
export const shipmentLocked = (db, row) =>
  ['in_transit', 'delivered', 'returned', 'cancelled'].includes(row.status) ||
  linkedInvoices(db, row.id).some((i) => i.lifecycle !== 'void');
export function assertCancellation(db, row) {
  if (linkedInvoices(db, row.id).some((i) => i.lifecycle !== 'void'))
    throw httpError(409, '运单已有账单，请先完成核销撤销、退款或冲销处理');
}
export function releaseCheck(db, row) {
  if (!commercialEnabled(db)) return; // Compatibility for isolated legacy service tests; the HTTP app always runs migrations.
  if (!row.customer_id || !row.channel_id) throw httpError(409, '出库前必须分配客户和渠道');
  const c = JSON.parse(
    db.prepare("SELECT body FROM records WHERE kind='admin:customer' AND id=?").get(row.customer_id)
      ?.body || 'null'
  );
  if (!c || c.status !== 'active') throw httpError(409, '客户已停用');
  const fee = db.prepare('SELECT * FROM shipment_fees WHERE shipment_id=?').get(row.id);
  if (!fee?.invoice_id) throw httpError(409, '出库前必须锁定报价并生成账单');
  const invoice = JSON.parse(
    db.prepare('SELECT body FROM records WHERE id=?').get(fee.invoice_id).body
  );
  if (invoice.lifecycle === 'void' || invoice.currency !== c.currency)
    throw httpError(409, '账单作废或币种与客户结算币种不一致');
  const bills = db
    .prepare(
      "SELECT body FROM records WHERE kind='replica:invoice' AND json_extract(body,'$.customer_id')=?"
    )
    .all(c.id)
    .map((r) => JSON.parse(r.body))
    .filter((i) => i.lifecycle !== 'void');
  const due = bills.filter((i) => i.totalCents > i.allocatedCents),
    today = new Date().toISOString().slice(0, 10);
  if (due.some((i) => i.dueDate && i.dueDate < today))
    throw httpError(409, '存在逾期账单，禁止放货');
  if ((c.settlement || 'prepaid') === 'prepaid') {
    if (invoice.allocatedCents < invoice.totalCents)
      throw httpError(409, '预付客户须付清本票账单后出库');
  } else {
    if (due.some((i) => i.currency !== c.currency))
      throw httpError(409, '存在其他币种欠款，须先结清');
    const exposure = due.reduce((s, i) => s + i.totalCents - i.allocatedCents, 0);
    if (!Number.isSafeInteger(exposure) || exposure > (c.creditCents || 0))
      throw httpError(409, '应收超出信用额度，禁止放货');
  }
  if (!row.outer_carrier?.trim()) throw httpError(409, '出库前必须录入承运商单号');
  if (
    !(row.actual_weight > 0) ||
    row.parcels?.some(
      (p) =>
        !['weight', 'length', 'width', 'height'].every(
          (k) => Number.isFinite(p['actual_' + k]) && p['actual_' + k] > 0
        )
    )
  )
    throw httpError(409, '出库前必须完成所有货箱实测');
  return {
    checkedAt: new Date().toISOString(),
    customerVersion: c.version,
    invoiceId: invoice.id,
    invoiceVersion: invoice.version,
    settlement: c.settlement || 'prepaid',
    creditCents: c.creditCents || 0
  };
}
