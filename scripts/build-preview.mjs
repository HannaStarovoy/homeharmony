// Package the static demo as one HTML file; the server-backed app remains separate.
import {readFile, writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');
let html=await read('index.html');
html=html.replace('<link rel="stylesheet" href="storefront.css">','<style>\n'+await read('storefront.css')+'\n</style>');
html=html.replace('<script src="catalog-data.js"></script>','<script>\n'+await read('catalog-data.js')+'\n</script>');
const image=await readFile(new URL('assets/editorial-hero.webp',root));
html=html.replace('assets/editorial-hero.webp','data:image/webp;base64,'+image.toString('base64'));
await writeFile(new URL('preview.html',root),html);
console.log('Built preview.html: standalone demo, ordering disabled.');
