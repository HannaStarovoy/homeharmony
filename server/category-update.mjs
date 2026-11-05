// Apply the owner's category changes once, preserving later manual assignments.
export function updateCategories(db){
 if(db.prepare('SELECT 1 FROM migrations WHERE version=4').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{
  const insert=db.prepare('INSERT OR IGNORE INTO categories(id,name,parent) VALUES(?,?,?)');
  for(const c of [['jewelry','Бижутерия','accessories'],['beauty-health','Красота и здоровье','all'],['oral-care','Уход за полостью рта','beauty-health'],['nail-care','Товары для маникюра и педикюра','beauty-health']])insert.run(...c);
  const update=db.prepare('UPDATE products SET category_id=?,version=version+1,updated_at=? WHERE id=?');
  for(const p of db.prepare('SELECT id,name FROM products WHERE deleted_at IS NULL').all())if(/(?:^|[^а-яё])серьг[а-яё]*/iu.test(p.name))update.run('jewelry',new Date().toISOString(),p.id);
  db.prepare('INSERT INTO migrations VALUES(4)').run();db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}

export function updateBeautyCategories(db){
 if(db.prepare('SELECT 1 FROM migrations WHERE version=5').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{
  const insert=db.prepare('INSERT OR IGNORE INTO categories(id,name,parent) VALUES(?,?,?)');
  for(const row of [['neckwarmers','Манишки','accessories'],['face-care','Уход за кожей лица','cosmetics'],['foot-care','Уход за кожей ног','cosmetics'],['chemicals','Бытовая химия','cosmetics']])insert.run(...row);
  db.prepare("UPDATE categories SET name='Косметика',parent='beauty-health' WHERE id='cosmetics'").run();
  db.prepare("UPDATE categories SET parent='face-care' WHERE id='creams'").run();
  db.prepare("UPDATE categories SET parent='cosmetics' WHERE id='hair'").run();
  db.prepare("UPDATE categories SET name='Уход за зубами',parent='cosmetics' WHERE id='oral-care'").run();
  const update=db.prepare('UPDATE products SET category_id=?,version=version+1,updated_at=? WHERE id=?');
  for(const p of db.prepare('SELECT id,name,category_id,attrs FROM products WHERE deleted_at IS NULL').all()){
   let cat=p.category_id;const name=p.name.toLocaleLowerCase('ru'),attrs=JSON.parse(p.attrs);
   if(/(?:^|[^а-яё])манишк[а-яё]*/iu.test(name+' '+(attrs['Тип']||attrs['Вид']||'')))cat='neckwarmers';
   else if(['cosmetics','creams'].includes(cat)){
    if(/(?:для|кож[аи])\s+(?:ног|стоп)|пят(?:ок|ки)|ступн/iu.test(name))cat='foot-care';
    else if(/зубн|полост[ьи]\s+рта/iu.test(name))cat='oral-care';
    else if(/стирк|моющ|отбелив|чистящ|для\s+(?:посуды|унитаза|сантехники)|кондиционер\s+для\s+белья/iu.test(name))cat='chemicals';
   }
   if(cat!==p.category_id)update.run(cat,new Date().toISOString(),p.id);
  }
  db.prepare('INSERT INTO migrations VALUES(5)').run();db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}
