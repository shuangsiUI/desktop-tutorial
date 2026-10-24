import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase } from '../persistence/database.mjs';
import { createAuth } from '../security/auth.mjs';
const args = process.argv.slice(2),
  get = (key) => args[args.indexOf(key) + 1];
const username = args.includes('--username') ? get('--username') : null,
  role = args.includes('--role') ? get('--role') : 'admin',
  customerId = args.includes('--customer') ? get('--customer') : null;
if (!username) {
  console.error(
    '用法：npm run user:create -- --username 用户名 --role admin|operator|finance|customer [--customer 客户ID]'
  );
  process.exit(1);
}
process.umask(0o077);
let password = process.env.FBA_INITIAL_PASSWORD;
delete process.env.FBA_INITIAL_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) {
    console.error('请通过交互终端设置密码，或通过临时环境变量FBA_INITIAL_PASSWORD传入');
    process.exit(1);
  }
  let mute = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!mute) process.stdout.write(chunk, encoding);
      callback();
    }
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('设置密码（至少15个字符，输入不显示）：');
  mute = true;
  password = await rl.question('');
  process.stdout.write('\n请再次输入密码：');
  const confirm = await rl.question('');
  mute = false;
  rl.close();
  process.stdout.write('\n');
  if (password !== confirm) {
    console.error('两次密码不一致');
    process.exit(1);
  }
}
const db = openDatabase();
try {
  const user = await createAuth(db).createUser({
    username,
    role,
    customerId,
    displayName: username,
    password
  });
  console.log('已创建账号：' + user.username + '（' + user.role + '）');
} catch (e) {
  console.error(e.code ? '账号创建失败' : e.message);
  process.exitCode = 1;
} finally {
  password = '';
  db.close();
}
