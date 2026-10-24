import { settlementDueDate } from './arithmetic.mjs';
import { randomUUID } from 'node:crypto';
import { transaction } from '../../persistence/transaction.mjs';
import { context, requestContext } from '../../persistence/context.mjs';
import { httpError } from '../../http/io.mjs';
import { requirePermission } from '../../security/policy.mjs';
import { post, safeCents, creditBalance, invoiceJournal, receiptAvailable } from './ledger.mjs';
import { linkedInvoices, shipmentLocked } from './guards.mjs';
import { quote } from '../../../domain.mjs';
import { createAdminService } from '../operations/service.mjs';
import { createFinanceService } from '../finance/service.mjs';

const fail = (message, status = 400) => {
  throw httpError(status, message);
};
const text = (s, label, max = 200) => {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > max) fail(label + '无效');
  return s.trim();
};
const keys = (o, allowed) => {
  if (
    !o ||
    typeof o !== 'object' ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => !allowed.includes(k))
  )
    fail('请求字段无效');
};
export function createCommercialService(db, principal) {
  const guard = (permission) => requirePermission(principal, permission);
  const get = (kind, id) => {
    const r = db.prepare('SELECT body FROM records WHERE id=? AND kind=?').get(id || '', kind);
    if (!r) fail('记录不存在', 404);
    return JSON.parse(r.body);
  };
  const save = (kind, row) =>
    db
      .prepare('UPDATE records SET body=? WHERE kind=? AND id=?')
      .run(JSON.stringify(row), kind, row.id);
  const check = (row, version) => {
    if (!Number.isSafeInteger(version) || version !== row.version) fail('记录已更新，请刷新', 409);
  };
  const actor = () => text(principal?.id, '操作者');
  const run = (fn) =>
    transaction(db, () =>
      requestContext.run({ ...context(), principal: principal || context().principal }, fn)
    );
  const ledgerRows = ({ kind, customerId, page = 1, pageSize = 30 } = {}) => {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      fail('分页无效');
    const conditions = ["status='posted'"],
      params = [];
    if (principal?.role === 'customer') {
      conditions.push('customer_id=?');
      params.push(principal.customerId);
    }
    if (customerId && principal?.role !== 'customer') {
      conditions.push('customer_id=?');
      params.push(text(customerId, '客户ID'));
    }
    if (kind) {
      conditions.push('kind=?');
      params.push(text(kind, '流水种类'));
    }
    const where = conditions.join(' AND ');
    return {
      items: db
        .prepare(
          'SELECT * FROM ledger_transactions WHERE ' +
            where +
            ' ORDER BY rowid DESC LIMIT ? OFFSET ?'
        )
        .all(...params, pageSize, (page - 1) * pageSize),
      total: db.prepare('SELECT count(*) n FROM ledger_transactions WHERE ' + where).get(...params)
        .n,
      page,
      pageSize
    };
  };
  const accounts = () => {
    const customer = principal?.role === 'customer' ? ' AND t.customer_id=?' : '';
    const params = principal?.role === 'customer' ? [principal.customerId] : [];
    return db
      .prepare(
        "SELECT t.customer_id customerId,t.currency currency,sum(CASE WHEN l.account='customer_credit' THEN l.credit_cents-l.debit_cents ELSE 0 END) availableCents,sum(CASE WHEN l.account='receivable' THEN l.debit_cents-l.credit_cents ELSE 0 END) receivableCents FROM ledger_transactions t JOIN ledger_lines l ON l.transaction_id=t.id WHERE t.status='posted'" +
          customer +
          ' GROUP BY t.customer_id,t.currency'
      )
      .all(...params);
  };
  const request = (kind, objectId, baseVersion, proposal, reason) => {
    actor();
    reason = text(reason, '申请原因', 2000);
    if (
      db
        .prepare(
          "SELECT 1 FROM commercial_requests WHERE kind=? AND object_id=? AND status='pending'"
        )
        .get(kind, objectId)
    )
      fail('已有待审核申请', 409);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO commercial_requests(id,kind,object_id,base_version,proposal,reason,maker_id,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)"
    ).run(
      id,
      kind,
      objectId,
      baseVersion,
      JSON.stringify(proposal),
      reason,
      actor(),
      new Date().toISOString()
    );
    return db.prepare('SELECT * FROM commercial_requests WHERE id=?').get(id);
  };
  const quoteShipment = (shipment) => {
    if (!shipment.customer_id || !shipment.channel_id) fail('请先分配客户和渠道');
    const channel = get('admin:channel', shipment.channel_id),
      customer = get('admin:customer', shipment.customer_id);
    if (channel.archived || channel.status !== 'active' || customer.status !== 'active')
      fail('客户或渠道已停用');
    if (channel.currency !== customer.currency) fail('渠道币种须与客户结算币种一致');
    if (
      channel.country !== shipment.country ||
      (channel.serviceCode && channel.serviceCode !== shipment.service) ||
      (customer.channelIds?.length && !customer.channelIds.includes(channel.id))
    )
      fail('客户、目的地或服务不符合渠道条件');
    const boxes = [
      ...new Map(shipment.parcels.map((p, i) => [String(p.number || i + 1), p])).entries()
    ].map(([number, p]) => ({
      sku: number,
      qty: 1,
      ...Object.fromEntries(
        ['weight', 'length', 'width', 'height'].map((k) => [k, p['actual_' + k]])
      )
    }));
    if (
      boxes.some(
        (p) =>
          !['weight', 'length', 'width', 'height'].every(
            (k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] > 0
          )
      )
    )
      fail('请先录入全部实测重量和尺寸');
    const result = quote(channel, boxes, { maxBoxes: 2000 });
    safeCents(result.estimatedCents);
    return {
      channel: { ...channel },
      result,
      capturedAt: new Date().toISOString(),
      currency: channel.currency
    };
  };
  const service = {
    transactions(options) {
      guard(principal?.role === 'customer' ? 'client:access' : 'finance:read');
      return ledgerRows(options);
    },
    accounts() {
      guard(principal?.role === 'customer' ? 'client:access' : 'finance:read');
      return accounts();
    },
    changes({ page = 1, pageSize = 30 } = {}) {
      guard('system:read');
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        fail('分页无效');
      return {
        items: db
          .prepare('SELECT * FROM record_changes ORDER BY id DESC LIMIT ? OFFSET ?')
          .all(pageSize, (page - 1) * pageSize),
        total: db.prepare('SELECT count(*) n FROM record_changes').get().n,
        page,
        pageSize
      };
    },
    receipt(input) {
      guard('finance:write');
      return run(() => {
        keys(input, [
          'customerId',
          'currency',
          'amountCents',
          'reference',
          'bankReference',
          'account',
          'reason'
        ]);
        const c = get('admin:customer', input.customerId);
        if (c.status !== 'active') fail('客户已停用');
        const account = text(input.account, '收款账户'),
          bankReference = text(input.bankReference, '银行流水号');
        return post(db, {
          reference: 'receipt:' + text(input.reference, '收款参考号'),
          kind: 'receipt',
          customerId: c.id,
          currency: input.currency,
          amountCents: input.amountCents,
          bankReference: account + ':' + bankReference,
          reason: text(input.reason, '收款核实说明', 2000),
          debit: 'bank',
          credit: 'customer_credit'
        });
      });
    },
    reverseAllocation(input) {
      guard('finance:write');
      return run(() => {
        keys(input, ['id', 'version', 'reference', 'reason']);
        const allocation = get('replica:allocation', input.id),
          invoice = get('replica:invoice', allocation.invoiceId);
        check(invoice, input.version);
        if (!allocation.receiptId) fail('历史无收款关联核销须先完成期初迁移核对');
        const old = db
          .prepare("SELECT * FROM ledger_transactions WHERE reference=? AND kind='allocation'")
          .get('allocation:' + allocation.reference);
        if (!old) fail('核销凭证不存在');
        const existing = db
          .prepare(
            "SELECT * FROM ledger_transactions WHERE kind='allocation_reversal' AND invoice_id=? AND reason=?"
          )
          .get(invoice.id, '撤销核销 ' + allocation.id + '：' + input.reason);
        if (existing) return existing;
        if (
          db
            .prepare('SELECT 1 FROM ledger_transactions WHERE reference=?')
            .get('reverse-allocation:' + allocation.id)
        )
          fail('该核销已撤销', 409);
        const tx = post(db, {
          reference: 'reverse-allocation:' + allocation.id,
          kind: 'allocation_reversal',
          customerId: invoice.customer_id,
          currency: invoice.currency,
          amountCents: allocation.amountCents,
          invoiceId: invoice.id,
          sourceId: allocation.receiptId,
          reason: '撤销核销 ' + allocation.id + '：' + text(input.reason, '撤销原因', 1800),
          debit: 'receivable',
          credit: 'customer_credit'
        });
        invoice.allocatedCents -= allocation.amountCents;
        invoice.version++;
        invoice.updated = new Date().toISOString();
        save('replica:invoice', invoice);
        return tx;
      });
    },
    generateInvoice(input) {
      guard('finance:write');
      return run(() => {
        keys(input, ['shipmentId', 'version', 'reference']);
        const shipment = get('replica:shipment', input.shipmentId);
        check(shipment, input.version);
        if (!['ready', 'picked'].includes(shipment.status)) fail('仅出库前运单可以生成费用');
        const existing = db
          .prepare('SELECT * FROM shipment_fees WHERE shipment_id=?')
          .get(shipment.id);
        if (existing) {
          const invoice = get('replica:invoice', existing.invoice_id);
          if (invoice.lifecycle === 'void') fail('原费用账单已作废，须处理原费用后重新计费');
          if (invoice.reference !== input.reference) fail('本票已有费用账单', 409);
          return invoice;
        }
        if (linkedInvoices(db, shipment.id).some((i) => i.lifecycle !== 'void'))
          fail('该运单已有账单，请先核对，避免重复计费');
        const snapshot = quoteShipment(shipment),
          c = get('admin:customer', shipment.customer_id),
          day = new Date(),
          invoiceDate = day.toISOString().slice(0, 10);
        const dueDate = settlementDueDate(invoiceDate, c.settlement);
        let invoice = createFinanceService(db, principal).importInvoice({
          reference: text(input.reference, '账单号'),
          customerId: c.id,
          currency: snapshot.currency,
          invoiceDate,
          dueDate,
          description: '锁定运单实测与渠道费率',
          lines: [
            {
              shipmentId: shipment.id,
              reference: 'freight:' + shipment.id,
              description: '运费',
              amountCents: snapshot.result.estimatedCents
            }
          ]
        });
        invoice = { ...get('replica:invoice', invoice.id), billingSource: 'measured' };
        save('replica:invoice', invoice);
        db.prepare('INSERT INTO shipment_fees VALUES(?,?,?,?,?,?,?,?,?)').run(
          randomUUID(),
          shipment.id,
          c.id,
          snapshot.currency,
          snapshot.result.estimatedCents,
          JSON.stringify(snapshot),
          shipment.version,
          invoice.id,
          new Date().toISOString()
        );
        return invoice;
      });
    },
    requestPricing(input) {
      guard('pricing:propose');
      return run(() => {
        keys(input, [
          'channelId',
          'version',
          'rateCents',
          'fixedCents',
          'minimum',
          'divisor',
          'step',
          'reason'
        ]);
        const channel = get('admin:channel', input.channelId);
        check(channel, input.version);
        const proposal = {
          ...channel,
          status: 'active',
          ...Object.fromEntries(
            ['rateCents', 'fixedCents', 'minimum', 'divisor', 'step'].map((k) => [k, input[k]])
          )
        };
        for (const k of ['rateCents', 'fixedCents'])
          if (!Number.isSafeInteger(proposal[k]) || proposal[k] < 0 || proposal[k] > 1e10)
            fail('费率须为整数分');
        for (const k of ['minimum', 'divisor', 'step'])
          if (
            typeof proposal[k] !== 'number' ||
            !Number.isFinite(proposal[k]) ||
            proposal[k] < (k === 'minimum' ? 0 : 0.001) ||
            proposal[k] > 1e6
          )
            fail('计费参数无效');
        return request('pricing', channel.id, channel.version, proposal, input.reason);
      });
    },
    requestMeasurement(input) {
      guard('shipments:write');
      return run(() => {
        keys(input, ['shipmentId', 'version', 'parcels', 'reason']);
        const shipment = get('replica:shipment', input.shipmentId);
        check(shipment, input.version);
        if (!shipmentLocked(db, shipment)) fail('未锁定运单请直接录入');
        if (['cancelled', 'returned'].includes(shipment.status))
          fail('取消及退回运单不可申请此更正');
        const dry = { ...context(), approvedCorrection: true, reason: input.reason };
        db.exec('SAVEPOINT validate_measurement');
        try {
          requestContext.run(dry, () =>
            createAdminService(db).updateShipment({
              id: shipment.id,
              version: shipment.version,
              parcels: input.parcels
            })
          );
        } finally {
          db.exec('ROLLBACK TO validate_measurement; RELEASE validate_measurement');
        }
        return request(
          'measurement',
          shipment.id,
          shipment.version,
          { parcels: input.parcels },
          input.reason
        );
      });
    },
    requestAdjustment(input) {
      guard('finance:write');
      return run(() => {
        const proposal = requestContext.run({ ...context(), approvedCorrection: true }, () =>
          createFinanceService(db, principal).validateRevision(input)
        );
        return request('invoice_adjustment', proposal.id, input.version, input, input.reason);
      });
    },
    requestVoid(input) {
      guard('finance:write');
      return run(() => {
        keys(input, ['invoiceId', 'version', 'reason']);
        const invoice = get('replica:invoice', input.invoiceId);
        check(invoice, input.version);
        if (invoice.lifecycle === 'void' || invoice.allocatedCents)
          fail('账单已作废或仍有核销，请先撤销核销并处理余款');
        if (!invoice.customer_id) fail('请先分配客户');
        const released = db
          .prepare(
            "SELECT 1 FROM invoice_shipments l JOIN business_shipments s ON s.id=l.shipment_id WHERE l.invoice_id=? AND s.status IN ('in_transit','delivered')"
          )
          .get(invoice.id);
        if (released) fail('已出库账单不能整单作废，请按实际业务申请费用更正');
        return request('invoice_void', invoice.id, invoice.version, {}, input.reason);
      });
    },
    requestRefund(input) {
      guard('finance:write');
      return run(() => {
        keys(input, [
          'customerId',
          'currency',
          'amountCents',
          'reference',
          'bankReference',
          'account',
          'reason',
          'receiptId'
        ]);
        get('admin:customer', input.customerId);
        safeCents(input.amountCents);
        if (!/^[A-Z]{3}$/.test(input.currency || '')) fail('币种无效');
        const receipt = receiptAvailable(db, input.receiptId);
        if (receipt.customer_id !== input.customerId || receipt.currency !== input.currency)
          fail('退款收款归属或币种不一致');
        if (
          input.amountCents > receipt.availableCents ||
          input.amountCents > creditBalance(db, input.customerId, input.currency)
        )
          fail('可退款余额不足');
        const proposal = {
          ...input,
          reference: text(input.reference, '退款参考号'),
          account: text(input.account, '退款账户'),
          bankReference: text(input.bankReference, '付款流水号')
        };
        return request(
          'refund',
          input.customerId + ':' + proposal.reference,
          0,
          proposal,
          input.reason
        );
      });
    },
    requests({ page = 1, pageSize = 30 } = {}) {
      guard('approvals:read');
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        fail('分页无效');
      return {
        items: db
          .prepare('SELECT * FROM commercial_requests ORDER BY rowid DESC LIMIT ? OFFSET ?')
          .all(pageSize, (page - 1) * pageSize),
        total: db.prepare('SELECT count(*) n FROM commercial_requests').get().n,
        page,
        pageSize
      };
    },
    review(input) {
      guard('approvals:review');
      return run(() => {
        keys(input, ['id', 'version', 'decision', 'note']);
        const req = db.prepare('SELECT * FROM commercial_requests WHERE id=?').get(input.id || '');
        if (!req) fail('申请不存在', 404);
        check(req, input.version);
        if (req.status !== 'pending') fail('申请已处理', 409);
        if (req.maker_id === actor()) fail('申请人与审核人必须不同', 403);
        if (!['approved', 'rejected'].includes(input.decision)) fail('审核结果无效');
        const note = text(input.note, '审核说明', 2000),
          proposal = JSON.parse(req.proposal);
        let result;
        if (input.decision === 'approved')
          requestContext.run(
            { ...context(), approvedCorrection: true, approvedPricing: true, reason: req.reason },
            () => {
              if (req.kind === 'pricing') {
                const channel = get('admin:channel', req.object_id);
                check(channel, req.base_version);
                const {
                  id,
                  version,
                  created,
                  updated,
                  archived,
                  pricingApprovedVersion,
                  pricingEffectiveAt,
                  ...fields
                } = proposal;
                result = createAdminService(db).saveChannel({ ...fields, id, version });
              }
              if (req.kind === 'measurement') {
                const shipment = get('replica:shipment', req.object_id);
                check(shipment, req.base_version);
                result = createAdminService(db).updateShipment({
                  id: shipment.id,
                  version: shipment.version,
                  parcels: proposal.parcels
                });
                const fee = db
                  .prepare('SELECT * FROM shipment_fees WHERE shipment_id=?')
                  .get(shipment.id);
                if (fee) {
                  const invoice = get('replica:invoice', fee.invoice_id);
                  if (invoice.lifecycle === 'void') fail('关联账单已作废');
                  const correctedBoxes = [
                    ...new Map(
                      result.parcels.map((p, i) => [String(p.number || i + 1), p])
                    ).entries()
                  ].map(([number, p]) => ({
                    sku: number,
                    qty: 1,
                    ...Object.fromEntries(
                      ['weight', 'length', 'width', 'height'].map((k) => [k, p['actual_' + k]])
                    )
                  }));
                  const oldSnapshot = JSON.parse(fee.pricing_snapshot),
                    oldChannel = oldSnapshot.channel;
                  const boxes = correctedBoxes;
                  const revisedQuote = quote(oldChannel, boxes, { maxBoxes: 2000 });
                  safeCents(revisedQuote.estimatedCents);
                  const updated = createFinanceService(db, principal).updateInvoice({
                    id: invoice.id,
                    version: invoice.version,
                    reference: invoice.reference,
                    currency: invoice.currency,
                    invoiceDate: invoice.invoiceDate,
                    dueDate: invoice.dueDate,
                    description: invoice.description,
                    reason: req.reason,
                    lines: invoice.lines.map((line) =>
                      line.reference === 'freight:' + shipment.id
                        ? {
                            ...line,
                            description: '实测更正后运费',
                            amountCents: revisedQuote.estimatedCents
                          }
                        : line
                    )
                  });
                  db.prepare(
                    'UPDATE shipment_fees SET amount_cents=?,pricing_snapshot=?,shipment_version=? WHERE id=?'
                  ).run(
                    revisedQuote.estimatedCents,
                    JSON.stringify({
                      ...oldSnapshot,
                      result: revisedQuote,
                      correctionRequestId: req.id
                    }),
                    result.version,
                    fee.id
                  );
                  result = { shipment: result, invoice: updated };
                }
              }
              if (req.kind === 'invoice_adjustment') {
                const invoice = get('replica:invoice', req.object_id);
                check(invoice, req.base_version);
                result = createFinanceService(db, principal).updateInvoice(proposal);
              }
              if (req.kind === 'invoice_void') {
                const invoice = get('replica:invoice', req.object_id);
                check(invoice, req.base_version);
                if (invoice.allocatedCents || invoice.lifecycle === 'void')
                  fail('账单状态已变化', 409);
                if (
                  db
                    .prepare(
                      "SELECT 1 FROM invoice_shipments l JOIN business_shipments s ON s.id=l.shipment_id WHERE l.invoice_id=? AND s.status IN ('in_transit','delivered')"
                    )
                    .get(invoice.id)
                )
                  fail('运单已出库，不可作废', 409);
                invoiceJournal(db, invoice, invoice, '补记期初应收');
                post(db, {
                  reference: 'void:' + invoice.id,
                  kind: 'invoice_void',
                  customerId: invoice.customer_id,
                  currency: invoice.currency,
                  amountCents: invoice.totalCents,
                  invoiceId: invoice.id,
                  reason: req.reason,
                  debit: 'revenue',
                  credit: 'receivable'
                });
                invoice.lifecycle = 'void';
                invoice.version++;
                invoice.voidReason = req.reason;
                save('replica:invoice', invoice);
                result = invoice;
              }
              if (req.kind === 'refund') {
                if (
                  proposal.amountCents > receiptAvailable(db, proposal.receiptId).availableCents ||
                  proposal.amountCents > creditBalance(db, proposal.customerId, proposal.currency)
                )
                  fail('可退款余额已变化', 409);
                result = post(db, {
                  reference: 'refund:' + proposal.reference,
                  kind: 'refund',
                  customerId: proposal.customerId,
                  currency: proposal.currency,
                  amountCents: proposal.amountCents,
                  sourceId: proposal.receiptId,
                  bankReference: proposal.account + ':' + proposal.bankReference,
                  reason: req.reason,
                  debit: 'customer_credit',
                  credit: 'bank'
                });
              }
            }
          );
        db.prepare(
          'UPDATE commercial_requests SET status=?,version=version+1,reviewer_id=?,note=?,reviewed_at=? WHERE id=?'
        ).run(input.decision, actor(), note, new Date().toISOString(), req.id);
        return {
          request: db.prepare('SELECT * FROM commercial_requests WHERE id=?').get(req.id),
          result
        };
      });
    }
  };
  return service;
}
