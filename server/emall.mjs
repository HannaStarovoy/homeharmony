// Read-only Emall client. No imports, local stock changes, image downloads or write methods.
import {spawn} from 'node:child_process';

const MAX_RESPONSE_BYTES=5*1024*1024;
const HOSTS={production:'api.emall.by',sandbox:'api-sandbox.emall.by'};
const MESSAGES={
 TOKEN_MISSING:'Секрет API Emall недоступен рабочему процессу.',
 INVALID_CONFIG:'Некорректные настройки чтения Emall.',
 NETWORK:'Не удалось выполнить защищённый запрос к Emall.',
 HTTP_ERROR:'Emall вернул ошибку HTTP. Проверьте статус и права доступа ключа.',
 RESPONSE_TOO_LARGE:'Ответ Emall превышает допустимый размер.',
 INVALID_RESPONSE:'Ответ Emall не соответствует документированной схеме.',
 PAGINATION_ERROR:'Emall вернул противоречивые страницы или повторяющиеся товары.'
};
export class EmallError extends Error{
 constructor(code,status=null){
  const safeCode=typeof code==='string'&&Object.hasOwn(MESSAGES,code)?code:'INVALID_RESPONSE';
  super(MESSAGES[safeCode]);this.name='EmallError';this.code=safeCode;
  this.status=Number.isInteger(status)&&status>=100&&status<=599?status:null;
 }
}
const invalid=()=>{throw new EmallError('INVALID_RESPONSE')};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const has=(value,key)=>Object.hasOwn(value,key);
function validateProduct(product){
 if(!record(product)||!integer(product.id,1)||typeof product.name!=='string'||!product.name.trim())invalid();
 // Preserve fields exactly as read. A valid read is not a publishable/import-ready product.
 if(has(product,'category_id')&&!integer(product.category_id,1))invalid();
 if(has(product,'stock')&&!integer(product.stock))invalid();
 if(has(product,'inner_article')&&typeof product.inner_article!=='string')invalid();
 if(has(product,'description')&&product.description!==null&&typeof product.description!=='string')invalid();
 if(has(product,'images')&&(!Array.isArray(product.images)||product.images.some(value=>typeof value!=='string'||!value)))invalid();
 if(has(product,'properties')&&!record(product.properties))invalid();
 if(has(product,'prices')){
  if(!record(product.prices))invalid();
  if(has(product.prices,'price')&&!integer(product.prices.price,1))invalid();
  if(has(product.prices,'old_price')&&product.prices.old_price!==null&&!integer(product.prices.old_price))invalid();
 }
}
function validatePage(payload,page,perPage){
 if(!record(payload)||payload.success===false||!Array.isArray(payload.data)||!record(payload.meta))invalid();
 const meta=payload.meta;
 if(!integer(meta.total)||!integer(meta.count)||!integer(meta.per_page,1)||!integer(meta.current_page,1)||!integer(meta.total_pages))invalid();
 if(meta.count!==payload.data.length||meta.count>meta.per_page||meta.per_page>perPage||meta.total<meta.count)invalid();
 if(meta.current_page!==page)throw new EmallError('PAGINATION_ERROR');
 if(meta.total===0){if(meta.count!==0||page!==1||meta.total_pages>1)invalid()}
 else{
  if(meta.total_pages<page||meta.total_pages!==Math.ceil(meta.total/meta.per_page))throw new EmallError('PAGINATION_ERROR');
  const expected=Math.min(meta.per_page,meta.total-(page-1)*meta.per_page);
  if(meta.count!==expected)throw new EmallError('PAGINATION_ERROR');
 }
 for(const product of payload.data)validateProduct(product);
 return meta;
}
const curlQuote=value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
function curlTransport({url,headers}){
 return new Promise((resolve,reject)=>{
  // --disable must come first: a local .curlrc must not enable redirects or disable TLS.
  // Authorization is supplied only on stdin, never in argv or an on-disk config file.
  const child=spawn('curl',['--disable','--config','-'],{stdio:['pipe','pipe','ignore']});
  let chunks=[],size=0,tooLarge=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000);timer.unref();
  child.stdout.on('data',chunk=>{
   if(tooLarge)return;
   size+=chunk.length;
   if(size>MAX_RESPONSE_BYTES+4){tooLarge=true;chunks=[];child.kill('SIGKILL')}
   else chunks.push(chunk);
  });
  child.stdin.on('error',()=>{});
  child.once('error',()=>{clearTimeout(timer);reject(new EmallError('NETWORK'))});
  child.once('close',code=>{
   clearTimeout(timer);
   if(tooLarge||code===63){reject(new EmallError('RESPONSE_TOO_LARGE'));return}
   if(code!==0){reject(new EmallError('NETWORK'));return}
   const output=Buffer.concat(chunks),tail=output.subarray(-4).toString('ascii');
   if(!/^\n[1-5]\d{2}$/.test(tail)){reject(new EmallError('NETWORK'));return}
   resolve({status:Number(tail.slice(1)),body:output.subarray(0,-4).toString('utf8')});
  });
  const config=[
   'url = '+curlQuote(url),'request = "GET"',
   ...Object.entries(headers).map(([name,value])=>'header = '+curlQuote(name+': '+value)),
   'proto = "=https"','proto-redir = "=https"','max-redirs = 0',
   'connect-timeout = 10','max-time = 30','max-filesize = '+MAX_RESPONSE_BYTES,
   'silent','write-out = "\\n%{http_code}"'
  ].join('\n')+'\n';
  child.stdin.end(config);
 });
}
export function createEmallClient({token,environment='production',transport=curlTransport}={}){
 if(typeof environment!=='string'||!Object.hasOwn(HOSTS,environment)||typeof transport!=='function')throw new EmallError('INVALID_CONFIG');
 const credential=token===undefined?process.env[environment==='sandbox'?'EMALL_SANDBOX_API_TOKEN':'EMALL_API_TOKEN']:token;
 if(typeof credential!=='string'||!credential.trim())throw new EmallError('TOKEN_MISSING');
 if(credential.length>4096||/[\s\x00-\x1f\x7f]/.test(credential))throw new EmallError('INVALID_CONFIG');
 async function listProducts({limit=5}={}){
  if(!integer(limit,1)||limit>5000)throw new EmallError('INVALID_CONFIG');
  const products=[],seen=new Set(),perPage=Math.min(limit,100);
  let page=1,total=null,pagesRead=0,actualPerPage=null;
  while(products.length<limit){
   if(page>Math.min(limit,5000))throw new EmallError('PAGINATION_ERROR');
   const url=new URL('/open/api/v1/products','https://'+HOSTS[environment]);
   url.searchParams.set('page',String(page));url.searchParams.set('perPage',String(perPage));
   let response;
   try{response=await transport({url:url.href,headers:{Accept:'application/json',Authorization:'Bearer '+credential}})}
   catch(error){throw new EmallError(error instanceof EmallError?error.code:'NETWORK',error instanceof EmallError?error.status:null)}
   if(!record(response)||!integer(response.status,100)||response.status>599)invalid();
   if(response.status!==200)throw new EmallError('HTTP_ERROR',response.status);
   if(typeof response.body!=='string')invalid();
   if(Buffer.byteLength(response.body,'utf8')>MAX_RESPONSE_BYTES)throw new EmallError('RESPONSE_TOO_LARGE');
   let payload;try{payload=JSON.parse(response.body)}catch{invalid()}
   const meta=validatePage(payload,page,perPage);
   if(total!==null&&(meta.total!==total||meta.per_page!==actualPerPage))throw new EmallError('PAGINATION_ERROR');
   for(const product of payload.data){
    if(seen.has(product.id))throw new EmallError('PAGINATION_ERROR');seen.add(product.id);
   }
   products.push(...payload.data.slice(0,limit-products.length));
   pagesRead++;total=meta.total;actualPerPage=meta.per_page;
   if(page>=meta.total_pages||payload.data.length===0)break;
   page++;
  }
  return {environment,products,pagesRead,total};
 }
 return {listProducts};
}
