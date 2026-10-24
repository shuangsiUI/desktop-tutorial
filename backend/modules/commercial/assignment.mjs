import { transaction } from '../../persistence/transaction.mjs';
import { requestContext, context } from '../../persistence/context.mjs';
import { requirePermission } from '../../security/policy.mjs';
import { httpError } from '../../http/io.mjs';
import { invoiceJournal } from './ledger.mjs';
export function assignLegacyGroup(db, principal, input) {
  requirePermission(principal, 'customers:write');
  if (
    !input ||
    Object.keys(input).some(
      (k) => !['customerId', 'shipments', 'invoices', 'reason'].includes(k)
    ) ||
    typeof input.customerId !== 'string' ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 2000
  )
    throw httpError(400, '归属分配字段无效');
  const { customerId, reason } = input;
  return transaction(db, () =>
    requestContext.run({ ...context(), principal, reason }, () => {
      const c = db
        .prepare("SELECT body FROM records WHERE id=? AND kind='admin:customer'")
        .get(customerId);
      if (!c || JSON.parse(c.body).status !== 'active') throw httpError(400, '客户不存在或已停用');
      const read = (kind, list) => {
        if (!Array.isArray(list) || list.length > 200) throw httpError(400, '每类最多200条');
        const seen = new Set();
        return list.map((item) => {
          if (
            !item ||
            Object.keys(item).some((k) => !['id', 'version'].includes(k)) ||
            typeof item.id !== 'string' ||
            seen.has(item.id) ||
            !Number.isSafeInteger(item.version)
          )
            throw httpError(400, '记录ID或版本无效');
          seen.add(item.id);
          const raw = db
            .prepare('SELECT body FROM records WHERE id=? AND kind=?')
            .get(item.id, kind);
          if (!raw) throw httpError(404, '记录不存在');
          const row = JSON.parse(raw.body);
          if (row.version !== item.version) throw httpError(409, '记录已更新');
          if (row.customer_id) throw httpError(409, '已有客户归属，不可通过旧数据分配转移');
          return row;
        });
      };
      const shipments = read('replica:shipment', input.shipments || []),
        invoices = read('replica:invoice', input.invoices || []);
      if (!shipments.length && !invoices.length) throw httpError(400, '请选择旧记录');
      const shipmentIds = new Set(shipments.map((r) => r.id)),
        invoiceIds = new Set(invoices.map((r) => r.id));
      for (const row of shipments)
        for (const linked of db
          .prepare('SELECT invoice_id FROM invoice_shipments WHERE shipment_id=?')
          .all(row.id))
          if (!invoiceIds.has(linked.invoice_id)) throw httpError(409, '须同时选择全部关联账单');
      for (const row of invoices)
        for (const linked of db
          .prepare('SELECT shipment_id FROM invoice_shipments WHERE invoice_id=?')
          .all(row.id))
          if (!shipmentIds.has(linked.shipment_id)) throw httpError(409, '须同时选择全部关联运单');
      const update = (kind, row) => {
        const next = {
          ...row,
          customer_id: customerId,
          version: row.version + 1,
          updated: new Date().toISOString()
        };
        if (kind === 'replica:invoice') {
          next.customerId = customerId;
          next.source = { ...row.source, customerId };
        }
        db.prepare('UPDATE records SET body=? WHERE id=? AND kind=?').run(
          JSON.stringify(next),
          row.id,
          kind
        );
        return next;
      };
      const assignedShipments = shipments.map((r) => update('replica:shipment', r)),
        assignedInvoices = invoices.map((r) => update('replica:invoice', r));
      for (const invoice of assignedInvoices) {
        if (invoice.lifecycle !== 'void')
          invoiceJournal(db, invoice, invoice, '旧数据归属分配，确认期初未收');
        for (const row of db
          .prepare(
            "SELECT id,body FROM records WHERE kind='replica:allocation' AND json_extract(body,'$.invoiceId')=?"
          )
          .all(invoice.id))
          db.prepare('UPDATE records SET body=? WHERE id=?').run(
            JSON.stringify({ ...JSON.parse(row.body), customer_id: customerId }),
            row.id
          );
      }
      return { shipments: assignedShipments, invoices: assignedInvoices };
    })
  );
}
