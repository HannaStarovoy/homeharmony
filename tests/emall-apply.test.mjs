import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
test('downloaded bulk bundle installs locally with a backup and preserves manual edits on repeat',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emall-install-'));
 try{
  await cp(new URL('../server/',import.meta.url),join(dir,'server'),{recursive:true});await mkdir(join(dir,'scripts'));await mkdir(join(dir,'data'));
  await cp(new URL('../catalog-data.js',import.meta.url),join(dir,'catalog-data.js'));
  await cp(new URL('../scripts/apply-emall-all.mjs',import.meta.url),join(dir,'scripts/apply-emall-all.mjs'));
  const bundle=join(dir,'download');await mkdir(join(bundle,'media'),{recursive:true});
  const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#ccc'}}).webp().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex'),file=sha256+'.webp',url='/uploads/emall-'+file;
  const manifest={version:1,source:{provider:'emall',environment:'production',account:'homeharmony-emall-main'},products:Array.from({length:6},(_,i)=>({externalId:String(i+1),name:'Synthetic '+i,cat:'beanies',images:[url],variants:[{externalId:String(i+1),price:10,stock:2}]})),media:[{url,file,sha256,width:20,height:20,bytes:bytes.length}]};
  await writeFile(join(bundle,'media',file),bytes);await writeFile(join(bundle,'manifest.json'),JSON.stringify(manifest));await writeFile(join(bundle,'review.json'),'{}');
  const env={...process.env};delete env.SHOP_DATA_DIR;
  const run=()=>spawnSync(process.execPath,['scripts/apply-emall-all.mjs',bundle],{cwd:dir,env,encoding:'utf8',timeout:20000});
  const first=run();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).created,6);
  const db=new DatabaseSync(join(dir,'var/shop.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,20);db.prepare("UPDATE products SET name='Manual' WHERE status='draft'").run();db.close();
  const second=run();assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).applied,false);
  const reopened=new DatabaseSync(join(dir,'var/shop.sqlite'));assert.equal(reopened.prepare("SELECT count(*) n FROM products WHERE name='Manual'").get().n,6);reopened.close();
  assert.equal((await readdir(join(dir,'var/backups'))).length,2);assert.equal(JSON.parse(await readFile(join(dir,'data/emall-mass/manifest.json'),'utf8')).products.length,6);
 }finally{await rm(dir,{recursive:true,force:true})}
});
