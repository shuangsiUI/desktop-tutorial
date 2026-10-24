import { openDatabase } from '../persistence/database.mjs';
import { inspectIntegrity } from '../operations/integrity.mjs';
const db = openDatabase();
try {
  const report = inspectIntegrity(db);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  db.close();
}
