import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
test('bulk command reads multiple pages, skips bad cards and emits a verified deduplicated bundle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emall-bulk-test-'));
 try{
  const bytes=await sharp({create:{width:24,height:32,channels:3,background:'#bbb'}}).png().toBuffer();
  await writeFile(join(dir,'curl'),'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),c=fs.readFileSync(0,'utf8'),u=new URL(c.match(/^url = "(.+)"$/m)[1]);
if(!c.includes('request = "GET"'))process.exit(90);
fs.appendFileSync(${JSON.stringify(join(dir,'requests.txt'))},u.pathname+'\\n');
if(c.includes('%{stderr}')){if(c.includes('Authorization:'))process.exit(91);process.stdout.write(u.pathname==='/bad'?Buffer.from('<html>Unavailable</html>'):Buffer.from('${bytes.toString('base64')}','base64'));process.stderr.write('200\\n')}
else{
let data,total=0,page=Number(u.searchParams.get('page')),per=Number(u.searchParams.get('perPage'));
if(u.pathname==='/open/api/v1/products'){total=102;data=Array.from({length:Math.min(per,total-(page-1)*per)},(_,j)=>{const id=(page-1)*per+j+1;return {id,name:'Synthetic '+id,category_id:id===1?999:11,prices:{price:1234},stock:2,properties:{},images:['https://api.emall.by/'+(id===2?'bad':'good')]}})}
else if(u.pathname==='/open/api/v1/products/2'&&process.env.DETAIL_RESCUE==='1'){process.stdout.write(JSON.stringify({id:2,name:'Synthetic 2',category_id:11,prices:{price:1234},stock:2,images:['https://api.emall.by/good']})+'\\n200');process.exit(0)}
else if(u.pathname==='/open/api/v1/catalog/categories'){data=[{id:11,name:'Шапки'},{id:999,name:'Unmapped'}];total=2}
else if(u.pathname==='/open/api/v1/configurator/categories/11/properties'){data=[];total=0}
else process.exit(92);
process.stdout.write(JSON.stringify({data,meta:{total,count:data.length,per_page:per,current_page:page,total_pages:Math.ceil(total/per)}})+'\\n200');}
`,{mode:0o700});
  const output=join(dir,'bundle'),r=spawnSync(process.execPath,['scripts/import-emall-all.mjs','--output',output],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:dir+delimiter+process.env.PATH,EMALL_API_TOKEN:'SYNTHETIC_BULK_TOKEN'},encoding:'utf8',timeout:60000});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{received:102,prepared:100,skipped:2,photos:1,published:0});
  const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8')),review=JSON.parse(await readFile(join(output,'review.json'),'utf8'));
  assert.equal(manifest.products.length,100);assert.equal(manifest.media.length,1);assert.deepEqual(review.skipped.map(s=>s.code),['CATEGORY_UNMAPPED','NO_VALID_PHOTOS']);assert(!JSON.stringify({manifest,review}).includes('SYNTHETIC_BULK_TOKEN'));
  const env={...process.env,PATH:dir+delimiter+process.env.PATH,EMALL_API_TOKEN:'SYNTHETIC_BULK_TOKEN'};
  const requestOffset=(await readFile(join(dir,'requests.txt'),'utf8')).length;
  const resumed=spawnSync(process.execPath,['scripts/import-emall-all.mjs','--output',join(dir,'resumed'),'--resume',output],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',timeout:20000});
  assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).prepared,100);assert.equal(JSON.parse(resumed.stdout).photos,1);
  assert(!(await readFile(join(dir,'requests.txt'),'utf8')).slice(requestOffset).includes('/good'));
  const rescued=spawnSync(process.execPath,['scripts/import-emall-all.mjs','--output',join(dir,'rescued'),'--resume',output],{cwd:new URL('../',import.meta.url),env:{...env,DETAIL_RESCUE:'1'},encoding:'utf8',timeout:20000});
  assert.equal(rescued.status,0,rescued.stderr);assert.equal(JSON.parse(rescued.stdout).prepared,101);assert.equal(JSON.parse(rescued.stdout).skipped,1);
  assert(JSON.parse(await readFile(join(dir,'rescued/review.json'),'utf8')).warnings.some(w=>w.code==='DETAIL_PHOTOS_USED'));
  const incomplete=spawnSync(process.execPath,['scripts/import-emall-all.mjs','--output',join(dir,'incomplete'),'--limit','2'],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',timeout:20000});
  assert.equal(incomplete.status,1);assert.match(incomplete.stderr,/CATALOG_LIMIT_EXCEEDED/);
  const curl=join(dir,'curl');await writeFile(curl,(await readFile(curl,'utf8')).replace('category_id:id===1?999:11','category_id:999'),{mode:0o700});
  const emptyOutput=join(dir,'all-skipped'),empty=spawnSync(process.execPath,['scripts/import-emall-all.mjs','--output',emptyOutput],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',timeout:20000});
  assert.equal(empty.status,1);assert.match(empty.stderr,/NO_IMPORTABLE_PRODUCTS/);assert.equal(JSON.parse(await readFile(join(emptyOutput,'review.json'),'utf8')).skipped.length,102);

 }finally{await rm(dir,{recursive:true,force:true})}
});
