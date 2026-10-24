import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
export function operationalStatus(
  db,
  {
    backupDir = process.env.BACKUP_DIR || 'data/backups',
    production = process.env.NODE_ENV === 'production'
  } = {}
) {
  let backup;
  try {
    const status = JSON.parse(readFileSync(resolve(backupDir, 'status.json'), 'utf8'));
    const fileValid =
      /^logistics-\d+-[a-f0-9]{8}\.(enc|sqlite)$/.test(status.file) &&
      statSync(resolve(backupDir, status.file)).size === status.bytes;
    const ageMs = Date.now() - new Date(status.createdAt).getTime();
    backup = {
      ok:
        fileValid &&
        Number.isFinite(ageMs) &&
        ageMs >= 0 &&
        ageMs <= 26 * 3600000 &&
        status.restoreVerified &&
        (!production || (status.encrypted && status.remoteCopied)),
      ageHours: Math.round(ageMs / 360000) / 10,
      encrypted: !!status.encrypted,
      restoreVerified: !!status.restoreVerified,
      remoteCopied: !!status.remoteCopied
    };
  } catch {
    backup = { ok: false, reason: '没有可验证的近期备份' };
  }
  const pending = db
      .prepare("SELECT count(*) n FROM commercial_requests WHERE status='pending'")
      .get().n,
    unposted = db
      .prepare("SELECT count(*) n FROM ledger_transactions WHERE status<>'posted'")
      .get().n;
  return {
    ok: backup.ok && unposted === 0,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    backup,
    pendingApprovals: pending,
    unpostedTransactions: unposted
  };
}
