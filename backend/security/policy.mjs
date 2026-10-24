const grants = {
  admin: ['*'],
  operator: [
    'dashboard:read',
    'shipments:read',
    'shipments:write',
    'catalog:read',
    'catalog:write',
    'customers:read',
    'channels:read',
    'pricing:propose',
    'approvals:read',
    'services:read',
    'bookings:read',
    'bookings:write'
  ],
  finance: [
    'dashboard:read',
    'shipments:read',
    'customers:read',
    'channels:read',
    'finance:read',
    'finance:write',
    'pricing:propose',
    'approvals:read'
  ],
  customer: ['client:access']
};
export const permissions = (role) => grants[role] || [];
export const can = (p, permission) =>
  !!p && (permissions(p.role).includes('*') || permissions(p.role).includes(permission));
export function requirePermission(p, permission) {
  if (!p) {
    const e = Error('请先登录');
    e.status = 401;
    throw e;
  }
  if (!can(p, permission)) {
    const e = Error('没有此操作权限');
    e.status = 403;
    throw e;
  }
}
