import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../persistence/database.mjs';
import { newMfaSecret, enrollMfa, encryptionKey } from '../security/mfa.mjs';
const args = process.argv.slice(2),
  get = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null),
  username = get('--username'),
  reason = get('--reason');
if (!process.stdin.isTTY || !username || !reason)
  throw Error('请在交互终端运行 npm run user:mfa -- --username 账号 --reason 启用原因 [--replace]');
encryptionKey(process.env.MFA_ENCRYPTION_KEY);
const db = openDatabase();
try {
  const user = db.prepare('SELECT id FROM auth_users WHERE username=? AND enabled=1').get(username);
  if (!user) throw Error('账号不存在或已停用');
  if (
    db.prepare('SELECT 1 FROM auth_mfa WHERE user_id=?').get(user.id) &&
    !args.includes('--replace')
  )
    throw Error('已启用MFA；重置须明确--replace');
  const secret = newMfaSecret(),
    uri =
      'otpauth://totp/' +
      encodeURIComponent('FBA Logistics:' + username) +
      '?secret=' +
      secret +
      '&issuer=FBA%20Logistics&algorithm=SHA1&digits=6&period=30';
  console.log('请在本人验证器中手工添加下列密钥，避免保存在共享终端记录：\n' + secret + '\n' + uri);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let otp;
  try {
    otp = await rl.question('输入验证器当前6位验证码确认：');
  } finally {
    rl.close();
  }
  enrollMfa(db, {
    userId: user.id,
    secret,
    otp,
    key: process.env.MFA_ENCRYPTION_KEY,
    replace: args.includes('--replace'),
    reason
  });
  console.log('双重验证已启用，原会话已撤销。请等待下一组验证码后登录。');
} finally {
  db.close();
}
