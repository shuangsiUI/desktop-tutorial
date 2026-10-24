// Uses the same dialogs, table classes and permission model as the existing client/admin UI.
export async function renderCommercial(kind, container, ctx) {
  const {
    api,
    esc,
    money,
    modal,
    field,
    select,
    textarea,
    actions,
    table,
    hasPermission,
    user,
    customers = []
  } = ctx;
  let page = 1;
  const call = (path, body) => api('commercial/' + path, body),
    choice = () =>
      select(
        'customerId',
        '所属客户',
        customers.filter((c) => c.status === 'active').map((c) => [c.id, c.name]),
        customers[0]?.id
      );
  const refresh = async () => {
    const endpoint =
        kind === 'approvals' ? 'requests' : kind === 'changes' ? 'changes' : 'transactions',
      data = await call(endpoint + '?page=' + page + '&pageSize=30');
    const headers =
      kind === 'approvals'
        ? ['类型', '对象', '申请人', '原因', '状态', '操作']
        : kind === 'changes'
          ? ['时间', '对象', '操作者', '客户', '原因', '变更']
          : ['时间', '类型', '客户', '币种', '金额', '凭证号', '账单 / 来源'];
    container.innerHTML = `<h1>${kind === 'approvals' ? '业务更正与费率审批' : kind === 'changes' ? '变更审计' : '收款、退款与会计流水'}</h1><p class="subtitle">收款和退款须先核实银行流水；系统登记不代替银行付款。</p>${kind === 'ledger' && hasPermission('finance:write') ? '<div class="toolbar"><button id="newReceipt" class="btn btn-green">登记已核实收款</button><button id="newRefund" class="btn">申请退款</button><button id="reverseAllocation" class="btn">撤销核销</button><button id="voidInvoice" class="btn">申请作废账单</button></div>' : ''}${table(
      headers,
      data.items.map((r) =>
        kind === 'approvals'
          ? [
              esc(r.kind),
              esc(r.object_id),
              esc(r.maker_id),
              esc(r.reason),
              esc(r.status),
              `<button data-detail="${esc(r.id)}">详情</button>${r.status === 'pending' && hasPermission('approvals:review') && r.maker_id !== user.id ? `<button data-review="${esc(r.id)}">审核</button>` : ''}`
            ]
          : kind === 'changes'
            ? [
                esc(r.at),
                esc(r.kind + ' ' + r.object_id),
                esc(r.actor_id),
                esc(r.customer_id),
                esc(r.reason),
                `<button data-detail="${esc(r.id)}">前后记录</button>`
              ]
            : [
                esc(r.created_at),
                esc(r.kind),
                esc(customers.find((c) => c.id === r.customer_id)?.name || r.customer_id),
                esc(r.currency),
                money(r.amount_cents),
                esc(r.reference),
                esc(r.invoice_id || r.source_id || '—')
              ]
      )
    )}<div class="pager">共 ${data.total} 条 <button id="commercialPrev" ${page === 1 ? 'disabled' : ''}>上一页</button> ${page} <button id="commercialNext" ${page * 30 >= data.total ? 'disabled' : ''}>下一页</button></div>`;
    container.querySelector('#commercialPrev').onclick = () => {
      page--;
      refresh().catch(ctx.notify);
    };
    container.querySelector('#commercialNext').onclick = () => {
      page++;
      refresh().catch(ctx.notify);
    };
    container.querySelectorAll('[data-detail]').forEach(
      (b) =>
        (b.onclick = () => {
          const row = data.items.find((r) => String(r.id) === b.dataset.detail);
          modal(
            kind === 'changes' ? '变更前后（业务摘要）' : '申请详情',
            `<pre style="white-space:pre-wrap">${esc(JSON.stringify(kind === 'changes' ? { before: JSON.parse(row.before_json || 'null'), after: JSON.parse(row.after_json || 'null') } : { ...row, proposal: JSON.parse(row.proposal) }, null, 2))}</pre>`
          );
        })
    );
    container.querySelectorAll('[data-review]').forEach(
      (b) =>
        (b.onclick = () => {
          const row = data.items.find((r) => r.id === b.dataset.review);
          modal(
            '业务申请审核',
            `<p>${esc(row.kind)}：${esc(row.reason)}</p><pre style="white-space:pre-wrap">${esc(JSON.stringify(JSON.parse(row.proposal), null, 2))}</pre>${select(
              'decision',
              '审核结果',
              [
                ['approved', '同意'],
                ['rejected', '拒绝']
              ],
              'approved'
            )}${textarea('note', '审核说明')}${actions('确认审核')}`,
            async (data) => {
              await call('review', {
                id: row.id,
                version: row.version,
                decision: data.decision,
                note: data.note
              });
              await refresh();
            }
          );
        })
    );
    if (container.querySelector('#newReceipt'))
      container.querySelector('#newReceipt').onclick = () =>
        modal(
          '登记已到账收款',
          `<div class="fields">${choice()}${field('currency', '币种', 'CNY', 'text', true)}${field('amount', '到账金额', '', 'text', true)}${field('reference', '唯一收款参考号', '', 'text', true)}${field('account', '收款银行账户标识', '', 'text', true)}${field('bankReference', '银行到账流水号', '', 'text', true)}${textarea('reason', '核实凭据和说明')}</div>${actions('确认登记')}`,
          async (data) => {
            const { amount, ...body } = data;
            await call('receipt', {
              ...body,
              currency: data.currency.toUpperCase(),
              amountCents: ctx.cents(amount)
            });
            await refresh();
          }
        );
    if (container.querySelector('#newRefund'))
      container.querySelector('#newRefund').onclick = () =>
        modal(
          '申请已核实退款',
          `<div class="fields">${choice()}${field('currency', '币种', 'CNY', 'text', true)}${field('receiptId', '原收款ID', '', 'text', true)}${field('amount', '退款金额', '', 'text', true)}${field('reference', '唯一退款参考号', '', 'text', true)}${field('account', '付款银行账户标识', '', 'text', true)}${field('bankReference', '银行付款流水号', '', 'text', true)}${textarea('reason', '退款原因及核实说明')}</div><p>需要另一名管理员复核；登记不触发银行转账。</p>${actions('提交审核')}`,
          async (data) => {
            const { amount, ...body } = data;
            await call('refund/request', {
              ...body,
              currency: data.currency.toUpperCase(),
              amountCents: ctx.cents(amount)
            });
            await refresh();
          }
        );
    if (container.querySelector('#reverseAllocation'))
      container.querySelector('#reverseAllocation').onclick = () =>
        modal(
          '撤销原核销',
          `<div class="fields">${field('id', '原核销ID', '', 'text', true)}${field('version', '账单当前版本', '', 'number', true)}${textarea('reason', '撤销原因')}</div><p>原流水保留，新增反向凭证，账单重新形成应收。</p>${actions('撤销核销')}`,
          async (data) => {
            await call('allocation/reverse', { ...data, version: Number(data.version) });
            await refresh();
          }
        );
    if (container.querySelector('#voidInvoice'))
      container.querySelector('#voidInvoice').onclick = () =>
        modal(
          '申请账单整单冲销',
          `${field('invoiceId', '账单ID', '', 'text', true)}${field('version', '账单当前版本', '', 'number', true)}${textarea('reason', '作废原因')}${actions('提交审核')}`,
          async (data) => {
            await call('invoice/void', { ...data, version: Number(data.version) });
            await refresh();
          }
        );
  };
  await refresh();
}
