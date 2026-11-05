import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openStore, root, Problem } from './store.mjs';
import { login, session } from './auth.mjs';
import { templates } from './schema.mjs';
import { deliveries } from './orders.mjs';

export function createApp({dataDir,origin=process.env.SHOP_ORIGIN,secureCookies=process.env.NODE_ENV==='production',reserveHours,draftBundleDir=dataDir===undefined?join(root,'data/emall-drafts'):null,publicationPlanPath=dataDir===undefined?join(root,'data/emall-publication.json'):null,massBundleDir=dataDir===undefined?join(root,'data/emall-mass'):null}={}) {
  const store=openStore(dataDir,{...(reserveHours===undefined?{}:{reserveHours}),draftBundleDir,publicationPlanPath,massBundleDir});
  const cookie=(token,maxAge)=>`shop_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies?'; Secure':''}`;
  if (origin && (!/^https?:\/\//.test(origin) || new URL(origin).origin!==origin)) throw new Error('SHOP_ORIGIN must be a complete origin without a trailing slash or path.');
  if (process.env.NODE_ENV==='production' && (!origin?.startsWith('https://') || !secureCookies)) throw new Error('Production requires an HTTPS SHOP_ORIGIN and secure cookies.');
  function expectedOrigin(req) {
    if (origin) {if (req.headers.host!==new URL(origin).host) throw new Problem(403,'Недопустимый адрес сервера.');return origin}
    let url;
    try {url=new URL(`http://${req.headers.host}`)} catch {throw new Problem(400,'Неверный адрес сервера.')}
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Problem(403,'Укажите SHOP_ORIGIN для этого адреса сервера.');
    return url.origin;
  }
  function send(res,status,value,type='application/json; charset=utf-8') {
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});
    res.end(type.startsWith('application/json')?JSON.stringify(value):value);
  }
  async function body(req,limit=256*1024) {
    if (Number(req.headers['content-length'])>limit) throw new Problem(413,'Файл или запрос слишком большой.');
    if(req.savedBody){if(req.savedBody.length>limit)throw new Problem(413,'Файл или запрос слишком большой.');return req.savedBody}
    const chunks=[];let size=0;
    for await (const part of req) {size+=part.length;if(size>limit)throw new Problem(413,'Файл или запрос слишком большой.');chunks.push(part)}
    req.savedBody=Buffer.concat(chunks);return req.savedBody;
  }
  async function jsonBody(req,limit) {
    if (req.headers['content-type']?.split(';')[0]!=='application/json') throw new Problem(415,'Ожидаются данные JSON.');
    try {return JSON.parse((await body(req,limit)).toString('utf8'))} catch(error) {if(error instanceof Problem)throw error;throw new Problem(400,'Некорректный JSON.')}
  }
  let writeTail=Promise.resolve();
  const server=createServer(async(req,res)=>{
    let releaseWrite;
    try {
      const base=expectedOrigin(req),url=new URL(req.url,base),path=url.pathname;
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','same-origin');
      res.setHeader('X-Frame-Options','DENY');
      if (!['GET','HEAD','POST','PUT','DELETE'].includes(req.method)) throw new Problem(405,'Метод не поддерживается.');
      if (['POST','PUT','DELETE'].includes(req.method) && req.headers.origin!==base) throw new Problem(403,'Обновите страницу перед отправкой данных.');
      let user=session(store,req);
      if(['POST','PUT','DELETE'].includes(req.method)){
        const adminWrite=path.startsWith('/api/admin/')&&path!=='/api/admin/login';
        if(!adminWrite||user){
          if(adminWrite&&req.headers['x-csrf-token']!==user.csrf)throw new Problem(403,'Сессия изменилась. Обновите страницу.');
          const limit=path.startsWith('/api/admin/backups/')?256*1024*1024:path==='/api/admin/media'?8*1024*1024:2*1024*1024;
          await body(req,limit);const previous=writeTail;writeTail=new Promise(resolve=>releaseWrite=resolve);await previous;user=session(store,req);
        }
      }
      if(path==='/api/orders'&&req.method==='POST'){
        const result=store.orders.create(await jsonBody(req),req.headers['idempotency-key'],req.socket.remoteAddress);
        return send(res,result.replayed?200:201,result.receipt);
      }
      if(path==='/api/orders/receipt'&&req.method==='GET')return send(res,200,store.orders.findReceipt(req.headers['idempotency-key']));
      if (path==='/api/admin/login' && req.method==='POST') {
        const credentials=await jsonBody(req);
        if(!credentials||typeof credentials!=='object'||Array.isArray(credentials))throw new Problem(400,'Неверные данные входа.');
        const {email,password}=credentials,result=await login(store,email,password,req.socket.remoteAddress);
        res.setHeader('Set-Cookie',cookie(result.token,8*60*60));
        return send(res,200,{email:result.email,csrf:result.csrf});
      }
      if (path.startsWith('/api/admin/')) {
        if (!user) return send(res,401,{message:'Войдите в административную панель.',setupRequired:!store.db.prepare('SELECT 1 FROM admins LIMIT 1').get()});
        if (['POST','PUT','DELETE'].includes(req.method) && req.headers['x-csrf-token']!==user.csrf) throw new Problem(403,'Сессия изменилась. Обновите страницу и повторите сохранение.');
        if (path==='/api/admin/session' && req.method==='GET') return send(res,200,{email:user.email,csrf:user.csrf});
        if (path==='/api/admin/logout' && req.method==='POST') {
          store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);
          res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});
        }
        if(path==='/api/admin/orders'&&req.method==='GET')return send(res,200,store.orders.list({status:url.searchParams.get('status')||'all',search:url.searchParams.get('q')||'',page:url.searchParams.get('page')||1}));
        const orderMatch=path.match(/^\/api\/admin\/orders\/([1-9]\d{0,12})$/);
        if(orderMatch&&req.method==='GET')return send(res,200,store.orders.detail(Number(orderMatch[1])));
        if(orderMatch&&req.method==='PUT')return send(res,200,store.orders.update(Number(orderMatch[1]),await jsonBody(req),user.email));
        if (path==='/api/admin/catalog' && req.method==='GET') return send(res,200,{categories:store.categories(),products:store.products(),templates,views:store.tools.listViews()});
        if(path==='/api/admin/products/rows'&&req.method==='POST')return send(res,200,store.tools.saveRows(await jsonBody(req,2*1024*1024)));
        if(path==='/api/admin/views'&&req.method==='POST')return send(res,201,store.tools.saveView(await jsonBody(req)));
        if(path==='/api/admin/views'&&req.method==='DELETE')return send(res,200,store.tools.deleteView((await jsonBody(req))?.id));
        if(path==='/api/admin/backups/list'&&req.method==='GET')return send(res,200,await store.backups.listSafety());
        if(path==='/api/admin/backups/download'&&req.method==='GET'){const bytes=await store.backups.exportBackup();res.setHeader('Content-Disposition','attachment; filename=homeharmony-'+new Date().toISOString().slice(0,10)+'.hhbackup');return send(res,200,bytes,'application/gzip')}
        if(path==='/api/admin/backups/safety'&&req.method==='GET')return send(res,200,await store.backups.downloadSafety(url.searchParams.get('name')),'application/gzip');
        if(path==='/api/admin/backups/inspect'&&req.method==='POST')return send(res,200,await store.backups.inspect(await body(req,256*1024*1024)));
        if(path==='/api/admin/backups/restore'&&req.method==='POST')return send(res,200,await store.backups.restore(await body(req,256*1024*1024)));
        if(path==='/api/admin/recovery'&&req.method==='GET')return send(res,200,store.recovery.list());
        if(path==='/api/admin/recovery/restore'&&req.method==='POST')return send(res,200,store.recovery.restore(await jsonBody(req)));
        if(path==='/api/admin/recovery/split'&&req.method==='POST')return send(res,200,store.recovery.split(await jsonBody(req)));
        if(path==='/api/admin/recovery/undo-price'&&req.method==='POST')return send(res,200,store.recovery.undoPrice(await jsonBody(req)));
        if(path==='/api/admin/products/variant'&&req.method==='POST')return send(res,200,store.saveVariant(await jsonBody(req)));
        if(path==='/api/admin/products/merge'&&req.method==='POST')return send(res,200,store.mergeProducts(await jsonBody(req,1024*1024)));
        if(path==='/api/admin/products/bulk'&&req.method==='POST')return send(res,200,store.bulkProducts(await jsonBody(req,1024*1024)));
        if (path==='/api/admin/products' && req.method==='POST') return send(res,201,store.saveProduct(await jsonBody(req)));
        const match=path.match(/^\/api\/admin\/products\/([a-zA-Z0-9-]+)$/);
        if(match&&req.method==='DELETE')return send(res,200,store.deleteProduct(match[1],(await jsonBody(req))?.version));
        if (match && req.method==='PUT') return send(res,200,store.saveProduct(await jsonBody(req),match[1]));
        if (path==='/api/admin/media' && req.method==='POST') {
          const input=await body(req,8*1024*1024);
          let output,info;
          try {
            const metadata=await sharp(input,{limitInputPixels:25_000_000,failOn:'warning'}).metadata();
            if (!['jpeg','png','webp'].includes(metadata.format) || (metadata.pages||1)>1) throw new Error('Unsupported image');
            ({data:output,info}=await sharp(input,{limitInputPixels:25_000_000,failOn:'warning'}).rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true}));
          } catch {throw new Problem(422,'Загрузите корректную фотографию JPEG, PNG или WebP до 8 МБ и 25 мегапикселей.')}
          const filename=randomUUID()+'.webp',path=join(store.uploadDir,filename),publicUrl='/uploads/'+filename;
          await writeFile(path,output,{mode:0o600,flag:'wx'});
          try {store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(publicUrl,filename,info.width,info.height,output.length)} catch(error) {await unlink(path);throw error}
          return send(res,201,{url:publicUrl,width:info.width,height:info.height});
        }
        throw new Problem(404,'Адрес не найден.');
      }
      if (req.method!=='GET' && req.method!=='HEAD') throw new Problem(405,'Метод не поддерживается.');
      if (path==='/api/health') return send(res,200,{ok:true});
      if (path==='/api/catalog' || path==='/catalog-data.js') {
        const data={categories:store.categories(),products:store.products(true),orderingEnabled:true,checkout:{deliveries,reserveHours:store.orders.reserveHours}};
        if(path==='/api/catalog')return send(res,200,data);
        const encoded=JSON.stringify(data).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
        return send(res,200,'window.catalogData = '+encoded+';','application/javascript; charset=utf-8');
      }
      if (path.startsWith('/uploads/')) {
        const media=store.db.prepare('SELECT filename FROM media WHERE url=?').get(path);
        if (!media || (!user && !store.isPublicMedia(path))) throw new Problem(404,'Фотография не найдена.');
        return send(res,200,await readFile(join(store.uploadDir,media.filename)),'image/webp');
      }
      if(path==='/assets/everyday-hero.webp')return send(res,200,await readFile(join(root,'assets/everyday-hero.webp')),'image/webp');
      if(path==='/assets/editorial-hero.webp')return send(res,200,await readFile(join(root,'assets/editorial-hero.webp')),'image/webp');
      const files={'/':'index.html','/index.html':'index.html','/storefront.css':'storefront.css','/admin':'admin/index.html','/admin/':'admin/index.html','/admin/app.js':'admin/app.js','/admin/style.css':'admin/style.css'};
      const file=files[path];
      if (!file) throw new Problem(404,'Адрес не найден.');
      const data=await readFile(join(root,file),'utf8');
      const hashes=[...data.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      return send(res,200,data,file.endsWith('.js')?'application/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
    } catch(error) {
      if (res.headersSent) {res.destroy();return}
      if (!(error instanceof Problem)) console.error('Request failed:',error.code||error.name);
      send(res,error.status||500,{message:error instanceof Problem?error.message:'Не удалось выполнить операцию. Попробуйте ещё раз.',...(error.field?{field:error.field}:{}),...(error instanceof Problem&&error.code?{code:error.code}:{})});
    } finally {releaseWrite?.()}
  });
  server.requestTimeout=120_000;
  server.headersTimeout=15_000;
  return {server,store};
}
