import { shipmentDetails } from '../../shipment.mjs';
import { randomUUID } from 'node:crypto';
import { quote, required, num, transition } from '../../domain.mjs';
import { requirePermission } from '../security/policy.mjs';
import { json, readJson } from './io.mjs';
export function createLegacyRouter(db) {
  const all = (k) =>
    db
      .prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC')
      .all(k)
      .map((r) => JSON.parse(r.body));
  const get = (id) => {
    const r = db.prepare('SELECT body FROM records WHERE id=?').get(id);
    if (!r) throw Error('记录不存在');
    return JSON.parse(r.body);
  };
  function save(kind, o, action) {
    db.prepare(
      'INSERT INTO records(id,kind,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body'
    ).run(o.id, kind, JSON.stringify(o));
    db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(
      new Date().toISOString(),
      action,
      o.id
    );
    return o;
  }
  function mutate(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return async (req, res, url, p) => {
    requirePermission(p, 'legacy:manage');
    const send = (status, value) => {
      json(res, status, value);
      return true;
    };
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/state')
        return send(200, {
          channels: all('channel'),
          orders: all('order'),
          audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all()
        });
      if (req.method !== 'POST') return send(404, { error: '接口不存在' });
      const b = await readJson(req, 200000);
      const result = mutate(() => {
        if (url.pathname === '/api/channels') {
          return save(
            'channel',
            {
              id: randomUUID(),
              name: required(b.name, '渠道'),
              carrier: required(b.carrier, '承运商'),
              destination: required(b.destination, '目的国家'),
              currency: ['CNY', 'USD'].includes(b.currency) ? b.currency : 'CNY',
              rateCents: Math.round(num(b.rate, '每kg费率', 0, 100000) * 100),
              fixedCents: Math.round(num(b.fixed, '固定费用', 0, 100000) * 100),
              divisor: num(b.divisor, '体积除数', 1, 100000),
              minimum: num(b.minimum, '最低计费kg', 0, 10000),
              step: num(b.step, '进位kg', 0.001, 100),
              version: 1
            },
            '创建渠道'
          );
        }
        if (url.pathname === '/api/quote') {
          const c = get(b.channelId);
          if (!c.carrier) throw Error('渠道无效');
          return quote(c, b.boxes);
        }
        if (url.pathname === '/api/orders') {
          const c = get(b.channelId);
          if (!c.carrier) throw Error('渠道无效');
          const q = quote(c, b.boxes);
          const ref = required(b.reference, '业务编号');
          if (all('order').some((o) => o.reference === ref)) throw Error('业务编号已存在');
          return save(
            'order',
            {
              id: randomUUID(),
              reference: ref,
              shipmentId: required(b.shipmentId, 'Amazon货件编号（手工）'),
              warehouse: required(b.warehouse, 'FBA目的仓'),
              channel: c,
              details: shipmentDetails(b.details),
              ...q,
              status: 'draft',
              tracking: '',
              events: [],
              createdAt: new Date().toISOString(),
              version: 1,
              invoice: null
            },
            '创建物流单'
          );
        }
        const o = get(b.id);
        if (!o.status) throw Error('物流单无效');
        if (o.version !== b.version) throw Error('记录已更新，请刷新后再操作');
        if (url.pathname === '/api/status') {
          transition(o, b.status, b.tracking);
          if (b.status === 'booked') {
            const t = required(b.tracking, '运单号');
            if (
              all('order').some(
                (x) => x.id !== o.id && x.tracking.toLowerCase() === t.toLowerCase()
              )
            )
              throw Error('运单号已使用');
            o.tracking = t;
          }
          o.status = b.status;
          o.events.push({
            at: new Date().toISOString(),
            status: b.status,
            note: required(b.note, '操作说明')
          });
          o.version++;
          return save('order', o, '更新人工轨迹');
        }
        if (url.pathname === '/api/invoice') {
          if (o.status !== 'delivered') throw Error('仅签收后可核对账单');
          if (o.invoice?.confirmed) throw Error('已确认账单不可修改');
          const cents = Math.round(num(b.amount, '实际费用', 0, 100000000) * 100);
          o.invoice = {
            amountCents: cents,
            differenceCents: cents - o.estimatedCents,
            note: required(b.note, '差异或核对说明'),
            confirmed: b.confirmed === true,
            at: new Date().toISOString()
          };
          o.version++;
          return save('order', o, b.confirmed ? '确认费用对账' : '保存账单');
        }
        throw Error('接口不存在');
      });
      send(200, result);
      return true;
    }
    return false;
  };
}
