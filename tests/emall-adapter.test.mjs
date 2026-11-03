// Artificial cards and dictionaries; these are not data from an Emall account.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareEmallRecords,EmallAdapterError} from '../server/emall-adapter.mjs';
import {EmallError} from '../server/emall.mjs';
const categories=[
 {id:'all',name:'Все товары',parent:null},
 {id:'accessories',name:'Головные уборы и аксессуары',parent:'all'},
 {id:'hats',name:'Головные уборы',parent:'accessories'},
 {id:'beanies',name:'Шапки',parent:'hats'},
 {id:'cosmetics',name:'Косметика и бытовая химия',parent:'all'},
 {id:'hair',name:'Уход за волосами',parent:'cosmetics'},
 {id:'masks',name:'Маски',parent:'hair'},
 {id:'household',name:'Хозяйственные товары',parent:'all'},
 {id:'food',name:'Продукты питания',parent:'all'},
 {id:'sweets',name:'Сладости',parent:'food'}
];
const sourceCategories=[{id:10,name:'Головные уборы',children:[{id:11,name:'Шапки'}]}];
const definitions=[
 {id:149,name:'Материал',property:{type:{name:'list'},values:[{id:1,value:'Шерсть'},{id:2,value:'Хлопок'}]}},
 {id:150,property:{name:'Длина, см',type:{name:'number'},values:[]}},
 {id:151,name:'Ручная работа',property:{type:{name:'boolean'}}},
 {id:152,name:'Уход',property:{type:{name:'string'}}}
];
const card=id=>({id,name:'Искусственная шапка '+id,category_id:11,description:'<p>Только <b>unit test</b>.</p>',inner_article:'TEST-'+id,stock:3,prices:{price:1299,old_price:1599},images:['https://images.example.test/photo.jpg'],properties:{149:[1,2],150:'100',151:true,152:'Бережная стирка'},composition:'Шерсть, хлопок',manufacturer_name:'Тестовый производитель'});
function client(products=[card(1)],{tree=sourceCategories,properties=definitions}={}){
 return {listProducts:async({limit})=>({products:products.slice(0,limit)}),getCatalogCategories:async()=>({categories:tree}),getCategoryProperties:async()=>({properties})};
}
const prepare=(instance,options={})=>prepareEmallRecords(instance,{categories,...options});
const code=expected=>error=>error instanceof EmallAdapterError&&error.code===expected;

test('normalizes one source product to one local product and SKU, with separate remote image jobs',async()=>{
 const result=await prepare(client());
 assert.equal(result.records.length,1);assert.deepEqual(result.records[0],{
  externalId:'1',name:'Искусственная шапка 1',summary:'Только unit test.',cat:'beanies',
  attrs:{Состав:'Шерсть, хлопок',Производитель:'Тестовый производитель',Материал:'Шерсть, Хлопок','Длина, см':'100','Ручная работа':'Да',Уход:'Бережная стирка'},
  images:[],variants:[{externalId:'1',externalSku:'TEST-1',price:12.99,old:15.99,stock:3,options:{},images:[]}]
 });
 assert.deepEqual(result.imageJobs,[{externalId:'1',urls:['https://images.example.test/photo.jpg']}]);
 assert.deepEqual(result.warnings,[]);
});
test('default selects the first five real source positions without inventing groups or records',async()=>{
 const source=Array.from({length:7},(_,i)=>({...card(i+1),name:'Одинаковое название'}));
 let requested;const instance=client(source);instance.listProducts=async options=>{requested=options;return {products:source}};
 const result=await prepare(instance);
 assert.deepEqual(requested,{limit:5});assert.deepEqual(result.records.map(p=>p.externalId),['1','2','3','4','5']);
 assert(result.records.every(p=>p.variants.length===1));assert.equal(source.length,7);
});
test('nullable optionals and digit strings preserve explicit zero stock and source identity',async()=>{
 const raw={...card('0001'),category_id:'0011',inner_article:null,description:null,images:null,properties:null,composition:null,manufacturer_name:null,stock:'0',prices:{price:'100',old_price:null}};
 const result=await prepare(client([raw]));
 assert.equal(result.records[0].externalId,'0001');assert.equal(result.records[0].variants[0].externalId,'0001');
 assert.equal(result.records[0].variants[0].externalSku,'');assert.equal(result.records[0].variants[0].price,1);assert.equal(result.records[0].variants[0].stock,0);assert.equal(result.records[0].variants[0].old,0);
 assert.equal(result.records[0].summary,'');assert.deepEqual(result.records[0].attrs,{});
 assert.deepEqual(result.imageJobs,[{externalId:'0001',urls:[]}]);assert(result.warnings.some(w=>w.code==='NO_SOURCE_IMAGES'));
});
test('missing or malformed price and stock are never converted to zero',async()=>{
 for(const price of [undefined,null,'',' 10','10 ','10.0','1e2',-1,0,1.2,Infinity,true,100000001,'9007199254740992']){
  const raw=card(1);raw.prices.price=price;await assert.rejects(prepare(client([raw])),code('PRICE_REQUIRED'));
 }
 for(const stock of [undefined,null,'',' 0','1.0','1e2',-1,1.2,Infinity,true,1000001,'9007199254740992']){
  const raw=card(1);raw.stock=stock;await assert.rejects(prepare(client([raw])),code('STOCK_REQUIRED'));
 }
 for(const prices of [undefined,null,{}])await assert.rejects(prepare(client([{...card(1),prices}])),code('PRICE_REQUIRED'));
});
test('old prices that do not exceed the current price become zero with a warning',async()=>{
 for(const old_price of [1299,'1000']){
  const result=await prepare(client([{...card(1),prices:{price:1299,old_price}}]));
  assert.equal(result.records[0].variants[0].old,0);assert(result.warnings.some(w=>w.code==='OLD_PRICE_RESET'));
 }
 for(const old_price of [-1,'1.1',false])await assert.rejects(prepare(client([{...card(1),prices:{price:1299,old_price}}])),code('INVALID_PRODUCT'));
});
test('unknown categories fail with fixed diagnostics even if product text mentions a local category',async()=>{
 const raw={...card(1),category_id:999,name:'Шапки <private response>',description:'Шапки'};
 await assert.rejects(prepare(client([raw])),error=>{
  assert.equal(error.code,'CATEGORY_UNMAPPED');assert.equal(error.categoryId,999);
  assert.deepEqual(error.categoryReview,{categoryId:999,path:[],dictionaryError:null});
  assert(!String(error.stack).includes('<private response>'));return true;
 });
 await assert.rejects(prepare(client([{...card(1),category_id:null}])),error=>{
  assert.equal(error.code,'CATEGORY_UNMAPPED');
  assert.deepEqual(error.categoryReview,{categoryId:null,path:[],dictionaryError:null});return true;
 });
});
test('unmapped category review contains only the selected bounded category path',async()=>{
 const raw={...card(1),category_id:4702,name:'private product name',description:'private product description',category_name:'Unused category fallback'};
 const tree=[{id:4701,name:'Неизвестный раздел',children:[{id:4702,name:'Новая категория'}]}];
 await assert.rejects(prepare(client([raw],{tree})),error=>{
  assert.deepEqual(error.categoryReview,{categoryId:4702,path:['Неизвестный раздел','Новая категория'],dictionaryError:null});
  assert(!JSON.stringify(error).includes('private product'));assert(!JSON.stringify(error).includes('https://'));return true;
 });
 let deep={id:2020,name:'К'.repeat(250)};
 for(let i=19;i>=0;i--)deep={id:2000+i,name:'К'.repeat(250),children:[deep]};
 await assert.rejects(prepare(client([{...raw,category_id:2020}],{tree:[deep]})),error=>{
  assert.equal(error.categoryReview.path.length,20);assert(error.categoryReview.path.every(name=>typeof name==='string'&&name.length===200));return true;
 });
 for(const category_name of ['https://private.example.test/category','https&#58;//private.example.test/category']){
  await assert.rejects(prepare(client([{...raw,category_name}],{tree:[]})),error=>{
   assert.deepEqual(error.categoryReview.path,[]);return true;
  });
 }
});
test('unmapped category review retains only safe typed dictionary failure fields',async()=>{
 const diagnostic={field:'meta.count',expected:'count-matches-data',actual:'integer'};
 for(const failure of [new EmallError('HTTP_ERROR',403),new EmallError('INVALID_RESPONSE',200,diagnostic)]){
  failure.message='private exception message';failure.privateResponse={secret:'private arbitrary key'};
  if(failure.diagnostic)failure.diagnostic={...failure.diagnostic,privateKey:'private arbitrary key'};
  const instance=client([{...card(1),category_name:'Новая категория'}]);instance.getCatalogCategories=async()=>{throw failure};
  await assert.rejects(prepare(instance),error=>{
   assert.deepEqual(error.categoryReview,{categoryId:11,path:['Новая категория'],dictionaryError:{code:failure.code,status:failure.status,diagnostic:failure.code==='INVALID_RESPONSE'?diagnostic:null}});
   assert(!JSON.stringify(error).includes('private'));assert(!String(error.stack).includes('private'));return true;
  });
 }
});
test('unknown dictionary failures cannot contribute messages, keys, or lookalike diagnostics',async()=>{
 const failures=[new Error('private transport response'),{code:'HTTP_ERROR',status:401,diagnostic:{field:'meta.count',expected:'count-matches-data',actual:'integer'},privateKey:'private response'}];
 const malformed=new EmallError('INVALID_RESPONSE');malformed.code='private-code';malformed.status='private-status';malformed.diagnostic={field:'private-key',expected:'object',actual:'string'};
 failures.push(malformed);
 for(const failure of failures){
  const instance=client();instance.getCatalogCategories=async()=>{throw failure};
  await assert.rejects(prepare(instance),error=>{
   const expectedCode=failure instanceof EmallError?'INVALID_RESPONSE':'DICTIONARY_UNAVAILABLE';
   assert.deepEqual(error.categoryReview,{categoryId:11,path:[],dictionaryError:{code:expectedCode,status:null,diagnostic:null}});
   assert(!JSON.stringify(error).includes('private'));return true;
  });
 }
});
test('explicit category ID overrides use an existing approved category only',async()=>{
 const raw={...card(1),category_id:999};
 const result=await prepare(client([raw]),{categoryMap:{999:'beanies'}});assert.equal(result.records[0].cat,'beanies');
 assert.equal((await prepare(client([raw]),{categoryMap:{'00999':'beanies'}})).records[0].cat,'beanies');
 for(const categoryMap of [{999:'new-root'},{999:'all'},{invalid:'beanies'}])await assert.rejects(prepare(client([raw]),{categoryMap}),code('INVALID_CONFIG'));
 await assert.rejects(prepare(client([raw]),{categoryMap:{999:'beanies','00999':'hats'}}),code('INVALID_CONFIG'));
 const extended=[...categories,{id:'new-root',name:'Новый раздел',parent:'all'}];
 await assert.rejects(prepareEmallRecords(client([raw]),{categories:extended,categoryMap:{999:'new-root'}}),code('INVALID_CONFIG'));
});
test('all selected unmapped categories are reviewed before property requests or partial records',async()=>{
 let propertyCalls=0;
 const raw=[{...card(1),category_id:888,name:'PRIVATE_PRODUCT_ONE'},{...card(2),category_id:999,name:'PRIVATE_PRODUCT_TWO'}];
 const instance=client(raw,{tree:[{id:888,name:'Первый новый раздел'},{id:999,name:'Второй новый раздел'}]});
 instance.getCategoryProperties=async()=>{propertyCalls++;return {properties:[]}};
 await assert.rejects(prepare(instance),error=>{
  assert.equal(error.code,'CATEGORY_UNMAPPED');assert.deepEqual(error.categoryReview.unmapped,[{categoryId:888,path:['Первый новый раздел']},{categoryId:999,path:['Второй новый раздел']}]);
  assert(!JSON.stringify(error.categoryReview).includes('PRIVATE_PRODUCT'));return true;
 });
 assert.equal(propertyCalls,0);
});
test('documented Продукты root maps to food, with deepest approved path match preferred',async()=>{
 const tree=[{id:20,name:'Продукты',children:[{id:21,name:'Сладости',children:[{id:22,name:'Шоколад'}]},{id:23,name:'Молоко'}]}];
 const result=await prepare(client([{...card(1),category_id:22},{...card(2),category_id:23}],{tree}));
 assert.deepEqual(result.records.map(p=>p.cat),['sweets','food']);
});
test('ambiguous leaf names need the matching source ancestor',async()=>{
 await assert.rejects(prepare(client([{...card(1),category_id:30}],{tree:[{id:30,name:'Маски'}]})),code('CATEGORY_UNMAPPED'));
 const result=await prepare(client([{...card(1),category_id:30}],{tree:[{id:31,name:'Уход за волосами',children:[{id:30,name:'Маски'}]}]}));
 assert.equal(result.records[0].cat,'masks');
});
test('unavailable optional dictionaries preserve readable source fields and never expose numeric property codes',async()=>{
 const instance=client();instance.getCategoryProperties=async()=>{throw new Error('private API response and token')};
 const result=await prepare(instance),attrs=result.records[0].attrs;
 assert.deepEqual(attrs,{Состав:'Шерсть, хлопок',Производитель:'Тестовый производитель'});
 assert(result.warnings.some(w=>w.code==='PROPERTIES_UNAVAILABLE'));assert(result.warnings.some(w=>w.code==='PROPERTY_UNRESOLVED'));
 assert(!JSON.stringify(result).includes('private API response and token'));
});
test('property dictionaries are fetched once for each category and unknown enum values are omitted',async()=>{
 const source=[card(1),card(2)];source[0].properties[149]=[1,999];source[0].properties[999]=[12345];
 const instance=client(source);let calls=0;instance.getCategoryProperties=async id=>{assert.equal(id,11);calls++;return {properties:definitions}};
 const result=await prepare(instance);
 assert.equal(calls,1);assert.equal(result.records[0].attrs.Материал,'Шерсть');assert(!JSON.stringify(result.records).includes('12345'));
 assert(result.warnings.some(w=>w.code==='PROPERTY_VALUE_UNRESOLVED'));assert(result.warnings.some(w=>w.code==='PROPERTY_UNRESOLVED'));
});
test('HTML descriptions become readable plain text with common entities and scripts removed',async()=>{
 const description='<p>А &amp; Б&nbsp;&#8212; &#x43C;&#1080;&#1088;.</p><script>privateScript()</script><style>secret { color:red }</style><p>Следующая<br>строка &quot;тест&quot;.</p>';
 const result=await prepare(client([{...card(1),description}]));
 assert.equal(result.records[0].summary,'А & Б — мир.\n\nСледующая\nстрока "тест".');
 assert(!result.records[0].summary.includes('privateScript'));assert(!result.records[0].summary.includes('<'));
});
test('local text and attribute limits truncate with warnings and preserve importable fields',async()=>{
 const properties=Object.fromEntries(Array.from({length:35},(_,i)=>['Описание '+i,'Д'.repeat(600)]));properties['К'.repeat(70)]='Текст';
 const result=await prepare(client([{...card(1),name:'И'.repeat(250),description:'О'.repeat(11000),properties,composition:null,manufacturer_name:null}]));
 const record=result.records[0];assert.equal(record.name.length,200);assert.equal(record.summary.length,10000);assert.equal(Object.keys(record.attrs).length,30);
 assert(Object.entries(record.attrs).every(([k,v])=>k.length<=60&&v.length<=500));assert(result.warnings.some(w=>w.code==='TEXT_TRUNCATED'));assert(result.warnings.some(w=>w.code==='ATTRIBUTES_TRUNCATED'));
});
test('category dictionary failure can use explicit mapping or exact available source category title',async()=>{
 const instance=client([{...card(1),category_name:'Шапки'}]);instance.getCatalogCategories=async()=>{throw new Error('private details')};
 const result=await prepare(instance);assert.equal(result.records[0].cat,'beanies');assert(result.warnings.some(w=>w.code==='CATEGORY_DICTIONARY_UNAVAILABLE'));
 const unmapped=client();unmapped.getCatalogCategories=instance.getCatalogCategories;
 await assert.rejects(prepare(unmapped),code('CATEGORY_UNMAPPED'));
 assert.equal((await prepare(unmapped,{categoryMap:{11:'beanies'}})).records[0].cat,'beanies');
});
test('empty catalogs return no placeholders and do not request dictionaries',async()=>{
 const instance=client([]);instance.getCatalogCategories=()=>assert.fail('no dictionary read required');
 assert.deepEqual(await prepare(instance),{records:[],imageJobs:[],warnings:[]});
});
test('malformed and duplicate cards fail safely before any draft output',async()=>{
 for(const products of [[card(1),card('01')],[{...card(1),name:' '}],[{...card(1),images:[42]}]])await assert.rejects(prepare(client(products)),code('INVALID_PRODUCT'));
 const instance=client();instance.listProducts=async()=>{throw new Error('private transport secret')};
 await assert.rejects(prepare(instance),error=>error.code==='READ_FAILED'&&!String(error.stack).includes('private transport secret'));
});
