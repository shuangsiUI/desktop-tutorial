import { randomUUID } from 'node:crypto';
import { context } from '../../persistence/context.mjs';
import { httpError } from '../../http/io.mjs';
export const commercialEnabled = (db) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_transactions'")
    .get();
export const safeCents = (n) => {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1e12)
    throw httpError(400, '金额须为1至1000000000000的整数分');
  return n;
};
export function post(
  db,
  {
    reference,
    kind,
    customerId,
    currency,
    amountCents,
    invoiceId = null,
    sourceId = null,
    bankReference = null,
    reason,
    debit,
    credit
  }
) {
  safeCents(amountCents);
  if (
    typeof reference !== 'string' ||
    !reference.trim() ||
    reference.length > 200 ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.length > 2000 ||
    !/^[A-Z]{3}$/.test(currency || '') ||
    debit === credit
  )
    throw httpError(400, '凭证字段无效');
  const c = db.prepare('SELECT status FROM business_customers WHERE id=?').get(customerId || '');
  if (!c) throw httpError(400, '凭证必须关联有效客户');
  const old = db.prepare('SELECT * FROM ledger_transactions WHERE reference=?').get(reference);
  if (old) {
    if (
      old.kind !== kind ||
      old.customer_id !== customerId ||
      old.currency !== currency ||
      old.amount_cents !== amountCents ||
      old.invoice_id !== invoiceId ||
      old.source_id !== sourceId ||
      old.bank_reference !== bankReference ||
      old.reason !== reason
    )
      throw httpError(409, '凭证参考号已用于不同内容');
    return old;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO ledger_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'draft')").run(
    id,
    reference,
    kind,
    customerId,
    currency,
    amountCents,
    invoiceId,
    sourceId,
    bankReference,
    reason,
    context().principal?.id || 'system',
    new Date().toISOString()
  );
  const insert = db.prepare('INSERT INTO ledger_lines VALUES(?,?,?,?)');
  insert.run(id, debit, amountCents, 0);
  insert.run(id, credit, 0, amountCents);
  db.prepare("UPDATE ledger_transactions SET status='posted' WHERE id=?").run(id);
  return db.prepare('SELECT * FROM ledger_transactions WHERE id=?').get(id);
}
export function creditBalance(db, customerId, currency) {
  const r = db
    .prepare(
      "SELECT COALESCE(sum(l.credit_cents-l.debit_cents),0) n FROM ledger_lines l JOIN ledger_transactions t ON t.id=l.transaction_id WHERE t.status='posted' AND t.customer_id=? AND t.currency=? AND l.account='customer_credit'"
    )
    .get(customerId, currency);
  if (!Number.isSafeInteger(r.n)) throw httpError(409, '账户余额超出安全范围');
  return r.n;
}
export function invoiceJournal(db, old, next, reason) {
  if (!commercialEnabled(db) || !next.customer_id) return;
  // Legacy invoices get an opening receivable, never a fabricated cash receipt.
  if (
    old &&
    !db.prepare('SELECT 1 FROM ledger_transactions WHERE invoice_id=?').get(old.id) &&
    old.totalCents > old.allocatedCents
  )
    post(db, {
      reference: 'opening:' + old.id,
      kind: 'opening_receivable',
      customerId: old.customer_id,
      currency: old.currency,
      amountCents: old.totalCents - old.allocatedCents,
      invoiceId: old.id,
      reason: '迁移期初未收应收，非现金实收',
      debit: 'receivable',
      credit: 'opening_balance'
    });
  if (old && old.currency !== next.currency)
    throw httpError(409, '已归属账单币种锁定，请冲销后重开');
  const delta = next.totalCents - (old?.totalCents || 0);
  if (!delta) return;
  post(db, {
    reference: 'invoice:' + next.id + ':' + next.version,
    kind: delta > 0 ? 'invoice' : 'credit_note',
    customerId: next.customer_id,
    currency: next.currency,
    amountCents: Math.abs(delta),
    invoiceId: next.id,
    reason,
    debit: delta > 0 ? 'receivable' : 'revenue',
    credit: delta > 0 ? 'revenue' : 'receivable'
  });
}

export function receiptAvailable(db, id) {
  const receipt = db
    .prepare("SELECT * FROM ledger_transactions WHERE id=? AND kind='receipt' AND status='posted'")
    .get(id || '');
  if (!receipt) throw httpError(400, '收款不存在');
  const used = db
    .prepare(
      "SELECT COALESCE(sum(CASE WHEN kind IN ('allocation','refund') THEN amount_cents WHEN kind='allocation_reversal' THEN -amount_cents ELSE 0 END),0) n FROM ledger_transactions WHERE source_id=? AND status='posted'"
    )
    .get(id).n;
  return { ...receipt, availableCents: receipt.amount_cents - used };
}
