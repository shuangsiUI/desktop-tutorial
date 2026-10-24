import { openInvoiceEditor } from './invoice-editor.js';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const money = (cents) => {
  if (!Number.isSafeInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const s = String(Math.abs(cents)).padStart(3, '0');
  return sign + s.slice(0, -2) + '.' + s.slice(-2);
};
const decimal = (value) =>
  value === null || value === undefined || value === '' ? '—' : esc(value);
const invoiceColumns = [
  ['number', '账单号'],
  ['currency', '币种'],
  ['total_charge', '流水总额'],
  ['paid_charge', '已核销'],
  ['remaining_charge', '余款'],
  ['status', '状态'],
  ['description', '描述'],
  ['invoice_date', '账单日期'],
  ['due_date', '到期时间']
];
const accountColumns = [
  ['name', '账户名称'],
  ['currency', '币种'],
  ['balance', '余额'],
  ['unpay', '欠款'],
  ['actual_balance', '实际金额']
];
const rechargeColumns = [
  ['number', '充值记录'],
  ['currency', '币种'],
  ['amount', '金额'],
  ['created', '时间']
];
const stateLabel = (v) =>
  Number(v) === 4
    ? '已作废'
    : Number(v) === 3
      ? '已核销'
      : Number(v) === 2
        ? '待核销'
        : String(v ?? '—');
export function filterFinanceInvoices(rows, query = {}) {
  const shipments = String(query.shipment_id || '')
    .split(/[,，\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (shipments.length > 10) throw Error('运单号最多支持 10 个');
  return rows.filter(
    (row) =>
      (!query.number || String(row.number || row.reference || '').includes(query.number.trim())) &&
      (!query.status || query.status === 'all' || String(row.status) === query.status) &&
      (!query.from ||
        String(row.invoice_date || row.invoiceDate || '').slice(0, 10) >= query.from) &&
      (!query.to || String(row.invoice_date || row.invoiceDate || '').slice(0, 10) <= query.to) &&
      (!shipments.length ||
        shipments.some((term) =>
          (row.lines || []).some((line) =>
            [line.shipmentId, line.shipmentNumber, line.reference].some((v) =>
              String(v || '').includes(term)
            )
          )
        ))
  );
}
export async function renderFinance(key, container, ctx) {
  key = key === 'recharge_records' ? 'recharge' : key;
  if (['account', 'recharge'].includes(key)) {
    await renderLedgerAccount(container, ctx);
    return;
  }
  const overview = await ctx.api('/api/replica/finance');
  const revisionResult = await ctx.api('/api/replica/revisions?page=1&pageSize=100');
  const revisionRows = revisionResult.items;
  let rows = [],
    shipmentNumbers = new Map(),
    drawRequest = 0;
  let query = {},
    selected = new Set(),
    page = 1,
    size = 30;
  const columns =
    key === 'account' ? accountColumns : key === 'recharge' ? rechargeColumns : invoiceColumns;
  const value = (row, name) =>
    name === 'status'
      ? stateLabel(row.status)
      : (row[name] ?? (name === 'number' ? row.reference : undefined));
  const rowCells = (row) => columns.map(([name]) => value(row, name));
  async function detail(id) {
    try {
      const row = await ctx.api('/api/replica/invoice/' + encodeURIComponent(id));
      row.lines = (row.lines || []).map((line) => ({
        ...line,
        shipmentNumber: line.shipmentNumber || shipmentNumbers.get(line.shipmentId)
      }));
      ctx.openDialog(
        '账单明细',
        `<div class="table-tools"><button type="button" class="btn btn-grey" id="editClientInvoice">${ctx.user?.role === 'customer' ? '申请修改账单' : '修改账单'}</button></div><table class="data-table">${invoiceColumns.map(([name, title]) => `<tr><th>${title}</th><td>${decimal(value(row, name))}</td></tr>`).join('')}</table><h3>费用明细</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>运单号 / ID</th><th>明细参考号</th><th>描述</th><th>金额 (${esc(row.currency)})</th></tr></thead><tbody>${(row.lines || []).length ? row.lines.map((line) => `<tr><td>${esc(line.shipmentNumber || line.shipmentId || '—')}</td><td>${esc(line.reference)}</td><td>${esc(line.description)}</td><td>${money(line.amountCents)}</td></tr>`).join('') : '<tr><td colspan="4"><div class="empty">暂无数据</div></td></tr>'}</tbody></table></div><h3>本地核销记录</h3><table class="data-table"><thead><tr><th>参考号</th><th>币种</th><th>已核销金额</th><th>记录时间</th></tr></thead><tbody>${row.allocations?.length ? row.allocations.map((a) => `<tr><td>${esc(a.reference)}</td><td>${esc(a.currency)}</td><td>${money(a.amountCents)}</td><td>${esc(a.created)}</td></tr>`).join('') : '<tr><td colspan="4"><div class="empty">暂无数据</div></td></tr>'}</tbody></table>`
      );
      if (row.revisions?.length) {
        const form = document.getElementById('replicaForm');
        form.insertAdjacentHTML(
          'beforeend',
          `<h3>账单修改记录</h3><table class="data-table"><thead><tr><th>修改时间</th><th>修改原因</th><th>原版本</th><th>原总额</th></tr></thead><tbody>${row.revisions
            .slice()
            .reverse()
            .map(
              (rev) =>
                `<tr><td>${esc(rev.at)}</td><td>${esc(rev.reason)}</td><td>${esc(rev.before.version)}</td><td>${esc(rev.before.currency)} ${money(rev.before.totalCents)}</td></tr>`
            )
            .join('')}</tbody></table>`
        );
      }
      const requests = revisionRows.filter((request) => request.invoiceId === row.id);
      if (requests.length)
        document
          .getElementById('replicaForm')
          .insertAdjacentHTML(
            'beforeend',
            `<h3>账单修改申请</h3><table class="data-table"><thead><tr><th>申请时间</th><th>原因</th><th>状态</th><th>审核说明</th></tr></thead><tbody>${requests.map((request) => `<tr><td>${esc(request.created)}</td><td>${esc(request.input.reason)}</td><td>${esc({ pending: '待审核', approved: '已通过', rejected: '已拒绝' }[request.status])}</td><td>${esc(request.note || '—')}</td></tr>`).join('')}</tbody></table>`
          );
      document.getElementById('editClientInvoice').hidden = row.lifecycle === 'void';
      document.getElementById('editClientInvoice').onclick = () =>
        openInvoiceEditor(ctx, row, { onSaved: () => renderFinance(key, container, ctx) });
    } catch (error) {
      ctx.notify(error.message);
    }
  }
  async function download() {
    if (!selected.size) {
      ctx.notify('请先选择账单');
      return;
    }
    if (!window.XLSX) {
      ctx.notify('Excel组件未加载');
      return;
    }
    try {
      const chosen = rows.filter((row) => selected.has(row.id));
      const details = await Promise.all(
        chosen.map((row) => ctx.api('/api/replica/invoice/' + encodeURIComponent(row.id)))
      );
      const book = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(
        book,
        window.XLSX.utils.aoa_to_sheet([invoiceColumns.map((c) => c[1]), ...details.map(rowCells)]),
        '账单'
      );
      const lines = [['账单号', '币种', '运单号 / ID', '明细参考号', '描述', '金额']];
      for (const row of details)
        for (const line of row.lines || [])
          lines.push([
            row.number || row.reference,
            row.currency,
            line.shipmentNumber || shipmentNumbers.get(line.shipmentId) || line.shipmentId || '',
            line.reference,
            line.description,
            money(line.amountCents)
          ]);
      window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet(lines), '费用明细');
      const allocated = [['账单号', '参考号', '币种', '已核销金额', '记录时间']];
      for (const row of details)
        for (const a of row.allocations || [])
          allocated.push([
            row.number || row.reference,
            a.reference,
            a.currency,
            money(a.amountCents),
            a.created
          ]);
      window.XLSX.utils.book_append_sheet(
        book,
        window.XLSX.utils.aoa_to_sheet(allocated),
        '本地核销记录'
      );
      window.XLSX.writeFile(book, '本地账单.xlsx');
    } catch (error) {
      ctx.notify(error.message);
    }
  }
  async function draw() {
    const request = ++drawRequest;
    let result;
    try {
      result = await ctx.api(
        '/api/replica/invoice?' +
          new URLSearchParams({
            page: String(page),
            pageSize: String(size),
            filter: JSON.stringify(query)
          })
      );
    } catch (e) {
      ctx.notify(e.message);
      return;
    }
    if (request !== drawRequest) return;
    rows = result.items;
    const found = rows,
      total = result.total;
    const pages = Math.max(1, Math.ceil(total / size));
    page = result.page;
    const subset = found;
    const groups = overview.byCurrency || [];
    const grouped = (field) =>
      groups.length ? groups.map((g) => `${esc(g.currency)} ${money(g[field])}`).join('<br>') : '—';
    container.innerHTML = `<div class="finance-nav">${[
      ['invoice', '账单'],
      ['recharge', '充值记录'],
      ['account', '账户']
    ]
      .map(
        ([k, title]) =>
          `<button type="button" class="${key === k ? 'active' : ''}" data-finance="${k}">${title}</button>`
      )
      .join(
        ''
      )}</div><div class="finance-cards"><div class="finance-card"><strong>${decimal(overview.balance)}</strong>余额</div><div class="finance-card"><strong>${grouped('remainingCents')}</strong>待核销欠款</div><div class="finance-card"><strong>—</strong>待付账单</div><div class="finance-card"><strong>—</strong>待出账单</div></div>${groups.length ? `<div class="finance-local-totals">${groups.map((g) => `<p>${esc(g.currency)}：本地总额 ${money(g.totalCents)}　已核销 ${money(g.allocatedCents)}　余款 ${money(g.remainingCents)}</p>`).join('')}</div>` : ''}${key === 'invoice' ? `<form class="search-area" id="financeSearch"><div class="search-fields"><label class="field"><span>账单号</span><input name="number" value="${esc(query.number)}"></label><label class="field"><span>运单号</span><input name="shipment_id" value="${esc(query.shipment_id)}" placeholder="多个运单号用“,”隔开，最多支持10个"></label><label class="field"><span>状态</span><select name="status"><option value="all">全部</option><option value="2" ${query.status === '2' ? 'selected' : ''}>待核销</option><option value="3" ${query.status === '3' ? 'selected' : ''}>已核销</option></select></label><label class="field"><span>账单日期</span><div class="date-pair"><input type="date" name="from" value="${esc(query.from)}">→<input type="date" name="to" value="${esc(query.to)}"></div></label></div><div><button class="btn btn-green" type="submit">搜索</button><button class="btn btn-grey" type="reset">重置</button></div></form><div class="table-tools"><button class="btn btn-grey" type="button" id="downloadInvoices">下载账单</button></div>` : ''}<div class="table-wrap"><table class="data-table"><thead><tr>${key === 'invoice' ? '<th><input type="checkbox" id="financeSelectAll" aria-label="选择本页"></th>' : ''}${columns.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${subset.length ? subset.map((row) => `<tr>${key === 'invoice' ? `<td><input type="checkbox" data-finance-select="${esc(row.id)}" ${selected.has(row.id) ? 'checked' : ''} aria-label="选择账单"></td>` : ''}${columns.map(([name]) => `<td>${key === 'invoice' && name === 'number' ? `<button class="table-link" type="button" data-invoice="${esc(row.id)}">${esc(value(row, name))}</button>` : decimal(value(row, name))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length + (key === 'invoice' ? 1 : 0)}"><div class="empty"><span class="empty-symbol"></span>暂无数据</div></td></tr>`}</tbody></table></div>${total ? `<div class="pagination"><span>共 ${total} 条</span><button class="btn" id="financePrev" ${page === 1 ? 'disabled' : ''}>‹</button><span>${page} / ${pages}</span><button class="btn" id="financeNext" ${page === pages ? 'disabled' : ''}>›</button><select id="financeSize">${[10, 30, 50, 100].map((n) => `<option ${n === size ? 'selected' : ''}>${n}</option>`).join('')}</select>条/页</div>` : ''}`;
    container
      .querySelectorAll('[data-finance]')
      .forEach((b) => (b.onclick = () => ctx.navigate(b.dataset.finance)));
    container.querySelector('#financeSearch')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = Object.fromEntries(new FormData(e.currentTarget));
      try {
        filterFinanceInvoices(rows, next);
        if (next.from && next.to && next.from > next.to)
          throw Error('账单日期起始时间不能晚于结束时间');
        query = next;
        page = 1;
        selected.clear();
        draw();
      } catch (error) {
        ctx.notify(error.message);
      }
    });
    container.querySelector('#financeSearch')?.addEventListener('reset', (e) => {
      e.preventDefault();
      query = {};
      page = 1;
      selected.clear();
      draw();
    });
    container.querySelectorAll('[data-finance-select]').forEach(
      (b) =>
        (b.onchange = () => {
          b.checked
            ? selected.add(b.dataset.financeSelect)
            : selected.delete(b.dataset.financeSelect);
        })
    );
    const all = container.querySelector('#financeSelectAll');
    if (all) {
      all.checked = !!subset.length && subset.every((r) => selected.has(r.id));
      all.onchange = () => {
        subset.forEach((r) => (all.checked ? selected.add(r.id) : selected.delete(r.id)));
        draw();
      };
    }
    container
      .querySelectorAll('[data-invoice]')
      .forEach((b) => (b.onclick = () => detail(b.dataset.invoice)));
    container.querySelector('#downloadInvoices')?.addEventListener('click', download);
    container.querySelector('#financePrev')?.addEventListener('click', () => {
      page--;
      selected.clear();
      draw();
    });
    container.querySelector('#financeNext')?.addEventListener('click', () => {
      page++;
      selected.clear();
      draw();
    });
    container.querySelector('#financeSize')?.addEventListener('change', (e) => {
      size = Number(e.target.value);
      page = 1;
      draw();
    });
  }
  await draw();
}

async function renderLedgerAccount(container, ctx) {
  let page = 1;
  async function draw() {
    const [accounts, ledger] = await Promise.all([
      ctx.api('/api/replica/ledger/accounts'),
      ctx.api('/api/replica/ledger/transactions?page=' + page + '&pageSize=30')
    ]);
    container.innerHTML = `<h2>账户与收付款记录</h2><p class="subtitle">金额按币种独立核算，银行流水由财务核实后登记。</p><div class="table-wrap"><table class="data-table"><thead><tr><th>币种</th><th>未分配收款余额</th><th>未收应收</th></tr></thead><tbody>${accounts.map((a) => `<tr><td>${esc(a.currency)}</td><td>${money(a.availableCents)}</td><td>${money(a.receivableCents)}</td></tr>`).join('') || '<tr><td colspan="3">暂无账户流水</td></tr>'}</tbody></table></div><h3>凭证记录</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>类型</th><th>凭证号</th><th>币种</th><th>金额</th></tr></thead><tbody>${ledger.items.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.kind)}</td><td>${esc(r.reference)}</td><td>${esc(r.currency)}</td><td>${money(r.amount_cents)}</td></tr>`).join('') || '<tr><td colspan="5">暂无数据</td></tr>'}</tbody></table></div><div class="pagination">共 ${ledger.total} 条 <button id="ledgerPrev" class="btn" ${page === 1 ? 'disabled' : ''}>上一页</button> ${page} <button id="ledgerNext" class="btn" ${page * 30 >= ledger.total ? 'disabled' : ''}>下一页</button></div>`;
    container.querySelector('#ledgerPrev').onclick = () => {
      page--;
      draw().catch((e) => ctx.notify(e.message));
    };
    container.querySelector('#ledgerNext').onclick = () => {
      page++;
      draw().catch((e) => ctx.notify(e.message));
    };
  }
  await draw();
}
