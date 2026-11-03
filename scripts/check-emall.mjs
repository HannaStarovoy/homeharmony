// Read-only diagnostic. Never writes local products or sends changes to Emall.
import {createEmallClient,EmallError} from '../server/emall.mjs';

const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('Проверка чтения Emall API. Товары на сайте не создаются.\nnode --env-file-if-exists=.env.local scripts/check-emall.mjs [--limit 5] [--sandbox]\nРабочий ключ: EMALL_API_TOKEN; тестовый: EMALL_SANDBOX_API_TOKEN. Значения ключей аргументами не передаются.');
 process.exit(0);
}
try{
 let limit=5,sandbox=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--sandbox')sandbox=true;
  else if(args[i]==='--limit')limit=Number(args[++i]);
  else throw new Error('Неизвестный параметр. Используйте --help.');
 }
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Для проверки укажите --limit от 1 до 100.');
 const environment=sandbox?'sandbox':'production';
 const token=process.env[sandbox?'EMALL_SANDBOX_API_TOKEN':'EMALL_API_TOKEN']||'';
 const result=await createEmallClient({token,environment}).listProducts({limit});
 console.log(JSON.stringify({mode:'read-only',environment:result.environment,received:result.products.length,pagesRead:result.pagesRead,total:result.total,imported:0,products:result.products.map(p=>({id:p.id,name:p.name,emallCategoryId:p.category_id??null,photoCount:Array.isArray(p.images)?p.images.length:0,priceCents:p.prices?.price??null,stockReportedByEmall:p.stock??null})),notes:['Карточки на сайте не создавались.','stockReportedByEmall — количество из API, его учёт резервов Emall ещё требует проверки.']},null,2));
}catch(error){
 const message=error instanceof EmallError?(error.status===401?'Emall не принял авторизацию (HTTP 401). Проверьте рабочий ключ в HTTP-секрете.':error.status===403?'Emall отказал в доступе (HTTP 403). Проверьте права ключа на чтение каталога.':error.message):('Неизвестный параметр. Используйте --help.'===error.message||error.message==='Для проверки укажите --limit от 1 до 100.'?error.message:'Проверка Emall не завершена.');
 console.error(message);process.exitCode=1;
}
