import { assertCancellation, releaseCheck, shipmentLocked } from '../commercial/guards.mjs';
import { records } from '../../persistence/records.mjs';
import { transaction } from '../../persistence/transaction.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const config = JSON.parse(
  readFileSync(new URL('../../../public/replica-config.json', import.meta.url))
);
const transitions = {
  ready: ['picked', 'cancelled'],
  picked: ['in_transit', 'returned'],
  in_transit: ['delivered', 'returned'],
  delivered: [],
  returned: [],
  cancelled: []
};
function fieldsOf(columns) {
  const fields = [];
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (x.name && x.type && !['toTitle', 'group'].includes(x.type)) fields.push(x);
    for (const [key, value] of Object.entries(x))
      if (!['options', 'value'].includes(key)) walk(value);
  }
  walk(columns);
  return fields;
}
function profileFields(profile) {
  const fields = new Map(fieldsOf(config.pages.shipment.form.form.columns).map((f) => [f.name, f]));
  for (const f of fieldsOf(profile.form.columns)) fields.set(f.name, f);
  return [...fields.values()].filter((f) => f.type !== 'hidden' && !f.hidden);
}
const optionValues = (options) =>
  Array.isArray(options)
    ? options.flatMap((o) => [String(o.value), ...optionValues(o.children || [])])
    : options && typeof options === 'object'
      ? Object.keys(options)
      : [];
function cents(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw Error('申报单价必须为最多两位小数的正金额');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1e10) throw Error('申报单价超限');
  return amount;
}
export function createShipmentService(db, principal) {
  const repository = records(db, principal);
  const all = () => repository.list('replica:shipment');
  const get = (id) => repository.get('replica:shipment', id);
  const atomic = (fn) => transaction(db, fn);
  const put = (o, action) => {
    const record = repository.put('replica:shipment', o);
    db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(
      new Date().toISOString(),
      'shipment:' + action,
      o.id
    );
    return record;
  };
  const check = (o, v) => {
    if (!Number.isSafeInteger(v) || o.version !== v) throw Error('记录已更新，请刷新后重试');
  };
  const service = {
    list: all,
    saveBatch(inputs) {
      return atomic(() => {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100)
          throw Error('批量保存须为1至100票');
        let rowCount = 0;
        for (const input of inputs) {
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            !Array.isArray(input.parcels)
          )
            throw Error('批量运单格式无效');
          rowCount += input.parcels.length;
          if (rowCount > 2000) throw Error('批量申报行总数不得超过2000行');
        }
        return inputs.map((input) => service.save(input));
      });
    },
    save(b) {
      return atomic(() => {
        const values = b.values;
        if (!values || typeof values !== 'object' || Array.isArray(values))
          throw Error('表单格式无效');
        const prev = b.id ? get(b.id) : null;
        if (prev) {
          check(prev, b.version);
          if (prev.status !== 'ready') throw Error('仅已下单运单可修改');
          if (shipmentLocked(db, prev)) throw Error('运单已有账单，计费数据已锁定');
        }
        const service = values.service ?? prev?.service;
        const profile = Object.hasOwn(config.shipmentProfiles, service || '')
          ? config.shipmentProfiles[service]
          : null;
        const serviceSetting = db
          .prepare(
            "SELECT body FROM records WHERE kind='admin:service' AND json_extract(body,'$.code')=?"
          )
          .get(service);
        if (
          (!prev || prev.service !== service) &&
          serviceSetting &&
          JSON.parse(serviceSetting.body).enabled === false
        )
          throw Error('该服务已暂停本地接单');
        if (!profile?.form?.columns || !profile.excelTableData?.tableColumns?.length)
          throw Error('该服务的动态表单尚未完成原站验证，暂不能下单');
        const fields = profileFields(profile),
          columns = profile.excelTableData.tableColumns;
        const clean = {};
        const allowed = new Set(fields.map((f) => f.name));
        for (const key of Object.keys(values))
          if (!allowed.has(key)) throw Error('不允许字段 ' + key);
        for (const f of fields) {
          let v = values[f.name] ?? prev?.[f.name] ?? f.value ?? '';
          const opts = optionValues(f.options);
          if (f.type === 'checkboxGroup') {
            if (!Array.isArray(v) || v.some((x) => !opts.includes(String(x))))
              throw Error('物品属性无效');
            clean[f.name] = [...new Set(v.map(String))];
            continue;
          }
          if (!['string', 'number', 'boolean'].includes(typeof v)) throw Error('字段格式无效');
          v = String(v).trim();
          if (v.length > 4000) throw Error('字段过长');
          if (f.required && !v) throw Error(f.label + '不能为空');
          if (v && opts.length && !opts.includes(v)) throw Error(f.label + '选项无效');
          clean[f.name] = v;
        }
        if (!clean.service) clean.service = service;
        if (principal?.role === 'customer') {
          for (const [field, kind] of [
            ['store_id', 'replica:store'],
            ['to_warehouse_code', 'replica:address'],
            ['form_warehouse_code', 'replica:address']
          ])
            if (clean[field]) repository.get(kind, clean[field]);
        }
        if (
          all().some(
            (o) =>
              o.id !== b.id &&
              clean.client_reference &&
              o.client_reference === clean.client_reference
          )
        )
          throw Error('客户单号已存在');
        const list = b.parcels;
        if (!Array.isArray(list) || !list.length || list.length > 2000)
          throw Error('填写1至2000行货箱信息');
        let total = 0;
        const allowedParcel = new Set(columns.map((c) => c.name));
        const rows = list.map((row, i) => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('货箱格式无效');
          for (const key of Object.keys(row))
            if (!allowedParcel.has(key)) throw Error('不允许货箱字段 ' + key);
          const out = {};
          for (const c of columns) {
            let value = row[c.name] ?? '';
            if (typeof value === 'string') value = value.trim();
            const mandatory = c.verify || c.label.includes('*');
            if (mandatory && (value === '' || value == null))
              throw Error(`第${i + 1}行 ${c.label.replace(/<[^>]*>/g, '')}不能为空`);
            if (c.type === 'numeric' && c.name !== 'hscode' && value !== '') {
              if (!['string', 'number'].includes(typeof value)) throw Error('货箱数值格式无效');
              const n = Number(value);
              if (
                !Number.isFinite(n) ||
                n < 0 ||
                (mandatory && n === 0) ||
                n > 1e8 ||
                (c.name === 'qty' && (!Number.isInteger(n) || n === 0))
              )
                throw Error('货箱数量/尺寸/重量或申报值无效');
              if (c.name === 'unit_value') cents(value);
              value = n;
            } else {
              if (!['string', 'number', 'boolean'].includes(typeof value))
                throw Error('货箱字段格式无效');
              value = String(value).trim();
              if (value.length > 2000) throw Error('货箱字段过长');
            }
            out[c.name] = value;
          }
          const amount =
            out.unit_value === '' || out.unit_value === undefined
              ? 0
              : cents(out.unit_value) * Number(out.qty || 0);
          total += amount;
          if (!Number.isSafeInteger(total)) throw Error('申报总额超限');
          return out;
        });
        const count = Number(b.parcel_count);
        if (!Number.isInteger(count) || count < 1 || count > 2000)
          throw Error('件数须为1至2000整数');
        const numbered = new Set(rows.map((r, i) => r.number || String(i + 1)));
        if (numbered.size !== count) throw Error('货箱不同箱号数量须等于件数');
        if (b.fba_shipment !== undefined && typeof b.fba_shipment !== 'boolean')
          throw Error('FBA运单标记无效');
        const fba = b.fba_shipment === true;
        if (
          fba &&
          (typeof b.ba_shipment_id !== 'string' || !/^FBA[A-Z0-9]{1,37}$/.test(b.ba_shipment_id))
        )
          throw Error('FBA号格式无效');
        if (
          b.amazon_ref_id !== undefined &&
          b.amazon_ref_id !== null &&
          (typeof b.amazon_ref_id !== 'string' || b.amazon_ref_id.length > 200)
        )
          throw Error('亚马逊参考号无效');
        const internal = Object.fromEntries(
          ['customer_id', 'channel_id', 'outer_carrier', 'updated']
            .filter((k) => prev && Object.hasOwn(prev, k))
            .map((k) => [k, prev[k]])
        );
        if (prev) {
          const oldNumbers = new Set(prev.parcels.map((p, i) => String(p.number || i + 1)));
          if (
            oldNumbers.size === numbered.size &&
            [...numbered].every((n) => oldNumbers.has(String(n)))
          ) {
            for (const k of ['actual_weight', 'actual_volume'])
              if (Object.hasOwn(prev, k)) internal[k] = prev[k];
            const measured = new Map(prev.parcels.map((p, i) => [String(p.number || i + 1), p]));
            for (const [i, row] of rows.entries()) {
              const old = measured.get(String(row.number || i + 1));
              for (const k of ['actual_weight', 'actual_length', 'actual_width', 'actual_height'])
                if (old && Object.hasOwn(old, k)) row[k] = old[k];
            }
          }
        }
        const now = new Date().toISOString();
        return put(
          {
            ...clean,
            ...internal,
            ...(prev && Object.hasOwn(prev, 'problem') ? { problem: prev.problem } : {}),
            ...(prev && Object.hasOwn(prev, 'problem_note')
              ? { problem_note: prev.problem_note }
              : {}),
            id: prev?.id || randomUUID(),
            shipment_number:
              prev?.shipment_number || 'LOCAL' + randomUUID().slice(0, 8).toUpperCase(),
            status: prev?.status || 'ready',
            version: (prev?.version || 0) + 1,
            created: prev?.created || now,
            parcels: rows,
            parcel_count: count,
            declarationCents: total,
            fba_shipment: fba,
            ba_shipment_id: fba ? b.ba_shipment_id : '',
            amazon_ref_id: String(b.amazon_ref_id || ''),
            tracking: prev?.tracking || [],
            charges: prev?.charges || []
          },
          prev ? 'update' : 'create'
        );
      });
    },
    action({ ids, versions, action, note = '', tracking_number = '' }) {
      return atomic(() => {
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 200 ||
          new Set(ids).size !== ids.length
        )
          throw Error('请选择不重复的运单');
        if (typeof note !== 'string' || note.length > 2000) throw Error('说明无效');
        return ids.map((id) => {
          const o = get(id);
          check(o, versions?.[id]);
          if (action === 'problem') {
            o.problem = !o.problem;
            o.problem_note = note;
          } else if (action === 'tracking') {
            if (!note.trim()) throw Error('轨迹内容不能为空');
            o.tracking.push({
              at: new Date().toISOString(),
              note,
              number: String(tracking_number).slice(0, 200)
            });
          } else if (action === 'charge') {
            if (o.status === 'cancelled') throw Error('已取消不能录入费用');
            throw Error('请通过账单模块核对费用');
          } else {
            if (!transitions[o.status]?.includes(action)) throw Error('当前状态不能执行该操作');
            if (action === 'cancelled') assertCancellation(db, o);
            if (action === 'in_transit') o.releaseCheck = releaseCheck(db, o);
            o.status = action;
            o.tracking.push({ at: new Date().toISOString(), status: action, note: note || action });
          }
          o.version++;
          return put(o, action);
        });
      });
    }
  };
  return service;
}
