import {
  commercialEnabled,
  invoiceJournal,
  post,
  creditBalance,
  receiptAvailable
} from '../commercial/ledger.mjs';
import { context, requestContext } from '../../persistence/context.mjs';
import { records } from '../../persistence/records.mjs';
import { transaction } from '../../persistence/transaction.mjs';
import { randomUUID } from 'node:crypto';
// Local bookkeeping only. An allocation records reconciliation, never a payment.
const fail = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const text = (value, label, max = 200, optional = false) => {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim()))
    fail(`${label}无效`);
  return value.trim();
};
const amount = (value, label = '金额') => {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label}必须为正整数分`);
  return value;
};
const safeSum = (values) =>
  values.reduce((sum, n) => {
    const next = sum + n;
    if (!Number.isSafeInteger(next)) fail('金额合计超出安全范围');
    return next;
  }, 0);
function date(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail(`${label}须为YYYY-MM-DD`);
  const d = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    fail(`${label}日期无效`);
  return value;
}
const decimal = (cents) => {
  const s = String(cents);
  return s.length < 3 ? '0.' + s.padStart(2, '0') : s.slice(0, -2) + '.' + s.slice(-2);
};
function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(`${label}格式或字段无效`);
}
export function createFinanceService(db, principal) {
  const repository = records(db, principal);
  const rows = (kind) => repository.list(kind);
  const invoices = () => rows('replica:invoice'),
    allocations = () => rows('replica:allocation');
  const get = (id) => repository.get('replica:invoice', id);
  const getShipment = (id) => {
    try {
      return repository.get('replica:shipment', id);
    } catch (error) {
      if (error.status === 404) fail('关联运单不存在', 404);
      throw error;
    }
  };
  const atomic = (fn) => transaction(db, fn);
  const put = (kind, record, action) => {
    const saved = repository.put(kind, record);
    db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(
      new Date().toISOString(),
      action,
      record.id
    );
    return saved;
  };
  const prepareUpdate = (input) => {
    keys(
      input,
      [
        'id',
        'version',
        'reference',
        'currency',
        'invoiceDate',
        'dueDate',
        'description',
        'lines',
        'reason'
      ],
      '账单修改'
    );
    const old = get(text(input.id, '账单ID'));
    if (old.lifecycle === 'void') fail('已作废账单不可修改', 409);
    if (
      commercialEnabled(db) &&
      db.prepare('SELECT 1 FROM shipment_fees WHERE invoice_id=?').get(old.id) &&
      !context().approvedCorrection &&
      principal?.role !== 'customer'
    )
      fail('自动计费账单须通过实测更正审批调整', 409);
    if (!Number.isSafeInteger(input.version) || input.version !== old.version)
      fail('账单已更新，请刷新后重试', 409);
    const reason = text(input.reason, '修改原因', 2000),
      reference = text(input.reference, '账单号'),
      currency = text(input.currency, '币种', 3);
    if (!/^[A-Z]{3}$/.test(currency)) fail('币种须为三位大写代码');
    if (commercialEnabled(db) && old.customer_id && currency !== old.currency)
      fail('已归属账单币种锁定，请冲销后重开');
    if (old.allocatedCents && currency !== old.currency) fail('已有核销记录，不可变更币种');
    if (invoices().some((r) => r.id !== old.id && r.reference === reference))
      fail('账单号已存在', 409);
    const invoiceDate = date(input.invoiceDate, '账单日期'),
      dueDate = date(input.dueDate, '到期日期', true);
    if (dueDate && dueDate < invoiceDate) fail('到期日期不能早于账单日期');
    const description = text(input.description, '描述', 4000, true);
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 2000)
      fail('账单明细须为1至2000条');
    const refs = new Set();
    const lines = input.lines.map((line) => {
      keys(line, ['shipmentId', 'reference', 'description', 'amountCents'], '账单明细');
      const reference = text(line.reference, '明细参考号');
      if (refs.has(reference)) fail('账单明细参考号重复');
      refs.add(reference);
      const shipmentId = text(line.shipmentId, '运单ID', 200, true) || null;
      if (shipmentId) {
        const linked = getShipment(shipmentId);
        if (old.customer_id && linked.customer_id !== old.customer_id)
          fail('关联运单不属于账单客户');
      }
      return {
        shipmentId,
        reference,
        description: text(line.description, '明细描述', 4000, true),
        amountCents: amount(line.amountCents)
      };
    });
    const totalCents = safeSum(lines.map((l) => l.amountCents));
    if (totalCents < old.allocatedCents) fail('修改后总额不得低于已核销金额');
    const source = {
      reference,
      currency,
      invoiceDate,
      dueDate,
      description,
      lines,
      ...(old.customer_id ? { customerId: old.customer_id } : {})
    };
    const snapshot = {
      reference: old.reference,
      currency: old.currency,
      invoiceDate: old.invoiceDate,
      dueDate: old.dueDate,
      description: old.description,
      lines: old.lines,
      totalCents: old.totalCents,
      version: old.version
    };
    const record = {
      ...old,
      ...source,
      totalCents,
      source,
      version: old.version + 1,
      updated: new Date().toISOString(),
      revisions: [
        ...(old.revisions || []),
        { at: new Date().toISOString(), reason, before: snapshot }
      ]
    };
    return record;
  };
  const view = (record, withAllocations = false) => ({
    ...record,
    number: record.reference,
    invoice_date: record.invoiceDate,
    due_date: record.dueDate,
    total_charge: decimal(record.totalCents),
    paid_charge: decimal(record.allocatedCents),
    remaining_charge: decimal(
      record.lifecycle === 'void' ? 0 : record.totalCents - record.allocatedCents
    ),
    remainingCents: record.lifecycle === 'void' ? 0 : record.totalCents - record.allocatedCents,
    status: record.lifecycle === 'void' ? 4 : record.totalCents === record.allocatedCents ? 3 : 2,
    localOnly: true,
    ...(withAllocations
      ? {
          allocations: db
            .prepare(
              "SELECT body FROM records WHERE kind='replica:allocation' AND json_extract(body,'$.invoiceId')=?"
            )
            .all(record.id)
            .map((r) => JSON.parse(r.body))
        }
      : {})
  });
  return {
    present(record) {
      return view(record);
    },
    validateRevision(input) {
      return prepareUpdate(input);
    },
    overview() {
      const where =
        "kind='replica:invoice' AND COALESCE(json_extract(body,'$.lifecycle'),'issued')<>'void'" +
        (principal?.role === 'customer' ? " AND json_extract(body,'$.customer_id')=?" : '');
      const grouped = db
        .prepare(
          "SELECT json_extract(body,'$.currency') currency,count(*) invoiceCount,sum(json_extract(body,'$.totalCents')) totalCents,sum(json_extract(body,'$.allocatedCents')) allocatedCents,sum(json_extract(body,'$.totalCents')-json_extract(body,'$.allocatedCents')) remainingCents FROM records WHERE " +
            where +
            " GROUP BY json_extract(body,'$.currency') ORDER BY currency"
        )
        .all(...(principal?.role === 'customer' ? [principal.customerId] : []))
        .map((r) => ({ ...r }));
      for (const r of grouped)
        for (const k of ['totalCents', 'allocatedCents', 'remainingCents'])
          if (!Number.isSafeInteger(r[k])) fail('金额合计超出安全范围');
      return {
        accounts: [],
        balance: null,
        unpay: null,
        actual_balance: null,
        byCurrency: grouped,
        localOnly: true
      };
    },
    listInvoices() {
      return invoices().map((record) => view(record));
    },
    invoice(id) {
      return view(get(text(id, '账单ID')), true);
    },
    importInvoice(input) {
      if (principal?.role === 'customer') fail('客户不可创建应收账单', 403);
      return atomic(() => {
        keys(
          input,
          ['reference', 'currency', 'invoiceDate', 'dueDate', 'description', 'lines', 'customerId'],
          '账单'
        );
        const reference = text(input.reference, '账单号'),
          currency = text(input.currency, '币种', 3);
        if (!/^[A-Z]{3}$/.test(currency)) fail('币种须为三位大写代码');
        const invoiceDate = date(input.invoiceDate, '账单日期'),
          dueDate = date(input.dueDate, '到期日期', true);
        if (dueDate && dueDate < invoiceDate) fail('到期日期不能早于账单日期');
        const description = text(input.description, '描述', 4000, true);
        if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 2000)
          fail('账单明细须为1至2000条');
        const lineReferences = new Set();
        const lines = input.lines.map((line) => {
          keys(line, ['shipmentId', 'reference', 'description', 'amountCents'], '账单明细');
          const ref = text(line.reference, '明细参考号');
          if (lineReferences.has(ref)) fail('账单明细参考号重复');
          lineReferences.add(ref);
          return {
            shipmentId: text(line.shipmentId, '运单ID', 200, true) || null,
            reference: ref,
            description: text(line.description, '明细描述', 4000, true),
            amountCents: amount(line.amountCents)
          };
        });
        const customerId = input.customerId || null;
        if (customerId) {
          if (principal?.role === 'customer' && customerId !== principal.customerId)
            fail('客户归属不可更改', 403);
          const c = db
            .prepare("SELECT body FROM records WHERE kind='admin:customer' AND id=?")
            .get(customerId);
          if (!c || JSON.parse(c.body).status !== 'active') fail('客户不存在或已停用');
        }
        const owners = new Set(
          lines
            .filter((l) => l.shipmentId)
            .map((l) => getShipment(l.shipmentId).customer_id)
            .filter(Boolean)
        );
        if (owners.size > 1 || (customerId && owners.size && !owners.has(customerId)))
          fail('账单不可混合不同客户运单');
        const owner = customerId || [...owners][0] || principal?.customerId || null;
        if (
          owner &&
          lines.some((l) => l.shipmentId && getShipment(l.shipmentId).customer_id !== owner)
        )
          fail('关联运单必须属于同一客户');
        const normalized = {
          reference,
          currency,
          invoiceDate,
          dueDate,
          description,
          lines,
          ...(owner ? { customerId: owner } : {})
        };
        if (commercialEnabled(db) && !owner) fail('新账单必须选择所属客户');
        const existing = invoices().find((record) => record.reference === reference);
        if (existing) {
          if (JSON.stringify(existing.source) !== JSON.stringify(normalized))
            fail('账单号已用于不同内容', 409);
          return view(existing, true);
        }
        for (const line of lines) if (line.shipmentId) getShipment(line.shipmentId);
        const totalCents = safeSum(lines.map((line) => line.amountCents));
        const now = new Date().toISOString();
        const record = {
          ...normalized,
          ...(owner ? { customer_id: owner } : {}),
          id: randomUUID(),
          version: 1,
          lifecycle: 'issued',
          totalCents,
          allocatedCents: 0,
          created: now,
          updated: now,
          source: normalized
        };
        put('replica:invoice', record, 'finance:import-local-invoice');
        invoiceJournal(db, null, record, '建立应收账单');
        return view(record, true);
      });
    },
    assignInvoice(input) {
      if (principal?.role === 'customer') fail('没有分配权限', 403);
      return atomic(() => {
        keys(input, ['id', 'version', 'customerId'], '账单归属');
        const row = get(text(input.id, '账单ID'));
        if (row.version !== input.version) fail('账单已更新', 409);
        if (row.customer_id && row.customer_id !== input.customerId)
          fail('账单已有客户归属，不能直接转移');
        const c = db
          .prepare("SELECT body FROM records WHERE id=? AND kind='admin:customer'")
          .get(input.customerId || '');
        if (!c || JSON.parse(c.body).status !== 'active') fail('客户不存在或已停用');
        for (const l of row.lines)
          if (l.shipmentId && getShipment(l.shipmentId).customer_id !== input.customerId)
            fail('请先分配关联运单给同一客户');
        const next = {
          ...row,
          customer_id: input.customerId,
          customerId: input.customerId,
          source: { ...row.source, customerId: input.customerId },
          version: row.version + 1
        };
        put('replica:invoice', next, 'finance:assign-customer');
        invoiceJournal(db, next, next, '归属分配期初应收');
        for (const a of allocations().filter((a) => a.invoiceId === row.id))
          put(
            'replica:allocation',
            { ...a, customer_id: input.customerId },
            'finance:assign-allocation-owner'
          );
        return view(next, true);
      });
    },
    updateInvoice(input) {
      if (principal?.role === 'customer') fail('客户账单修改需提交审核', 403);
      return atomic(() => {
        const record = prepareUpdate(input);
        invoiceJournal(db, get(record.id), record, input.reason);
        put('replica:invoice', record, 'finance:update-local-invoice');
        return view(record, true);
      });
    },
    listRevisions() {
      return rows('replica:invoice-revision');
    },
    requestRevision(input) {
      if (principal?.role !== 'customer') fail('仅客户提交账单修改申请', 403);
      return atomic(() => {
        const prepared = prepareUpdate(input);
        if (
          rows('replica:invoice-revision').some(
            (r) => r.invoiceId === input.id && r.status === 'pending'
          )
        )
          fail('该账单已有待处理修改申请', 409);
        const record = {
          id: randomUUID(),
          customer_id: principal.customerId,
          invoiceId: input.id,
          version: 1,
          status: 'pending',
          created: new Date().toISOString(),
          input: { ...prepared.source, id: input.id, version: input.version, reason: input.reason }
        };
        delete record.input.customerId;
        put('replica:invoice-revision', record, 'finance:request-revision');
        return record;
      });
    },
    reviewRevision(input) {
      if (principal?.role === 'customer') fail('没有审核权限', 403);
      return atomic(() => {
        keys(input, ['id', 'version', 'decision', 'note'], '审核');
        const change = repository.get('replica:invoice-revision', text(input.id, '申请ID'));
        if (change.status !== 'pending' || change.version !== input.version)
          fail('申请已处理或已更新', 409);
        if (!['approved', 'rejected'].includes(input.decision)) fail('审核结果无效');
        const note = text(input.note, '审核说明', 2000, input.decision === 'approved');
        let invoice;
        if (input.decision === 'approved') {
          const updated = requestContext.run({ ...context(), approvedCorrection: true }, () =>
            prepareUpdate(change.input)
          );
          invoiceJournal(db, get(updated.id), updated, change.input.reason);
          put('replica:invoice', updated, 'finance:approve-revision');
          invoice = view(updated, true);
        }
        const next = {
          ...change,
          status: input.decision,
          note,
          version: change.version + 1,
          reviewedBy: principal?.id || null,
          reviewedAt: new Date().toISOString()
        };
        put('replica:invoice-revision', next, 'finance:review-revision');
        return { request: next, invoice };
      });
    },
    recordAllocation(input) {
      if (principal?.role === 'customer') fail('客户不可登记核销', 403);
      return atomic(() => {
        keys(input, ['invoiceId', 'version', 'amountCents', 'reference', 'receiptId'], '核销');
        const invoiceId = text(input.invoiceId, '账单ID'),
          reference = text(input.reference, '核销参考号'),
          amountCents = amount(input.amountCents);
        const existing = allocations().find((record) => record.reference === reference);
        if (existing) {
          if (
            existing.invoiceId !== invoiceId ||
            existing.amountCents !== amountCents ||
            (existing.receiptId || null) !== (input.receiptId || null)
          )
            fail('核销参考号已用于不同内容', 409);
          return { allocation: existing, invoice: view(get(invoiceId), true), idempotent: true };
        }
        const record = get(invoiceId);
        if (record.lifecycle === 'void') fail('已作废账单不可核销', 409);
        if (!Number.isSafeInteger(input.version) || record.version !== input.version)
          fail('账单已更新，请刷新后重试', 409);
        if (amountCents > record.totalCents - record.allocatedCents) fail('核销金额超过账单余款');
        if (commercialEnabled(db)) {
          if (!record.customer_id) fail('请先分配账单客户');
          const receipt = db
            .prepare(
              "SELECT * FROM ledger_transactions WHERE id=? AND kind='receipt' AND status='posted'"
            )
            .get(input.receiptId || '');
          if (
            !receipt ||
            receipt.customer_id !== record.customer_id ||
            receipt.currency !== record.currency
          )
            fail('请选择同客户同币种的已核实收款');
          if (
            amountCents > receiptAvailable(db, receipt.id).availableCents ||
            amountCents > creditBalance(db, record.customer_id, record.currency)
          )
            fail('收款可用余额不足');
          invoiceJournal(db, record, record, '补记期初应收');
          post(db, {
            reference: 'allocation:' + reference,
            kind: 'allocation',
            customerId: record.customer_id,
            currency: record.currency,
            amountCents,
            invoiceId,
            sourceId: receipt.id,
            reason: '收款核销 ' + reference,
            debit: 'customer_credit',
            credit: 'receivable'
          });
        }
        const now = new Date().toISOString(),
          allocation = {
            id: randomUUID(),
            invoiceId,
            reference,
            amountCents,
            currency: record.currency,
            created: now,
            localOnly: true,
            kind: commercialEnabled(db) ? 'receipt_allocation' : 'local_reconciliation',
            ...(input.receiptId ? { receiptId: input.receiptId } : {}),
            ...(record.customer_id ? { customer_id: record.customer_id } : {})
          };
        // Allocation records are append-only. No API updates or deletes them.
        db.prepare('INSERT INTO records(id,kind,body) VALUES(?,?,?)').run(
          allocation.id,
          'replica:allocation',
          JSON.stringify(allocation)
        );
        db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(
          now,
          'finance:record-local-allocation',
          allocation.id
        );
        record.allocatedCents = safeSum([record.allocatedCents, amountCents]);
        record.version++;
        record.updated = now;
        put('replica:invoice', record, 'finance:reconcile-local-invoice');
        return { allocation, invoice: view(record, true), idempotent: false };
      });
    }
  };
}
