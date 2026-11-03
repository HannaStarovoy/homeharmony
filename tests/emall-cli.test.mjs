// CLI diagnostics only: no live Emall requests and no real credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';

function run(args=[],extra={}){
 return spawnSync(process.execPath,['scripts/check-emall.mjs',...args],{cwd:new URL('../',import.meta.url),env:{...process.env,EMALL_API_TOKEN:'',EMALL_SANDBOX_API_TOKEN:'',...extra},encoding:'utf8',timeout:5000});
}
test('read-only Emall CLI documents the required secret and cannot apply imports',()=>{
 const result=run(['--help']);assert.equal(result.status,0);assert.match(result.stdout,/EMALL_API_TOKEN/);assert.match(result.stdout,/не создаются/);
 assert.equal(run(['--apply']).status,1);
});
test('missing credentials fail before a network request and do not report a successful read',()=>{
 const result=run();assert.equal(result.status,1);assert.equal(result.stdout,'');assert(result.stderr.trim().length>0);
});
test('sandbox CLI never falls back to a production credential',()=>{
 const fake='FAKE_PRODUCTION_TEST_TOKEN';const result=run(['--sandbox'],{EMALL_API_TOKEN:fake});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert(!result.stderr.includes(fake));assert(!result.error);
});
test('diagnostic CLI rejects unbounded reads and unknown arguments',()=>{
 for(const args of [['--limit','101'],['--limit','0'],['--limit','oops'],['--token','FAKE_TEST_TOKEN']]){
  const result=run(args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert(!result.stderr.includes('FAKE_TEST_TOKEN'));
 }
});
test('GitHub summary contains counts without exposing source products or credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'homeharmony-github-cli-'));
 const source={id:90210,name:'PRIVATE_FIXTURE_NAME',category_id:321,description:'PRIVATE_FIXTURE_DESCRIPTION',images:['https://example.test/PRIVATE_FIXTURE_IMAGE'],prices:{price:4321},stock:71};
 const body=JSON.stringify({data:[source],meta:{total:1,count:1,per_page:5,current_page:1,total_pages:1}});
 try{
  await writeFile(join(dir,'curl'),'#!'+process.execPath+'\nprocess.stdout.write('+JSON.stringify(body+'\n200')+');\n',{mode:0o700});
  const summaryFile=join(dir,'summary.md'),fake='FAKE_GITHUB_TEST_TOKEN';
  const result=run(['--summary'],{EMALL_API_TOKEN:fake,PATH:dir+delimiter+process.env.PATH,GITHUB_STEP_SUMMARY:summaryFile});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{mode:'read-only',environment:'production',received:1,pagesRead:1,imported:0});
  const summary=await readFile(summaryFile,'utf8');assert.match(summary,/Получено карточек: 1/);
  for(const value of ['PRIVATE_FIXTURE',String(source.id),String(source.prices.price),fake])assert(!(result.stdout+result.stderr+summary).includes(value));
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('missing GitHub secret produces a useful failure summary without a live request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'homeharmony-github-missing-'));
 try{
  const summaryFile=join(dir,'summary.md'),result=run(['--summary'],{GITHUB_STEP_SUMMARY:summaryFile});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/EMALL_API_TOKEN/);
  const summary=await readFile(summaryFile,'utf8');assert.match(summary,/Проверка не завершена/);assert.match(summary,/Secrets репозитория/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
