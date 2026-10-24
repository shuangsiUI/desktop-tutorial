import { assignLegacyGroup } from '../modules/commercial/assignment.mjs';
import { dashboard } from '../modules/operations/dashboard.mjs';
import { queryRecords } from '../persistence/query.mjs';
import { context } from '../persistence/context.mjs';
import { createAdminService } from '../modules/operations/service.mjs';
import { createShipmentService } from '../modules/shipments/service.mjs';
import { createFinanceService } from '../modules/finance/service.mjs';
import { createReplicaService } from '../modules/catalog/service.mjs';
import { requirePermission } from '../security/policy.mjs';
import { json, readJson, httpError } from './io.mjs';
export async function invoke(fn) {
  try {
    context().assertSession?.();
    return await fn();
  } catch (e) {
    if (!e.status && [5, 6].includes(Number(e.errcode) & 255)) {
      e.status = 503;
      e.message = '数据库繁忙，请稍后重试';
    }
    if (
      !e.status &&
      (String(e.code || '').startsWith('SQLITE_CONSTRAINT') || (Number(e.errcode) & 255) === 19)
    ) {
      e.status = 409;
      e.message = '数据关联或唯一约束冲突，请刷新并检查关联记录';
    }
    if (!e.status && !e.code && !(e instanceof TypeError) && !(e instanceof SyntaxError))
      e.status = 400;
    throw e;
  }
}
export function createAdminRouter(db) {
  return async (req, res, url, p) => {
    if (!url.pathname.startsWith('/api/admin/')) return false;
    if (p?.role === 'customer') throw httpError(403, '没有管理端权限');
    const admin = createAdminService(db),
      shipment = createShipmentService(db, p),
      finance = createFinanceService(db, p),
      catalog = createReplicaService(db, p);
    const reads = {
      summary: ['dashboard:read', () => dashboard(db, p)],
      customers: ['customers:read', admin.customers],
      channels: ['channels:read', admin.channels],
      services: ['services:read', admin.services],
      shipments: ['shipments:read', admin.shipments],
      audit: ['system:read', admin.audit],
      invoices: ['finance:read', finance.listInvoices],
      finance: ['finance:read', finance.overview],
      revisions: ['finance:read', finance.listRevisions],
      booking: ['bookings:read', () => catalog.list('booking')],
      cabin: ['bookings:read', () => catalog.list('cabin')]
    };
    const writes = {
      'record/assign-group': ['customers:write', (b) => assignLegacyGroup(db, p, b)],
      'record/assign': ['catalog:write', (b) => catalog.assign(b.module, b)],
      'invoice/assign': ['finance:write', finance.assignInvoice],
      'channel/quote': ['channels:read', admin.quoteChannel],
      'channel/save': ['channels:write', admin.saveChannel],
      'channel/archive': ['channels:write', admin.archiveChannel],
      'customer/save': ['customers:write', admin.saveCustomer],
      'service/save': ['services:write', admin.saveService],
      'shipment/update': ['shipments:write', admin.updateShipment],
      'shipment/action': ['shipments:write', shipment.action],
      'invoice/save': ['finance:write', finance.importInvoice],
      'invoice/update': ['finance:write', finance.updateInvoice],
      'invoice/allocate': ['finance:write', finance.recordAllocation],
      'invoice/review': ['finance:write', finance.reviewRevision],
      'booking/cancel': ['bookings:write', (b) => catalog.cancel('booking', b)],
      'cabin/cancel': ['bookings:write', (b) => catalog.cancel('cabin', b)]
    };
    const key = url.pathname.slice(11),
      map = req.method === 'GET' ? reads : req.method === 'POST' ? writes : null;
    if (!map) throw httpError(405, '不支持的方法');
    if (!Object.hasOwn(map, key)) throw httpError(404, '接口不存在');
    const [permission, fn] = map[key];
    requirePermission(p, permission);
    const kinds = {
      customers: 'admin:customer',
      channels: 'admin:channel',
      shipments: 'replica:shipment',
      invoices: 'replica:invoice',
      revisions: 'replica:invoice-revision',
      booking: 'replica:booking',
      cabin: 'replica:cabin'
    };
    if (req.method === 'GET' && url.searchParams.has('page') && kinds[key]) {
      const result = queryRecords(db, kinds[key], p, url.searchParams);
      if (key === 'invoices') result.items = result.items.map((r) => finance.present(r));
      json(res, 200, result);
      return true;
    }
    const body = req.method === 'POST' ? await readJson(req) : null;
    if (body && typeof body.reason === 'string') context().reason = body.reason.slice(0, 2000);
    json(res, 200, await invoke(() => (body ? fn(body) : fn())));
    return true;
  };
}
