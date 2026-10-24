import { resolve } from 'node:path';
import { exportRestore } from '../operations/backup.mjs';
if (!process.argv[2] || !process.argv[3])
  throw Error('用法：npm run db:restore-export -- 备份文件 新建恢复文件.sqlite');
const target = resolve(process.argv[3]);
if (target === resolve(process.env.DB_PATH || 'data/logistics.sqlite'))
  throw Error('禁止直接写入运行数据库，请输出到独立新文件');
const result = await exportRestore(process.argv[2], target, {
  secret: process.env.BACKUP_ENCRYPTION_KEY
});
console.log(JSON.stringify({ ...result, exportedTo: target }, null, 2));
