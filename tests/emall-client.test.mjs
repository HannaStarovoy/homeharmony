// Artificial fixtures shaped like the public docs, never live Emall responses or credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createEmallClient,EmallError} from '../server/emall.mjs';
const token='fictional-test-secret-not-an-api-key';
const card=id=>({id,name:'Искусственный товар '+id,category_id:123,inner_article:'TEST-'+id,description:'Только unit test',images:['https://api-sandbox.emall.by/storage/images/fixture.jpg'],properties:{'149':[11022]},prices:{price:2000,old_price:2100},stock:3});
function page(data,{total=data.length,current=1,perPage=5}={}){return {status:200,body:JSON.stringify({data,meta:{total,count:data.length,current_page:current,per_page:perPage,total_pages:Math.ceil(total/perPage)||1}})}}
const client=transport=>createEmallClient({token,transport});
const errorCode=code=>error=>error instanceof EmallError&&error.code===code;

test('missing or explicitly empty credentials fail before any transport call',()=>{
 let calls=0;const transport=()=>{calls++};
 for(const missing of ['',null,42])assert.throws(()=>createEmallClient({token:missing,transport}),errorCode('TOKEN_MISSING'));
 assert.equal(calls,0);
});
test('invalid environments and header-injection tokens fail before networking',()=>{
 for(const environment of ['http://other.example','development','constructor','__proto__'])assert.throws(()=>createEmallClient({token,environment}),errorCode('INVALID_CONFIG'));
 for(const value of ['fictional\nInjected: value','fictional\rvalue','fictional value','x'.repeat(4097)])assert.throws(()=>createEmallClient({token:value}),errorCode('INVALID_CONFIG'));
});
test('the default read requests exactly five production products and preserves raw source fields',async()=>{
 const data=Array.from({length:5},(_,i)=>card(i+1)),requests=[];
 const result=await client(async request=>{requests.push(request);return page(data,{total:14})}).listProducts();
 assert.equal(requests.length,1);assert.equal(requests[0].url,'https://api.emall.by/open/api/v1/products?page=1&perPage=5');
 assert.deepEqual(requests[0].headers,{Accept:'application/json',Authorization:'Bearer '+token});
 assert.deepEqual(result,{environment:'production',products:data,pagesRead:1,total:14});
 assert.equal(result.products[0].prices.price,2000);assert.equal(result.products[0].stock,3);
});
test('sandbox is restricted to its own host when explicitly configured',async()=>{
 const result=await createEmallClient({token,environment:'sandbox',transport:async request=>{
  assert.equal(new URL(request.url).hostname,'api-sandbox.emall.by');return page([card(1)]);
 }}).listProducts();
 assert.equal(result.environment,'sandbox');
});
test('a production default token cannot fall back into sandbox; sandbox uses its distinct binding',async()=>{
 const code=`import assert from 'node:assert/strict';import{createEmallClient}from'./server/emall.mjs';
 let calls=0;assert.throws(()=>createEmallClient({environment:'sandbox',transport:async()=>{calls++}}),e=>e.code==='TOKEN_MISSING');assert.equal(calls,0);
 process.env.EMALL_SANDBOX_API_TOKEN='fictional-sandbox';
 await createEmallClient({environment:'sandbox',transport:async({headers,url})=>{assert.equal(headers.Authorization,'Bearer fictional-sandbox');assert.equal(new URL(url).hostname,'api-sandbox.emall.by');return{status:200,body:JSON.stringify({data:[],meta:{total:0,count:0,per_page:5,current_page:1,total_pages:0}})}}}).listProducts();console.log('PASS');`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:new URL('../',import.meta.url),env:{...process.env,EMALL_API_TOKEN:'fictional-production',EMALL_SANDBOX_API_TOKEN:''}});
 assert.equal(stdout.trim(),'PASS');
});
test('pagination caps page size at 100 and returns only the requested source records',async()=>{
 const requests=[];
 const result=await client(async request=>{
  const current=Number(new URL(request.url).searchParams.get('page'));requests.push(request);
  return page(Array.from({length:current===1?100:7},(_,i)=>card((current-1)*100+i+1)),{total:107,current,perPage:100});
 }).listProducts({limit:105});
 assert.equal(requests.length,2);assert.equal(result.products.length,105);assert.equal(result.products.at(-1).id,105);assert.equal(result.total,107);assert.equal(result.pagesRead,2);
 assert(requests.every(request=>new URL(request.url).searchParams.get('perPage')==='100'));
});
test('empty seller catalogs are valid and do not create placeholder goods',async()=>{
 const result=await client(async()=>page([])).listProducts();assert.deepEqual(result,{environment:'production',products:[],pagesRead:1,total:0});
});
test('limits must be positive integers within the bounded import-read range',async()=>{
 let calls=0;const instance=client(async()=>{calls++;return page([])});
 for(const limit of [0,-1,1.5,'5',NaN,Infinity,5001])await assert.rejects(instance.listProducts({limit}),errorCode('INVALID_CONFIG'));
 assert.equal(calls,0);
});
test('a successful read tolerates absent optional import fields without replacing them with zero',async()=>{
 const raw={id:1,name:'Минимальная искусственная карточка'};
 const result=await client(async()=>page([raw])).listProducts();assert.deepEqual(result.products,[raw]);assert.equal(Object.hasOwn(result.products[0],'stock'),false);assert.equal(Object.hasOwn(result.products[0],'prices'),false);
});
test('nullable old price is preserved and optional source fields are type checked if present',async()=>{
 const raw=card(1);raw.prices.old_price=null;assert.equal((await client(async()=>page([raw])).listProducts()).products[0].prices.old_price,null);
 const edits=[p=>p.id=0,p=>delete p.id,p=>p.name=' ',p=>p.category_id='invalid',p=>p.images='not an array',p=>p.images=[17],p=>p.properties=[{private:'value'}],p=>p.stock=-1,p=>p.stock=null,p=>p.prices.price=20.5,p=>p.prices.price=null,p=>p.prices.old_price=-5,p=>p.prices=null,p=>p.inner_article=15,p=>p.description={}];
 for(const edit of edits){const row=card(1);edit(row);await assert.rejects(client(async()=>page([row])).listProducts(),errorCode('INVALID_RESPONSE'))}
});
test('nullable optional fields and empty attribute arrays are preserved as missing source details',async()=>{
 for(const properties of [null,[]]){
  const raw={...card(1),category_id:null,inner_article:null,description:null,images:null,properties};
  const result=await client(async()=>page([raw])).listProducts();
  assert.deepEqual(result.products,[raw]);assert.equal(result.products[0].stock,3);assert.equal(result.products[0].prices.price,2000);
 }
});
test('complete safe decimal integer strings are accepted without rewriting product fields',async()=>{
 const raw={...card('0001'),category_id:'123',stock:'0',prices:{price:'2000',old_price:'2100'}};
 const payload={data:[raw],meta:{total:'1',count:'1',per_page:'5',current_page:'1',total_pages:'1',last_page:1}};
 const result=await client(async()=>({status:200,body:JSON.stringify(payload)})).listProducts();
 assert.deepEqual(result,{environment:'production',products:[raw],pagesRead:1,total:1});
 assert.equal(result.products[0].stock,'0');assert.equal(result.products[0].prices.price,'2000');
});
test('numeric compatibility never coerces missing values, partial strings or unsafe integers into money or stock',async()=>{
 const malformed=[null,true,false,'',' ',' 3','3 ','+3','-3','3.0','3e0','0x3','3x','9007199254740992',Number.MAX_SAFE_INTEGER+1,3.5,-1,[],{}];
 for(const value of malformed){
  for(const field of ['stock','price','old_price']){
   if(field==='old_price'&&value===null)continue;
   const raw=card(1);if(field==='stock')raw.stock=value;else raw.prices[field]=value;
   await assert.rejects(client(async()=>page([raw])).listProducts(),errorCode('INVALID_RESPONSE'));
  }
 }
 for(const value of [0,'0']){
  const raw=card(1);raw.prices.price=value;
  await assert.rejects(client(async()=>page([raw])).listProducts(),errorCode('INVALID_RESPONSE'));
 }
});
test('pagination derives omitted count and page totals and accepts a consistent Laravel last_page alias',async()=>{
 for(const mode of ['last_page','derived','matching-aliases']){
  let calls=0;
  const result=await client(async()=>{
   const current=++calls,payload={data:[card(String(current))],meta:{total:'2',per_page:'1',current_page:String(current)}};
   if(mode!=='derived')payload.meta.last_page='2';
   if(mode==='matching-aliases')payload.meta.total_pages=2;
   return {status:200,body:JSON.stringify(payload)};
  }).listProducts({limit:2});
  assert.equal(calls,2);assert.equal(result.total,2);assert.deepEqual(result.products.map(p=>p.id),['1','2']);
 }
 const empty=await client(async()=>({status:200,body:JSON.stringify({data:[],meta:{total:'0',per_page:'15',current_page:'1'}})})).listProducts();
 assert.equal(empty.products.length,0);assert.equal(empty.total,0);
});
test('a larger server page is validated and sliced to the local requested limit',async()=>{
 let calls=0;const data=Array.from({length:15},(_,i)=>card(i+1));
 const result=await client(async()=>{calls++;return page(data,{total:20,perPage:15})}).listProducts();
 assert.equal(calls,1);assert.equal(result.products.length,5);assert.deepEqual(result.products,data.slice(0,5));assert.equal(result.total,20);
});
test('undocumented envelopes, metadata and non-JSON bodies fail with fixed safe messages',async()=>{
 const good=JSON.parse(page([card(1)]).body);
 const examples=[{},[],{data:[card(1)]},{...good,success:false},{...good,data:{}},{...good,meta:{...good.meta,count:9}},{...good,meta:{...good.meta,total:null}}];
 for(const body of examples)await assert.rejects(client(async()=>({status:200,body:JSON.stringify(body)})).listProducts(),errorCode('INVALID_RESPONSE'));
 await assert.rejects(client(async()=>({status:200,body:'<html>'+token+'</html>'})).listProducts(),error=>error.code==='INVALID_RESPONSE'&&!error.message.includes(token));
});
test('duplicate IDs within one page and across pages cannot create an endless read or duplicate goods',async()=>{
 await assert.rejects(client(async()=>page([card(1),card(1)])).listProducts(),errorCode('PAGINATION_ERROR'));
 let calls=0;
 await assert.rejects(client(async()=>{calls++;return page([card(1)],{total:2,current:calls,perPage:1})}).listProducts({limit:2}),errorCode('PAGINATION_ERROR'));
 assert.equal(calls,2);
});
test('numeric and digit string forms of the same ID are canonical duplicates',async()=>{
 await assert.rejects(client(async()=>page([card(1),card('0001')])).listProducts(),errorCode('PAGINATION_ERROR'));
 let calls=0;
 await assert.rejects(client(async()=>{calls++;return page([card(calls===1?1:'01')],{total:2,current:calls,perPage:1})}).listProducts({limit:2}),errorCode('PAGINATION_ERROR'));
 assert.equal(calls,2);
});
test('malformed pagination fields and conflicting page count aliases remain rejected',async()=>{
 const good=JSON.parse(page([card(1)]).body);
 for(const field of ['total','count','per_page','current_page','total_pages','last_page']){
  for(const value of [null,'','1.0','1e0',' 1',true,'9007199254740992']){
   const payload={...good,meta:{...good.meta,[field]:value}};
   await assert.rejects(client(async()=>({status:200,body:JSON.stringify(payload)})).listProducts(),errorCode('INVALID_RESPONSE'));
  }
 }
 const conflict={...good,meta:{...good.meta,last_page:'2'}};
 await assert.rejects(client(async()=>({status:200,body:JSON.stringify(conflict)})).listProducts(),errorCode('PAGINATION_ERROR'));
});
test('structural diagnostics reveal fixed paths and types without response values or arbitrary keys',async()=>{
 const secret='PRIVATE-RESPONSE-'+token;
 const payload={...JSON.parse(page([{...card(1),name:secret,stock:secret,[secret]:secret}]).body),[secret]:{[secret]:secret}};
 await assert.rejects(client(async()=>({status:200,body:JSON.stringify(payload)})).listProducts(),error=>{
  assert.equal(error.status,200);
  assert.deepEqual(error.diagnostic,{field:'data[].stock',expected:'nonnegative-integer',actual:'string'});
  assert.equal(Object.isFrozen(error.diagnostic),true);
  assert(!JSON.stringify(error).includes(secret));assert(!String(error.stack).includes(token));
  return error.code==='INVALID_RESPONSE';
 });
 await assert.rejects(client(async()=>({status:200,body:'<html>'+secret+'</html>'})).listProducts(),error=>{
  assert.equal(error.status,200);assert.deepEqual(error.diagnostic,{field:'response.json',expected:'JSON',actual:'non-JSON'});
  assert(!JSON.stringify(error).includes(secret));return error.code==='INVALID_RESPONSE';
 });
 const base={field:'data[].stock',expected:'nonnegative-integer',actual:'string'};
 for(const key of ['field','expected','actual'])assert.equal(new EmallError('INVALID_RESPONSE',200,{...base,[key]:secret}).diagnostic,null);
 const sanitized=new EmallError('INVALID_RESPONSE',200,{...base,[secret]:secret});
 assert.deepEqual(sanitized.diagnostic,base);assert(!JSON.stringify(sanitized).includes(secret));
 let reads=0;
 const changing={...base,get field(){return reads++===0?base.field:secret}};
 assert.deepEqual(new EmallError('INVALID_RESPONSE',200,changing).diagnostic,base);assert.equal(reads,1);
 assert.equal(new EmallError('INVALID_RESPONSE',200,{get field(){throw new Error(secret)}}).diagnostic,null);
 assert.equal(new EmallError('NETWORK').diagnostic,null);
 await assert.rejects(client(async()=>{const error=new EmallError('INVALID_RESPONSE',200);error.diagnostic={...base,field:secret};throw error}).listProducts(),error=>error.diagnostic===null&&!JSON.stringify(error).includes(secret));
});
test('wrong page numbers, premature empty pages and contradictory page totals stop pagination',async()=>{
 for(const response of [page([card(1)],{current:2,total:2,perPage:1}),page([],{total:6}),{status:200,body:JSON.stringify({data:[card(1)],meta:{total:6,count:1,per_page:5,current_page:1,total_pages:1}})}])await assert.rejects(client(async()=>response).listProducts(),errorCode('PAGINATION_ERROR'));
});
test('an incomplete last page or changing total/page size cannot silently truncate a catalog',async()=>{
 for(const mode of ['missing-last','total-changed','per-page-changed']){
  let calls=0;
  await assert.rejects(client(async()=>{
   calls++;if(calls===1)return page(Array.from({length:100},(_,i)=>card(i+1)),{total:102,perPage:100});
   if(mode==='missing-last')return page([card(101)],{total:102,current:2,perPage:100});
   if(mode==='total-changed')return page([card(101),card(102),card(103)],{total:103,current:2,perPage:100});
   return page(Array.from({length:50},(_,i)=>card(i+101)),{total:102,current:2,perPage:50});
  }).listProducts({limit:105}),errorCode('PAGINATION_ERROR'));
  assert.equal(calls,2);
 }
});
test('HTTP authentication errors and redirects expose only safe numeric status; no response body or key',async()=>{
 for(const status of [301,302,307,308,401,403,429,500]){
  let calls=0;await assert.rejects(client(async()=>{calls++;return {status,body:'untrusted-body '+token+' https://other.example'}}).listProducts(),error=>error.code==='HTTP_ERROR'&&error.status===status&&!error.message.includes(token)&&!error.message.includes('untrusted-body'));
  assert.equal(calls,1);
 }
});
test('network errors cannot echo transport exception details or credentials',async()=>{
 await assert.rejects(client(async()=>{throw new Error('transport failure '+token)}).listProducts(),error=>error.code==='NETWORK'&&!String(error.stack).includes(token)&&!Object.hasOwn(error,'cause'));
});
test('response payloads over 5 MiB are rejected before JSON parsing',async()=>{
 await assert.rejects(client(async()=>({status:200,body:'x'.repeat(5*1024*1024+1)})).listProducts(),errorCode('RESPONSE_TOO_LARGE'));
});
test('malformed transport results are rejected without exposing arbitrary data',async()=>{
 for(const response of [null,{}, {status:'200',body:'{}'}, {status:600,body:'{}'}, {status:200,body:{data:[]}}])await assert.rejects(client(async()=>response).listProducts(),errorCode('INVALID_RESPONSE'));
});
test('default curl transport keeps bearer in stdin, disables curlrc, and does not enable redirects or TLS bypass',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'homeharmony-fake-curl-')),log=join(dir,'calls.txt');
 try{
  const executable=`#!${process.execPath}\nimport assert from 'node:assert/strict';import{readFileSync,appendFileSync}from'node:fs';
assert.deepEqual(process.argv.slice(2),['--disable','--config','-']);
const config=readFileSync(0,'utf8');
assert(config.includes('header = "Authorization: Bearer fictional-curl-secret"'));
assert(config.includes('header = "Accept: application/json"'));
assert(config.includes('url = "https://api.emall.by/open/api/v1/products?page=1&perPage=5"'));
assert(config.includes('request = "GET"'));assert(config.includes('proto = "=https"'));assert(config.includes('proto-redir = "=https"'));
assert(config.includes('max-redirs = 0'));assert(config.includes('max-filesize = 5242880'));assert(config.includes('max-time = 30'));
assert(!/^(?:location|insecure|verbose|trace|trace-ascii)\\b/m.test(config));
appendFileSync(process.env.FAKE_CURL_LOG,'called\\n');
process.stdout.write(${JSON.stringify(page([card(1)]).body)}+'\\n'+process.env.FAKE_CURL_STATUS);
`;
  // .mjs keeps the executable fixture an ES module independent of the temp directory.
  await writeFile(join(dir,'fake-curl.mjs'),executable,{mode:0o700});
  await writeFile(join(dir,'curl'),`#!${process.execPath}\nawait import(${JSON.stringify(new URL('file://'+join(dir,'fake-curl.mjs')).href)});\n`,{mode:0o700});
  for(const status of ['200','302']){
   const code=`import assert from 'node:assert/strict';import{createEmallClient}from'./server/emall.mjs';
const run=createEmallClient().listProducts();
if(process.env.FAKE_CURL_STATUS==='302')await assert.rejects(run,e=>e.code==='HTTP_ERROR'&&e.status===302);
else{const result=await run;assert.equal(result.products.length,1);assert.equal(result.products[0].id,1);assert.equal(result.pagesRead,1)}console.log('PASS');`;
   const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:dir+delimiter+process.env.PATH,EMALL_API_TOKEN:'fictional-curl-secret',EMALL_SANDBOX_API_TOKEN:'',FAKE_CURL_LOG:log,FAKE_CURL_STATUS:status}});
   assert.equal(stdout.trim(),'PASS');
  }
  assert.equal(await readFile(log,'utf8'),'called\ncalled\n');
 }finally{await rm(dir,{recursive:true,force:true})}
});
