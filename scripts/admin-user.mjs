import { createInterface } from 'node:readline/promises';
import { openStore } from '../server/store.mjs';
import { createAdmin } from '../server/auth.mjs';
const args=process.argv.slice(2),emailIndex=args.indexOf('--email');
let email=emailIndex>=0?args[emailIndex+1]:process.env.SHOP_ADMIN_EMAIL;
async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal or set SHOP_ADMIN_EMAIL and SHOP_ADMIN_PASSWORD securely in the environment.');
  process.stdout.write(prompt);
  const previous=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    function finish(error){process.stdin.removeListener('data',handle);process.stdin.setRawMode(previous);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value)}
    function handle(chunk){for(const c of chunk.toString('utf8')){if(c==='\u0003')return finish(new Error('Cancelled'));if(c==='\r'||c==='\n')return finish();if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(c>=' ')value+=c}}
    process.stdin.on('data',handle);
  });
}
let store;
try {
  if (!email) {
    if (!process.stdin.isTTY) throw new Error('Укажите --email или SHOP_ADMIN_EMAIL.');
    const rl=createInterface({input:process.stdin,output:process.stdout});email=await rl.question('Email администратора: ');rl.close();
  }
  let password=process.env.SHOP_ADMIN_PASSWORD;
  if (!password) {
    password=await hiddenQuestion('Пароль (не отображается, от 12 символов): ');
    if(password!==await hiddenQuestion('Повторите пароль: '))throw new Error('Пароли не совпадают.');
  }
  store=openStore();await createAdmin(store,email,password,{reset:args.includes('--reset')});
  console.log('Учётная запись сохранена. Откройте /admin и войдите с указанными данными.');
} catch(error) {console.error(error.message);process.exitCode=1} finally {store?.close()}
