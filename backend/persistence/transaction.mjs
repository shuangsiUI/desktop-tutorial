import { randomUUID } from 'node:crypto';
export function transaction(db, fn) {
  const nested = db.isTransaction,
    point = 'tx_' + randomUUID().replaceAll('-', '');
  db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec(nested ? `RELEASE SAVEPOINT ${point}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO SAVEPOINT ${point}`);
      db.exec(`RELEASE SAVEPOINT ${point}`);
    } else db.exec('ROLLBACK');
    throw error;
  }
}
