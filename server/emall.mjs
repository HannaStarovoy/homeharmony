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
 INVALID_RESPONSE:'Не удалось разобрать формат ответа Emall.',
 PAGINATION_ERROR:'Emall вернул противоречивые страницы или повторяющиеся товары.'
};
// Diagnostics contain only fixed schema paths and type labels, never response data or keys.
const DIAGNOSTIC_FIELDS=new Set(['response','response.status','response.body','response.json','success','data','meta','meta.total','meta.count','meta.per_page','meta.current_page','meta.total_pages','meta.last_page','data[]','data[].id','data[].name','data[].title','data[].category_id','data[].stock','data[].product_stock','data[].product_price','data[].product_price.price','data[].product_price.red_price','data[].product_price.old_price','data[].inner_article','data[].description','data[].images','data[].images[]','data[].properties','data[].prices','data[].prices.price','data[].prices.old_price']);
const DIAGNOSTIC_EXPECTED=new Set(['object','array','string','nonempty-string','string-or-null','array-or-null','object-or-null-or-empty-array','positive-integer','nonnegative-integer','http-status','JSON','not-false','count-matches-data','consistent-pagination','requested-page','requested-id','stable-total','stable-page-size','unique-id']);
const DIAGNOSTIC_ACTUAL=new Set(['missing','null','array','object','string','integer','number','boolean','bigint','symbol','function','non-JSON']);
function safeDiagnostic(value){
 if(value===null||typeof value!=='object'||Array.isArray(value))return null;
 try{
  const {field,expected,actual}=value;
  if(!DIAGNOSTIC_FIELDS.has(field)||!DIAGNOSTIC_EXPECTED.has(expected)||!DIAGNOSTIC_ACTUAL.has(actual))return null;
  return Object.freeze({field,expected,actual});
 }catch{return null}
}
export class EmallError extends Error{
 constructor(code,status=null,diagnostic=null){
  const safeCode=typeof code==='string'&&Object.hasOwn(MESSAGES,code)?code:'INVALID_RESPONSE';
  super(MESSAGES[safeCode]);this.name='EmallError';this.code=safeCode;
  this.status=Number.isInteger(status)&&status>=100&&status<=599?status:null;
  this.diagnostic=safeDiagnostic(diagnostic);
 }
}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const has=(value,key)=>Object.hasOwn(value,key);
const NON_JSON=Symbol();
function typeLabel(value){
 if(value===NON_JSON)return 'non-JSON';
 if(value===undefined)return 'missing';
 if(value===null)return 'null';
 if(Array.isArray(value))return 'array';
 if(Number.isSafeInteger(value))return 'integer';
 return typeof value;
}
const diagnostic=(field,expected,value)=>({field,expected,actual:typeLabel(value)});
const invalid=(field,expected,value)=>{throw new EmallError('INVALID_RESPONSE',null,diagnostic(field,expected,value))};
const pagination=(field,expected,value)=>{throw new EmallError('PAGINATION_ERROR',null,diagnostic(field,expected,value))};
function sourceInteger(value,min=0){
 // Accept only complete decimal digit strings; null, blanks, fractions and exponents never become numbers.
 if(typeof value==='string'){
  if(!/^\d+$/.test(value))return null;
  value=Number(value);
 }
 return integer(value,min)?value:null;
}
function readInteger(value,field,min=0){
 const parsed=sourceInteger(value,min);
 if(parsed===null)invalid(field,min===1?'positive-integer':'nonnegative-integer',value);
 return parsed;
}
function validateProduct(product){
 if(!record(product))invalid('data[]','object',product);
 readInteger(product.id,'data[].id',1);
 if(typeof product.name!=='string'||!product.name.trim())invalid('data[].name','nonempty-string',product.name);
 // Preserve fields exactly as read. A valid read is not a publishable/import-ready product.
 if(has(product,'category_id')&&product.category_id!==null)readInteger(product.category_id,'data[].category_id',1);
 if(has(product,'stock'))readInteger(product.stock,'data[].stock');
 if(has(product,'inner_article')&&product.inner_article!==null&&typeof product.inner_article!=='string')invalid('data[].inner_article','string-or-null',product.inner_article);
 if(has(product,'description')&&product.description!==null&&typeof product.description!=='string')invalid('data[].description','string-or-null',product.description);
 if(has(product,'images')&&product.images!==null){
  if(!Array.isArray(product.images))invalid('data[].images','array-or-null',product.images);
  for(const value of product.images)if(typeof value!=='string'||!value)invalid('data[].images[]','nonempty-string',value);
 }
 if(has(product,'properties')&&product.properties!==null&&!record(product.properties)&&!(Array.isArray(product.properties)&&product.properties.length===0))invalid('data[].properties','object-or-null-or-empty-array',product.properties);
 if(has(product,'prices')){
  if(!record(product.prices))invalid('data[].prices','object',product.prices);
  if(has(product.prices,'price'))readInteger(product.prices.price,'data[].prices.price',1);
  if(has(product.prices,'old_price')&&product.prices.old_price!==null)readInteger(product.prices.old_price,'data[].prices.old_price');
 }
}
function validateProductInfo(product){
 if(!record(product))invalid('data[]','object',product);
 readInteger(product.id,'data[].id',1);
 if(has(product,'title')&&(typeof product.title!=='string'||!product.title.trim()))invalid('data[].title','nonempty-string',product.title);
 // An audit requires explicit source quantities and prices. Preserve the raw
 // values; the short-info docs do not define red_price as an effective price.
 readInteger(product.product_stock,'data[].product_stock');
 if(!record(product.product_price))invalid('data[].product_price','object',product.product_price);
 readInteger(product.product_price.price,'data[].product_price.price',1);
 for(const field of ['red_price','old_price'])if(has(product.product_price,field)&&product.product_price[field]!==null)readInteger(product.product_price[field],'data[].product_price.'+field);
}
function validatePage(payload,page,validateItem=validateProduct){
 if(!record(payload))invalid('response.json','object',payload);
 if(payload.success===false)invalid('success','not-false',payload.success);
 if(!Array.isArray(payload.data))invalid('data','array',payload.data);
 if(!record(payload.meta))invalid('meta','object',payload.meta);
 const raw=payload.meta,meta={
  total:readInteger(raw.total,'meta.total'),
  count:has(raw,'count')?readInteger(raw.count,'meta.count'):payload.data.length,
  per_page:readInteger(raw.per_page,'meta.per_page',1),
  current_page:readInteger(raw.current_page,'meta.current_page',1)
 };
 const totalPages=has(raw,'total_pages')?readInteger(raw.total_pages,'meta.total_pages'):null;
 const lastPage=has(raw,'last_page')?readInteger(raw.last_page,'meta.last_page'):null;
 if(totalPages!==null&&lastPage!==null&&totalPages!==lastPage)pagination('meta.last_page','consistent-pagination',raw.last_page);
 meta.total_pages=totalPages??lastPage??Math.ceil(meta.total/meta.per_page);
 if(meta.count!==payload.data.length||meta.count>meta.per_page||meta.total<meta.count)invalid('meta.count','count-matches-data',raw.count);
 if(meta.current_page!==page)pagination('meta.current_page','requested-page',raw.current_page);
 if(meta.total===0){if(meta.count!==0||page!==1||meta.total_pages>1)invalid('meta.total_pages','consistent-pagination',totalPages??lastPage)}
 else{
  if(meta.total_pages<page||meta.total_pages!==Math.ceil(meta.total/meta.per_page))pagination('meta.total_pages','consistent-pagination',totalPages??lastPage);
  const expected=Math.min(meta.per_page,meta.total-(page-1)*meta.per_page);
  if(meta.count!==expected)pagination('meta.count','consistent-pagination',raw.count);
 }
 for(const product of payload.data)validateItem(product);
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
 async function readProduct(productId,path,validateItem){
  const id=sourceInteger(productId,1);
  if(id===null)throw new EmallError('INVALID_CONFIG');
  const url=new URL(path+id,'https://'+HOSTS[environment]);
  let response;
  try{response=await transport({url:url.href,headers:{Accept:'application/json',Authorization:'Bearer '+credential}})}
  catch(error){throw new EmallError(error instanceof EmallError?error.code:'NETWORK',error instanceof EmallError?error.status:null,error instanceof EmallError?error.diagnostic:null)}
  if(!record(response))invalid('response','object',response);
  if(!integer(response.status,100)||response.status>599)invalid('response.status','http-status',response.status);
  if(response.status!==200)throw new EmallError('HTTP_ERROR',response.status);
  try{
   if(typeof response.body!=='string')invalid('response.body','string',response.body);
   if(Buffer.byteLength(response.body,'utf8')>MAX_RESPONSE_BYTES)throw new EmallError('RESPONSE_TOO_LARGE');
   let payload;
   try{payload=JSON.parse(response.body)}catch{invalid('response.json','JSON',NON_JSON)}
   if(!record(payload))invalid('response.json','object',payload);
   if(payload.success===false)invalid('success','not-false',payload.success);
   // The documented detail response is a direct product; an object data envelope is compatible.
   const product=has(payload,'data')?payload.data:payload;
   if(has(payload,'data')&&!record(product))invalid('data','object',product);
   validateItem(product);
   if(sourceInteger(product.id,1)!==id)invalid('data[].id','requested-id',product.id);
   return {environment,product};
  }catch(error){throw new EmallError(error instanceof EmallError?error.code:'INVALID_RESPONSE',response.status,error instanceof EmallError?error.diagnostic:null)}
 }
 function getProduct(productId){return readProduct(productId,'/open/api/v1/products/',validateProduct)}
 function getProductInfo(productId){return readProduct(productId,'/open/api/v1/products/short/info/',validateProductInfo)}
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
   catch(error){throw new EmallError(error instanceof EmallError?error.code:'NETWORK',error instanceof EmallError?error.status:null,error instanceof EmallError?error.diagnostic:null)}
   if(!record(response))invalid('response','object',response);
   if(!integer(response.status,100)||response.status>599)invalid('response.status','http-status',response.status);
   if(response.status!==200)throw new EmallError('HTTP_ERROR',response.status);
   let payload,meta;
   try{
    if(typeof response.body!=='string')invalid('response.body','string',response.body);
    if(Buffer.byteLength(response.body,'utf8')>MAX_RESPONSE_BYTES)throw new EmallError('RESPONSE_TOO_LARGE');
    try{payload=JSON.parse(response.body)}catch{invalid('response.json','JSON',NON_JSON)}
    meta=validatePage(payload,page);
    if(total!==null&&meta.total!==total)pagination('meta.total','stable-total',payload.meta.total);
    if(actualPerPage!==null&&meta.per_page!==actualPerPage)pagination('meta.per_page','stable-page-size',payload.meta.per_page);
    for(const product of payload.data){
     const id=sourceInteger(product.id,1);
     if(seen.has(id))pagination('data[].id','unique-id',product.id);
     seen.add(id);
    }
   }catch(error){
    throw new EmallError(error instanceof EmallError?error.code:'INVALID_RESPONSE',response.status,error instanceof EmallError?error.diagnostic:null);
   }
   products.push(...payload.data.slice(0,limit-products.length));
   pagesRead++;total=meta.total;actualPerPage=meta.per_page;
   if(page>=meta.total_pages||payload.data.length===0)break;
   page++;
  }
  return {environment,products,pagesRead,total};
 }
 // Only these documented dictionary routes are available; callers cannot choose a URL.
 async function readDictionary(path,key,validateItem){
  const entries=[],seen=new Set();let page=1,total=null,actualPerPage=null;
  while(page<=100){
   const url=new URL(path,'https://'+HOSTS[environment]);
   url.searchParams.set('page',String(page));url.searchParams.set('perPage','100');
   let response;
   try{response=await transport({url:url.href,headers:{Accept:'application/json',Authorization:'Bearer '+credential}})}
   catch(error){throw new EmallError(error instanceof EmallError?error.code:'NETWORK',error instanceof EmallError?error.status:null,error instanceof EmallError?error.diagnostic:null)}
   if(!record(response))invalid('response','object',response);
   if(!integer(response.status,100)||response.status>599)invalid('response.status','http-status',response.status);
   if(response.status!==200)throw new EmallError('HTTP_ERROR',response.status);
   let payload,meta;
   try{
    if(typeof response.body!=='string')invalid('response.body','string',response.body);
    if(Buffer.byteLength(response.body,'utf8')>MAX_RESPONSE_BYTES)throw new EmallError('RESPONSE_TOO_LARGE');
    try{payload=JSON.parse(response.body)}catch{invalid('response.json','JSON',NON_JSON)}
    meta=validatePage(payload,page,validateItem);
    if(meta.total>10000||meta.total_pages>100)throw new EmallError('PAGINATION_ERROR');
    if(total!==null&&meta.total!==total)pagination('meta.total','stable-total',payload.meta.total);
    if(actualPerPage!==null&&meta.per_page!==actualPerPage)pagination('meta.per_page','stable-page-size',payload.meta.per_page);
    for(const entry of payload.data){
     const id=sourceInteger(entry.id,1);
     if(seen.has(id))pagination('data[].id','unique-id',entry.id);
     seen.add(id);
    }
   }catch(error){throw new EmallError(error instanceof EmallError?error.code:'INVALID_RESPONSE',response.status,error instanceof EmallError?error.diagnostic:null)}
   entries.push(...payload.data);total=meta.total;actualPerPage=meta.per_page;
   if(page>=meta.total_pages)return {[key]:entries,pagesRead:page,total};
   page++;
  }
  throw new EmallError('PAGINATION_ERROR');
 }
 function getCatalogCategories(){
  let nodes=0;
  function validateCategory(category,depth=0){
   if(!record(category)||depth>20||++nodes>10000)invalid('data[]','object',category);
   readInteger(category.id,'data[].id',1);
   if(typeof category.name!=='string'||!category.name.trim())invalid('data[].name','nonempty-string',category.name);
   if(category.children!==undefined&&category.children!==null){
    if(!Array.isArray(category.children))invalid('data','array',category.children);
    for(const child of category.children)validateCategory(child,depth+1);
   }
  }
  return readDictionary('/open/api/v1/catalog/categories','categories',validateCategory);
 }
 async function getCategoryProperties(categoryId){
  const id=sourceInteger(categoryId,1);
  if(id===null)throw new EmallError('INVALID_CONFIG');
  function validateProperty(value){
   if(!record(value))invalid('data[]','object',value);
   readInteger(value.id,'data[].id',1);
   if(value.name!==undefined&&value.name!==null&&typeof value.name!=='string')invalid('data[].name','string-or-null',value.name);
   if(value.property!==undefined&&value.property!==null&&!record(value.property))invalid('data[]','object',value.property);
  }
  return readDictionary('/open/api/v1/configurator/categories/'+id+'/properties','properties',validateProperty);
 }
 return {listProducts,getProduct,getProductInfo,getCatalogCategories,getCategoryProperties};
}
