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
