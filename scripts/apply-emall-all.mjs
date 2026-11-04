// Applies a downloaded, validated bulk bundle; no API credentials required.
import {mkdir,mkdtemp,cp,rename,rm,lstat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {backup} from 'node:sqlite';
import {openStore,root} from '../server/store.mjs';
import {loadDraftBundle} from '../server/draft-bundle.mjs';
let temporary,checkDir,check,store;
try{
 if(process.argv.length!==3)throw Error('USAGE');
 const source=resolve(process.argv[2]),target=join(root,'data/emall-mass');
 if(source===target||target.startsWith(source+'/'))throw Error('INVALID_PATH');
 const stat=await lstat(source);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('INVALID_PATH');
 await mkdir(join(root,'var'),{recursive:true,mode:0o700});
 checkDir=await mkdtemp(join(root,'var','.check-bulk-'));check=openStore(checkDir);loadDraftBundle(check,source,{slot:'mass'});check.close();check=null;
 temporary=await mkdtemp(join(root,'data','.emall-mass-'));await cp(source,temporary,{recursive:true,dereference:false});
 store=openStore(undefined,{draftBundleDir:join(root,'data/emall-drafts'),publicationPlanPath:join(root,'data/emall-publication.json')});await mkdir(join(store.dataDir||root+'/var','backups'),{recursive:true});
 const backupDir=resolve(process.env.SHOP_DATA_DIR||join(root,'var'),'backups');await mkdir(backupDir,{recursive:true,mode:0o700});
 const snapshot=join(backupDir,'before-mass-import-'+Date.now()+'.sqlite');await backup(store.db,snapshot);await chmod(snapshot,0o600);
 let previous=null;try{await lstat(target);previous=target+'.previous-'+Date.now();await rename(target,previous)}catch(e){if(e.code!=='ENOENT')throw e}
 let result;
 try{await rename(temporary,target);temporary=null;result=loadDraftBundle(store,target,{slot:'mass'})}catch(e){await rm(target,{recursive:true,force:true});if(previous)await rename(previous,target);throw e}
 if(previous)await rm(previous,{recursive:true,force:true});
 console.log(JSON.stringify({applied:result.applied,created:result.created||0,updated:result.updated||0,unchanged:result.unchanged||0,published:0}));
}catch(e){console.error('Не удалось применить пакет. Проверьте путь к распакованной папке с manifest.json, review.json и media. Ошибка: '+(['USAGE','INVALID_PATH'].includes(e.message)?e.message:'BUNDLE_REJECTED'));process.exitCode=1}
finally{check?.close();store?.close();if(temporary)await rm(temporary,{recursive:true,force:true});if(checkDir)await rm(checkDir,{recursive:true,force:true})}
