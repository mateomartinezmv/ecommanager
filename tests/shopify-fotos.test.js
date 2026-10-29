// Las fotos de MELI en los productos de la tienda, directo sobre api/shopify/_fotos.js
// (sin MELI ni Shopify).
//
// Lo que se protege:
//   · Una foto de MELI que ya está en Shopify no se vuelve a subir: va por id en el PUT. Shopify
//     la republica en su CDN, a veces en otro formato y con sufijos en el nombre: se reconoce
//     por la clave de la imagen que queda en el nombre del archivo. Si no, cada pasada
//     re-subiría todas las fotos.
//   · El producto queda con las fotos de MELI en el orden de MELI, y lo que sobra se saca.
//   · Dos SKUs que son variantes del mismo producto no ponen dos veces la misma foto.
//   · Un producto que ya está al día no se toca.

const { test } = require('node:test');
const assert = require('node:assert');
const { claveImagen, fotosObjetivo, cuerpoImagenes, alDia, armarPlan } = require('../api/shopify/_fotos');

const meli = n => ({ id: `${n}00000-MLU${n}0000000_082026`, url: `https://http2.mlstatic.com/D_${n}00000-MLU${n}0000000_082026-O.jpg` });
const enShopify = (n, id = `${n}`) => ({
  id,
  url: `https://cdn.shopify.com/s/files/1/0682/5771/0267/files/D_NQ_NP_2X_${n}00000-MLU${n}0000000_082026-F_39c75d22-c382-442d-be32-dc9167f46d68.webp?v=1773796850`,
});
const propia = { id: '77', url: 'https://cdn.shopify.com/s/files/1/files/foto-propia.jpg' };

test('claveImagen saca la clave de MELI de su url y de la de Shopify', () => {
  assert.strictEqual(claveImagen(meli(1).url), '100000-MLU10000000_082026');
  assert.strictEqual(claveImagen(enShopify(1).url), '100000-MLU10000000_082026');
  assert.strictEqual(
    claveImagen('https://cdn.shopify.com/s/files/1/files/D_NQ_NP_2X_805492-CBT83479760244_042025-F-aleron.webp'),
    '805492-CBT83479760244_042025'
  );
  assert.strictEqual(claveImagen(propia.url), '');
});

test('el cuerpo reusa por id lo que ya está, sube lo nuevo y sigue el orden de MELI', () => {
  const cuerpo = cuerpoImagenes([meli(1), meli(2), meli(3)], [enShopify(3, '30'), propia, enShopify(1, '10')]);
  assert.deepStrictEqual(cuerpo, [{ id: 10 }, { src: meli(2).url }, { id: 30 }]);
});

test('lo que no es de MELI no entra en el cuerpo, así Shopify lo saca', () => {
  const cuerpo = cuerpoImagenes([meli(1)], [propia]);
  assert.deepStrictEqual(cuerpo, [{ src: meli(1).url }]);
});

test('alDia exige las mismas fotos en el mismo orden y nada de más', () => {
  assert.strictEqual(alDia([meli(1), meli(2)], [enShopify(1), enShopify(2)]), true);
  assert.strictEqual(alDia([meli(1), meli(2)], [enShopify(2), enShopify(1)]), false);
  assert.strictEqual(alDia([meli(1)], [enShopify(1), propia]), false);
  assert.strictEqual(alDia([meli(1), meli(2)], [enShopify(1)]), false);
});

test('fotosObjetivo junta varias listas sin repetir, empezando por la primera', () => {
  const objetivo = fotosObjetivo([[meli(1), meli(2)], [meli(2), meli(3)]]);
  assert.deepStrictEqual(objetivo.map(f => f.id), [meli(1).id, meli(2).id, meli(3).id]);
});

test('armarPlan junta las variantes de un mismo producto y deja afuera lo que no se puede resolver', () => {
  const { productos, sinResolver } = armarPlan(
    [
      { sku: 'A-NEGRO', nombre: 'A', variantId: '1', original: { meli_id: 'MLU1', fotos: [meli(1), meli(2)] } },
      { sku: 'A-ROJO', nombre: 'A', variantId: '2', original: { meli_id: 'MLU2', fotos: [meli(2), meli(3)] } },
      { sku: 'B', nombre: 'B', variantId: '9', original: { meli_id: 'MLU9', fotos: [meli(5)] } },
      { sku: 'C', nombre: 'C', variantId: '3', original: null },
      { sku: 'D', nombre: 'D', variantId: '4', original: { meli_id: 'MLU4', fotos: [meli(4)] } },
    ],
    {
      1: { productId: 'P1', titulo: 'A', imagenes: [enShopify(1, '10'), propia] },
      2: { productId: 'P1', titulo: 'A', imagenes: [enShopify(1, '10'), propia] },
      3: { productId: 'P3', titulo: 'C', imagenes: [] },
      4: { productId: 'P4', titulo: 'D', imagenes: [enShopify(4)] },
    }
  );
  assert.deepStrictEqual(productos.map(p => p.productId), ['P1', 'P4']);
  const [a, d] = productos;
  assert.deepStrictEqual(a.skus, ['A-NEGRO', 'A-ROJO']);
  assert.deepStrictEqual(a.cuerpo, [{ id: 10 }, { src: meli(2).url }, { src: meli(3).url }]);
  assert.strictEqual(a.nuevas, 2);
  assert.strictEqual(a.sacadas, 1);
  assert.strictEqual(a.alDia, false);
  assert.strictEqual(d.alDia, true);
  assert.deepStrictEqual(sinResolver.map(s => s.sku), ['B', 'C']);
});
