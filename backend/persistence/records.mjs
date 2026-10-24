// Ownership is assigned only by authenticated application context or staff workflows.
export function records(db, principal) {
  const scoped = principal?.role === 'customer';
  if (scoped && !principal.customerId) throw Error('客户账号未绑定客户');
  const clause = scoped ? " AND json_extract(body,'$.customer_id')=?" : '';
  return {
    list(kind) {
      return db
        .prepare('SELECT body FROM records WHERE kind=?' + clause + ' ORDER BY rowid DESC')
        .all(...(scoped ? [kind, principal.customerId] : [kind]))
        .map((r) => JSON.parse(r.body));
    },
    get(kind, id) {
      if (typeof id !== 'string' || !id || id.length > 200) {
        const e = Error('记录ID无效');
        e.status = 400;
        throw e;
      }
      const row = db
        .prepare('SELECT body FROM records WHERE kind=? AND id=?' + clause)
        .get(...(scoped ? [kind, id, principal.customerId] : [kind, id]));
      if (!row) {
        const e = Error('记录不存在');
        e.status = 404;
        throw e;
      }
      return JSON.parse(row.body);
    },
    owner(record) {
      return scoped ? { ...record, customer_id: principal.customerId } : record;
    },
    put(kind, record) {
      const row = this.owner(record);
      db.prepare(
        'INSERT INTO records(id,kind,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body'
      ).run(row.id, kind, JSON.stringify(row));
      return row;
    }
  };
}
