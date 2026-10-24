export function inspectIntegrity(db) {
  const issues = [];
  for (const r of db.prepare('PRAGMA integrity_check').all())
    if (r.integrity_check !== 'ok') issues.push({ type: 'sqlite', detail: r.integrity_check });
  for (const r of db.prepare('PRAGMA foreign_key_check').all())
    issues.push({ type: 'foreign_key', ...r });
  const has = (table) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (has('invoice_shipments'))
    for (const r of db
      .prepare(
        'SELECT l.invoice_id,l.shipment_id FROM invoice_shipments l JOIN business_invoices i ON i.id=l.invoice_id JOIN business_shipments s ON s.id=l.shipment_id WHERE i.customer_id IS NOT s.customer_id'
      )
      .all())
      issues.push({ type: 'ownership', ...r });
  if (has('ledger_transactions')) {
    for (const r of db
      .prepare(
        "SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_lines l ON l.transaction_id=t.id GROUP BY t.id HAVING t.status<>'posted' OR count(l.account)<>2 OR sum(l.debit_cents)<>t.amount_cents OR sum(l.credit_cents)<>t.amount_cents"
      )
      .all())
      issues.push({ type: 'ledger_unbalanced', ...r });
    for (const r of db
      .prepare(
        "SELECT t.customer_id,t.currency FROM ledger_transactions t JOIN ledger_lines l ON l.transaction_id=t.id WHERE t.status='posted' AND l.account='customer_credit' GROUP BY t.customer_id,t.currency HAVING sum(l.credit_cents-l.debit_cents)<0"
      )
      .all())
      issues.push({ type: 'negative_credit', ...r });
    const invoiceBalances = db
      .prepare(
        "SELECT json_extract(body,'$.customer_id') customer_id,json_extract(body,'$.currency') currency,sum(CASE WHEN json_extract(body,'$.lifecycle')='void' THEN 0 ELSE json_extract(body,'$.totalCents')-json_extract(body,'$.allocatedCents') END) amount FROM records WHERE kind='replica:invoice' AND NULLIF(json_extract(body,'$.customer_id'),'') IS NOT NULL GROUP BY customer_id,currency"
      )
      .all();
    const ledgerBalances = db
      .prepare(
        "SELECT t.customer_id,t.currency,sum(l.debit_cents-l.credit_cents) amount FROM ledger_transactions t JOIN ledger_lines l ON l.transaction_id=t.id WHERE t.status='posted' AND l.account='receivable' GROUP BY t.customer_id,t.currency"
      )
      .all();
    const balances = new Map(
      ledgerBalances.map((r) => [r.customer_id + ':' + r.currency, r.amount])
    );
    for (const row of invoiceBalances) {
      const k = row.customer_id + ':' + row.currency;
      if (row.amount !== (balances.get(k) || 0))
        issues.push({
          type: 'receivable_mismatch',
          customer_id: row.customer_id,
          currency: row.currency
        });
      balances.delete(k);
    }
    for (const [account, amount] of balances)
      if (amount) issues.push({ type: 'orphan_receivable', account });
  }
  return { ok: issues.length === 0, checkedAt: new Date().toISOString(), issues };
}
