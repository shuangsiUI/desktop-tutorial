import { renderCommercial } from './commercial-ui.js';
import { session, apiFetch, hasPermission, logout, accountDialog } from './auth-client.js';
import { openInvoiceEditor, parseMoney } from './invoice-editor.js';
import { flattenFields, renderModule } from './replica-modules.js';
const configuration = await apiFetch('/replica-config.json').then((r) => r.json());
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
const allNames = {
  operations: '运行与备份状态',
  ledger: '收款与退款',
  approvals: '业务更正审批',
  changes: '变更审计',
  overview: '经营概览',
  shipments: '运单管理',
  customers: '客户管理',
  channels: '渠道管理',
  services: '服务管理',
  booking: '预约取件',
  cabin: '舱位申请',
  invoices: '账单管理',
  audit: '操作日志',
  users: '账号权限',
  revisions: '账单修改审核',
  address: '地址库',
  product: '产品库',
  vat: 'VAT管理',
  store: '店铺管理'
};
const menuPermissions = {
  operations: 'system:read',
  ledger: 'finance:read',
  approvals: 'approvals:read',
  changes: 'system:read',
  overview: 'dashboard:read',
  shipments: 'shipments:read',
  customers: 'customers:read',
  channels: 'channels:read',
  services: 'services:read',
  booking: 'bookings:read',
  cabin: 'bookings:read',
  invoices: 'finance:read',
  revisions: 'finance:read',
  audit: 'system:read',
  users: 'users:manage',
  address: 'catalog:read',
  product: 'catalog:read',
  vat: 'catalog:read',
  store: 'catalog:read'
};
const names = Object.fromEntries(
  Object.entries(allNames).filter(([key]) => hasPermission(menuPermissions[key]))
);
const states = {
  ready: '已下单',
  picked: '已收货',
  in_transit: '转运中',
  delivered: '已签收',
  returned: '退件',
  cancelled: '已取消',
  apply: '申请中',
  cancel: '已取消',
  active: '启用',
  disabled: '停用'
};
const transitions = {
  ready: ['picked', 'cancelled'],
  picked: ['in_transit', 'returned'],
  in_transit: ['delivered', 'returned']
};
let pageData = null;
const pagedModules = new Set([
  'shipments',
  'customers',
  'channels',
  'invoices',
  'revisions',
  'booking',
  'cabin'
]);
const reloadList = () =>
  pagedModules.has(current) ? refresh().catch((e) => toast(e.message)) : drawList();
let selected = new Set();
let current = 'overview',
  rows = [],
  customers = [],
  channels = [],
  search = '',
  page = 1,
  status = '',
  timer;
async function api(path, body) {
  const r = await apiFetch(
    '/api/admin/' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error || '请求失败');
  return data;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  clearTimeout(timer);
  timer = setTimeout(() => ($('#toast').style.display = 'none'), 4000);
}
function money(n) {
  if (!Number.isSafeInteger(n)) return '—';
  const s = String(Math.abs(n)).padStart(3, '0');
  return (n < 0 ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
}
function cents(text) {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw Error('金额最多两位小数');
  const [a, b = ''] = text.split('.'),
    n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n <= 0) throw Error('金额须大于零且在有效范围内');
  return n;
}
const auditNames = {
  'admin:channel-save': '保存渠道',
  'admin:channel-archive': '归档渠道',
  'finance:update-local-invoice': '修改账单',
  'admin:customer-save': '保存客户资料',
  'admin:service-save': '保存服务配置',
  'admin:shipment-operation': '录入运单操作数据',
  'finance:import-local-invoice': '建立本地账单',
  'finance:record-local-allocation': '登记本地核销',
  'finance:reconcile-local-invoice': '更新账单核销',
  'shipment:create': '创建运单',
  'shipment:update': '编辑运单',
  'shipment:tracking': '登记路由',
  'shipment:problem': '更新问题件标记',
  'booking:cancel-local': '取消本地预约',
  'cabin:cancel-local': '取消本地舱位申请'
};
const auditLabel = (value) =>
  auditNames[value] ||
  (value.startsWith('shipment:') && states[value.slice(9)]
    ? '运单状态更新：' + states[value.slice(9)]
    : value);
const date = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
function modal(title, html, submit) {
  $('#title').textContent = title;
  $('#form').innerHTML = html;
  $('#error').textContent = '';
  $('#form').onsubmit = async (e) => {
    e.preventDefault();
    if (!submit) return;
    const button = e.submitter;
    if (button) button.disabled = true;
    try {
      const result = await submit(Object.fromEntries(new FormData(e.target)), e.target);
      if (result === false) return;
      $('#modal').close();
      selected.clear();
      await refresh();
      toast('已保存');
    } catch (error) {
      $('#error').textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  };
  if (!$('#modal').open) $('#modal').showModal();
}
$('#close').onclick = () => $('#modal').close();
const field = (name, title, value = '', type = 'text', required = false) =>
  `<label class="field"><span>${title}</span><input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''}></label>`;
const select = (name, title, options, value) =>
  `<label class="field"><span>${title}</span><select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const textarea = (name, title, value = '') =>
  `<label class="field wide"><span>${title}</span><textarea name="${name}" maxlength="2000">${esc(value)}</textarea></label>`;
const actions = (label) =>
  `<div class="actions"><button class="btn btn-green primary" type="submit">${label || '保存'}</button></div>`;
const tag = (v) =>
  `<span class="tag ${v === 'active' || v === 'delivered' ? 'green' : ['disabled', 'cancel', 'cancelled'].includes(v) ? 'red' : ''}">${esc(states[v] || v || '—')}</span>`;
function table(headers, body) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((h) => `<th>${h === '<select>' ? '<input type="checkbox" id="selectAllAdmin" aria-label="全选本页">' : esc(h)}</th>`).join('')}</tr></thead><tbody>${body.length ? body.map((row) => `<tr>${row.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty">暂无数据</td></tr>`}</tbody></table></div>`;
}
function toolbar(extra = '') {
  return `<div class="toolbar"><input id="search" placeholder="输入关键字搜索" value="${esc(search)}"><button id="searchButton">搜索</button><button id="reset">重置</button>${extra}<button id="refresh">刷新</button></div>`;
}
function wireToolbar() {
  const run = () => {
    search = $('#search').value.trim();
    page = 1;
    selected.clear();
    reloadList();
  };
  $('#searchButton').onclick = run;
  $('#search').onkeydown = (e) => {
    if (e.key === 'Enter') run();
  };
  $('#reset').onclick = () => {
    search = '';
    status = '';
    page = 1;
    selected.clear();
    reloadList();
  };
  $('#refresh').onclick = () => refresh().catch((e) => toast(e.message));
}
function renderAdminNav() {
  const groups = [
    ['业务', ['overview', 'shipments', 'booking', 'cabin']],
    ['财务', ['invoices', 'ledger', 'revisions', 'approvals']],
    ['资料', ['channels', 'customers', 'services', 'address', 'product', 'vat', 'store']],
    ['系统', ['users', 'audit', 'changes', 'operations']]
  ];
  $('#adminNav').innerHTML =
    `<a class="company-brand" href="/admin">某某国际物流有限公司<small>管理端</small></a>${groups
      .map(
        ([title, keys]) =>
          `<div class="nav-group ${keys.includes(current) ? 'active' : ''}"><button>${title}⌄</button><div class="nav-menu">${keys
            .filter((k) => names[k])
            .map((k) => `<a href="#${k}" data-menu="${k}">${names[k]}</a>`)
            .join('')}</div></div>`
      )
      .join(
        ''
      )}<span class="spacer"></span><div class="nav-group"><button>管理工作台⌄</button><div class="nav-menu"><a href="/tms/wos/shipment">切换客户端</a><a href="#" id="accountSettings">账号与安全</a><a href="#" id="logoutAdmin">退出登录</a></div></div>`;
  $('#logoutAdmin').onclick = (e) => {
    e.preventDefault();
    logout();
  };
  $('#accountSettings').onclick = (e) => {
    e.preventDefault();
    accountDialog({
      openDialog: (title, html, submit) =>
        modal(title, html, async (data, form) => {
          await submit(new FormData(form), form);
          return false;
        })
    });
  };
  document.querySelectorAll('[data-menu]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        navigate(b.dataset.menu);
      })
  );
}
async function navigate(key) {
  current = Object.hasOwn(names, key) ? key : 'overview';
  search = '';
  status = '';
  page = 1;
  selected.clear();
  history.replaceState(null, '', '#' + current);
  $('#breadcrumb').textContent = names[current];
  renderAdminNav();
  try {
    await refresh();
  } catch (e) {
    $('#main').textContent = e.message;
  }
}
async function refresh() {
  pageData = null;
  if (current === 'operations') {
    const [state, integrity] = await Promise.all([
      api('commercial/status'),
      api('commercial/integrity')
    ]);
    $('#main').innerHTML =
      '<h1>运行与备份状态</h1>' +
      table(
        ['检查项目', '结果'],
        [
          ['近期备份', state.backup.ok ? '正常' : '需处理'],
          ['备份加密', state.backup.encrypted ? '已启用' : '未验证'],
          ['异地副本', state.backup.remoteCopied ? '已写入配置目录，需运维确认异地挂载' : '未验证'],
          ['备份恢复校验', state.backup.restoreVerified ? '通过' : '未验证'],
          ['数据完整性', integrity.ok ? '通过' : '存在异常'],
          ['待审核业务申请', String(state.pendingApprovals)]
        ]
      ) +
      '<p>生产主机、异地存储与告警接收须另外完成部署验收。</p>';
    return;
  }
  if (pagedModules.has(current)) {
    const result = await api(
      current + '?' + new URLSearchParams({ page: String(page), pageSize: '20', q: search, status })
    );
    rows = result.items;
    page = result.page;
    pageData = result;
    if (['shipments', 'invoices'].includes(current)) customers = await api('customers');
    if (['shipments', 'customers'].includes(current)) channels = await api('channels');
    drawList();
    return;
  }
  if (['ledger', 'approvals', 'changes'].includes(current)) {
    customers = await api('customers');
    await renderCommercial(current, $('#main'), {
      api,
      esc,
      money,
      cents,
      modal,
      field,
      select,
      textarea,
      actions,
      table,
      hasPermission,
      user: session.user,
      customers,
      notify: (message) => toast(message?.message || message)
    });
    return;
  }
  if (['address', 'product', 'vat', 'store'].includes(current)) {
    await renderModule(current, $('#main'), {
      api: async (path, body) => {
        const r = await apiFetch(
          path,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              }
        );
        const data = await r.json();
        if (!r.ok) throw Error(data.error || '请求失败');
        return data;
      },
      notify: toast,
      openDialog: (title, html, submit) =>
        modal(
          title,
          html,
          submit
            ? async (data, form) => {
                await submit(new FormData(form), form);
                return false;
              }
            : undefined
        ),
      closeDialog: () => $('#modal').close(),
      navigate
    });
    return;
  }
  if (current === 'overview') {
    await overview();
    return;
  }
  if (current === 'shipments')
    [rows, customers, channels] = await Promise.all([
      api('shipments'),
      api('customers'),
      api('channels')
    ]);
  else if (current === 'invoices')
    [rows, customers] = await Promise.all([api('invoices'), api('customers')]);
  else if (current === 'customers')
    [rows, channels] = await Promise.all([api('customers'), api('channels')]);
  else if (current === 'users') {
    const r = await apiFetch('/api/auth/users');
    rows = await r.json();
    if (!r.ok) throw Error(rows.error);
    customers = await api('customers');
  } else rows = await api(current);
  drawList();
}
async function overview() {
  const data = await api('summary'),
    counts = data.shipments,
    total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('#main').innerHTML =
    `<h1>经营概览</h1><p class="subtitle">某某国际物流有限公司 · 业务工作台</p><div class="cards">${[
      [total, '运单总数'],
      [counts.ready || 0, '待收货运单'],
      [counts.in_transit || 0, '转运中运单'],
      [data.customers.active || 0, '启用客户']
    ]
      .map(([v, t]) => `<div class="card"><strong>${v}</strong><span>${t}</span></div>`)
      .join(
        ''
      )}</div><div class="panel"><h2>待办事项</h2><div class="toolbar"><button data-go="shipments">待收货 ${counts.ready || 0}</button><button data-go="booking">待处理预约 ${data.bookings.ready || 0}</button><button data-go="cabin">舱位申请 ${data.cabins.apply || 0}</button><button data-go="invoices">账单与应收</button><button data-go="approvals">业务审批</button></div></div><div class="panel"><h2>账务汇总</h2>${data.finance.byCurrency.map((g) => `<p>${esc(g.currency)} 应收 ${money(g.totalCents)} · 已核销 ${money(g.allocatedCents)} · 未收 ${money(g.remainingCents)}</p>`).join('') || '<p>暂无可查看的账务数据</p>'}</div><div class="panel"><h2>最近操作</h2>${table(
      ['时间', '操作', '对象'],
      data.audit.map((a) => [esc(date(a.at)), esc(auditLabel(a.action)), esc(a.object)])
    )}</div>`;
  document.querySelectorAll('[data-go]').forEach((b) => {
    b.hidden = !names[b.dataset.go];
    b.onclick = () => navigate(b.dataset.go);
  });
}
function legacyAssignForm(row) {
  modal(
    '整组分配旧运单与账单',
    `<p>目标客户：${esc(row.name)}。仅处理尚无客户归属的旧记录，必须包含全部关联运单与账单。</p><p>每行填写 ID,版本；版本可在记录详情中查看。</p>${textarea('shipments', '旧运单 ID,版本（每行一条）')}${textarea('invoices', '旧账单 ID,版本（每行一条）')}${textarea('reason', '核对依据与分配原因')}${actions('原子分配')}`,
    (data) => {
      const parse = (value) =>
        String(value || '')
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const parts = s.split(',');
            if (parts.length !== 2) throw Error('每行格式为 ID,版本');
            return { id: parts[0].trim(), version: Number(parts[1]) };
          });
      return api('record/assign-group', {
        customerId: row.id,
        shipments: parse(data.shipments),
        invoices: parse(data.invoices),
        reason: data.reason
      });
    }
  );
}
function customerForm(row) {
  modal(
    row ? '编辑客户' : '新增客户',
    `<div class="fields">${field('name', '客户名称', row?.name || '', 'text', true)}${field('code', '客户编码', row?.code)}${select(
      'status',
      '状态',
      [
        ['active', '启用'],
        ['disabled', '停用']
      ],
      row?.status || 'active'
    )}${select(
      'settlement',
      '结算方式',
      [
        ['prepaid', '预付'],
        ['weekly', '周结'],
        ['monthly', '月结']
      ],
      row?.settlement || 'prepaid'
    )}${field('contact', '联系人', row?.contact)}${field('phone', '联系电话', row?.phone)}${field('email', '邮箱', row?.email, 'email')}${field('currency', '结算币种', row?.currency || 'CNY')}${field('credit', '信用额度', money(row?.creditCents || 0))}${field('taxNumber', '税号', row?.taxNumber)}${field('address', '公司地址', row?.address)}${textarea('remark', '备注', row?.remark)}</div><h3 class="parcel-heading">可用渠道</h3><p class="hint">未勾选时不额外限制渠道；选择后仅允许分配已勾选渠道。</p><div class="channel-options">${channels.length ? channels.map((c) => `<label><input type="checkbox" name="channelIds" value="${esc(c.id)}" ${row?.channelIds?.includes(c.id) ? 'checked' : ''}>${esc(c.code)} ${esc(c.name)}</label>`).join('') : '暂无渠道，请先维护渠道资料'}</div>${actions()}`,
    (data, form) => {
      const { credit, channelIds: ignored, ...rest } = data;
      return api('customer/save', {
        ...rest,
        currency: data.currency.toUpperCase(),
        creditCents: nonnegativeMoney(credit),
        channelIds: new FormData(form).getAll('channelIds'),
        ...(row ? { id: row.id, version: row.version } : {})
      });
    }
  );
}
function serviceForm(row) {
  modal(
    '编辑服务配置',
    `<p class="hint">服务代码 ${esc(row.code)}。内部名称和备注仅用于管理；接单开关控制本地新建运单。</p><div class="fields">${field('name', '内部服务名称', row.name, 'text', true)}${select(
      'enabled',
      '接单状态',
      [
        ['true', '启用'],
        ['false', '暂停新建']
      ],
      String(row.enabled)
    )}${textarea('remark', '备注', row.remark)}</div>${actions()}`,
    (data) =>
      api('service/save', {
        ...data,
        code: row.code,
        version: row.version,
        enabled: data.enabled === 'true'
      })
  );
}
function shipmentView(row) {
  const client = customers.find((c) => c.id === row.customer_id);
  modal(
    '运单详情',
    `<div class="detail-grid">${[
      ['运单ID / 版本', row.id + ' / ' + row.version],
      ['运单号', row.shipment_number],
      ['客户单号', row.client_reference],
      ['所属客户', client?.name || '尚未分配'],
      ['服务', row.service],
      ['收件人', row.name],
      ['目的地', [row.country, row.city, row.postcode].filter(Boolean).join(' ')],
      ['状态', states[row.status]],
      ['实际重量', row.actual_weight === undefined ? '—' : row.actual_weight + ' kg']
    ]
      .map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`)
      .join('')}</div>${table(
      ['箱号', '中文品名', '数量', '客户箱重', '实际箱重'],
      row.parcels.map((p) =>
        [p.number, p.name_zh, p.qty, p.client_weight, p.actual_weight ?? '—'].map(esc)
      )
    )}<h3>路由记录</h3>${table(
      ['时间', '状态', '内容'],
      (row.tracking || []).map((t) => [
        esc(date(t.at)),
        esc(states[t.status] || '轨迹'),
        esc(t.note)
      ])
    )}`
  );
}
function shipmentOperation(row) {
  const unique = [...new Map(row.parcels.map((p, i) => [String(p.number || i + 1), p])).entries()];
  modal(
    '入仓实测与客户分配',
    `<div class="fields">${select('customerId', '所属客户', [['', '不分配'], ...customers.filter((c) => c.status === 'active' || c.id === row.customer_id).map((c) => [c.id, c.name])], row.customer_id || '')}${field('outer_carrier', '承运商单号', row.outer_carrier)}${select('channelId', '操作渠道', [['', '不分配'], ...channels.filter((c) => c.status === 'active' || c.id === row.channel_id).map((c) => [c.id, c.code + ' ' + c.name])], row.channel_id || '')}</div><p class="hint">录入实测时需填写全部货箱的重量与尺寸；同箱多商品共用一份箱数据。未勾选时只更新客户与单号。</p><p><label><input type="checkbox" name="correction"> 实测更正申请（已锁定运单）</label></p>${textarea('reason', '实测更正原因')}<p><label><input type="checkbox" name="measure"> 同时保存货箱实测</label></p>${table(
      ['箱号', '实重 kg', '长 cm', '宽 cm', '高 cm'],
      unique.map(([number, p], i) => [
        esc(number),
        ...['weight', 'length', 'width', 'height'].map(
          (k) =>
            `<input aria-label="${esc(number + ' ' + k)}" name="m_${i}_${k}" type="number" step="any" min="0.001" value="${esc(p['actual_' + k] ?? '')}" style="width:100px">`
        )
      ])
    )}${actions()}`,
    (data) => {
      const body = {
        id: row.id,
        version: row.version,
        customerId: data.customerId,
        channelId: data.channelId,
        outer_carrier: data.outer_carrier
      };
      if (data.measure)
        body.parcels = unique.map(([number], i) => ({
          number,
          ...Object.fromEntries(
            ['weight', 'length', 'width', 'height'].map((k) => [k, Number(data[`m_${i}_${k}`])])
          )
        }));
      if (data.correction) {
        if (!body.parcels) throw Error('请勾选实测并填写全部货箱');
        return api('commercial/measurement/request', {
          shipmentId: row.id,
          version: row.version,
          parcels: body.parcels,
          reason: data.reason
        });
      }
      return api('shipment/update', body);
    }
  );
}
function shipmentAction(row, mode) {
  const allowed = mode === 'status' ? transitions[row.status] || [] : [];
  modal(
    mode === 'status' ? '更新运单状态' : mode === 'tracking' ? '登记路由' : '拦截 / 问题件',
    `<p>运单：${esc(row.shipment_number)}</p><div class="fields">${
      mode === 'status'
        ? select(
            'action',
            '目标状态',
            allowed.map((s) => [s, states[s]]),
            allowed[0]
          )
        : ''
    }${textarea('note', '操作说明')}</div>${actions('确认')}`,
    (data) =>
      api('shipment/action', {
        ids: [row.id],
        versions: { [row.id]: row.version },
        action: mode === 'status' ? data.action : mode,
        note: data.note
      })
  );
}
const invoiceContext = {
  user: session.user,
  customerChoices: () => customers,
  openDialog: (title, html, submit) =>
    modal(title, html, submit ? (data, form) => submit(new FormData(form), form) : undefined),
  api: (path, body) => api(path.replace('/api/admin/', ''), body),
  notify: toast
};
function invoiceForm(row) {
  openInvoiceEditor(invoiceContext, row, {
    endpoint: row
      ? row.billingSource === 'measured'
        ? '/api/admin/commercial/invoice/adjustment'
        : '/api/admin/invoice/update'
      : '/api/admin/invoice/save'
  });
}
async function allocationForm(row) {
  try {
    const result = await api(
      'commercial/transactions?kind=receipt&customerId=' +
        encodeURIComponent(row.customer_id || '') +
        '&pageSize=100'
    );
    const receipts = result.items.filter(
      (r) => r.customer_id === row.customer_id && r.currency === row.currency
    );
    modal(
      '关联收款核销',
      `<p>${esc(row.number)} · ${esc(row.currency)} 余款 ${money(row.remainingCents)}</p><div class="fields">${select(
        'receiptId',
        '已核实收款',
        receipts.map((r) => [r.id, r.reference + ' · ' + money(r.amount_cents)]),
        ''
      )}${field('reference', '核销参考号', '', 'text', true)}${field('amount', '核销金额', '', 'text', true)}</div><p>没有收款时，请先在“收款与退款”登记并核实银行流水。</p>${actions('核销')}`,
      (data) =>
        api('invoice/allocate', {
          invoiceId: row.id,
          version: row.version,
          reference: data.reference,
          receiptId: data.receiptId,
          amountCents: cents(data.amount)
        })
    );
  } catch (e) {
    toast(e.message);
  }
}
async function invoiceView(row) {
  try {
    const response = await apiFetch('/api/replica/invoice/' + encodeURIComponent(row.id));
    row = await response.json();
    if (!response.ok) throw Error(row.error);
    modal(
      '账单明细',
      `<div class="detail-grid">${[
        ['账单ID / 版本', row.id + ' / ' + row.version],
        ['账单号', row.number],
        ['币种', row.currency],
        ['账单总额', money(row.totalCents)],
        ['剩余待核销', money(row.remainingCents)]
      ]
        .map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`)
        .join('')}</div>${table(
        ['关联运单ID', '参考号', '费用说明', '金额'],
        row.lines.map((l) => [
          esc(l.shipmentId || '—'),
          esc(l.reference),
          esc(l.description),
          money(l.amountCents)
        ])
      )}<h3>核销流水（原记录保留）</h3>${table(
        ['核销ID', '参考号', '金额', '收款ID'],
        (row.allocations || []).map((a) => [
          esc(a.id),
          esc(a.reference),
          money(a.amountCents),
          esc(a.receiptId || '历史未关联')
        ])
      )}`
    );
  } catch (e) {
    toast(e.message);
  }
}
function bookingView(row) {
  const definitions = flattenFields(configuration.pages[current]?.form?.form?.columns || []),
    labels = new Map(definitions.map((f) => [f.name, f.label]));
  for (const [key, title] of Object.entries({
    created: '创建时间',
    createdAt: '创建时间',
    updated: '更新时间',
    status: '状态',
    number: '编号',
    cancellation: '取消记录'
  }))
    labels.set(key, title);
  const details = Object.entries(row)
    .filter(([k, v]) => !['id', 'version', 'archived'].includes(k) && v !== null && v !== '')
    .map(([k, v]) => {
      let value = v;
      if (k === 'status') value = states[v] || v;
      else if (['created', 'createdAt', 'updated'].includes(k)) value = date(v);
      else if (k === 'cancellation') value = (v.note || '无备注') + ' / ' + date(v.at);
      else if (typeof v === 'object') value = JSON.stringify(v);
      const def = definitions.find((f) => f.name === k);
      if (def) {
        const opts = Array.isArray(def.options)
          ? def.options
          : Object.entries(def.options || {}).map(([value, label]) => ({ value, label }));
        value = opts.find((o) => String(o.value) === String(v))?.label || value;
        if (def.type === 'date' && typeof v === 'number') value = date(v * 1000);
      }
      return [esc(labels.get(k) || k), esc(value)];
    });
  modal(names[current] + '详情', table(['项目', '内容'], details));
}
function cancel(row) {
  const kind = current;
  modal(
    '取消确认',
    `<p>确定取消所选本地${kind === 'booking' ? '预约' : '舱位申请'}？</p>${textarea('note', '说明')}${actions('确定取消')}`,
    (data) =>
      api(kind + '/cancel', { ids: [row.id], versions: { [row.id]: row.version }, note: data.note })
  );
}
function drawList() {
  let found = pageData
    ? rows
    : rows
        .filter(
          (row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase())
        )
        .filter(
          (row) =>
            !status ||
            (current === 'services'
              ? row.enabled
                ? 'active'
                : 'disabled'
              : String(row.status)) === status
        );
  const total = pageData?.total ?? found.length;
  const pages = Math.max(1, Math.ceil(total / 20));
  page = Math.min(page, pages);
  const part = pageData ? found : found.slice((page - 1) * 20, page * 20);
  let headers, body;
  const button = (id, action, title, cls = '') =>
    `<button data-row="${esc(id)}" data-action="${action}" class="${cls}">${title}</button>`;
  if (current === 'shipments') {
    headers = [
      '运单 / 客户单号',
      '客户',
      '服务',
      '收件人 / 国家',
      '箱数',
      '实重 kg',
      '状态',
      '操作'
    ];
    body = part.map((r) => [
      `${esc(r.shipment_number)}<br><span class="hint">${esc(r.client_reference)}</span>`,
      esc(customers.find((c) => c.id === r.customer_id)?.name || '未分配'),
      esc(r.service),
      esc(r.name) + ' / ' + esc(r.country),
      esc(r.parcel_count),
      esc(r.actual_weight ?? '—'),
      tag(r.status),
      button(r.id, 'view', '详情') +
        (r.status !== 'cancelled'
          ? button(r.id, 'operation', '操作录入') +
            button(r.id, 'tracking', '路由') +
            button(r.id, 'problem', r.problem ? '解除问题件' : '问题件')
          : '') +
        (transitions[r.status]?.length ? button(r.id, 'status', '状态更新') : '') +
        (hasPermission('finance:write') && ['ready', 'picked'].includes(r.status)
          ? button(r.id, 'generate', '锁价开账')
          : '')
    ]);
  } else if (current === 'customers') {
    headers = [
      '客户编码',
      '客户名称',
      '联系人',
      '电话',
      '结算方式',
      '币种 / 信用额度',
      '可用渠道',
      '状态',
      '操作'
    ];
    body = part.map((r) => [
      esc(r.code || '—'),
      esc(r.name),
      esc(r.contact),
      esc(r.phone),
      esc({ prepaid: '预付', weekly: '周结', monthly: '月结' }[r.settlement] || '预付'),
      esc(r.currency || 'CNY') + ' ' + money(r.creditCents || 0),
      esc(r.channelIds?.length || '不限'),
      tag(r.status),
      button(r.id, 'edit', '编辑') + button(r.id, 'legacyAssign', '分配旧数据')
    ]);
  } else if (current === 'channels') {
    headers = [
      '渠道代码',
      '渠道名称',
      '承运商',
      '目的国家',
      '运输方式',
      '关联服务',
      '单价 / 固定费',
      '状态',
      '操作'
    ];
    body = part.map((r) => [
      esc(r.code),
      esc(r.name),
      esc(r.carrier),
      esc(r.country),
      esc({ sea: '海运', air: '空运', express: '快递', rail: '铁路', road: '陆运' }[r.transport]),
      esc(r.serviceCode || '—'),
      esc(r.currency) + ' ' + money(r.rateCents) + ' / ' + money(r.fixedCents),
      tag(r.status),
      button(r.id, 'edit', '编辑') +
        button(r.id, 'quote', '试算') +
        button(r.id, 'archive', '归档') +
        (hasPermission('pricing:propose') ? button(r.id, 'pricing', '费率申请') : '')
    ]);
  } else if (current === 'services') {
    headers = ['服务代码', '内部名称', '本地接单', '备注', '操作'];
    body = part.map((r) => [
      esc(r.code),
      esc(r.name),
      tag(r.enabled ? 'active' : 'disabled'),
      esc(r.remark),
      button(r.id, 'edit', '配置')
    ]);
  } else if (current === 'invoices') {
    headers = ['账单号', '币种', '总额', '已核销', '剩余', '账单日期', '操作'];
    body = part.map((r) => [
      esc(r.number),
      esc(r.currency),
      money(r.totalCents),
      money(r.allocatedCents),
      money(r.remainingCents),
      esc(r.invoiceDate),
      button(r.id, 'view', '明细') +
        (!r.customer_id ? button(r.id, 'assign', '分配客户') : '') +
        button(r.id, 'edit', '修改') +
        button(r.id, 'history', '修改记录') +
        (r.remainingCents > 0 ? button(r.id, 'allocate', '核销') : '')
    ]);
  } else if (current === 'users') {
    headers = ['账号', '显示名称', '角色', '客户归属', '状态', '操作'];
    body = part.map((r) => [
      esc(r.username),
      esc(r.displayName),
      esc({ admin: '管理员', operator: '运营', finance: '财务', customer: '客户' }[r.role]),
      esc(customers.find((c) => c.id === r.customerId)?.name || '—'),
      tag(r.enabled ? 'active' : 'disabled'),
      button(r.id, 'edit', '编辑权限')
    ]);
  } else if (current === 'revisions') {
    headers = ['申请编号', '所属客户', '账单ID', '申请时间', '修改原因', '状态', '操作'];
    body = part.map((r) => [
      esc(r.id),
      esc(r.customer_id),
      esc(r.invoiceId),
      esc(date(r.created)),
      esc(r.input.reason),
      esc({ pending: '待审核', approved: '已通过', rejected: '已拒绝' }[r.status]),
      button(r.id, 'view', '查看') +
        (r.status === 'pending' && hasPermission('finance:write')
          ? button(r.id, 'approve', '通过') + button(r.id, 'reject', '拒绝')
          : '')
    ]);
  } else if (current === 'audit') {
    headers = ['时间', '操作', '对象'];
    body = part.map((r) => [esc(date(r.at)), esc(auditLabel(r.action)), esc(r.object)]);
  } else {
    headers = ['编号', '状态', '创建时间', '操作'];
    body = part.map((r) => [
      esc(r.number || r.id),
      tag(r.status),
      esc(date(r.createdAt || r.created)),
      button(r.id, 'view', '详情') +
        (['ready', 'apply'].includes(r.status) ? button(r.id, 'cancel', '取消', 'danger') : '')
    ]);
  }
  const extra =
    current === 'users'
      ? '<button class="primary" id="create">创建账号</button>'
      : current === 'customers'
        ? '<button class="primary" id="create">新增客户</button>'
        : current === 'channels'
          ? '<button class="primary" id="create">新增渠道</button>'
          : current === 'invoices'
            ? '<button class="primary" id="create">新建账单</button>'
            : '';
  const stateFilter =
    current === 'shipments'
      ? `<select id="stateFilter"><option value="">全部状态</option>${Object.keys(states)
          .filter((s) => !['apply', 'cancel', 'active', 'disabled'].includes(s))
          .map(
            (s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${states[s]}</option>`
          )
          .join('')}</select>`
      : '';
  $('#main').innerHTML =
    `<h1>${names[current]}</h1><p class="subtitle">${current === 'services' ? '已恢复的服务配置 · 接单开关作用于本地新建运单' : '与客户端共享本地业务记录'}</p>${toolbar(extra + stateFilter)}${moduleTabs()}<div class="table-tools"><span class="selected-count">已选中：${selected.size}</span><button class="btn" id="exportRecords">导出本页</button>${current === 'shipments' ? '<button class="btn" id="batchShipmentState">批量更新状态</button>' : ''}${['booking', 'cabin'].includes(current) ? '<button class="btn btn-red" id="batchCancel">批量取消</button>' : ''}</div>${table(
      ['<select>', ...headers],
      body.map((cells, i) => [
        `<input type="checkbox" data-check="${esc(part[i].id ?? part[i].object ?? i)}" ${selected.has(String(part[i].id ?? part[i].object ?? i)) ? 'checked' : ''} aria-label="选择记录">`,
        ...cells
      ])
    )}<div class="pager"><span>共 ${total} 条</span><button id="prev" ${page === 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${pages}</span><button id="next" ${page === pages ? 'disabled' : ''}>下一页</button></div>`;
  $('#exportRecords').onclick = () => {
    const chosen = part.filter((r) => selected.has(String(r.id ?? r.object)));
    const indexes = selected.size
      ? part.map((r, i) => (selected.has(String(r.id ?? r.object)) ? i : -1)).filter((i) => i >= 0)
      : part.map((_, i) => i);
    if (selected.size && !chosen.length) {
      toast('请切换至已选记录所在页导出');
      return;
    }
    const plain = (html) => {
      const el = document.createElement('div');
      el.innerHTML = html;
      return el.textContent;
    };
    const end = headers.at(-1) === '操作' ? -1 : headers.length;
    const data = [headers.slice(0, end), ...indexes.map((i) => body[i].slice(0, end).map(plain))];
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet(data), '记录');
    window.XLSX.writeFile(book, names[current] + '.xlsx');
  };
  document.querySelectorAll('[data-check]').forEach(
    (box) =>
      (box.onchange = () => {
        box.checked ? selected.add(box.dataset.check) : selected.delete(box.dataset.check);
        drawList();
      })
  );
  const all = $('#selectAllAdmin');
  if (all) {
    all.checked = !!part.length && part.every((r) => selected.has(String(r.id ?? r.object)));
    all.onchange = () => {
      part.forEach((r) =>
        all.checked
          ? selected.add(String(r.id ?? r.object))
          : selected.delete(String(r.id ?? r.object))
      );
      drawList();
    };
  }
  const chosenRows = () => rows.filter((r) => selected.has(String(r.id)));
  if ($('#batchShipmentState'))
    $('#batchShipmentState').onclick = () => {
      const chosen = chosenRows();
      if (!chosen.length) {
        toast('请先选择运单');
        return;
      }
      const opts = Object.keys(states).filter((s) =>
        chosen.every((r) => transitions[r.status]?.includes(s))
      );
      if (!opts.length) {
        toast('所选运单没有共同可转入的状态');
        return;
      }
      modal(
        '批量更新状态',
        `<p>已选 ${chosen.length} 票</p><div class="fields">${select(
          'action',
          '目标状态',
          opts.map((s) => [s, states[s]]),
          opts[0]
        )}${textarea('note', '操作说明')}</div>${actions('确认更新')}`,
        (data) =>
          api('shipment/action', {
            ids: chosen.map((r) => r.id),
            versions: Object.fromEntries(chosen.map((r) => [r.id, r.version])),
            action: data.action,
            note: data.note
          })
      );
    };
  if ($('#batchCancel'))
    $('#batchCancel').onclick = () => {
      const chosen = chosenRows(),
        kind = current;
      if (!chosen.length) {
        toast('请先选择记录');
        return;
      }
      modal(
        '批量取消',
        `<p>已选 ${chosen.length} 条</p>${textarea('note', '取消说明')}${actions('确认取消')}`,
        (data) =>
          api(kind + '/cancel', {
            ids: chosen.map((r) => r.id),
            versions: Object.fromEntries(chosen.map((r) => [r.id, r.version])),
            note: data.note
          })
      );
    };
  wireToolbar();
  document.querySelectorAll('[data-status-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        status = b.dataset.statusTab;
        page = 1;
        selected.clear();
        reloadList();
      })
  );
  $('#prev').onclick = () => {
    page--;
    selected.clear();
    reloadList();
  };
  $('#next').onclick = () => {
    page++;
    selected.clear();
    reloadList();
  };
  if ($('#create'))
    $('#create').onclick = () =>
      current === 'users'
        ? userForm()
        : current === 'customers'
          ? customerForm()
          : current === 'channels'
            ? channelForm()
            : invoiceForm();
  if ($('#stateFilter'))
    $('#stateFilter').onchange = (e) => {
      status = e.target.value;
      page = 1;
      selected.clear();
      reloadList();
    };
  const requiredWrite = {
    shipments: 'shipments:write',
    customers: 'customers:write',
    channels: 'channels:write',
    services: 'services:write',
    invoices: 'finance:write',
    booking: 'bookings:write',
    cabin: 'bookings:write'
  }[current];
  if (requiredWrite && !hasPermission(requiredWrite)) {
    document.querySelectorAll('[data-action]').forEach((b) => {
      if (
        ![
          'view',
          'history',
          'quote',
          ...(hasPermission('pricing:propose') ? ['pricing'] : []),
          ...(hasPermission('finance:write') ? ['generate'] : [])
        ].includes(b.dataset.action)
      )
        b.hidden = true;
    });
    for (const id of ['create', 'batchShipmentState', 'batchCancel'])
      if ($('#' + id)) $('#' + id).hidden = true;
  }
  document.querySelectorAll('[data-action]').forEach(
    (b) =>
      (b.onclick = () => {
        const row = rows.find((r) => String(r.id) === b.dataset.row),
          action = b.dataset.action;
        if (current === 'users') userForm(row);
        else if (current === 'revisions') reviewInvoice(row, action);
        else if (current === 'customers') {
          if (action === 'legacyAssign') legacyAssignForm(row);
          else customerForm(row);
        } else if (current === 'channels') {
          if (action === 'archive') archiveChannel(row);
          else if (action === 'quote') quoteChannel(row);
          else if (action === 'pricing') pricingForm(row);
          else channelForm(row);
        } else if (current === 'services') serviceForm(row);
        else if (current === 'shipments') {
          if (action === 'view') shipmentView(row);
          else if (action === 'operation') shipmentOperation(row);
          else if (action === 'generate') generateInvoice(row);
          else shipmentAction(row, action);
        } else if (current === 'invoices') {
          if (action === 'assign') invoiceAssignment(row);
          else if (action === 'allocate') allocationForm(row);
          else if (action === 'edit') invoiceForm(row);
          else if (action === 'history') invoiceHistory(row);
          else invoiceView(row);
        } else if (action === 'cancel') cancel(row);
        else bookingView(row);
      })
  );
}
function moduleTabs() {
  let opts;
  if (current === 'shipments')
    opts = [
      ['', '全部'],
      ...Object.entries(states).filter(([key]) =>
        ['ready', 'picked', 'in_transit', 'delivered', 'returned', 'cancelled'].includes(key)
      )
    ];
  else if (['customers', 'channels', 'services'].includes(current))
    opts = [
      ['', '全部'],
      ['active', '启用'],
      ['disabled', '停用']
    ];
  else if (current === 'revisions')
    opts = [
      ['', '全部申请'],
      ['pending', '待审核'],
      ['approved', '已通过'],
      ['rejected', '已拒绝']
    ];
  else if (current === 'invoices')
    opts = [
      ['', '全部账单'],
      ['2', '待核销'],
      ['3', '已核销']
    ];
  else if (current === 'booking')
    opts = [
      ['', '全部'],
      ['ready', '待处理'],
      ['cancelled', '已取消']
    ];
  else if (current === 'cabin')
    opts = [
      ['', '全部'],
      ['apply', '申请中'],
      ['cancel', '已取消']
    ];
  else return '';
  return `<div class="tabs">${opts.map(([key, title]) => `<button type="button" data-status-tab="${key}" class="${status === key ? 'active' : ''}">${title}(${pageData ? (key ? pageData.counts[key] || 0 : Object.values(pageData.counts).reduce((a, b) => a + b, 0)) : rows.filter((r) => !key || (current === 'services' ? (r.enabled ? 'active' : 'disabled') : String(r.status)) === key).length})</button>`).join('')}</div>`;
}
const nonnegativeMoney = (value) =>
  /^0(?:\.0{1,2})?$/.test(String(value).trim()) ? 0 : parseMoney(value);
function channelForm(row) {
  modal(
    row ? '编辑渠道' : '新增渠道',
    `<div class="fields">${field('code', '渠道代码', row?.code || '', 'text', true)}${field('name', '渠道名称', row?.name || '', 'text', true)}${field('carrier', '承运商', row?.carrier || '', 'text', true)}${field('country', '目的国家代码', row?.country || 'US', 'text', true)}${select(
      'transport',
      '运输方式',
      [
        ['sea', '海运'],
        ['air', '空运'],
        ['express', '快递'],
        ['rail', '铁路'],
        ['road', '陆运']
      ],
      row?.transport || 'sea'
    )}${select('serviceCode', '关联服务', [['', '不限制服务'], ...Object.keys(configuration.shipmentProfiles).map((code) => [code, code])], row?.serviceCode || '')}${select(
      'status',
      '渠道状态',
      [
        ['active', '启用'],
        ['disabled', '停用']
      ],
      row?.status || 'active'
    )}${field('currency', '计费币种', row?.currency || 'CNY', 'text', true)}${field('rate', '每公斤单价', money(row?.rateCents || 0), 'text', true)}${field('fixed', '整票固定费用', money(row?.fixedCents || 0), 'text', true)}${field('minimum', '最低计费重量 kg', row?.minimum ?? 0, 'number', true)}${field('divisor', '材积系数', row?.divisor ?? 6000, 'number', true)}${field('step', '重量进位 kg', row?.step ?? 0.5, 'number', true)}${textarea('remark', '渠道说明', row?.remark || '')}</div><p class="hint">渠道费率为自行维护的本地报价。按实重与体积重取大，比较最低计费重后按进位计费；历史账单不会随费率变更自动修改。</p>${actions()}`,
    (data) => {
      const { rate, fixed, ...rest } = data;
      return api('channel/save', {
        ...rest,
        country: data.country.toUpperCase(),
        currency: data.currency.toUpperCase(),
        rateCents: nonnegativeMoney(rate),
        fixedCents: nonnegativeMoney(fixed),
        minimum: Number(data.minimum),
        divisor: Number(data.divisor),
        step: Number(data.step),
        ...(row ? { id: row.id, version: row.version } : {})
      });
    }
  );
  document.querySelectorAll('#form input[type=number]').forEach((input) => (input.step = 'any'));
}
function archiveChannel(row) {
  modal(
    '归档渠道',
    `<p>归档渠道 ${esc(row.code)} ${esc(row.name)}？存在未完结关联运单时不能归档，可先将渠道停用。</p>${actions('确认归档')}`,
    () => api('channel/archive', { id: row.id, version: row.version })
  );
}
function quoteChannel(row) {
  modal(
    '渠道费率试算',
    `<p>${esc(row.code)} ${esc(row.name)} · ${esc(row.currency)}</p><div class="fields">${field('weight', '每箱重量 kg', '', 'number', true)}${field('length', '每箱长度 cm', '', 'number', true)}${field('width', '每箱宽度 cm', '', 'number', true)}${field('height', '每箱高度 cm', '', 'number', true)}${field('count', '相同尺寸货箱数量', 1, 'number', true)}</div><div id="channelQuoteResult"></div>${actions('试算')}`,
    async (data) => {
      const count = Number(data.count);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('试算1至100箱');
      const result = await api('channel/quote', {
        id: row.id,
        boxes: Array.from({ length: count }, (_, i) => ({
          sku: 'BOX-' + (i + 1),
          qty: 1,
          weight: Number(data.weight),
          length: Number(data.length),
          width: Number(data.width),
          height: Number(data.height)
        }))
      });
      document.getElementById('channelQuoteResult').innerHTML =
        `<div class="detail-grid"><div><b>实重 kg</b>${esc(result.weight)}</div><div><b>体积重 kg</b>${esc(result.volumetric.toFixed(3))}</div><div><b>计费重 kg</b>${esc(result.billable)}</div><div><b>试算总费用</b>${esc(result.currency)} ${money(result.estimatedCents)}</div></div>`;
      return false;
    }
  );
  document.querySelectorAll('#form input[type=number]').forEach((input) => (input.step = 'any'));
}
function invoiceHistory(row) {
  modal(
    '账单修改记录',
    row.revisions?.length
      ? row.revisions
          .slice()
          .reverse()
          .map(
            (rev) =>
              `<h3>${esc(date(rev.at))} · 第${rev.before.version}版 → 第${rev.before.version + 1}版</h3><p>修改原因：${esc(rev.reason)}</p><p>原账单：${esc(rev.before.reference)}　${esc(rev.before.currency)} ${money(rev.before.totalCents)}</p>${table(
                ['原明细参考号', '费用说明', '原金额'],
                rev.before.lines.map((l) => [
                  esc(l.reference),
                  esc(l.description),
                  money(l.amountCents)
                ])
              )}`
          )
          .join('')
      : '<div class="empty">暂无修改记录</div>'
  );
}
function invoiceAssignment(row) {
  modal(
    '分配账单客户',
    `<div class="fields">${select(
      'customerId',
      '所属客户',
      customers.filter((c) => c.status === 'active').map((c) => [c.id, c.name]),
      ''
    )}</div>${actions()}`,
    (data) =>
      api('invoice/assign', { id: row.id, version: row.version, customerId: data.customerId })
  );
}
function userForm(row) {
  modal(
    row ? '账号权限' : '创建账号',
    `<div class="fields">${row ? `<p>账号：${esc(row.username)}</p>` : field('username', '登录账号', '', 'text', true)}${field('displayName', '显示名称', row?.displayName || '', 'text', true)}${select(
      'role',
      '角色',
      [
        ['customer', '客户'],
        ['operator', '运营'],
        ['finance', '财务'],
        ['admin', '管理员']
      ],
      row?.role || 'customer'
    )}${select('customerId', '绑定客户', [['', '员工不绑定客户'], ...customers.filter((c) => c.status === 'active').map((c) => [c.id, c.name])], row?.customerId || '')}${
      row
        ? select(
            'enabled',
            '账号状态',
            [
              ['true', '启用'],
              ['false', '停用']
            ],
            String(row.enabled)
          )
        : field('password', '初始密码（至少15位）', '', 'password', true)
    }</div><p class="hint">客户账号必须绑定客户。修改角色或停用会立即撤销该账号的所有会话。</p>${actions()}`,
    async (data) => {
      const body = row
        ? {
            id: row.id,
            version: row.version,
            displayName: data.displayName,
            role: data.role,
            customerId: data.customerId || null,
            enabled: data.enabled === 'true'
          }
        : {
            username: data.username,
            displayName: data.displayName,
            role: data.role,
            customerId: data.customerId || null,
            password: data.password
          };
      const r = await apiFetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
    }
  );
  const password = document.querySelector('#form input[name=password]');
  if (password) {
    password.minLength = 15;
    password.autocomplete = 'new-password';
  }
}
function reviewInvoice(row, action) {
  const change = row.input;
  const html = `<p>原账单ID：${esc(row.invoiceId)}，提交时版本：${esc(change.version)}</p><p>客户修改原因：${esc(change.reason)}</p><p>拟变更账单：${esc(change.reference)} · ${esc(change.currency)} · ${esc(change.invoiceDate)}</p>${table(
    ['明细参考号', '费用说明', '申请金额'],
    change.lines.map((l) => [esc(l.reference), esc(l.description), money(l.amountCents)])
  )}`;
  if (action === 'view') {
    modal('账单修改申请', html);
    return;
  }
  modal(
    action === 'approve' ? '审核通过账单修改' : '拒绝账单修改',
    html + textarea('note', '审核说明') + actions('确认审核'),
    (data) =>
      api('invoice/review', {
        id: row.id,
        version: row.version,
        decision: action === 'approve' ? 'approved' : 'rejected',
        note: data.note
      })
  );
}
function generateInvoice(row) {
  modal(
    '按实测锁价并建立应收',
    `<p>按当前已审核费率及货箱实测生成账单，后续费率变动不影响此票。</p>${field('reference', '账单号', '', 'text', true)}${actions('锁价开账')}`,
    (data) =>
      api('commercial/invoice/generate', {
        shipmentId: row.id,
        version: row.version,
        reference: data.reference
      })
  );
}
function pricingForm(row) {
  modal(
    '申请费率生效',
    `<div class="fields">${field('rate', '每公斤单价', money(row.rateCents), 'text', true)}${field('fixed', '整票固定费用', money(row.fixedCents), 'text', true)}${field('minimum', '最低计费重', row.minimum, 'number', true)}${field('divisor', '材积系数', row.divisor, 'number', true)}${field('step', '重量进位', row.step, 'number', true)}${textarea('reason', '调整原因及合同依据')}</div><p>需要另一位管理员审核；审批通过后生效。</p>${actions('提交审核')}`,
    (data) =>
      api('commercial/pricing/request', {
        channelId: row.id,
        version: row.version,
        rateCents: nonnegativeMoney(data.rate),
        fixedCents: nonnegativeMoney(data.fixed),
        minimum: Number(data.minimum),
        divisor: Number(data.divisor),
        step: Number(data.step),
        reason: data.reason
      })
  );
  document.querySelectorAll('#form input[type=number]').forEach((input) => (input.step = 'any'));
}
await navigate(location.hash.slice(1) || 'overview');
