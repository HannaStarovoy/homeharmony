// CLI diagnostics only: no live Emall requests and no real credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

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
