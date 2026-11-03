// Image downloads are separate from the authenticated Emall API client.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {join,resolve} from 'node:path';
import sharp from 'sharp';

const MAX_BYTES=8*1024*1024,MAX_PIXELS=25_000_000,MAX_PHOTOS=8,MAX_REDIRECTS=4;
const PUBLIC_SUFFIXES=['emall.by','edostavka.by'];
const MESSAGES={
 INVALID_CONFIG:'Некорректные настройки подготовки фотографий Emall.',
 INVALID_SOURCE_URL:'Emall вернул небезопасный адрес фотографии.',
 HOST_NOT_ALLOWED:'Хост фотографии Emall не разрешён.',
 NETWORK:'Не удалось безопасно скачать фотографию Emall.',
 HTTP_ERROR:'Сервер фотографии Emall вернул ошибку HTTP.',
 INVALID_RESPONSE:'Сервер фотографии Emall вернул некорректный ответ.',
 TOO_MANY_REDIRECTS:'Превышено число перенаправлений фотографии Emall.',
 IMAGE_TOO_LARGE:'Фотография Emall превышает допустимый размер.',
 INVALID_IMAGE:'Нужна корректная статическая фотография JPEG, PNG или WebP до 25 мегапикселей.',
 WRITE_FAILED:'Не удалось записать подготовленную фотографию Emall.'
};
const safeHostname=value=>typeof value==='string'&&value.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)?value:null;
export class EmallMediaError extends Error{
 constructor(code,{status=null,hostname=null}={}){
  const safeCode=Object.hasOwn(MESSAGES,code)?code:'INVALID_RESPONSE';
  super(MESSAGES[safeCode]);this.name='EmallMediaError';this.code=safeCode;
  this.status=Number.isInteger(status)&&status>=100&&status<=599?status:null;
  if(safeCode==='HOST_NOT_ALLOWED'&&safeHostname(hostname))this.hostname=hostname;
 }
}
const failure=(code,details)=>new EmallMediaError(code,details);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(value).digest('hex');

function sourceURL(value,base){
 if(typeof value!=='string'||!value||value.length>8192||/[\s\\\x00-\x1f\x7f]/.test(value))throw failure('INVALID_SOURCE_URL');
 // Check the original path before URL parsing can remove dot segments. Decode
 // repeatedly so encoded separators and double-encoded traversal are rejected.
 const path=value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i,'').split(/[?#]/,1)[0];
 let decoded=path;
 try{
  for(let i=0;i<8;i++){
   if(decoded.includes('\\')||decoded.split('/').some(part=>part==='.'||part==='..'))throw failure('INVALID_SOURCE_URL');
   const next=decodeURIComponent(decoded);
   if(next===decoded)break;
   decoded=next;
   if(i===7)throw failure('INVALID_SOURCE_URL');
  }
 }catch{throw failure('INVALID_SOURCE_URL')}
 let url;
 try{url=base?new URL(value,base):new URL(value)}catch{throw failure('INVALID_SOURCE_URL')}
 const authority=(value.match(/^(?:https?:)?\/\/([^/?#]*)/i)||[])[1];
 if(url.protocol!=='https:'||url.username||url.password||authority?.includes('@')||url.port||url.hash||isIP(url.hostname)||!safeHostname(url.hostname))throw failure('INVALID_SOURCE_URL');
 if(!PUBLIC_SUFFIXES.some(suffix=>url.hostname===suffix||url.hostname.endsWith('.'+suffix)))throw failure('HOST_NOT_ALLOWED',{hostname:url.hostname});
 return url.href;
}

const curlQuote=value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
function curlTransport({url,headers}){
 return new Promise((resolve,reject)=>{
  // Inherit the managed proxy and CA environment. --disable must be first to
  // prevent .curlrc from changing TLS, auth or redirect policy. No API secrets
  // are read here, and only the fixed image Accept header is supplied.
  // curl's write-out switches to stderr directly. Opening /dev/fd/N is not
  // portable for Node stdio pipes, which may be sockets rather than files.
  const child=spawn('curl',['--disable','--config','-'],{stdio:['pipe','pipe','pipe']});
  let chunks=[],metadataChunks=[],size=0,metadataSize=0,tooLarge=false,badMetadata=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},35000);timer.unref();
  child.stdout.on('data',chunk=>{
   if(tooLarge)return;
   size+=chunk.length;
   if(size>MAX_BYTES){tooLarge=true;chunks=[];child.kill('SIGKILL')}
   else chunks.push(chunk);
  });
  child.stderr.on('data',chunk=>{
   if(badMetadata)return;
   metadataSize+=chunk.length;
   if(metadataSize>64*1024){badMetadata=true;metadataChunks=[];child.kill('SIGKILL')}
   else metadataChunks.push(chunk);
  });
  child.stdin.on('error',()=>{});
  child.once('error',()=>{clearTimeout(timer);reject(failure('NETWORK'))});
  child.once('close',code=>{
   clearTimeout(timer);
   if(tooLarge||code===63){reject(failure('IMAGE_TOO_LARGE'));return}
   if(badMetadata){reject(failure('INVALID_RESPONSE'));return}
   if(timedOut||code!==0){reject(failure('NETWORK'));return}
   const match=Buffer.concat(metadataChunks).toString('utf8').match(/^([1-5]\d{2})\n([^\r\n]*)$/);
   if(!match){reject(failure('INVALID_RESPONSE'));return}
   resolve({status:Number(match[1]),body:Buffer.concat(chunks),...(match[2]?{location:match[2]}:{})});
  });
  child.stdin.end([
   'url = '+curlQuote(url),'request = "GET"',
   'header = '+curlQuote('Accept: '+headers.Accept),
   'proto = "=https"','proto-redir = "=https"','max-redirs = 0',
   'connect-timeout = 10','max-time = 30','max-filesize = '+MAX_BYTES,
   'silent','write-out = "%{stderr}%{http_code}\\n%{redirect_url}"'
  ].join('\n')+'\n');
 });
}

async function downloadImage(url,transport,downloads){
 let current=url;
 const visited=new Set();
 for(let redirects=0;;redirects++){
  if(visited.has(current))throw failure('TOO_MANY_REDIRECTS');
  visited.add(current);
  if(downloads.has(current))return {photo:downloads.get(current),urls:[...visited]};
  let response;
  try{response=await transport({url:current,headers:{Accept:'image/jpeg,image/png,image/webp'}})}
  catch(error){throw error instanceof EmallMediaError?failure(error.code,{status:error.status,hostname:error.hostname}):failure('NETWORK')}
  if(!record(response)||!Number.isInteger(response.status)||response.status<100||response.status>599||!Buffer.isBuffer(response.body))throw failure('INVALID_RESPONSE');
  if(response.body.length>MAX_BYTES)throw failure('IMAGE_TOO_LARGE');
  if([301,302,303,307,308].includes(response.status)){
   if(redirects>=MAX_REDIRECTS)throw failure('TOO_MANY_REDIRECTS');
   if(typeof response.location!=='string'||!response.location)throw failure('INVALID_RESPONSE');
   current=sourceURL(response.location,current);
   continue;
  }
  if(response.status!==200)throw failure('HTTP_ERROR',{status:response.status});
  if(!response.body.length)throw failure('INVALID_IMAGE');
  return {input:response.body,urls:[...visited]};
 }
}

async function normalizeImage(input){
 try{
  const metadata=await sharp(input,{limitInputPixels:MAX_PIXELS,failOn:'warning'}).metadata();
  if(!['jpeg','png','webp'].includes(metadata.format)||(metadata.pages||1)>1||!metadata.width||!metadata.height||metadata.width*metadata.height>MAX_PIXELS)throw failure('INVALID_IMAGE');
  // libvips can expose only the first APNG frame without reporting pages.
  // Read actual chunk boundaries rather than searching compressed image bytes.
  if(metadata.format==='png'){
   for(let offset=8;offset+12<=input.length;){
    const length=input.readUInt32BE(offset),type=input.toString('ascii',offset+4,offset+8);
    if(length>input.length-offset-12)throw failure('INVALID_IMAGE');
    if(['acTL','fcTL','fdAT'].includes(type))throw failure('INVALID_IMAGE');
    offset+=length+12;
    if(type==='IEND')break;
   }
  }
  return await sharp(input,{limitInputPixels:MAX_PIXELS,failOn:'warning'}).rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true});
 }catch{throw failure('INVALID_IMAGE')}
}

async function mediaDirectory(directory){
 try{
  await mkdir(resolve(directory),{recursive:true,mode:0o700});
  const root=await realpath(resolve(directory)),target=join(root,'media');
  await mkdir(target,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error});
  if(!(await lstat(target)).isDirectory()||await realpath(target)!==target)throw failure('WRITE_FAILED');
  return target;
 }catch{throw failure('WRITE_FAILED')}
}
async function saveImage(directory,filename,data){
 try{await writeFile(join(directory,filename),data,{mode:0o600,flag:'wx'})}
 catch(error){
  if(error.code!=='EEXIST')throw failure('WRITE_FAILED');
  // Existing content may be reused, but never follow a substituted symlink.
  let file;
  try{
   file=await open(join(directory,filename),constants.O_RDONLY|constants.O_NOFOLLOW);
   const stat=await file.stat();
   if(!stat.isFile()||stat.size!==data.length||digest(await file.readFile())!==digest(data))throw failure('WRITE_FAILED');
  }catch{throw failure('WRITE_FAILED')}
  finally{await file?.close()}
 }
}

export async function prepareEmallImages(imageJobs,{directory,transport=curlTransport}={}){
 if(typeof directory!=='string'||!directory.trim()||typeof transport!=='function'||!Array.isArray(imageJobs)||imageJobs.length>5000)throw failure('INVALID_CONFIG');
 const ids=new Set(),jobs=[];
 for(const job of imageJobs){
  if(!record(job)||!(typeof job.externalId==='string'||Number.isSafeInteger(job.externalId))||!String(job.externalId).trim()||String(job.externalId).length>128||/[\x00-\x1f\x7f]/.test(String(job.externalId))||!Array.isArray(job.urls))throw failure('INVALID_CONFIG');
  const externalId=String(job.externalId);
  if(ids.has(externalId))throw failure('INVALID_CONFIG');
  ids.add(externalId);
  // Validate every chosen source before any request or filesystem write.
  jobs.push({externalId,urls:job.urls.slice(0,MAX_PHOTOS).map(url=>sourceURL(url)),truncated:job.urls.length>MAX_PHOTOS});
 }
 const imagesByExternalId=Object.fromEntries(jobs.map(job=>[job.externalId,[]])),media=[],warnings=[];
 const downloads=new Map(),photos=new Map();
 let target;
 for(const job of jobs){
  if(!job.urls.length)warnings.push({externalId:job.externalId,code:'NO_SOURCE_PHOTOS'});
  if(job.truncated)warnings.push({externalId:job.externalId,code:'PHOTO_LIMIT'});
  const seen=new Set();
  for(const url of job.urls){
   let photo=downloads.get(url);
   if(!photo){
    const downloaded=await downloadImage(url,transport,downloads);
    photo=downloaded.photo;
    if(!photo){
     const {data,info}=await normalizeImage(downloaded.input);
     const sha256=digest(data),file=sha256+'.webp';
     photo=photos.get(sha256);
     if(!photo){
      target??=await mediaDirectory(directory);
      await saveImage(target,file,data);
      photo={url:'/uploads/emall-'+file,file,sha256,width:info.width,height:info.height,bytes:data.length};
      photos.set(sha256,photo);media.push(photo);
     }
    }
    for(const alias of downloaded.urls)downloads.set(alias,photo);
   }
   if(!seen.has(photo.url)){seen.add(photo.url);imagesByExternalId[job.externalId].push(photo.url)}
  }
 }
 return {imagesByExternalId,media,warnings};
}
