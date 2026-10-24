import { operationalStatus } from '../operations/status.mjs';
import { inspectIntegrity } from '../operations/integrity.mjs';
import { requirePermission } from '../security/policy.mjs';
import { createCommercialService } from '../modules/commercial/service.mjs';
import { json, readJson, httpError } from './io.mjs';
import { invoke } from './admin.mjs';
import { context } from '../persistence/context.mjs';
export function createCommercialRouter(db) {
  return async (req, res, url, p) => {
    const client = url.pathname.startsWith('/api/replica/ledger/'),
      admin = url.pathname.startsWith('/api/admin/commercial/');
    if (!client && !admin) return false;
    if (!p) throw httpError(401, '请先登录');
    if (admin && p.role === 'customer') throw httpError(403, '没有管理端权限');
    const key = url.pathname.slice(client ? 20 : 22),
      service = createCommercialService(db, p),
      options = {
        page: Number(url.searchParams.get('page') || 1),
        pageSize: Number(url.searchParams.get('pageSize') || 30)
      };
    const reads = {
      status: () => {
        requirePermission(p, 'system:read');
        return operationalStatus(db);
      },
      integrity: () => {
        requirePermission(p, 'system:read');
        return inspectIntegrity(db);
      },
      transactions: () =>
        service.transactions({
          ...options,
          kind: url.searchParams.get('kind') || undefined,
          customerId: url.searchParams.get('customerId') || undefined
        }),
      accounts: service.accounts,
      requests: () => service.requests(options),
      changes: () => service.changes(options)
    };
    const writes = {
      receipt: service.receipt,
      'allocation/reverse': service.reverseAllocation,
      'invoice/generate': service.generateInvoice,
      'pricing/request': service.requestPricing,
      'measurement/request': service.requestMeasurement,
      'invoice/adjustment': service.requestAdjustment,
      'invoice/void': service.requestVoid,
      'refund/request': service.requestRefund,
      review: service.review
    };
    if (req.method === 'GET') {
      if (!Object.hasOwn(reads, key) || (client && !['transactions', 'accounts'].includes(key)))
        throw httpError(404, '接口不存在');
      json(res, 200, await invoke(reads[key]));
      return true;
    }
    if (req.method !== 'POST') throw httpError(405, '不支持的方法');
    if (client || !Object.hasOwn(writes, key)) throw httpError(403, '没有此操作权限');
    const body = await readJson(req);
    context().reason = typeof body.reason === 'string' ? body.reason.slice(0, 2000) : null;
    json(res, 200, await invoke(() => writes[key](body)));
    return true;
  };
}
