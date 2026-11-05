import {updateCategories,updateBeautyCategories} from './category-update.mjs';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,readFile,writeFile,rm,mkdir,unlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Problem} from './errors.mjs';
const LIMIT=256*1024*1024,AUTH=new Set(['admins','sessions','login_limits']);
const hash=data=>createHash('sha256').update(data).digest('hex');
const safeName=name=>typeof name==='string'&&/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,180}\.webp$/.test(name);
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
export function createBackups(store){
 const {db,uploadDir,dataDir}=store;
 async function exportBackup(){
  const directory=await mkdtemp(join(tmpdir(),'homeharmony-export-'));let copy;
  try{
   const path=join(directory,'snapshot.sqlite');await backup(db,path);copy=new DatabaseSync(path);copy.exec('PRAGMA secure_delete=ON; DELETE FROM sessions; DELETE FROM login_limits; DELETE FROM admins; VACUUM;');
   const media=copy.prepare('SELECT filename FROM media').all();copy.close();copy=null;
   const files=[];let size=0;for(const row of media){if(!safeName(row.filename))throw new Problem(422,'Проверьте имена фотографий перед резервным копированием.');const bytes=await readFile(join(uploadDir,row.filename));size+=bytes.length;if(size>150*1024*1024)throw new Problem(413,'Фото занимают больше 150 МБ. Скопируйте папку var при остановленном магазине.');files.push({name:row.filename,hash:hash(bytes),data:bytes.toString('base64')})}
   const bytes=await readFile(path),json=Buffer.from(JSON.stringify({format:'homeharmony-backup-v1',createdAt:new Date().toISOString(),database:bytes.toString('base64'),databaseHash:hash(bytes),files}));if(json.length>LIMIT)throw new Problem(413,'Резервная копия слишком большая.');return gzipSync(json);
  }finally{copy?.close();await rm(directory,{recursive:true,force:true})}
 }
 async function prepare(buffer){
  let archive;try{archive=JSON.parse(gunzipSync(buffer,{maxOutputLength:LIMIT}).toString('utf8'))}catch{throw new Problem(422,'Файл повреждён или не является резервной копией HomeHarmony.')}
  if(archive?.format!=='homeharmony-backup-v1'||typeof archive.database!=='string'||!Array.isArray(archive.files)||archive.files.length>20000||!Number.isFinite(Date.parse(archive.createdAt)))throw new Problem(422,'Неверный формат резервной копии.');
  const bytes=Buffer.from(archive.database,'base64');if(bytes.length>LIMIT||hash(bytes)!==archive.databaseHash)throw new Problem(422,'Проверка базы данных не пройдена.');
  const directory=await mkdtemp(join(tmpdir(),'homeharmony-restore-'));let source;
  try{
   const path=join(directory,'restore.sqlite');await writeFile(path,bytes,{mode:0o600});source=new DatabaseSync(path,{readOnly:true});
   if(source.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||source.prepare('PRAGMA foreign_key_check').all().length)throw new Error('integrity');
   if(JSON.stringify(schema(source))!==JSON.stringify(schema(db)))throw new Problem(422,'Копия создана другой версией магазина. Используйте ту же версию приложения.');
   const expected=new Set(source.prepare('SELECT filename FROM media').all().map(row=>row.filename)),files=new Map();
   for(const file of archive.files){if(!safeName(file?.name)||files.has(file.name)||!expected.has(file.name)||typeof file.data!=='string')throw new Error('media');const data=Buffer.from(file.data,'base64');if(data.length>8*1024*1024||hash(data)!==file.hash)throw new Error('media');files.set(file.name,data)}
   if(files.size!==expected.size)throw new Error('media');
   const counts={products:source.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL').get().n,orders:source.prepare('SELECT count(*) AS n FROM orders').get().n,photos:files.size};source.close();source=null;
   return {directory,path,files,summary:{createdAt:archive.createdAt,...counts}};
  }catch(error){source?.close();await rm(directory,{recursive:true,force:true});if(error instanceof Problem)throw error;throw new Problem(422,'Копия повреждена: база или фотографии не прошли проверку.')}
 }
 async function inspect(buffer){const prepared=await prepare(buffer);try{return prepared.summary}finally{await rm(prepared.directory,{recursive:true,force:true})}}
 async function restore(buffer){
  const prepared=await prepare(buffer),written=[];let attached=false,inTransaction=false,committed=false,fkDisabled=false;
  try{
   const safety=await exportBackup();await mkdir(join(dataDir,'backups'),{recursive:true,mode:0o700});const safetyName='before-restore-'+new Date().toISOString().replace(/[:.]/g,'-')+'.hhbackup';await writeFile(join(dataDir,'backups',safetyName),safety,{mode:0o600,flag:'wx'});
   for(const [name,bytes] of prepared.files){const path=join(uploadDir,name);try{const current=await readFile(path);if(hash(current)!==hash(bytes))throw new Problem(409,'Фотография с таким именем уже существует с другим содержимым. Восстановление остановлено.')}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(path,bytes,{mode:0o600,flag:'wx'});written.push(path)}}
   db.prepare('ATTACH DATABASE ? AS recovery_source').run(prepared.path);attached=true;db.exec('PRAGMA foreign_keys=OFF;');fkDisabled=true;db.exec('BEGIN IMMEDIATE;');inTransaction=true;
   const versionOffset=1+Math.max(db.prepare('SELECT coalesce(max(version),0) AS n FROM products').get().n,db.prepare('SELECT coalesce(max(version),0) AS n FROM orders').get().n);
   const tables=schema(db).filter(row=>row.type==='table'&&!AUTH.has(row.name)).map(row=>row.name);if(tables.some(name=>! /^[a-z_][a-z0-9_]*$/.test(name)))throw new Error('schema');
   for(const table of tables)db.exec('DELETE FROM main."'+table+'"');for(const table of tables)db.exec('INSERT INTO main."'+table+'" SELECT * FROM recovery_source."'+table+'"');
   // Invalidate every old browser version, including values from before the restore.
   db.prepare('UPDATE products SET version=version+?').run(versionOffset);db.prepare('UPDATE orders SET version=version+?').run(versionOffset);if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Problem(422,'Связи данных в копии повреждены. Восстановление отменено.');db.exec('COMMIT');inTransaction=false;committed=true;db.exec('PRAGMA foreign_keys=ON;');fkDisabled=false;db.exec('DETACH DATABASE recovery_source');attached=false;updateCategories(db);updateBeautyCategories(db);store.orders.expire();return {ok:true,...prepared.summary,safetyName};
  }catch(error){if(inTransaction)db.exec('ROLLBACK');if(fkDisabled)db.exec('PRAGMA foreign_keys=ON;');if(attached)db.exec('DETACH DATABASE recovery_source');if(!committed)await Promise.all(written.map(path=>unlink(path).catch(()=>{})));throw error}
  finally{await rm(prepared.directory,{recursive:true,force:true})}
 }
 async function listSafety(){try{return (await readdir(join(dataDir,'backups'))).filter(name=>/^before-restore-[a-zA-Z0-9-]+\.hhbackup$/.test(name)).sort().reverse()}catch(error){if(error.code==='ENOENT')return [];throw error}}
 async function downloadSafety(name){if(typeof name!=='string'||!/^before-restore-[a-zA-Z0-9-]+\.hhbackup$/.test(name))throw new Problem(404,'Копия не найдена.');try{return await readFile(join(dataDir,'backups',name))}catch(error){if(error.code==='ENOENT')throw new Problem(404,'Копия не найдена.');throw error}}
 return {exportBackup,inspect,restore,listSafety,downloadSafety};
}
