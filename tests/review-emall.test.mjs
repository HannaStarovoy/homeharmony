// Artificial API responses for the five committed source IDs; no live API or shop DB.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,lstat,mkdir,copyFile} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const committed=JSON.parse(await readFile(new URL('../data/emall-drafts/manifest.json',import.meta.url),'utf8'));
// Only the approved IDs come from the real bundle; all compared quantities are synthetic.
const manifest={version:1,source:committed.source,products:committed.products.map(({externalId})=>({externalId,variants:[{price:12.34,old:0,stock:5}]}))};
const testToken='FICTIONAL_REVIEW_TOKEN';
async function fixture({failId=false,tooManyValues=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'homeharmony-review-cli-'));
 const project=join(directory,'project');
 await Promise.all(['scripts','server','data/emall-drafts'].map(path=>mkdir(join(project,path),{recursive:true})));
 await Promise.all([
  copyFile(new URL('scripts/review-emall-drafts.mjs',root),join(project,'scripts/review-emall-drafts.mjs')),
  copyFile(new URL('server/emall.mjs',root),join(project,'server/emall.mjs')),
  writeFile(join(project,'data/emall-drafts/manifest.json'),JSON.stringify(manifest)+'\n')
 ]);
 const cards=manifest.products.map((product,index)=>({id:Number(product.externalId),name:'Synthetic card',category_id:123,stock:product.variants[0].stock+(index===0?1:0),prices:{price:Math.round(product.variants[0].price*100)+(index===0?100:0),old_price:index===1?Math.round(product.variants[0].price*100):Math.round((product.variants[0].old||0)*100)},properties:{149:[23227],999:[100],150:tooManyValues?Array(51).fill(1):'<b>'+testToken+'</b><script>PRIVATE_SCRIPT</script>',888:null},warehouse_stock:7,available_stock:3,reserved:4,secret:'PRIVATE_UNKNOWN',images:['https://private.invalid/image'],auth:{token:'PRIVATE_UNKNOWN'}}));
 const script='#!'+process.execPath+'\n'+`
const fs=require('node:fs');
const config=fs.readFileSync(0,'utf8'),url=new URL(config.match(/^url = "(.+)"$/m)[1]);
if(!config.includes('request = "GET"')||url.origin!=='https://api.emall.by')process.exit(90);
fs.appendFileSync(${JSON.stringify(join(directory,'requests.jsonl'))},JSON.stringify({path:url.pathname,method:'GET'})+'\\n');
const cards=${JSON.stringify(cards)};
let payload;
const detail=url.pathname.match(/^\\/open\\/api\\/v1\\/products\\/(\\d+)$/),short=url.pathname.match(/^\\/open\\/api\\/v1\\/products\\/short\\/info\\/(\\d+)$/);
if(detail){const card=cards.find(card=>card.id===Number(detail[1]));if(!card)process.exit(91);payload={...card,id:${failId?'card.id+1':'card.id'}}}
else if(short){const card=cards.find(card=>card.id===Number(short[1]));if(!card)process.exit(92);payload={id:card.id,product_stock:String(card.stock),product_price:{price:String(card.prices.price),red_price:1},warehouse_stock:'7',available_stock:'3',reserved:'4',secret:'PRIVATE_UNKNOWN'}}
else if(url.pathname==='/open/api/v1/configurator/categories/123/properties'){
 const data=[{id:149,name:'Материал',property:{id:149,type:{name:'list'},values:[{id:23227,value:'Шерсть'},{id:555,value:'UNSELECTED_VALUE'}]},secret:'PRIVATE_UNKNOWN'},{id:150,name:'Описание',property_id:222,property:{id:999,type:{name:'text'},values:[{id:100,value:'Возможный alias'},{id:555,value:'UNSELECTED_VALUE'}]}}];
 payload={data,meta:{total:data.length,count:data.length,per_page:100,current_page:1,total_pages:1}};
}else process.exit(93);
process.stdout.write(JSON.stringify(payload)+'\\n200');
`;
 await writeFile(join(directory,'curl'),script,{mode:0o700});
 const output=join(directory,'result'),summary=join(directory,'summary.md');
 const run=()=>spawnSync(process.execPath,['scripts/review-emall-drafts.mjs','--output',output],{cwd:project,env:{...process.env,PATH:directory+delimiter+process.env.PATH,EMALL_API_TOKEN:testToken,GITHUB_STEP_SUMMARY:summary},encoding:'utf8',timeout:20000});
 return {directory,output,summary,run,requests:join(directory,'requests.jsonl')};
}
test('review reads only five approved IDs, reports drift and unresolved dictionary identity, and leaks no arbitrary fields',async()=>{
 const f=await fixture();
 try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.deepEqual(report,{reviewed:5,differenceCount:2,unresolvedProperties:5,imported:0,published:0});
  const text=await readFile(join(f.output,'review.json'),'utf8'),review=JSON.parse(text);
  assert.equal(review.version,1);assert.deepEqual(review.source,manifest.source);assert.equal(review.stockMeaning,'not-confirmed');assert.equal(review.shortPriceUnit,'not-separately-documented');assert(Number.isFinite(Date.parse(review.checkedAt)));
  assert.equal(review.products.length,5);assert.deepEqual(review.products.map(product=>product.externalId),manifest.products.map(product=>product.externalId));
  const first=review.products[0];assert.equal(first.current.detail.stock,first.saved.stock+1);assert.equal(first.current.detail.priceCents,first.saved.priceCents+100);assert.equal(first.current.short.rawPrice,first.current.detail.priceCents);
  assert.equal(review.products[1].current.detail.oldPriceCents,review.products[1].current.detail.priceCents);assert.equal(review.products[1].current.detail.normalizedOldPriceCents,0);assert.deepEqual(review.products[1].differences,[]);
  assert.deepEqual(first.properties.find(property=>property.propertyId===888).raw,[null]);
  assert.deepEqual(first.stockBreakdown,{detail:{warehouse_stock:7,available_stock:3,reserved:4},short:{warehouse_stock:7,available_stock:3,reserved:4}});
  assert.deepEqual(first.properties.find(property=>property.propertyId===149).definition.values,[{id:23227,value:'Шерсть'}]);
  assert.equal(first.properties.find(property=>property.propertyId===999).resolved,false);
  const alias=first.propertyDictionary.find(property=>property.id===150);assert.equal(alias.propertyId,222);assert.equal(alias.nestedPropertyId,999);assert.deepEqual(alias.values,[{id:100,value:'Возможный alias'}]);
  assert.deepEqual(first.properties.find(property=>property.propertyId===150).raw,['[redacted]']);
  for(const forbidden of [testToken,'PRIVATE_UNKNOWN','PRIVATE_SCRIPT','UNSELECTED_VALUE','https://','red_price'])assert(!text.includes(forbidden),forbidden);
  assert(!result.stdout.includes('Synthetic card'));assert(!result.stderr.includes(testToken));
  const requests=(await readFile(f.requests,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(requests.length,11);assert(requests.every(request=>request.method==='GET'));
  for(const product of manifest.products){assert.equal(requests.filter(request=>request.path==='/open/api/v1/products/'+product.externalId).length,1);assert.equal(requests.filter(request=>request.path==='/open/api/v1/products/short/info/'+product.externalId).length,1)}
  assert.equal(requests.filter(request=>request.path==='/open/api/v1/configurator/categories/123/properties').length,1);
  assert.match(await readFile(f.summary,'utf8'),/Расхождений: 2/);
  const again=f.run();assert.equal(again.status,1);assert.match(again.stderr,/OUTPUT_EXISTS/);assert.equal((await readFile(f.requests,'utf8')).trim().split('\n').length,11);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
test('review refuses mismatched source IDs and never writes a partial report',async()=>{
 const f=await fixture({failId:true});
 try{
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/INVALID_RESPONSE/);assert(!result.stderr.includes(testToken));assert.equal(await lstat(f.output).then(()=>true,()=>false),false);
  assert.equal((await readFile(f.requests,'utf8')).trim().split('\n').length,1);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
test('review bounds raw property lists and fails without a partial output',async()=>{
 const f=await fixture({tooManyValues:true});
 try{
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/AUDIT_LIMIT_EXCEEDED/);assert.equal(await lstat(f.output).then(()=>true,()=>false),false);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
