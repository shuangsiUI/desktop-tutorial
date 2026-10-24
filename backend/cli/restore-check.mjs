import { verifyBackup } from '../operations/backup.mjs';
if (!process.argv[2]) throw Error('用法：npm run db:restore-check -- 备份文件');
const result = await verifyBackup(process.argv[2], { secret: process.env.BACKUP_ENCRYPTION_KEY });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
