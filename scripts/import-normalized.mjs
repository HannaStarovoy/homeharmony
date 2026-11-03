// Developer bridge for the internal import contract; not an Emall HTTP client.
import { readFile,stat } from 'node:fs/promises';
import { openStore } from '../server/store.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('Нормализованный внутренний импорт (подключение Emall API пока не реализовано).\nnode scripts/import-normalized.mjs --file prepared.json [--limit 5] [--apply]\nБез --apply выполняется только предварительная проверка.');
 process.exit(0);
}
let store;
try{
 for(let i=0;i<args.length;i++){if(['--file','--limit'].includes(args[i]))i++;else if(args[i]!=='--apply')throw new Error('Неизвестный параметр команды. Используйте --help.')}
 const file=args[args.indexOf('--file')+1];if(!args.includes('--file')||!file)throw new Error('Укажите --file с нормализованным JSON-каталогом.');
 if((await stat(file)).size>5*1024*1024)throw new Error('Файл превышает 5 МБ.');
 let input;try{input=JSON.parse(await readFile(file,'utf8'))}catch{throw new Error('Файл не является нормализованным JSON-каталогом.')}
 const limit=args.includes('--limit')?Number(args[args.indexOf('--limit')+1]):5;
 store=openStore();const result=args.includes('--apply')?store.imports.apply(input.products,input.source,{limit}):store.imports.preview(input.products,input.source,{limit});
 console.log(JSON.stringify({mode:args.includes('--apply')?'applied':'preview',...result},null,2));
}catch(error){console.error(error.message);process.exitCode=1}finally{store?.close()}
