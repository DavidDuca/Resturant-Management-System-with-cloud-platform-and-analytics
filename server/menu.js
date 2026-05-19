/**
 * menu.js — Jonel's Inasalan
 * Categories: grills | nonGrilled | drinks | sides
 * Each item carries:
 *   cookingArea : 'grill' | 'kitchen'      → smart routing target
 *   pairBehavior: 'fixed' | 'follow-grill' → if 'follow-grill', the item
 *                  travels with grill items when the order has any grill item;
 *                  otherwise it routes by its own cookingArea.
 *
 * NOTE: legacy items without these fields default to:
 *   grills      → cookingArea='grill',   pairBehavior='fixed'
 *   nonGrilled  → cookingArea='kitchen', pairBehavior='fixed'
 *   drinks      → cookingArea='kitchen', pairBehavior='fixed'
 *   sides       → cookingArea='kitchen', pairBehavior='follow-grill'
 *   add-ons     → always follow their parent item (in-item pairing)
 */

const MENU = {
  "grills": [
    { "id": "g01", "name": "Pork Liempo",         "price": 150, "image": "g01-liempo.jpg",      "description": "shout out kay jhasper panes",          "inStock": true, "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g02", "name": "Chicken Inasal",      "price": 159, "image": "g02-inasal.jpg",      "description": "Bisaya-style marinated chicken quarter","inStock": true, "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g03", "name": "Inihaw na Bangus",    "price": 169, "image": "g03-bangus.jpg",      "description": "Whole milkfish stuffed with tomato & onion", "inStock": true, "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g04", "name": "Pork BBQ Stick",      "price": 49,  "image": "g04-bbq-stick.jpg",   "description": "Classic skewered pork, sweet-soy marinade (per stick)", "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g05", "name": "Beef Steak",          "price": 229, "image": "g05-beef-steak.jpg",  "description": "200g sirloin, fried garlic, onion rings", "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g06", "name": "Pusit sa Grill",      "price": 189, "image": "g06-pusit.jpg",       "description": "Whole squid, ginger-soy baste", "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g07", "name": "Pork Chop Inasal",    "price": 195, "image": "g07-pork-chop.jpg",   "description": "Thick-cut chop, tangy citrus rub", "cookingArea": "grill", "pairBehavior": "fixed" },
    { "id": "g08", "name": "Grilled Tuna Belly",  "price": 210, "image": "g08-tuna-belly.jpg",  "description": "Fresh tuna collar, native vinegar dip", "cookingArea": "grill", "pairBehavior": "fixed" }
  ],
  "nonGrilled": [
    { "id": "n01", "name": "Pork Sisig",          "price": 169, "image": "n01-sisig.jpg",       "description": "Sizzling chopped pork, calamansi & chili", "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n02", "name": "Crispy Fried Chicken","price": 149, "image": "n02-fried-chicken.jpg","description": "Hand-breaded, double-fried, gravy on side", "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n03", "name": "Pork Adobo",          "price": 159, "image": "n03-adobo.jpg",       "description": "Slow-braised in soy, vinegar & garlic",  "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n04", "name": "Kare-Kare",           "price": 219, "image": "n04-karekare.jpg",    "description": "Oxtail in peanut sauce w/ bagoong",      "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n05", "name": "Sinigang na Baboy",   "price": 189, "image": "n05-sinigang.jpg",    "description": "Sour tamarind pork soup",                "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n06", "name": "Pancit Canton",       "price": 129, "image": "n06-pancit.jpg",      "description": "Stir-fried egg noodles, veggies, pork",  "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n07", "name": "Beef Caldereta",      "price": 209, "image": "n07-caldereta.jpg",   "description": "Tomato-based beef stew w/ liver sauce",  "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "n08", "name": "Chicken Tinola",      "price": 159, "image": "n08-tinola.jpg",      "description": "Ginger-clear broth w/ green papaya",     "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" }
  ],
  "drinks": [
    { "id": "d01", "name": "Iced Tea",        "price": 39, "image": "d01-iced-tea.jpg",  "description": "Bottomless sweetened black tea (Glass)", "inStock": true, "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "d02", "name": "Calamansi Juice", "price": 55, "image": "d02-calamansi.jpg", "description": "Fresh-squeezed, lightly sweetened",       "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "d03", "name": "Sago at Gulaman", "price": 59, "image": "d03-sago.jpg",      "description": "Brown sugar syrup, tapioca pearls",       "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "d04", "name": "Softdrink (Can)", "price": 45, "image": "d04-softdrink.jpg", "description": "Coke, Sprite, Royal — served cold",       "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "d05", "name": "Bottled Water",   "price": 30, "image": "d05-water.jpg",     "description": "500mL purified water",                    "cookingArea": "kitchen", "pairBehavior": "fixed" },
    { "id": "d06", "name": "Fresh Buko Juice","price": 79, "image": "d06-buko.jpg",      "description": "Young coconut water with strips",         "cookingArea": "kitchen", "pairBehavior": "fixed" }
  ],
  "sides": [
    { "id": "s01", "name": "Garlic Fried Rice",   "price": 49, "image": "s01-garlic-rice.jpg",  "description": "Day-old rice, toasted garlic",          "cookingArea": "kitchen", "pairBehavior": "follow-grill" },
    { "id": "s02", "name": "Steamed Rice",        "price": 15, "image": "s02-steamed-rice.jpg", "description": "Premium Sinandomeng rice", "inStock": true, "cookingArea": "kitchen", "pairBehavior": "follow-grill" },
    { "id": "s03", "name": "Achara",              "price": 29, "image": "s03-achara.jpg",       "description": "Green papaya pickle relish",             "cookingArea": "kitchen", "pairBehavior": "follow-grill" },
    { "id": "s04", "name": "Sawsawan Platter",    "price": 39, "image": "s04-sawsawan.jpg",     "description": "Soy-vinegar, bagoong, chili",            "cookingArea": "kitchen", "pairBehavior": "follow-grill" },
    { "id": "s05", "name": "Corn on the Cob",     "price": 49, "image": "s05-corn.jpg",         "description": "Charred, butter & salt",                 "cookingArea": "grill",   "pairBehavior": "fixed" },
    { "id": "s06", "name": "Ensaladang Talong",   "price": 55, "image": "s06-talong.jpg",       "description": "Grilled eggplant, tomato, salted egg",   "cookingArea": "grill",   "pairBehavior": "fixed" }
  ]
};

const ADD_ONS = [
  { "id": "ao1", "name": "Unli Rice",         "price": 59 },
  { "id": "ao2", "name": "Extra Chili",       "price": 0  },
  { "id": "ao3", "name": "Calamansi (2 pcs)", "price": 0  },
  { "id": "ao4", "name": "Extra Sawsawan",    "price": 15 },
  { "id": "ao5", "name": "Extra Atchara",     "price": 20 },
  { "id": "ao6", "name": "Extra Garlic Rice", "price": 49 }
];

// Default cookingArea/pairBehavior by category — used as fallback for legacy items
const CATEGORY_DEFAULTS = {
  grills:     { cookingArea: 'grill',   pairBehavior: 'fixed' },
  nonGrilled: { cookingArea: 'kitchen', pairBehavior: 'fixed' },
  drinks:     { cookingArea: 'kitchen', pairBehavior: 'fixed' },
  sides:      { cookingArea: 'kitchen', pairBehavior: 'follow-grill' }
};

const CATEGORIES = ['grills', 'nonGrilled', 'drinks', 'sides'];

module.exports = { MENU, ADD_ONS, CATEGORY_DEFAULTS, CATEGORIES };
