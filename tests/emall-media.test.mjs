// All photographs are generated locally. No live Emall/API requests or credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {EmallMediaError,prepareEmallImages} from '../server/emall-media.mjs';

const source=name=>'https://images.emall.by/photos/'+name;
const photo=(color='#d75d32',width=40,height=30)=>sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();
const sha256=data=>createHash('sha256').update(data).digest('hex');
const code=expected=>error=>error instanceof EmallMediaError&&error.code===expected;
async function directory(t){const path=await mkdtemp(join(tmpdir(),'emall-media-test-'));t.after(()=>rm(path,{recursive:true,force:true}));return path}
const job=(urls,externalId='emall:1')=>({externalId,urls});
async function syntheticApng(){
 const png=await photo('#f00',2,2),parts=[];
 for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset);parts.push({type:png.toString('ascii',offset+4,offset+8),data:png.subarray(offset+8,offset+8+length)});offset+=length+12}
 const chunk=(type,data)=>{
  const output=Buffer.alloc(data.length+12);output.writeUInt32BE(data.length);output.write(type,4);data.copy(output,8);
  let crc=-1;
  for(const byte of output.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  output.writeUInt32BE((crc^-1)>>>0,output.length-4);return output;
 };
 const control=Buffer.alloc(8);control.writeUInt32BE(2);
 const frame=sequence=>{const data=Buffer.alloc(26);data.writeUInt32BE(sequence);data.writeUInt32BE(2,4);data.writeUInt32BE(2,8);data.writeUInt16BE(1,20);data.writeUInt16BE(10,22);return chunk('fcTL',data)};
 const idat=Buffer.concat(parts.filter(part=>part.type==='IDAT').map(part=>part.data)),sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
 return Buffer.concat([png.subarray(0,8),chunk('IHDR',parts.find(part=>part.type==='IHDR').data),chunk('acTL',control),frame(0),chunk('IDAT',idat),frame(1),chunk('fdAT',Buffer.concat([sequence,idat])),chunk('IEND',Buffer.alloc(0))]);
}

test('photos normalize to content-addressed WebP with stripped metadata and deterministic files',async t=>{
 const path=await directory(t),input=await sharp(await photo('#1769e0',3000,1500)).withMetadata({orientation:6}).jpeg().toBuffer();
 const result=await prepareEmallImages([job([source('synthetic.jpg')])],{directory:path,transport:async request=>{
  assert.deepEqual(request,{url:source('synthetic.jpg'),headers:{Accept:'image/jpeg,image/png,image/webp'}});
  return {status:200,body:input};
 }});
 assert.equal(result.media.length,1);const media=result.media[0],output=await readFile(join(path,'media',media.file)),metadata=await sharp(output).metadata();
 assert.deepEqual(media,{url:'/uploads/emall-'+sha256(output)+'.webp',file:sha256(output)+'.webp',sha256:sha256(output),width:1000,height:2000,bytes:output.length});
 assert.deepEqual(result.imagesByExternalId,{'emall:1':[media.url]});assert.deepEqual(result.warnings,[]);
 assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(metadata.orientation,undefined);
 assert.deepEqual(await readdir(join(path,'media')),[media.file]);
 const again=await prepareEmallImages([job([source('synthetic.jpg')])],{directory:path,transport:async()=>({status:200,body:input})});
 assert.deepEqual(again,result);assert.deepEqual(await readdir(join(path,'media')),[media.file]);
 assert(!JSON.stringify(result).includes('https://'));
});

test('content and URL deduplication preserve first-photo order across products and redirects',async t=>{
 const path=await directory(t),red=await photo(),blue=await photo('#1740d0'),redWithMetadata=await sharp(red).withMetadata().png().toBuffer(),calls=[];
 const urls=[source('red.png'),source('blue.png'),source('same-red.png'),source('red.png'),source('redirect.png')];
 const result=await prepareEmallImages([job(urls),job([source('final.png'),source('red.png')],'emall:2'),job([source('other-redirect.png')],'emall:3')],{directory:path,transport:async({url})=>{
  calls.push(url);
  if(url===source('redirect.png')||url===source('other-redirect.png'))return {status:302,location:'/photos/final.png',body:Buffer.alloc(0)};
  return {status:200,body:url===source('blue.png')?blue:url===source('same-red.png')?redWithMetadata:red};
 }});
 assert.equal(result.media.length,2);assert.equal(new Set(calls).size,calls.length);
 assert.equal(calls.filter(url=>url===source('final.png')).length,1);
 const [redMedia,blueMedia]=result.media;
 assert.deepEqual(result.imagesByExternalId,{'emall:1':[redMedia.url,blueMedia.url],'emall:2':[redMedia.url],'emall:3':[redMedia.url]});
 assert.equal((await readdir(join(path,'media'))).length,2);
});

test('drafts with no source photos succeed with an explicit warning and no invented media',async t=>{
 const path=await directory(t);let calls=0;
 const result=await prepareEmallImages([job([],'emall:9')],{directory:path,transport:async()=>{calls++}});
 assert.deepEqual(result,{imagesByExternalId:{'emall:9':[]},media:[],warnings:[{externalId:'emall:9',code:'NO_SOURCE_PHOTOS'}]});
 assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});

test('only the first eight product photos are selected and the cap is visible',async t=>{
 const path=await directory(t),input=await photo(),calls=[];
 const result=await prepareEmallImages([job(Array.from({length:10},(_,i)=>source(i+'.png')))],{directory:path,transport:async({url})=>{calls.push(url);return {status:200,body:input}}});
 assert.equal(calls.length,8);assert.deepEqual(result.warnings,[{externalId:'emall:1',code:'PHOTO_LIMIT'}]);
 assert.equal(result.imagesByExternalId['emall:1'].length,1);
});

test('HTTPS Emall and Edostavka host boundaries allow public source images only',async t=>{
 const path=await directory(t),input=await photo();let calls=0;
 for(const url of ['https://emall.by/photo.png','https://api-sandbox.emall.by/storage/images/photo.jpg','https://img.edostavka.by/a.png','https://cdn.ime.by/photo.webp']){
  await prepareEmallImages([job([url])],{directory:path,transport:async()=>{calls++;return {status:200,body:input}}});
 }
 assert.equal(calls,4);
 for(const hostname of ['emall.by.evil.example','evilemall.by','example.test','private.example','127.0.0.1.emall.by.evil.example','other.ime.by','sub.cdn.ime.by','cdn.ime.by.evil.example']){
  const url='https://'+hostname+'/PRIVATE_IMAGE?token=PRIVATE_QUERY';
  await assert.rejects(prepareEmallImages([job([url])],{directory:path,transport:async()=>{calls++}}),error=>{
   assert.equal(error.code,'HOST_NOT_ALLOWED');assert.equal(error.hostname,hostname);
   assert(!JSON.stringify(error).includes('PRIVATE'));assert(!error.message.includes(url));return true;
  });
 }
 assert.equal(calls,4);
});

test('unsafe URLs and path traversal fail before requests and filesystem writes',async t=>{
 const path=await directory(t);let calls=0;
 const urls=[
  'http://images.emall.by/photo.png','file:///etc/passwd','https://user:PRIVATE@images.emall.by/a.jpg','https://@images.emall.by/a.jpg',
  'https://127.0.0.1/a.jpg','https://2130706433/a.jpg','https://[::1]/a.jpg','https://localhost/a.jpg','https://images.emall.by:8443/a.jpg',
  'https://images.emall.by/../private.jpg','https://images.emall.by/./private.jpg','https://images.emall.by/%2e%2e/private.jpg',
  'https://images.emall.by/%252e%252e%252fprivate.jpg','https://images.emall.by/a/..%2fprivate.jpg','https://images.emall.by/a\\..\\private.jpg',
  ' https://images.emall.by/a.jpg','https://images.emall.by/a.jpg\n','https://images.emall.by/a.jpg#fragment','not a URL'
 ];
 for(const url of urls)await assert.rejects(prepareEmallImages([job([url])],{directory:path,transport:async()=>{calls++}}),code('INVALID_SOURCE_URL'));
 // A bad later job is also rejected before fetching an earlier valid job.
 await assert.rejects(prepareEmallImages([job([source('valid.png')]),job(['https://evil.example/private'],'emall:2')],{directory:path,transport:async()=>{calls++}}),code('HOST_NOT_ALLOWED'));
 assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});

test('every redirect is revalidated and requests never carry API authorization',async t=>{
 const path=await directory(t),input=await photo(),requests=[];
 const old=process.env.EMALL_API_TOKEN;process.env.EMALL_API_TOKEN='PRIVATE_SYNTHETIC_API_TOKEN';
 t.after(()=>{if(old===undefined)delete process.env.EMALL_API_TOKEN;else process.env.EMALL_API_TOKEN=old});
 await prepareEmallImages([job([source('first.png')])],{directory:path,transport:async request=>{
  requests.push(request);
  assert.deepEqual(Object.keys(request.headers),['Accept']);assert(!JSON.stringify(request).includes('PRIVATE_SYNTHETIC_API_TOKEN'));
  return requests.length===1?{status:302,location:'https://img.edostavka.by/final.png',body:Buffer.alloc(0)}:{status:200,body:input};
 }});
 assert.equal(requests.length,2);
 for(const [location,expected] of [['https://evil.example/PRIVATE?key=PRIVATE','HOST_NOT_ALLOWED'],['https://127.0.0.1/PRIVATE','INVALID_SOURCE_URL'],['http://images.emall.by/a','INVALID_SOURCE_URL'],['/a/%2e%2e/private','INVALID_SOURCE_URL'],['https://user:PRIVATE@images.emall.by/a','INVALID_SOURCE_URL']]){
  let calls=0;
  await assert.rejects(prepareEmallImages([job([source('unsafe-redirect.png')])],{directory:path,transport:async()=>{calls++;return {status:302,location,body:Buffer.alloc(0)}}}),error=>{
   assert.equal(error.code,expected);assert(!JSON.stringify(error).includes('PRIVATE'));return true;
  });
  assert.equal(calls,1);
 }
});

test('redirect loops, excess redirects, and missing redirect locations fail safely',async t=>{
 const path=await directory(t);let calls=0;
 await assert.rejects(prepareEmallImages([job([source('loop.png')])],{directory:path,transport:async()=>{calls++;return {status:301,location:source('loop.png'),body:Buffer.alloc(0)}}}),code('TOO_MANY_REDIRECTS'));
 assert.equal(calls,1);calls=0;
 await assert.rejects(prepareEmallImages([job([source('start.png')])],{directory:path,transport:async()=>({status:302,location:source((++calls)+'.png'),body:Buffer.alloc(0)})}),code('TOO_MANY_REDIRECTS'));
 assert.equal(calls,5);
 await assert.rejects(prepareEmallImages([job([source('no-location.png')])],{directory:path,transport:async()=>({status:302,body:Buffer.alloc(0)})}),code('INVALID_RESPONSE'));
});

test('required-photo download failures and bad responses are never reported as imported photos',async t=>{
 const path=await directory(t);
 const cases=[
  [async()=>{throw new Error('PRIVATE_TOKEN https://private.example/PRIVATE')},'NETWORK'],
  [async()=>({status:404,body:Buffer.from('PRIVATE_BODY')}),'HTTP_ERROR'],
  [async()=>({status:200,body:'PRIVATE_BODY'}),'INVALID_RESPONSE'],
  [async()=>({status:99,body:Buffer.alloc(0)}),'INVALID_RESPONSE'],
  [async()=>({status:200,body:Buffer.alloc(8*1024*1024+1)}),'IMAGE_TOO_LARGE'],
  [async()=>({status:200,body:Buffer.alloc(0)}),'INVALID_IMAGE'],
  [async()=>({status:200,body:Buffer.from('PRIVATE_DECODE_ERROR')}),'INVALID_IMAGE']
 ];
 for(const [transport,expected] of cases)await assert.rejects(prepareEmallImages([job([source('required.png')])],{directory:path,transport}),error=>{
  assert.equal(error.code,expected);assert(!JSON.stringify(error).includes('PRIVATE'));assert(!error.message.includes('PRIVATE'));return true;
 });
 assert.deepEqual(await readdir(path),[]);
});

test('JPEG, PNG and WebP are decoded; SVG, GIF, animations, truncation and oversized pixels are rejected',async t=>{
 const path=await directory(t),input=await photo();
 for(const body of [input,await sharp(input).jpeg().toBuffer(),await sharp(input).webp().toBuffer()]){
  const result=await prepareEmallImages([job([source('valid.bin')])],{directory:path,transport:async()=>({status:200,body})});assert.equal(result.media.length,1);
 }
 const raw=Buffer.concat([Buffer.alloc(4*4*3,30),Buffer.alloc(4*4*3,210)]);
 const animated=await sharp(raw,{raw:{width:4,height:8,channels:3,pageHeight:4}}).webp({loop:0,delay:[100,100]}).toBuffer();
 assert.equal((await sharp(animated).metadata()).pages,2);
 const apng=await syntheticApng();assert.equal((await sharp(apng).metadata()).format,'png');assert.equal((await sharp(apng).metadata()).pages,undefined);
 const huge=await sharp({create:{width:5001,height:5000,channels:3,background:'#334455'}}).png().toBuffer();
 const invalid=[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3"/></svg>'),await sharp(input).gif().toBuffer(),animated,apng,input.subarray(0,Math.floor(input.length/2)),huge];
 for(const body of invalid)await assert.rejects(prepareEmallImages([job([source('invalid.bin')])],{directory:path,transport:async()=>({status:200,body})}),code('INVALID_IMAGE'));
});

test('media writes cannot follow a media directory or content filename symlink',async t=>{
 const path=await directory(t),outside=await directory(t),input=await photo();
 await symlink(outside,join(path,'media'),'dir');
 await assert.rejects(prepareEmallImages([job([source('photo.png')])],{directory:path,transport:async()=>({status:200,body:input})}),code('WRITE_FAILED'));
 assert.deepEqual(await readdir(outside),[]);
 const root=await directory(t),output=await sharp(input).rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();
 await mkdir(join(root,'media'));await writeFile(join(outside,'target'),'unchanged');
 await symlink(join(outside,'target'),join(root,'media',sha256(output)+'.webp'));
 await assert.rejects(prepareEmallImages([job([source('photo.png')])],{directory:root,transport:async()=>({status:200,body:input})}),code('WRITE_FAILED'));
 assert.equal(await readFile(join(outside,'target'),'utf8'),'unchanged');
});

test('invalid job configuration fails without touching transport',async t=>{
 const path=await directory(t);let calls=0;const transport=async()=>{calls++};
 for(const jobs of [null,{},[null],[{}],[job(null)],[job([],null)],[job([]),job([])]])await assert.rejects(prepareEmallImages(jobs,{directory:path,transport}),code('INVALID_CONFIG'));
 await assert.rejects(prepareEmallImages([job([])],{transport}),code('INVALID_CONFIG'));
 await assert.rejects(prepareEmallImages([job([])],{directory:path,transport:null}),code('INVALID_CONFIG'));
 assert.equal(calls,0);
});

test('default curl transport keeps binary body separate from bounded stderr metadata',async t=>{
 const path=await directory(t),input=join(path,'fixture.png'),log=join(path,'calls.txt');
 await writeFile(input,await photo());
 const executable=join(path,'fake-curl.mjs');
 await writeFile(executable,`import assert from 'node:assert/strict';
import {appendFileSync,readFileSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2),['--disable','--config','-']);
const config=readFileSync(0,'utf8'),lines=config.trimEnd().split('\\n');
for(const line of ${JSON.stringify(['request = "GET"','header = "Accept: image/jpeg,image/png,image/webp"','proto = "=https"','proto-redir = "=https"','max-redirs = 0','connect-timeout = 10','max-time = 30','max-filesize = 8388608','silent','write-out = "%{stderr}%{http_code}\\n%{redirect_url}"'])})assert(lines.includes(line));
assert.equal(lines.filter(line=>line.startsWith('header = ')).length,1);
assert(!config.includes('/dev/fd/'));
assert(!/Authorization|dump-header|^(?:location|insecure|show-error|verbose|trace|trace-ascii)\\b/m.test(config));
const mode=process.env.FAKE_CURL_MODE;
appendFileSync(process.env.FAKE_CURL_LOG,'called\\n');
if(mode==='redirect'&&lines.includes('url = "https://images.emall.by/photos/start.png"')){
 process.stdout.write('redirect body');process.stderr.write('302\\nhttps://images.emall.by/photos/final.png');
}else{
 if(mode==='oversized-body')process.stdout.write(Buffer.alloc(8388609));
 else process.stdout.write(readFileSync(process.env.FAKE_CURL_IMAGE));
 const metadata=mode==='bad-status'?'000\\n':mode==='malformed'?'200\\nPRIVATE_RESPONSE\\nPRIVATE_TOKEN':mode==='oversized-metadata'?'PRIVATE_TOKEN'.repeat(6000):'200\\n';
 process.stderr.write(metadata);
 if(mode==='network')process.exitCode=7;
 if(mode==='filesize')process.exitCode=63;
}
`);
 await writeFile(join(path,'curl'),`#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(executable).href)});\n`,{mode:0o700});
 const runner=`import assert from 'node:assert/strict';import{prepareEmallImages}from'./server/emall-media.mjs';
const run=prepareEmallImages([{externalId:'fixture-product',urls:['https://images.emall.by/photos/start.png']}],{directory:process.env.FAKE_CURL_OUTPUT});
if(process.env.FAKE_CURL_EXPECTED)await assert.rejects(run,error=>error.code===process.env.FAKE_CURL_EXPECTED&&!JSON.stringify(error).includes('PRIVATE')&&!error.message.includes('PRIVATE'));
else{const result=await run;assert.equal(result.media.length,1);assert.equal(result.imagesByExternalId['fixture-product'].length,1)}
console.log('PASS');`;
 for(const [mode,expected] of [['success',''],['redirect',''],['bad-status','INVALID_RESPONSE'],['malformed','INVALID_RESPONSE'],['oversized-metadata','INVALID_RESPONSE'],['oversized-body','IMAGE_TOO_LARGE'],['network','NETWORK'],['filesize','IMAGE_TOO_LARGE']]){
  const output=join(path,mode);
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',runner],{cwd:new URL('../',import.meta.url),env:{...process.env,PATH:path+delimiter+process.env.PATH,FAKE_CURL_MODE:mode,FAKE_CURL_EXPECTED:expected,FAKE_CURL_LOG:log,FAKE_CURL_IMAGE:input,FAKE_CURL_OUTPUT:output}});
  assert.equal(stdout.trim(),'PASS');
  if(expected)await assert.rejects(readdir(output),{code:'ENOENT'});
 }
 assert.equal((await readFile(log,'utf8')).split('\n').filter(Boolean).length,9);
});
