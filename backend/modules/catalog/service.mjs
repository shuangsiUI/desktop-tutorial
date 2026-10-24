import { records } from '../../persistence/records.mjs';
import { transaction } from '../../persistence/transaction.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const modules = ['address', 'product', 'vat', 'store', 'booking', 'cabin'];
const definitions = Object.fromEntries(
  modules.map((module) => {
    const raw = JSON.parse(
      readFileSync(new URL(`../../../schemas/${module}-form-schema.json`, import.meta.url))
    );
    const fields = [];
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (value.name && value.type && !['hidden', 'toTitle'].includes(value.type))
        fields.push(value);
      for (const child of Object.values(value)) if (typeof child === 'object') walk(child);
    }
    walk(raw);
    return [module, fields];
  })
);
const initial = { product: 'pending', vat: 'pending', booking: 'ready', cabin: 'apply' };
const numeric = new Set([
  'unit_value',
  'weight',
  'sale_price',
  'duty_rate',
  'box_count',
  'volume',
  'scheduled_capacity'
]);
const fail = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
function validDate(value) {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, y, m, d, h, minute, sec] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    (h === undefined || (Number(h) < 24 && Number(minute) < 60 && Number(sec || 0) < 60))
  );
}
function attachments(value, field, budget) {
  if (value === '') return [];
  if (!Array.isArray(value) || value.length > (field.filesCount || 10))
    fail(`${field.label}附件数量无效`);
  return value.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).some((key) => !['name', 'type', 'size', 'data'].includes(key))
    )
      fail('附件格式无效');
    if (
      typeof file.name !== 'string' ||
      !file.name.trim() ||
      file.name.length > 255 ||
      /[\x00-\x1f/\\]/.test(file.name)
    )
      fail('附件文件名无效');
    if (!['image/png', 'image/jpeg'].includes(file.type)) fail('附件仅支持PNG或JPEG图片');
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES)
      fail('单个附件不得超过5MB');
    if (
      typeof file.data !== 'string' ||
      file.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64
    )
      fail('附件数据过大或无效');
    const uri = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.data);
    if (file.data.startsWith('data:') && (!uri || uri[1] !== file.type)) fail('附件数据类型无效');
    const encoded = uri ? uri[2] : file.data;
    if (
      !encoded ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      fail('附件Base64无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length !== file.size)
      fail('附件大小与实际内容不一致');
    const png =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes.at(-2) === 255 &&
      bytes.at(-1) === 217;
    if (!(file.type === 'image/png' ? png : jpeg)) fail('附件内容与图片格式不一致');
    budget.bytes += bytes.length;
    if (budget.bytes > MAX_ATTACHMENT_BYTES) fail('附件总大小不得超过5MB');
    return {
      name: file.name.trim(),
      type: file.type,
      size: bytes.length,
      data: `data:${file.type};base64,${encoded}`
    };
  });
}
export function createReplicaService(db, principal) {
  const repository = records(db, principal);
  const checkModule = (module) => {
    if (!modules.includes(module)) fail('不支持的业务模块');
  };
  const rows = (module) => repository.list('replica:' + module);
  const get = (module, id) => repository.get('replica:' + module, id);
  const atomic = (fn) => transaction(db, fn);
  const persist = (module, record, action) => {
    const saved = repository.put('replica:' + module, record);
    db.prepare('INSERT INTO audit(at,action,object) VALUES(?,?,?)').run(
      new Date().toISOString(),
      module + ':' + action,
      record.id
    );
    return saved;
  };
  const versionCheck = (record, version) => {
    if (!Number.isInteger(version) || record.version !== version)
      fail('记录已变更，请刷新后重试', 409);
  };
  return {
    list(module, { includeArchived = false } = {}) {
      checkModule(module);
      return rows(module).filter((row) => includeArchived || !row.archived);
    },
    save(module, { id, version, values } = {}) {
      checkModule(module);
      return atomic(() => {
        if (!values || typeof values !== 'object' || Array.isArray(values))
          fail('values 必须为对象');
        const previous = id ? get(module, id) : null;
        if (previous) {
          versionCheck(previous, version);
          if (previous.archived) fail('已删除记录不可编辑');
          if (
            (module === 'booking' && previous.status === 'cancelled') ||
            (module === 'cabin' && previous.status === 'cancel')
          )
            fail('已取消的本地记录不可修改');
        }
        const fields = definitions[module],
          allowed = new Set(fields.map((field) => field.name));
        for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`不允许字段：${key}`);
        const clean = {},
          attachmentBudget = { bytes: 0 };
        for (const field of fields) {
          let value = Object.hasOwn(values, field.name)
            ? values[field.name]
            : (previous?.[field.name] ?? field.value ?? '');
          if (value === null) value = '';
          if (typeof value === 'string') value = value.trim();
          if (field.required && value === '') fail(`${field.label}不能为空`);
          if (value !== '' && (field.type === 'number' || numeric.has(field.name))) {
            if (
              typeof value === 'boolean' ||
              !['string', 'number'].includes(typeof value) ||
              !Number.isFinite(Number(value)) ||
              Number(value) < 0 ||
              Number(value) > Number.MAX_SAFE_INTEGER
            )
              fail(`${field.label}必须为非负数`);
            value = Number(value);
            if (field.name === 'box_count' && !Number.isInteger(value)) fail('预约箱数必须为整数');
          } else if (['switch', 'checkbox'].includes(field.type)) {
            if (![0, 1, false, true, '0', '1'].includes(value)) fail(`${field.label}必须为是或否`);
            value = Number(value);
          } else if (field.type === 'date') {
            if (value !== '' && !validDate(value)) fail(`${field.label}日期无效`);
          } else if (field.type === 'uploadImage')
            value = attachments(value, field, attachmentBudget);
          else if (typeof value !== 'string') fail(`${field.label}必须为文本`);
          if (typeof value === 'string' && value.length > 20000) fail(`${field.label}过长`);
          const options = field.options;
          const keys = Array.isArray(options)
            ? options.map((option) => String(option.value))
            : options && typeof options === 'object'
              ? Object.keys(options)
              : [];
          if (value !== '' && keys.length && !keys.includes(String(value)))
            fail(`${field.label}选项无效`);
          clean[field.name] = value;
        }
        const unique = module === 'product' ? 'sku' : module === 'address' ? 'code' : null;
        if (
          unique &&
          rows(module).some(
            (row) => !row.archived && row.id !== id && row[unique] === clean[unique]
          )
        )
          fail(`${unique === 'sku' ? '商品SKU' : '地址编码'}已存在`, 409);
        if (module === 'booking') {
          if (clean.box_count <= 0 || clean.weight <= 0) fail('预约箱数和预计重量必须大于0');
          const address = get('address', clean.address_id);
          if (address.archived || address.type !== 'booking') fail('请选择有效的预约取件地址');
        }
        const now = new Date().toISOString();
        return persist(
          module,
          {
            ...clean,
            ...(previous?.customer_id ? { customer_id: previous.customer_id } : {}),
            id: previous?.id || randomUUID(),
            version: (previous?.version || 0) + 1,
            status: previous?.status || initial[module] || '',
            created: previous?.created || now,
            updated: now,
            archived: false,
            ...(module === 'booking'
              ? { number: previous?.number || `LOCAL-${randomUUID().slice(0, 8)}` }
              : {})
          },
          previous ? 'update' : 'create'
        );
      });
    },
    cancel(module, { ids, versions, note = '' } = {}) {
      checkModule(module);
      if (!['booking', 'cabin'].includes(module)) fail('此模块不支持本地取消');
      return atomic(() => {
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== 'string' || !id)
        )
          fail('请选择不重复的记录，最多1000条');
        if (typeof note !== 'string' || note.length > 2000) fail('取消说明无效');
        const records = ids.map((id, index) => {
          const record = get(module, id);
          versionCheck(record, Array.isArray(versions) ? versions[index] : versions?.[id]);
          if (record.archived) fail('已删除记录不可取消');
          if (record.status !== initial[module]) fail('仅初始状态的本地记录可取消');
          return record;
        });
        const now = new Date().toISOString();
        return records.map((record) =>
          persist(
            module,
            {
              ...record,
              status: module === 'booking' ? 'cancelled' : 'cancel',
              version: record.version + 1,
              updated: now,
              cancellation: { at: now, note: note.trim(), scope: 'local' }
            },
            'cancel-local'
          )
        );
      });
    },
    assign(module, { id, version, customerId } = {}) {
      if (principal?.role === 'customer') fail('没有分配权限', 403);
      checkModule(module);
      return atomic(() => {
        const row = get(module, id);
        versionCheck(row, version);
        if (row.customer_id && row.customer_id !== customerId) fail('已有客户归属，不能直接转移');
        const owner = db
          .prepare("SELECT body FROM records WHERE kind='admin:customer' AND id=?")
          .get(customerId || '');
        if (!owner || JSON.parse(owner.body).status !== 'active') fail('客户不存在或已停用');
        if (module === 'booking' && get('address', row.address_id).customer_id !== customerId)
          fail('请先分配预约地址给同一客户');
        return persist(
          module,
          {
            ...row,
            customer_id: customerId,
            version: row.version + 1,
            updated: new Date().toISOString()
          },
          'assign-customer'
        );
      });
    },
    archive(module, { ids, versions } = {}) {
      checkModule(module);
      return atomic(() => {
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          new Set(ids).size !== ids.length
        )
          fail('请选择不重复的记录，最多1000条');
        const records = ids.map((id, index) => {
          const record = get(module, id);
          versionCheck(record, Array.isArray(versions) ? versions[index] : versions?.[id]);
          if (record.archived) fail('记录已删除');
          return record;
        });
        return records.map((record) =>
          persist(
            module,
            {
              ...record,
              archived: true,
              version: record.version + 1,
              updated: new Date().toISOString()
            },
            'archive'
          )
        );
      });
    }
  };
}
