import { can, requirePermission } from '../../security/policy.mjs';
import { createFinanceService } from '../finance/service.mjs';
export function dashboard(db, principal) {
  requirePermission(principal, 'dashboard:read');
  const counts = (kind, permission) =>
    can(principal, permission)
      ? Object.fromEntries(
          db
            .prepare(
              "SELECT COALESCE(json_extract(body,'$.status'),'') status,count(*) n FROM records WHERE kind=? AND COALESCE(json_extract(body,'$.archived'),0)<>1 GROUP BY json_extract(body,'$.status')"
            )
            .all(kind)
            .map((r) => [r.status, r.n])
        )
      : {};
  return {
    shipments: counts('replica:shipment', 'shipments:read'),
    customers: counts('admin:customer', 'customers:read'),
    bookings: counts('replica:booking', 'bookings:read'),
    cabins: counts('replica:cabin', 'bookings:read'),
    finance: can(principal, 'finance:read')
      ? createFinanceService(db, principal).overview()
      : { byCurrency: [] },
    audit: can(principal, 'system:read')
      ? db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 8').all()
      : []
  };
}
