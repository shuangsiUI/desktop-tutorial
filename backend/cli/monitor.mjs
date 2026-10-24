import { openDatabase } from '../persistence/database.mjs';
import { operationalStatus } from '../operations/status.mjs';
const db = openDatabase();
try {
  const status = operationalStatus(db);
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
} finally {
  db.close();
}
