// Read-only diagnostic. Never writes local products or sends changes to Emall.
import {createEmallClient,EmallError} from '../server/emall.mjs';
import {appendFile} from 'node:fs/promises';

const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('Проверка чтения Emall API. Товары на сайте не создаются.\nnode --env-file-if-exists=.env.local scripts/check-emall.mjs [--limit 5] [--sandbox] [--summary]\nРабочий ключ: EMALL_API_TOKEN; тестовый: EMALL_SANDBOX_API_TOKEN. Значения ключей аргументами не передаются.\n--summary: только результат и количество карточек, без данных товаров; в GitHub Actions также заполняет Summary.');
 process.exit(0);
}
let summary=false,tokenName='EMALL_API_TOKEN';
async function githubSummary(text){
 if(summary&&process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n','utf8');
}
try{
 let limit=5,sandbox=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--sandbox')sandbox=true;
  else if(args[i]==='--summary')summary=true;
  else if(args[i]==='--limit')limit=Number(args[++i]);
  else throw new Error('Неизвестный параметр. Используйте --help.');
 }
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Для проверки укажите --limit от 1 до 100.');
 const environment=sandbox?'sandbox':'production';
 tokenName=sandbox?'EMALL_SANDBOX_API_TOKEN':'EMALL_API_TOKEN';
 const token=process.env[tokenName]||'';
 const result=await createEmallClient({token,environment}).listProducts({limit});
 const report={mode:'read-only',environment:result.environment,received:result.products.length,pagesRead:result.pagesRead,imported:0};
 if(!summary)Object.assign(report,{total:result.total,products:result.products.map(p=>({id:p.id,name:p.name,emallCategoryId:p.category_id??null,photoCount:Array.isArray(p.images)?p.images.length:0,priceCents:p.prices?.price??null,stockReportedByEmall:p.stock??null})),notes:['Карточки на сайте не создавались.','stockReportedByEmall — количество из API, его учёт резервов Emall ещё требует проверки.']});
 await githubSummary('## Проверка Emall API\n\nЧтение выполнено успешно.\n\n- Получено карточек: '+report.received+'\n- Прочитано страниц: '+report.pagesRead+'\n- Создано товаров на сайте: 0\n\nПроверка только читает API. Названия, фотографии, цены и остатки товаров не публикуются в отчёте.');
 console.log(JSON.stringify(report,null,2));
}catch(error){
 const message=error instanceof EmallError?(error.code==='TOKEN_MISSING'?'Ключ '+tokenName+' отсутствует. Добавьте его в Secrets репозитория для GitHub Actions или в защищённые настройки рабочего процесса.':error.status===401?'Emall не принял авторизацию (HTTP 401). Проверьте ключ '+tokenName+'.':error.status===403?'Emall отказал в доступе (HTTP 403). Проверьте права ключа на чтение каталога.':error.message):('Неизвестный параметр. Используйте --help.'===error.message||error.message==='Для проверки укажите --limit от 1 до 100.'?error.message:'Проверка Emall не завершена.');
 await githubSummary('## Проверка Emall API\n\nПроверка не завершена.\n\n'+message+'\n\nТовары на сайте не создавались.').catch(()=>{});
 console.error(message);process.exitCode=1;
}
