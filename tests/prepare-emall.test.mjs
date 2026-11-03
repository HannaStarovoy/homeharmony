// End-to-end bundle preparation with a fake curl process; never contacts a live service.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';

async function fixture(knownCategory=true,imageFailure=false,secondaryPhoto=false){
 const directory=await mkdtemp(join(tmpdir(),'homeharmony-prepare-cli-'));
 const image=imageFailure?Buffer.from('<html>PRIVATE_IMAGE_BODY</html>'):await sharp({create:{width:32,height:24,channels:3,background:'#cc9900'}}).png().toBuffer();
 const secondary=secondaryPhoto?await sharp({create:{width:48,height:36,channels:3,background:'#1177cc'}}).jpeg().toBuffer():image;
 const images=['https://api.emall.by/synthetic.png',...(secondaryPhoto?['https://api.emall.by/secondary.jpg']:[])];
 const script='#!'+process.execPath+'\n'+`
const fs=require('node:fs');
const config=fs.readFileSync(0,'utf8');
const url=new URL(config.match(/^url = "(.+)"$/m)[1]);
if(config.includes('%{stderr}')){
 if(config.includes('Authorization:'))process.exit(90);
 process.stdout.write(Buffer.from(url.pathname==='/secondary.jpg'?${JSON.stringify(secondary.toString('base64'))}:${JSON.stringify(image.toString('base64'))},'base64'));
 process.stderr.write('200\\n');
}else{
 let data;
 if(url.pathname==='/open/api/v1/products')data=Array.from({length:5},(_,i)=>({id:i+1,name:'Synthetic card '+(i+1),category_id:998123,prices:{price:1234,old_price:null},stock:3,inner_article:null,description:'<p>Synthetic description</p>',properties:{},images:${JSON.stringify(images)}}));
 else if(url.pathname==='/open/api/v1/catalog/categories')data=[{id:998123,name:${JSON.stringify(knownCategory?'Шапки':'Unmapped synthetic category')},children:[]}];
 else if(url.pathname==='/open/api/v1/configurator/categories/998123/properties')data=[];
 else process.exit(91);
 process.stdout.write(JSON.stringify({data,meta:{total:data.length,count:data.length,per_page:Number(url.searchParams.get('perPage')),current_page:1,total_pages:data.length?1:0}})+'\\n200');
}
`;
 await writeFile(join(directory,'curl'),script,{mode:0o700});
 const output=join(directory,'bundle'),summary=join(directory,'summary.md');
 const run=()=>spawnSync(process.execPath,['scripts/prepare-emall-drafts.mjs','--output',output],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:directory+delimiter+process.env.PATH,EMALL_API_TOKEN:'FICTIONAL_PREPARE_TEST_TOKEN',GITHUB_STEP_SUMMARY:summary},encoding:'utf8',timeout:20000});
 return {directory,output,summary,run};
}
test('preparation CLI produces five verified drafts and deduplicated local photos without live data',async()=>{
 const f=await fixture();
 try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.prepared,5);assert.equal(report.photos,1);assert.equal(report.published,0);
  const manifest=JSON.parse(await readFile(join(f.output,'manifest.json'),'utf8'));
  assert.equal(manifest.products.length,5);assert.equal(manifest.media.length,1);
  assert(manifest.products.every(p=>p.cat==='beanies'&&p.variants[0].price===12.34&&p.images[0]===manifest.media[0].url));
  assert(!JSON.stringify(manifest).includes('FICTIONAL_PREPARE_TEST_TOKEN'));assert.match(await readFile(f.summary,'utf8'),/Подготовлено карточек: 5/);
  const again=f.run();assert.equal(again.status,1);assert.match(again.stderr,/OUTPUT_EXISTS/);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
test('unmapped categories fail without a partial output bundle or source details in logs',async()=>{
 const f=await fixture(false);
 try{
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/CATEGORY_UNMAPPED/);assert(!result.stderr.includes('Synthetic card'));
  assert.equal(await stat(f.output).then(()=>true,()=>false),false);
  const diagnostic=JSON.parse(await readFile(f.output+'.diagnostic.json','utf8'));
  assert.equal(diagnostic.categoryId,998123);assert.deepEqual(diagnostic.path,['Unmapped synthetic category']);
  assert(!JSON.stringify(diagnostic).includes('Synthetic card'));assert(!JSON.stringify(diagnostic).includes('FICTIONAL_PREPARE_TEST_TOKEN'));
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
test('preparation CLI replaces an HTML cover with a real secondary JPEG and reports every skipped source',async()=>{
 const f=await fixture(true,true,true);
 try{
  const result=f.run();assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.deepEqual(report,{prepared:5,photos:1,warningCount:5,published:0});
  const manifest=JSON.parse(await readFile(join(f.output,'manifest.json'),'utf8'));
  assert.equal(manifest.products.length,5);assert.equal(manifest.media.length,1);
  assert(manifest.products.every(product=>product.images.length===1&&product.images[0]===manifest.media[0].url));
  const metadata=await sharp(await readFile(join(f.output,'media',manifest.media[0].file))).metadata();
  assert.equal(metadata.format,'webp');assert.equal(metadata.width,48);assert.equal(metadata.height,36);
  const review=JSON.parse(await readFile(join(f.output,'review.json'),'utf8'));
  assert.equal(review.warnings.length,report.warningCount);
  assert.deepEqual(review.warnings.map(({externalId,code,photoIndex,reason,status})=>({externalId,code,photoIndex,reason,status})),Array.from({length:5},(_,index)=>({externalId:String(index+1),code:'SOURCE_PHOTO_SKIPPED',photoIndex:0,reason:'INVALID_IMAGE',status:null})));
  assert(review.warnings.every(warning=>warning.imageDiagnostic.format==='html'));
  const artifacts=JSON.stringify({manifest,review,report});
  assert(!artifacts.includes('PRIVATE_IMAGE_BODY'));assert(!artifacts.includes('FICTIONAL_PREPARE_TEST_TOKEN'));assert(!artifacts.includes('https://'));
  assert.match(await readFile(f.summary,'utf8'),/Предупреждений для проверки: 5/);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
test('failed source photos keep only the approved five-record review in a private diagnostic artifact',async()=>{
 const f=await fixture(true,true);
 try{
  const result=f.run();assert.equal(result.status,1);assert.match(result.stderr,/NO_VALID_PHOTOS/);assert(!result.stderr.includes('Synthetic card'));assert(!result.stderr.includes('PRIVATE_IMAGE_BODY'));
  const diagnostic=JSON.parse(await readFile(f.output+'.diagnostic.json','utf8'));
  assert.equal(diagnostic.kind,'image-preparation');assert.equal(diagnostic.records.length,5);assert.equal(diagnostic.imageJobs.length,5);
  assert.equal(diagnostic.imageDiagnostic,null);
  assert(!JSON.stringify(diagnostic).includes('PRIVATE_IMAGE_BODY'));assert(!JSON.stringify(diagnostic).includes('FICTIONAL_PREPARE_TEST_TOKEN'));
  assert.equal(await stat(f.output).then(()=>true,()=>false),false);
 }finally{await rm(f.directory,{recursive:true,force:true})}
});
