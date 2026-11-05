// Demo catalog for static preview; the application server serves published database records here.
window.catalogData = {
  "categories": [
    {
      "id": "all",
      "name": "Все товары",
      "parent": null
    },
    {
      "id": "accessories",
      "name": "Головные уборы и аксессуары",
      "parent": "all"
    },
    {
      "id": "hats",
      "name": "Головные уборы",
      "parent": "accessories"
    },
    {
      "id": "beanies",
      "name": "Шапки",
      "parent": "hats"
    },
    {
      "id": "headbands",
      "name": "Повязки",
      "parent": "hats"
    },
    {
      "id": "mittens",
      "name": "Варежки и перчатки",
      "parent": "accessories"
    },
    {
      "id": "scarves",
      "name": "Шарфы",
      "parent": "accessories"
    },
    {
      "id": "cosmetics",
      "name": "Косметика",
      "parent": "beauty-health"
    },
    {
      "id": "creams",
      "name": "Кремы",
      "parent": "face-care"
    },
    {
      "id": "hair",
      "name": "Уход за волосами",
      "parent": "cosmetics"
    },
    {
      "id": "shampoos",
      "name": "Шампуни",
      "parent": "hair"
    },
    {
      "id": "conditioners",
      "name": "Бальзамы",
      "parent": "hair"
    },
    {
      "id": "masks",
      "name": "Маски",
      "parent": "hair"
    },
    {
      "id": "sets",
      "name": "Наборы",
      "parent": "hair"
    },
    {
      "id": "household",
      "name": "Хозяйственные товары",
      "parent": "all"
    },
    {
      "id": "sponges",
      "name": "Губки",
      "parent": "household"
    },
    {
      "id": "cloths",
      "name": "Тряпки",
      "parent": "household"
    },
    {
      "id": "food",
      "name": "Продукты питания",
      "parent": "all"
    },
    {
      "id": "sweets",
      "name": "Сладости",
      "parent": "food"
    },
    {
      "id": "jewelry",
      "name": "Бижутерия",
      "parent": "accessories"
    },
    {
      "id": "beauty-health",
      "name": "Красота и здоровье",
      "parent": "all"
    },
    {
      "id": "oral-care",
      "name": "Уход за зубами",
      "parent": "cosmetics"
    },
    {
      "id": "nail-care",
      "name": "Товары для маникюра и педикюра",
      "parent": "beauty-health"
    },
    {
      "id": "neckwarmers",
      "name": "Манишки",
      "parent": "accessories"
    },
    {
      "id": "face-care",
      "name": "Уход за кожей лица",
      "parent": "cosmetics"
    },
    {
      "id": "foot-care",
      "name": "Уход за кожей ног",
      "parent": "cosmetics"
    },
    {
      "id": "chemicals",
      "name": "Бытовая химия",
      "parent": "cosmetics"
    }
  ],
  "products": [
    {
      "id": "hat-line",
      "name": "Шапка «Линия»",
      "type": "hat",
      "cat": "beanies",
      "price": 50,
      "old": 0,
      "tag": "Хит",
      "date": 12,
      "pop": 98,
      "summary": "Мягкая шапка с аккуратной посадкой. Состав: 70% шерсть, 30% акрил.",
      "attrs": {
        "Состав": "70% шерсть, 30% акрил",
        "Уход": "Деликатная стирка"
      },
      "variants": [
        {
          "name": "Чёрный · 54–56",
          "color": "#2e302e",
          "stock": 12,
          "sku": "HAT-LINE-1",
          "options": {
            "Цвет": "Чёрный",
            "Размер": "54–56"
          }
        },
        {
          "name": "Бежевый · 54–56",
          "color": "#c9b39a",
          "stock": 8,
          "sku": "HAT-LINE-2",
          "options": {
            "Цвет": "Бежевый",
            "Размер": "54–56"
          }
        },
        {
          "name": "Бордо · 54–56",
          "color": "#793c4b",
          "stock": 3,
          "sku": "HAT-LINE-3",
          "options": {
            "Цвет": "Бордо",
            "Размер": "54–56"
          }
        },
        {
          "name": "Молочный · 54–56",
          "color": "#eee4d5",
          "stock": 0,
          "sku": "HAT-LINE-4",
          "options": {
            "Цвет": "Молочный",
            "Размер": "54–56"
          }
        },
        {
          "sku": "HAT-LINE-BLACK-58",
          "name": "Чёрный · 56–58",
          "color": "#2e302e",
          "stock": 4,
          "price": 55,
          "options": {
            "Цвет": "Чёрный",
            "Размер": "56–58"
          }
        },
        {
          "sku": "HAT-LINE-BEIGE-58",
          "name": "Бежевый · 56–58",
          "color": "#c9b39a",
          "stock": 0,
          "price": 55,
          "options": {
            "Цвет": "Бежевый",
            "Размер": "56–58"
          }
        }
      ]
    },
    {
      "id": "hat-rib",
      "name": "Шапка «Рельеф»",
      "type": "hat",
      "cat": "beanies",
      "price": 59,
      "old": 69,
      "tag": "Скидка",
      "date": 10,
      "pop": 90,
      "summary": "Фактурная вязка, мягкая посадка и спокойные базовые оттенки.",
      "attrs": {
        "Материал": "Шерстяная смесь",
        "Размер": "Универсальный"
      },
      "variants": [
        {
          "name": "Песочный",
          "color": "#c9a887",
          "stock": 5,
          "sku": "HAT-RIB-1",
          "options": {
            "Цвет": "Песочный"
          }
        },
        {
          "name": "Графит",
          "color": "#62615e",
          "stock": 10,
          "sku": "HAT-RIB-2",
          "options": {
            "Цвет": "Графит"
          }
        },
        {
          "name": "Молочный",
          "color": "#eee6db",
          "stock": 8,
          "sku": "HAT-RIB-3",
          "options": {
            "Цвет": "Молочный"
          }
        }
      ]
    },
    {
      "id": "mittens-frost",
      "name": "Варежки «Мороз»",
      "type": "mittens",
      "cat": "mittens",
      "price": 48,
      "old": 0,
      "tag": "Новинка",
      "date": 14,
      "pop": 87,
      "summary": "Пушистые мягкие варежки с ангорой и шерстью. Универсальный размер.",
      "attrs": {
        "Состав": "Ангора и шерсть",
        "Размер": "Универсальный"
      },
      "variants": [
        {
          "name": "Бордо",
          "color": "#844654",
          "stock": 12,
          "sku": "MITTENS-FROST-1",
          "options": {
            "Цвет": "Бордо"
          }
        },
        {
          "name": "Молочный",
          "color": "#dcd6c9",
          "stock": 7,
          "sku": "MITTENS-FROST-2",
          "options": {
            "Цвет": "Молочный"
          }
        },
        {
          "name": "Капучино",
          "color": "#aa8973",
          "stock": 6,
          "sku": "MITTENS-FROST-3",
          "options": {
            "Цвет": "Капучино"
          }
        }
      ]
    },
    {
      "id": "scarf-soft",
      "name": "Шарф «Мягкий»",
      "type": "scarf",
      "cat": "scarves",
      "price": 72,
      "old": 0,
      "tag": "",
      "date": 6,
      "pop": 67,
      "summary": "Объёмный шарф с мягкой фактурой. Хорошо сочетается с однотонными шапками.",
      "attrs": {
        "Материал": "Шерстяная смесь",
        "Размер": "Универсальный"
      },
      "variants": [
        {
          "name": "Серый",
          "color": "#aba9a3",
          "stock": 7,
          "sku": "SCARF-SOFT-1",
          "options": {
            "Цвет": "Серый"
          }
        },
        {
          "name": "Кремовый",
          "color": "#d8c4ad",
          "stock": 5,
          "sku": "SCARF-SOFT-2",
          "options": {
            "Цвет": "Кремовый"
          }
        },
        {
          "name": "Олива",
          "color": "#777965",
          "stock": 3,
          "sku": "SCARF-SOFT-3",
          "options": {
            "Цвет": "Олива"
          }
        }
      ]
    },
    {
      "id": "shampoo-satin",
      "name": "Шампунь SATIN FX",
      "type": "shampoo",
      "cat": "shampoos",
      "price": 34,
      "old": 0,
      "tag": "",
      "date": 13,
      "pop": 83,
      "summary": "Мягкое очищение и уход за волосами. Формула с инкапсулированным Д-пантенолом.",
      "attrs": {
        "Назначение": "Увлажнение и восстановление",
        "Активный_компонент": "Д-пантенол"
      },
      "variants": [
        {
          "name": "250 мл",
          "color": "#d4c0a5",
          "stock": 11,
          "sku": "SHAMPOO-SATIN-1",
          "options": {
            "Объём": "250 мл"
          }
        },
        {
          "name": "500 мл",
          "color": "#d4c0a5",
          "stock": 4,
          "sku": "SHAMPOO-SATIN-2",
          "options": {
            "Объём": "500 мл"
          },
          "price": 58
        }
      ]
    },
    {
      "id": "conditioner-satin",
      "name": "Бальзам SATIN FX",
      "type": "conditioner",
      "cat": "conditioners",
      "price": 34,
      "old": 0,
      "tag": "",
      "date": 11,
      "pop": 72,
      "summary": "Для гладкости, блеска и облегчения расчёсывания волос.",
      "attrs": {
        "Назначение": "Гладкость и уход"
      },
      "variants": [
        {
          "name": "250 мл",
          "color": "#c4b195",
          "stock": 10,
          "sku": "CONDITIONER-SATIN-1",
          "options": {
            "Объём": "250 мл"
          }
        },
        {
          "name": "500 мл",
          "color": "#c4b195",
          "stock": 3,
          "sku": "CONDITIONER-SATIN-2",
          "options": {
            "Объём": "500 мл"
          }
        }
      ]
    },
    {
      "id": "set-satin",
      "name": "Набор шампунь + бальзам",
      "type": "kit",
      "cat": "sets",
      "price": 62,
      "old": 68,
      "tag": "Скидка",
      "date": 15,
      "pop": 92,
      "summary": "Набор средств с Д-пантенолом для комплексного ухода за волосами.",
      "attrs": {
        "Комплектация": "Шампунь и бальзам",
        "Назначение": "Уход за волосами"
      },
      "variants": [
        {
          "name": "Набор",
          "color": "#bea68a",
          "stock": 8,
          "sku": "SET-SATIN-1",
          "options": {
            "Вариант": "Набор"
          }
        }
      ]
    },
    {
      "id": "mask-hair",
      "name": "Маска для волос",
      "type": "jar",
      "cat": "masks",
      "price": 39,
      "old": 0,
      "tag": "Новинка",
      "date": 16,
      "pop": 69,
      "summary": "Уходовая маска для мягкости и гладкости волос.",
      "attrs": {
        "Назначение": "Питание и мягкость"
      },
      "variants": [
        {
          "name": "300 мл",
          "color": "#d6c1a5",
          "stock": 8,
          "sku": "MASK-HAIR-1",
          "options": {
            "Объём": "300 мл"
          }
        }
      ]
    },
    {
      "id": "hat-cloud",
      "name": "Шапка «Облако»",
      "type": "hat",
      "cat": "beanies",
      "price": 55,
      "old": 0,
      "tag": "Новинка",
      "date": 17,
      "pop": 75,
      "summary": "Мягкая шапка с выразительной текстурой.",
      "attrs": {
        "Материал": "Шерстяная смесь",
        "Размер": "Универсальный"
      },
      "variants": [
        {
          "name": "Молочный",
          "color": "#eee4d6",
          "stock": 13,
          "sku": "HAT-CLOUD-1",
          "options": {
            "Цвет": "Молочный"
          }
        },
        {
          "name": "Розовый",
          "color": "#ba9a9c",
          "stock": 5,
          "sku": "HAT-CLOUD-2",
          "options": {
            "Цвет": "Розовый"
          }
        }
      ]
    },
    {
      "id": "gloves-soft",
      "name": "Перчатки «Тепло»",
      "type": "mittens",
      "cat": "mittens",
      "price": 42,
      "old": 49,
      "tag": "Скидка",
      "date": 5,
      "pop": 58,
      "summary": "Повседневные вязаные перчатки для прохладной погоды.",
      "attrs": {
        "Размер": "Универсальный"
      },
      "variants": [
        {
          "name": "Серый",
          "color": "#84827d",
          "stock": 6,
          "sku": "GLOVES-SOFT-1",
          "options": {
            "Цвет": "Серый"
          }
        },
        {
          "name": "Бежевый",
          "color": "#b8a28b",
          "stock": 7,
          "sku": "GLOVES-SOFT-2",
          "options": {
            "Цвет": "Бежевый"
          }
        }
      ]
    },
    {
      "id": "headband-rib",
      "name": "Повязка «Рибана»",
      "type": "headband",
      "cat": "headbands",
      "price": 29,
      "old": 0,
      "tag": "",
      "date": 8,
      "pop": 61,
      "summary": "Вязаная повязка для прохладной погоды.",
      "attrs": {
        "Материал": "Шерстяная смесь"
      },
      "variants": [
        {
          "name": "Кофейный",
          "color": "#9b7865",
          "stock": 8,
          "sku": "HEADBAND-RIB-1",
          "options": {
            "Цвет": "Кофейный"
          }
        },
        {
          "name": "Чёрный",
          "color": "#373633",
          "stock": 4,
          "sku": "HEADBAND-RIB-2",
          "options": {
            "Цвет": "Чёрный"
          }
        }
      ]
    },
    {
      "id": "scarf-cream",
      "name": "Шарф «Крем»",
      "type": "scarf",
      "cat": "scarves",
      "price": 67,
      "old": 0,
      "tag": "",
      "date": 7,
      "pop": 65,
      "summary": "Мягкий однотонный шарф.",
      "attrs": {
        "Материал": "Шерстяная смесь"
      },
      "variants": [
        {
          "name": "Кремовый",
          "color": "#e1d2bf",
          "stock": 9,
          "sku": "SCARF-CREAM-1",
          "options": {
            "Цвет": "Кремовый"
          }
        },
        {
          "name": "Бордо",
          "color": "#8f5865",
          "stock": 4,
          "sku": "SCARF-CREAM-2",
          "options": {
            "Цвет": "Бордо"
          }
        }
      ]
    },
    {
      "id": "sponges-dish",
      "name": "Губки для посуды",
      "type": "sponge",
      "cat": "sponges",
      "price": 3.5,
      "old": 0,
      "tag": "",
      "date": 1,
      "pop": 50,
      "summary": "Демонстрационный набор губок для мытья посуды. Все характеристики условные.",
      "attrs": {
        "Материал": "Поролон и абразивный слой",
        "Назначение": "Мытьё посуды"
      },
      "variants": [
        {
          "sku": "SPONGES-5",
          "name": "5 шт.",
          "color": "#e4ca67",
          "stock": 20,
          "price": 3.5,
          "options": {
            "Упаковка": "5 шт."
          }
        },
        {
          "sku": "SPONGES-10",
          "name": "10 шт.",
          "color": "#e4ca67",
          "stock": 0,
          "price": 6,
          "options": {
            "Упаковка": "10 шт."
          }
        }
      ]
    },
    {
      "id": "sweets-mix",
      "name": "Конфеты ассорти",
      "type": "candy",
      "cat": "sweets",
      "price": 7.9,
      "old": 0,
      "tag": "",
      "date": 1,
      "pop": 49,
      "summary": "Демонстрационный товар для проверки продуктовой карточки. Состав и срок годности указаны условно и не относятся к реальному продукту.",
      "attrs": {
        "Вес": "250 г",
        "Состав": "Демо: сахар, какао, сухое молоко",
        "Аллергены": "Демо: содержит молоко; возможны следы орехов",
        "Срок_годности": "Демо: 6 месяцев с даты изготовления",
        "Хранение": "Демо: сухое прохладное место"
      },
      "variants": [
        {
          "sku": "SWEETS-250",
          "name": "250 г",
          "color": "#a66a76",
          "stock": 9,
          "price": 7.9,
          "options": {}
        }
      ]
    }
  ]
};
