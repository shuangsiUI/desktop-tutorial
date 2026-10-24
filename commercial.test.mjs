import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './backend/persistence/database.mjs';
import { createAdminService } from './backend/modules/operations/service.mjs';
import { createFinanceService } from './backend/modules/finance/service.mjs';
import { createShipmentService } from './backend/modules/shipments/service.mjs';
import { createCommercialService } from './backend/modules/commercial/service.mjs';
import { requestContext } from './backend/persistence/context.mjs';
import { creditBalance } from './backend/modules/commercial/ledger.mjs';
import { inspectIntegrity } from './backend/operations/integrity.mjs';
const maker = { id: 'maker', role: 'finance' },
  reviewer = { id: 'reviewer', role: 'admin' },
  operator = { id: 'operator', role: 'operator' };
function setup(settlement = 'prepaid', creditCents = 0) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const admin = createAdminService(db),
    finance = createFinanceService(db, maker),
    commercial = createCommercialService(db, maker),
    approve = createCommercialService(db, reviewer);
  const customer = admin.saveCustomer({
    name: 'Customer',
    status: 'active',
    currency: 'USD',
    settlement,
    creditCents
  });
  const channel = admin.saveChannel({
    code: 'C',
    name: 'Channel',
    carrier: 'Carrier',
    country: 'US',
    transport: 'air',
    currency: 'USD',
    rateCents: 100,
    fixedCents: 0,
    minimum: 1,
    divisor: 6000,
    step: 1,
    status: 'active'
  });
  const pricing = commercial.requestPricing({
    channelId: channel.id,
    version: 1,
    rateCents: 100,
    fixedCents: 0,
    minimum: 1,
    divisor: 6000,
    step: 1,
    reason: '初始报价审核'
  });
  approve.review({ id: pricing.id, version: 1, decision: 'approved', note: '核对合同同意' });
  const shipment = {
    id: 'S',
    customer_id: customer.id,
    channel_id: channel.id,
    status: 'ready',
    country: 'US',
    version: 1,
    tracking: [],
    outer_carrier: 'TRACK',
    actual_weight: 10,
    parcels: [
      { number: '1', actual_weight: 10, actual_length: 10, actual_width: 10, actual_height: 10 }
    ]
  };
  db.prepare('INSERT INTO records VALUES(?,?,?)').run(
    shipment.id,
    'replica:shipment',
    JSON.stringify(shipment)
  );
  return {
    db,
    admin,
    finance,
    commercial,
    approve,
    customer,
    channel,
    shipment,
    shipments: createShipmentService(db, operator)
  };
}
const receipt = (ctx, amountCents = 1000, reference = 'R') =>
  ctx.commercial.receipt({
    customerId: ctx.customer.id,
    currency: 'USD',
    amountCents,
    reference,
    account: 'Bank-1',
    bankReference: reference,
    reason: '银行到账人工核实'
  });
const generate = (ctx) =>
  ctx.commercial.generateInvoice({ shipmentId: 'S', version: 1, reference: 'INV' });
test('归属在服务和数据库双层不可转移，关联账单保持一致', () => {
  const c = setup();
  try {
    const b = c.admin.saveCustomer({ name: 'Other', status: 'active' });
    const invoice = generate(c);
    assert.throws(
      () => c.admin.updateShipment({ id: 'S', version: 1, customerId: b.id }),
      /不能直接转移/
    );
    const doc = { ...c.shipment, customer_id: b.id };
    assert.throws(
      () => c.db.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify(doc), 'S'),
      /不能直接转移/
    );
    assert.equal(c.finance.invoice(invoice.id).customer_id, c.customer.id);
    assert.throws(() => c.db.prepare('DELETE FROM records WHERE id=?').run('S'), /FOREIGN KEY/);
  } finally {
    c.db.close();
  }
});
test('新渠道待审核，制单人与审核人分离，历史费率保持快照', () => {
  const c = setup();
  try {
    const inv = generate(c);
    const req = c.commercial.requestPricing({
      channelId: c.channel.id,
      version: 2,
      rateCents: 200,
      fixedCents: 0,
      minimum: 1,
      divisor: 6000,
      step: 1,
      reason: '新价格'
    });
    assert.throws(
      () =>
        createCommercialService(c.db, { ...maker, role: 'admin' }).review({
          id: req.id,
          version: 1,
          decision: 'approved',
          note: '自审'
        }),
      /必须不同/
    );
    c.approve.review({ id: req.id, version: 1, decision: 'approved', note: '复核同意' });
    assert.equal(c.finance.invoice(inv.id).totalCents, 1000);
    assert.equal(
      JSON.parse(c.db.prepare('SELECT pricing_snapshot FROM shipment_fees').get().pricing_snapshot)
        .channel.rateCents,
      100
    );
    assert.throws(
      () => c.admin.saveChannel({ ...c.admin.channels()[0], created: undefined }),
      /字段/
    );
    assert.throws(
      () => createCommercialService(c.db, operator).receipt({}),
      (e) => e.status === 403
    );
  } finally {
    c.db.close();
  }
});
test('收款、核销、撤销、退款、作废、取消完整闭环且不可双花', () => {
  const c = setup();
  try {
    const inv = generate(c),
      r = receipt(c);
    assert.equal(receipt(c).id, r.id);
    assert.throws(
      () =>
        c.commercial.receipt({
          customerId: c.customer.id,
          currency: 'USD',
          amountCents: 1,
          reference: 'duplicate-bank',
          account: 'Bank-1',
          bankReference: 'R',
          reason: '同一流水重复录入'
        }),
      /UNIQUE/
    );
    const allocation = c.finance.recordAllocation({
      invoiceId: inv.id,
      version: 1,
      amountCents: 1000,
      reference: 'ALLOC',
      receiptId: r.id
    });
    assert.equal(creditBalance(c.db, c.customer.id, 'USD'), 0);
    assert.throws(
      () => c.shipments.action({ ids: ['S'], versions: { S: 1 }, action: 'cancelled' }),
      /已有账单/
    );
    assert.throws(
      () =>
        c.finance.recordAllocation({
          invoiceId: inv.id,
          version: 2,
          amountCents: 1,
          reference: 'TOO',
          receiptId: r.id
        }),
      /超过/
    );
    c.commercial.reverseAllocation({
      id: allocation.allocation.id,
      version: 2,
      reference: 'REV',
      reason: '客户取消'
    });
    assert.equal(c.finance.invoice(inv.id).allocatedCents, 0);
    const refund = c.commercial.requestRefund({
      customerId: c.customer.id,
      currency: 'USD',
      amountCents: 1000,
      receiptId: r.id,
      reference: 'REF',
      account: 'Bank-1',
      bankReference: 'OUT-1',
      reason: '取消退还预付款'
    });
    c.approve.review({ id: refund.id, version: 1, decision: 'approved', note: '确认退款已支付' });
    assert.equal(creditBalance(c.db, c.customer.id, 'USD'), 0);
    const voidReq = c.commercial.requestVoid({ invoiceId: inv.id, version: 3, reason: '取消账单' });
    c.approve.review({ id: voidReq.id, version: 1, decision: 'approved', note: '同意整单冲销' });
    assert.equal(c.finance.invoice(inv.id).remainingCents, 0);
    assert.equal(
      c.shipments.action({ ids: ['S'], versions: { S: 1 }, action: 'cancelled' })[0].status,
      'cancelled'
    );
    assert.equal(c.commercial.accounts()[0].receivableCents, 0);
    assert.equal(
      c.db.prepare("SELECT count(*) n FROM ledger_transactions WHERE status='draft'").get().n,
      0
    );
    assert.throws(() => c.db.prepare('UPDATE ledger_lines SET debit_cents=1').run(), /不可修改/);
  } finally {
    c.db.close();
  }
});
test('出库强制报价、实测、预付及承运单号；放行检查留痕', () => {
  const c = setup();
  try {
    c.shipments.action({ ids: ['S'], versions: { S: 1 }, action: 'picked' });
    assert.throws(
      () => c.shipments.action({ ids: ['S'], versions: { S: 2 }, action: 'in_transit' }),
      /生成账单/
    );
    const inv = c.commercial.generateInvoice({ shipmentId: 'S', version: 2, reference: 'INV' });
    assert.throws(
      () => c.shipments.action({ ids: ['S'], versions: { S: 2 }, action: 'in_transit' }),
      /付清/
    );
    const r = receipt(c);
    c.finance.recordAllocation({
      invoiceId: inv.id,
      version: 1,
      amountCents: 1000,
      reference: 'A',
      receiptId: r.id
    });
    const out = c.shipments.action({ ids: ['S'], versions: { S: 2 }, action: 'in_transit' })[0];
    assert.equal(out.releaseCheck.invoiceId, inv.id);
    assert.throws(
      () =>
        c.admin.updateShipment({
          id: 'S',
          version: 3,
          parcels: [{ number: '1', weight: 20, length: 10, width: 10, height: 10 }]
        }),
      /锁定/
    );
  } finally {
    c.db.close();
  }
});
test('月结信用不足与逾期阻断放货，失败无部分状态更新', () => {
  const c = setup('monthly', 999);
  try {
    const inv = generate(c);
    c.shipments.action({ ids: ['S'], versions: { S: 1 }, action: 'picked' });
    assert.throws(
      () => c.shipments.action({ ids: ['S'], versions: { S: 2 }, action: 'in_transit' }),
      /信用额度/
    );
    c.admin.saveCustomer({
      name: 'Customer',
      status: 'active',
      id: c.customer.id,
      version: 1,
      currency: 'USD',
      settlement: 'monthly',
      creditCents: 1000
    });
    c.finance.importInvoice({
      reference: 'OVERDUE',
      customerId: c.customer.id,
      currency: 'USD',
      invoiceDate: '2020-01-01',
      dueDate: '2020-01-02',
      lines: [{ reference: 'O', amountCents: 1 }]
    });
    assert.throws(
      () => c.shipments.action({ ids: ['S'], versions: { S: 2 }, action: 'in_transit' }),
      /逾期/
    );
    assert.equal(c.admin.shipments()[0].status, 'picked');
    assert.equal(c.finance.invoice(inv.id).allocatedCents, 0);
  } finally {
    c.db.close();
  }
});
test('锁定实测双人更正采用历史费率并同步应收；重复审核无效', () => {
  const c = setup();
  try {
    generate(c);
    const req = createCommercialService(c.db, operator).requestMeasurement({
      shipmentId: 'S',
      version: 1,
      parcels: [{ number: '1', weight: 20, length: 10, width: 10, height: 10 }],
      reason: '复磅确认'
    });
    assert.equal(c.admin.shipments()[0].actual_weight, 10);
    const result = c.approve.review({
      id: req.id,
      version: 1,
      decision: 'approved',
      note: '复磅单复核通过'
    });
    assert.equal(result.result.invoice.totalCents, 2000);
    assert.equal(result.result.shipment.actual_weight, 20);
    assert.equal(c.commercial.accounts()[0].receivableCents, 2000);
    assert.throws(
      () => c.approve.review({ id: req.id, version: 2, decision: 'approved', note: '重复' }),
      /已处理/
    );
  } finally {
    c.db.close();
  }
});
test('更正低于已核销金额整体回滚，申请仍待审', () => {
  const c = setup();
  try {
    const inv = generate(c),
      r = receipt(c);
    c.finance.recordAllocation({
      invoiceId: inv.id,
      version: 1,
      amountCents: 1000,
      receiptId: r.id,
      reference: 'A'
    });
    const req = createCommercialService(c.db, operator).requestMeasurement({
      shipmentId: 'S',
      version: 1,
      parcels: [{ number: '1', weight: 1, length: 10, width: 10, height: 10 }],
      reason: '重量下降'
    });
    assert.throws(
      () => c.approve.review({ id: req.id, version: 1, decision: 'approved', note: '尝试更正' }),
      /低于/
    );
    assert.equal(c.admin.shipments()[0].actual_weight, 10);
    assert.equal(c.approve.requests().items.find((r) => r.id === req.id).status, 'pending');
    assert.equal(c.finance.invoice(inv.id).totalCents, 1000);
  } finally {
    c.db.close();
  }
});
test('客户账户与流水隔离、分页有界、审计记录员工及目标客户', () => {
  const c = setup();
  try {
    generate(c);
    receipt(c);
    const own = createCommercialService(c.db, {
        id: 'customer',
        role: 'customer',
        customerId: c.customer.id
      }),
      other = createCommercialService(c.db, {
        id: 'other',
        role: 'customer',
        customerId: 'unknown'
      });
    assert.equal(own.accounts().length, 1);
    assert.equal(other.transactions().total, 0);
    assert.throws(
      () => own.requests(),
      (e) => e.status === 403
    );
    assert.throws(() => c.commercial.transactions({ pageSize: 101 }), /分页/);
    const changes = c.approve.changes().items;
    assert(changes.some((r) => r.customer_id === c.customer.id));
    requestContext.run({ principal: operator, requestId: 'audit-test', reason: '核对单号' }, () =>
      c.admin.updateShipment({ id: 'S', version: 1, outer_carrier: 'NEW' })
    );
    const audit = c.db.prepare('SELECT * FROM record_changes ORDER BY id DESC LIMIT 1').get();
    assert.equal(audit.actor_id, operator.id);
    assert.equal(audit.customer_id, c.customer.id);
    assert.equal(audit.reason, '核对单号');
    assert(audit.before_json && audit.after_json);
  } finally {
    c.db.close();
  }
});
test('自动费用的客户异议和财务调整须审核，并同步会计应收', () => {
  const c = setup();
  try {
    const inv = generate(c),
      input = {
        id: inv.id,
        version: 1,
        reference: inv.reference,
        currency: 'USD',
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        description: '费用核对',
        lines: [{ shipmentId: 'S', reference: 'freight:S', amountCents: 900 }],
        reason: '合同折扣核对'
      };
    assert.throws(() => c.finance.updateInvoice(input), /更正审批/);
    const client = createFinanceService(c.db, {
        id: 'client',
        role: 'customer',
        customerId: c.customer.id
      }),
      request = client.requestRevision(input);
    const accepted = c.finance.reviewRevision({
      id: request.id,
      version: 1,
      decision: 'approved',
      note: '核对折扣同意'
    });
    assert.equal(accepted.invoice.totalCents, 900);
    const adjustment = c.commercial.requestAdjustment({
      ...input,
      version: 2,
      lines: [{ shipmentId: 'S', reference: 'freight:S', amountCents: 950 }],
      reason: '补充确认差额'
    });
    c.approve.review({
      id: adjustment.id,
      version: 1,
      decision: 'approved',
      note: '另一人复核同意'
    });
    assert.equal(c.commercial.accounts()[0].receivableCents, 950);
    assert.equal(inspectIntegrity(c.db).ok, true);
  } finally {
    c.db.close();
  }
});
test('退款必须关联原收款，竞争审核不能透支同一笔到账', () => {
  const c = setup();
  try {
    const r = receipt(c),
      data = {
        customerId: c.customer.id,
        currency: 'USD',
        amountCents: 600,
        receiptId: r.id,
        account: 'Bank-1',
        reason: '按原收款退款'
      };
    assert.throws(
      () =>
        c.commercial.requestRefund({
          ...data,
          receiptId: 'not-found',
          reference: 'BAD',
          bankReference: 'BAD'
        }),
      /收款不存在/
    );
    const a = c.commercial.requestRefund({ ...data, reference: 'REF-A', bankReference: 'OUT-A' }),
      b = c.commercial.requestRefund({ ...data, reference: 'REF-B', bankReference: 'OUT-B' });
    c.approve.review({ id: a.id, version: 1, decision: 'approved', note: '确认A退款' });
    assert.throws(
      () => c.approve.review({ id: b.id, version: 1, decision: 'approved', note: '确认B退款' }),
      /余额已变化/
    );
    assert.equal(c.approve.requests().items.find((r) => r.id === b.id).status, 'pending');
    assert.equal(creditBalance(c.db, c.customer.id, 'USD'), 400);
    assert.equal(inspectIntegrity(c.db).ok, true);
  } finally {
    c.db.close();
  }
});
test('历史应收迁移只建立期初未收，不虚构银行收款', () => {
  const c = setup();
  try {
    const row = {
      id: 'OLD',
      reference: 'OLD-INV',
      customer_id: c.customer.id,
      currency: 'USD',
      totalCents: 1000,
      allocatedCents: 500,
      version: 1,
      lines: []
    };
    c.db
      .prepare('INSERT INTO records VALUES(?,?,?)')
      .run(row.id, 'replica:invoice', JSON.stringify(row));
    migrate(c.db);
    const tx = c.db.prepare('SELECT * FROM ledger_transactions WHERE invoice_id=?').get(row.id);
    assert.equal(tx.kind, 'opening_receivable');
    assert.equal(tx.amount_cents, 500);
    assert.equal(
      c.db.prepare("SELECT count(*) n FROM ledger_lines WHERE account='bank'").get().n,
      0
    );
    assert.equal(inspectIntegrity(c.db).ok, true);
    migrate(c.db);
    assert.equal(
      c.db.prepare('SELECT count(*) n FROM ledger_transactions WHERE invoice_id=?').get(row.id).n,
      1
    );
  } finally {
    c.db.close();
  }
});
