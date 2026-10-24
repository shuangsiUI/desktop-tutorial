import { queryRecords } from '../persistence/query.mjs';
import { createAdminService } from '../modules/operations/service.mjs';
import { createShipmentService } from '../modules/shipments/service.mjs';
import { createFinanceService } from '../modules/finance/service.mjs';
import { createReplicaService } from '../modules/catalog/service.mjs';
import { requirePermission } from '../security/policy.mjs';
import { json, readJson, httpError } from './io.mjs';
import { invoke } from './admin.mjs';
export function createReplicaRouter(db) {
  return async (req, res, url, p) => {
    if (!url.pathname.startsWith('/api/replica/')) return false;
    if (!p) throw httpError(401, '请先登录');
    const parts = url.pathname.slice(13).split('/');
    if (parts.length > 2 || parts.some((v) => !v)) throw httpError(404, '接口不存在');
    const [module, action] = parts;
    const isCustomer = p.role === 'customer',
      admin = createAdminService(db),
      shipment = createShipmentService(db, p),
      finance = createFinanceService(db, p),
      catalog = createReplicaService(db, p);
    const customer = isCustomer ? admin.customers().find((c) => c.id === p.customerId) : null;
    const channels = () =>
      admin
        .channels()
        .filter(
          (c) =>
            c.status === 'active' &&
            (!isCustomer || !customer?.channelIds?.length || customer.channelIds.includes(c.id))
        )
        .map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          country: c.country,
          transport: c.transport,
          serviceCode: c.serviceCode,
          currency: c.currency,
          rateCents: c.rateCents,
          fixedCents: c.fixedCents,
          remark: c.remark,
          status: c.status
        }));
    const group =
      module === 'shipment'
        ? 'shipments'
        : ['finance', 'invoice', 'account', 'recharge', 'revisions'].includes(module)
          ? 'finance'
          : ['channels', 'channel'].includes(module)
            ? 'channels'
            : ['booking', 'cabin'].includes(module)
              ? 'bookings'
              : 'catalog';
    if (isCustomer) requirePermission(p, 'client:access');
    else
      requirePermission(
        p,
        group +
          ':' +
          (req.method === 'GET' || (module === 'channel' && action === 'quote') ? 'read' : 'write')
      );
    if (req.method === 'GET') {
      if (
        !action &&
        url.searchParams.has('page') &&
        [
          'shipment',
          'invoice',
          'revisions',
          'address',
          'product',
          'vat',
          'store',
          'booking',
          'cabin'
        ].includes(module)
      ) {
        const result = queryRecords(
          db,
          'replica:' + (module === 'revisions' ? 'invoice-revision' : module),
          p,
          url.searchParams
        );
        if (module === 'invoice') result.items = result.items.map((r) => finance.present(r));
        json(res, 200, result);
        return true;
      }
      if (action && module !== 'invoice') throw httpError(404, '接口不存在');
      let data;
      if (module === 'channels') data = channels();
      else if (module === 'shipment') data = shipment.list();
      else if (module === 'finance') data = finance.overview();
      else if (module === 'invoice')
        data = action ? finance.invoice(action) : finance.listInvoices();
      else if (module === 'revisions') data = finance.listRevisions();
      else if (['account', 'recharge', 'ticket'].includes(module)) data = [];
      else if (['address', 'product', 'vat', 'store', 'booking', 'cabin'].includes(module))
        data = catalog.list(module);
      else throw httpError(404, '接口不存在');
      json(res, 200, data);
      return true;
    }
    if (req.method !== 'POST') throw httpError(405, '不支持的方法');
    const body = await readJson(req);
    const value = await invoke(() => {
      if (module === 'channel' && action === 'quote') {
        if (!channels().some((c) => c.id === body.id)) throw httpError(404, '渠道不存在');
        return admin.quoteChannel(body);
      }
      if (module === 'finance') {
        if (action === 'update')
          return isCustomer ? finance.requestRevision(body) : finance.updateInvoice(body);
        if (isCustomer) throw httpError(403, '客户不可创建账单或登记核销');
        if (action === 'import') return finance.importInvoice(body);
        if (action === 'allocate') return finance.recordAllocation(body);
        throw httpError(404, '接口不存在');
      }
      if (module === 'shipment') {
        if (action === 'action') {
          if (isCustomer && !['cancelled', 'problem'].includes(body.action))
            throw httpError(403, '客户不可更改物流状态或路由');
          return shipment.action(body);
        }
        if (action === 'batch') return shipment.saveBatch(body.inputs);
        if (action) throw httpError(404, '接口不存在');
        return shipment.save(body);
      }
      if (!['address', 'product', 'vat', 'store', 'booking', 'cabin'].includes(module))
        throw httpError(404, '接口不存在');
      if (action === 'cancel') return catalog.cancel(module, body);
      if (action === 'archive') return catalog.archive(module, body);
      if (action) throw httpError(404, '接口不存在');
      return catalog.save(module, body);
    });
    json(res, 200, value);
    return true;
  };
}
