export const templates = {
  'beauty-health': { attributes: ['Назначение', 'Способ применения', 'Меры предосторожности'], dimensions: ['Объём', 'Упаковка'] },
  jewelry: { attributes: ['Материал', 'Тип застёжки'], dimensions: ['Цвет'] },
  accessories: { attributes: ['Состав', 'Материал', 'Сезон', 'Уход'], dimensions: ['Цвет', 'Размер'] },
  cosmetics: { attributes: ['Назначение', 'Способ применения', 'Меры предосторожности'], dimensions: ['Объём', 'Аромат'] },
  household: { attributes: ['Материал', 'Назначение', 'Размеры'], dimensions: ['Упаковка', 'Размер'] },
  food: { attributes: ['Состав', 'Аллергены', 'Срок годности', 'Хранение', 'Вес'], dimensions: ['Вес', 'Упаковка'] },
  creams: { attributes: ['Назначение', 'Тип кожи', 'Состав', 'Способ применения'], dimensions: ['Объём'] },
  shampoos: { attributes: ['Назначение', 'Тип волос', 'Состав', 'Способ применения'], dimensions: ['Объём'] },
};

for(const template of Object.values(templates)){
 template.attributes=[...new Set([...template.attributes,'Производитель','Страна производства'])];
}
