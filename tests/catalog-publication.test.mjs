// Artificial local records verify the owner's five-product publication decision.
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store.mjs';
import {applyCatalogPublication} from '../server/catalog-publication.mjs';

const source={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
const plan=()=>({version:1,id:'emall-first-five-2026-11-04',source:{...source},externalIds:['1001','1002','1003','1004','1005']});
let directory,planPath,store,dataDir;
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'homeharmony-publication-'));dataDir=join(directory,'store');planPath=join(directory,'publication.json');store=openStore(dataDir);
});
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true})});
async function fixture(){
 const url='/uploads/synthetic-publication.webp';
 store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(url,'synthetic-publication.webp',1,1,4);
 const records=plan().externalIds.map((id,index)=>({externalId:id,name:'Искусственный товар '+id,cat:'beanies',summary:'Только тест.',attrs:{Материал:'Искусственный'},images:[url],variants:[{externalId:id,price:12.5+index,old:20,stock:3+index,options:{Цвет:'Тестовый'},images:[url]}]}));
 store.imports.apply(records,source);await writeFile(planPath,JSON.stringify(plan()));return {url};
}
const linked=()=>store.db.prepare('SELECT product_id FROM import_products WHERE provider=? AND environment=? AND account=? ORDER BY external_id').all(...Object.values(source)).map(row=>row.product_id);
const selected=()=>{const ids=new Set(linked());return store.products(false,{expire:false}).filter(product=>ids.has(product.id))};
const markers=()=>store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_publications'").get()?store.db.prepare('SELECT count(*) AS n FROM catalog_publications').get().n:0;

test('missing plan performs no publication or marker write',()=>{
 assert.deepEqual(applyCatalogPublication(store,planPath),{applied:false,reason:'missing'});assert.equal(markers(),0);assert.equal(store.products(true).length,14);
});
test('publishes exactly the linked five products and their media while preserving inventory and unrelated products',async()=>{
 const {url}=await fixture(),before=selected(),other=store.products(true);
 assert.equal(store.isPublicMedia(url),false);
 assert.deepEqual(applyCatalogPublication(store,planPath),{applied:true,id:plan().id,published:5,alreadyPublished:0});
 assert.equal(store.products(true).length,19);assert.equal(store.isPublicMedia(url),true);assert.equal(markers(),1);
 for(const product of before){const after=selected().find(value=>value.id===product.id);assert.equal(after.status,'published');assert.deepEqual(after.variants,product.variants);assert.deepEqual(after.attrs,product.attrs);assert.deepEqual(after.images,product.images);assert.equal(after.version,product.version+1)}
 assert.deepEqual(store.products(true).filter(product=>!linked().includes(product.id)),other);
});
test('restarting with the same decision preserves a later manual withdrawal and edit',async()=>{
 await fixture();applyCatalogPublication(store,planPath);
 const product=selected()[0];store.saveProduct({...product,status:'draft',name:'Ручная правка'},product.id);
 const version=selected().find(p=>p.id===product.id).version;
 store.close();store=openStore(dataDir);
 const reordered=plan();await writeFile(planPath,JSON.stringify({externalIds:[...reordered.externalIds].reverse(),source:{account:source.account,environment:source.environment,provider:source.provider},id:reordered.id,version:1}));
 assert.deepEqual(applyCatalogPublication(store,planPath),{applied:false,reason:'already-applied',id:plan().id});
 const actual=selected().find(p=>p.id===product.id);assert.equal(actual.status,'draft');assert.equal(actual.name,'Ручная правка');assert.equal(actual.version,version);assert.equal(store.products(true).length,18);
});
test('missing linked product and mid-batch save failure publish nothing and leave no decision marker',async()=>{
 await fixture();const missing=plan();missing.externalIds[4]='9999';await writeFile(planPath,JSON.stringify(missing));
 assert.throws(()=>applyCatalogPublication(store,planPath),/source product is missing/);assert(selected().every(p=>p.status==='draft'));assert.equal(markers(),0);
 await writeFile(planPath,JSON.stringify(plan()));
 const failId=linked()[2];store.db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON products WHEN NEW.id='"+failId+"' BEGIN SELECT RAISE(ABORT,'simulated publication failure'); END;");
 assert.throws(()=>applyCatalogPublication(store,planPath),/simulated publication failure/);assert(selected().every(p=>p.status==='draft'&&p.version===1));assert.equal(markers(),0);assert.equal(store.products(true).length,14);
 store.db.exec('DROP TRIGGER fail_publication');assert.equal(applyCatalogPublication(store,planPath).published,5);
});
test('existing publication stays unchanged and a reused decision cannot target another source ID',async()=>{
 await fixture();const product=selected()[0];store.saveProduct({...product,status:'published'},product.id);const version=selected().find(p=>p.id===product.id).version;
 assert.deepEqual(applyCatalogPublication(store,planPath),{applied:true,id:plan().id,published:4,alreadyPublished:1});assert.equal(selected().find(p=>p.id===product.id).version,version);
 const changed=plan();changed.externalIds[4]='9999';await writeFile(planPath,JSON.stringify(changed));assert.throws(()=>applyCatalogPublication(store,planPath),/decision cannot be changed/);assert.equal(markers(),1);
});
test('invalid sources, IDs, shape, oversized files and symlinks cannot publish records',async()=>{
 await fixture();
 for(const mutate of [p=>p.source.environment='sandbox',p=>p.source.account='other',p=>p.source.provider='other',p=>p.source.extra='bad',p=>p.version=2,p=>p.id='unknown',p=>p.extra='bad',p=>p.externalIds.pop(),p=>p.externalIds[0]='01001',p=>p.externalIds[0]='1002',p=>p.externalIds[0]=1001,p=>p.externalIds[0]='9007199254740992']){
  const invalid=plan();mutate(invalid);await writeFile(planPath,JSON.stringify(invalid));assert.throws(()=>applyCatalogPublication(store,planPath),/Invalid catalog publication/);assert.equal(markers(),0);assert(selected().every(p=>p.status==='draft'));
 }
 await writeFile(planPath,' '.repeat(64*1024+1));assert.throws(()=>applyCatalogPublication(store,planPath),/bounded regular file/);
 await writeFile(join(directory,'outside.json'),JSON.stringify(plan()));await rm(planPath);await symlink(join(directory,'outside.json'),planPath);assert.throws(()=>applyCatalogPublication(store,planPath),/symlinks/);assert.equal(markers(),0);
});
