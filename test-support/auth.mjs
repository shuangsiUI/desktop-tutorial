import net from 'node:net';
export async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../backend/persistence/database.mjs';
import {createAuth} from '../backend/security/auth.mjs';
const password=randomBytes(32).toString('base64url'),sessions=new Map();
export async function seedTestAdmin(file){const db=openDatabase(file);try{if(!db.prepare('SELECT id FROM auth_users LIMIT 1').get())await createAuth(db).createUser({username:'test-admin',displayName:'测试管理员',role:'admin',password})}finally{db.close()}}
export async function authFetch(url,options={}){const origin=new URL(url).origin;let session=sessions.get(origin);if(!session){const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'test-admin',password})});const body=await response.json();if(!response.ok)throw Error('测试登录失败 '+JSON.stringify(body));session={cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf};sessions.set(origin,session)}return fetch(url,{...options,headers:{Origin:origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf,...options.headers}})}
