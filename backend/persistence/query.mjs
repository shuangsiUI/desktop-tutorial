import { httpError } from '../http/io.mjs';
export function queryRecords(db, kind, principal, search) {
  const page = Number(search.get('page') || 1),
    pageSize = Number(search.get('pageSize') || 30),
    q = search.get('q') || '',
    status = search.get('status') || '';
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    q.length > 200 ||
    status.length > 40
  )
    throw httpError(400, '分页或筛选参数无效');
  const clauses = ['kind=?', "COALESCE(json_extract(body,'$.archived'),0)<>1"],
    params = [kind];
  const statusExpr =
    kind === 'replica:invoice'
      ? "CASE WHEN json_extract(body,'$.lifecycle')='void' THEN '4' WHEN json_extract(body,'$.totalCents')=json_extract(body,'$.allocatedCents') THEN '3' ELSE '2' END"
      : "CAST(COALESCE(json_extract(body,'$.status'),'') AS TEXT)";
  if (principal?.role === 'customer') {
    if (!principal.customerId) throw httpError(403, '未绑定客户');
    clauses.push("json_extract(body,'$.customer_id')=?");
    params.push(principal.customerId);
  }
  if (q) {
    clauses.push('instr(lower(body),lower(?))>0');
    params.push(q);
  }
  if (search.has('filter')) {
    const raw = search.get('filter');
    if (raw.length > 4000) throw httpError(400, '筛选过长');
    let filter;
    try {
      filter = JSON.parse(raw);
    } catch {
      throw httpError(400, '筛选格式无效');
    }
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw httpError(400, '筛选格式无效');
    const exact = ['service', 'country', 'store_id', 'depot_id', 'name'],
      contains = ['to_warehouse_code', 'postcode'],
      dates = ['created', 'picking', 'delivered'];
    for (const [key, value] of Object.entries(filter)) {
      if (kind === 'replica:invoice') {
        invoiceFilter(key, value, clauses, params, statusExpr);
        continue;
      }
      if (typeof value !== 'string' || value.length > 1000) throw httpError(400, '筛选值无效');
      if (
        ![
          ...exact,
          ...contains,
          'keyword',
          ...dates.flatMap((k) => [k + '_from', k + '_to'])
        ].includes(key)
      )
        throw httpError(400, '筛选字段无效');
      if (!value) continue;
      if (exact.includes(key)) {
        clauses.push(`CAST(COALESCE(json_extract(body,'$.${key}'),'') AS TEXT)=?`);
        params.push(value);
      } else if (contains.includes(key) || key === 'keyword') {
        const terms = value
          .split(/[,，\n]/)
          .map((t) => t.trim())
          .filter(Boolean);
        if (terms.length > 20) throw httpError(400, '最多20个检索词');
        if (!terms.length) continue;
        const fields =
          key === 'keyword'
            ? [
                'shipment_number',
                'client_reference',
                'reference_1',
                'reference_2',
                'ba_shipment_id'
              ]
            : [key];
        clauses.push(
          '(' +
            terms
              .map(
                (term) =>
                  '(' +
                  fields
                    .map((f) => {
                      params.push(term);
                      return `instr(COALESCE(json_extract(body,'$.${f}'),''),?)>0`;
                    })
                    .join(' OR ') +
                  ')'
              )
              .join(' OR ') +
            ')'
        );
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError(400, '筛选日期无效');
        const dateKind = key.replace(/_(from|to)$/, ''),
          state = dateKind === 'picking' ? 'picked' : 'delivered',
          expression =
            dateKind === 'created'
              ? "substr(json_extract(body,'$.created'),1,10)"
              : `substr(COALESCE(json_extract(body,'$.${dateKind}_at'),(SELECT json_extract(value,'$.at') FROM json_each(records.body,'$.tracking') WHERE json_extract(value,'$.status')='${state}' LIMIT 1)),1,10)`;
        clauses.push(expression + (key.endsWith('_from') ? '>=?' : '<=?'));
        params.push(value);
      }
    }
  }
  const base = clauses.join(' AND '),
    counts = Object.fromEntries(
      db
        .prepare(
          'SELECT ' +
            statusExpr +
            ' status,count(*) n FROM records WHERE ' +
            base +
            ' GROUP BY ' +
            statusExpr
        )
        .all(...params)
        .map((r) => [r.status, r.n])
    );
  if (status && status !== 'all') {
    clauses.push(statusExpr + '=?');
    params.push(status);
  }
  const where = clauses.join(' AND '),
    total = db.prepare('SELECT count(*) n FROM records WHERE ' + where).get(...params).n,
    actualPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  return {
    items: db
      .prepare('SELECT body FROM records WHERE ' + where + ' ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(...params, pageSize, (actualPage - 1) * pageSize)
      .map((r) => JSON.parse(r.body)),
    page: actualPage,
    pageSize,
    total,
    counts
  };
}

function invoiceFilter(key, value, clauses, params, statusExpr) {
  if (
    !['number', 'shipment_id', 'status', 'from', 'to'].includes(key) ||
    typeof value !== 'string' ||
    value.length > 1000
  )
    throw httpError(400, '账单筛选无效');
  if (!value || value === 'all') return;
  if (key === 'number') {
    clauses.push("instr(COALESCE(json_extract(body,'$.reference'),''),?)>0");
    params.push(value.trim());
  }
  if (key === 'status') {
    if (!['2', '3', '4'].includes(value)) throw httpError(400, '账单状态无效');
    clauses.push(statusExpr + '=?');
    params.push(value);
  }
  if (['from', 'to'].includes(key)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError(400, '账单日期筛选无效');
    clauses.push(
      "substr(json_extract(body,'$.invoiceDate'),1,10)" + (key === 'from' ? '>=?' : '<=?')
    );
    params.push(value);
  }
  if (key === 'shipment_id') {
    const terms = value
      .split(/[,，\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length > 10) throw httpError(400, '运单号最多支持10个');
    if (!terms.length) return;
    clauses.push(
      '(' +
        terms
          .map((term) => {
            params.push(term, term, term);
            return "EXISTS(SELECT 1 FROM json_each(records.body,'$.lines') line LEFT JOIN records shipment ON shipment.id=json_extract(line.value,'$.shipmentId') AND shipment.kind='replica:shipment' WHERE instr(COALESCE(json_extract(line.value,'$.shipmentId'),''),?)>0 OR instr(COALESCE(json_extract(line.value,'$.reference'),''),?)>0 OR instr(COALESCE(json_extract(shipment.body,'$.shipment_number'),''),?)>0)";
          })
          .join(' OR ') +
        ')'
    );
  }
}
