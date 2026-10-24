import { openDatabase } from '../persistence/database.mjs';
import { backupDatabase } from '../operations/backup.mjs';
process.umask(0o077);
const db = openDatabase();
try {
  console.log(
    JSON.stringify(
      await backupDatabase(db, {
        directory: process.env.BACKUP_DIR || 'data/backups',
        remoteDirectory: process.env.BACKUP_REMOTE_DIR,
        secret: process.env.BACKUP_ENCRYPTION_KEY,
        production: process.env.NODE_ENV === 'production',
        retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 30)
      }),
      null,
      2
    )
  );
} finally {
  db.close();
}
