import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Problem } from './store.mjs';
const scrypt=promisify(scryptCallback);
export const tokenHash=token=>createHash('sha256').update(token).digest('hex');
export async function passwordHash(password) {
  if (typeof password!=='string' || password.length<12 || Buffer.byteLength(password)>256) throw new Problem(422,'Пароль должен содержать от 12 символов и не более 256 байт.');
  const salt=randomBytes(16).toString('hex');
  return salt+':'+(await scrypt(password,salt,64)).toString('hex');
}
export async function createAdmin(store,email,password,{reset=false}={}) {
  email=String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>200) throw new Problem(422,'Укажите корректный email администратора.');
  const hash=await passwordHash(password);
  if (store.db.prepare('SELECT 1 FROM admins WHERE email=?').get(email) && !reset) throw new Problem(409,'Администратор уже существует. Для смены пароля используйте --reset.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO admins VALUES(?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash').run(email,hash);
    store.db.prepare('DELETE FROM sessions WHERE email=?').run(email);
    store.db.exec('COMMIT');
  } catch(error) {store.db.exec('ROLLBACK');throw error}
}
export function session(store,req) {
  const token=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('shop_session='))?.slice(13);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return store.db.prepare('SELECT email,csrf,token_hash FROM sessions WHERE token_hash=? AND expires>?').get(tokenHash(token),Date.now())||null;
}
export async function login(store,email,password,address) {
  const now=Date.now();
  store.db.prepare('DELETE FROM login_limits WHERE expires<?').run(now);
  const limit=store.db.prepare('SELECT attempts FROM login_limits WHERE address=?').get(address);
  if (limit?.attempts>=10) throw new Problem(429,'Слишком много попыток входа. Повторите через 15 минут.');
  store.db.prepare('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=attempts+1').run(address,now+15*60*1000);
  if (typeof email!=='string' || typeof password!=='string' || email.length>200 || Buffer.byteLength(password)>256) throw new Problem(401,'Неверный email или пароль.');
  const admin=store.db.prepare('SELECT password_hash FROM admins WHERE email=?').get(email.trim().toLowerCase());
  const [salt,expected]=(admin?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64)).split(':');
  const actual=await scrypt(password,salt,64);
  if (!admin || !timingSafeEqual(actual,Buffer.from(expected,'hex'))) throw new Problem(401,'Неверный email или пароль.');
  // Check again under the write lock: a concurrent password reset must revoke an in-flight login too.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if(store.db.prepare('SELECT password_hash FROM admins WHERE email=?').get(email.trim().toLowerCase())?.password_hash!==admin.password_hash)throw new Problem(401,'Неверный email или пароль.');
    store.db.prepare('DELETE FROM login_limits WHERE address=?').run(address);
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token),email.trim().toLowerCase(),csrf,now+8*60*60*1000);
    store.db.exec('COMMIT');
    return {token,csrf,email:email.trim().toLowerCase()};
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
