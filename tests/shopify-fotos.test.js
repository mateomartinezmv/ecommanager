// Las fotos de MELI que le faltan a cada producto de la tienda, directo sobre
// api/shopify/_fotos.js (sin MELI ni Shopify).
//
// Lo que se protege:
//   · Una foto de MELI que ya está en Shopify no se vuelve a subir. Shopify la republica en
//     su CDN, a veces en otro formato y con sufijos en el nombre: se reconoce por la clave
//     de la imagen que queda en el nombre del archivo. Si no, cada pasada duplicaría fotos.
//   · El orden de MELI se respeta en lo que se agrega.
//   · Dos SKUs que son variantes del mismo producto no suben dos veces la misma foto.

const { test } = require('node:test');
const assert = require('node:assert');
const { claveImagen, fotosFaltantes, armarPlan } = require('../api/shopify/_fotos');

const meli = n => ({ id: `${n}00000-MLU${n}0000000_082026`, url: `https://http2.mlstatic.com/D_${n}00000-MLU${n}0000000_082026-O.jpg` });
const enShopify = n => `https://cdn.shopify.com/s/files/1/0682/5771/0267/files/D_NQ_NP_2X_${n}00000-MLU${n}0000000_082026-F_39c75d22-c382-442d-be32-dc9167f46d68.webp?v=1773796850`;

test('claveImagen saca la clave de MELI de su url y de la de Shopify', () => {
  assert.strictEqual(claveImagen(meli(1).url), '100000-MLU10000000_082026');
  assert.strictEqual(claveImagen(enShopify(1)), '100000-MLU10000000_082026');
  assert.strictEqual(
    claveImagen('https://cdn.shopify.com/s/files/1/files/D_NQ_NP_2X_805492-CBT83479760244_042025-F-aleron.webp'),
    '805492-CBT83479760244_042025'
  );
  assert.strictEqual(claveImagen('https://cdn.shopify.com/s/files/1/files/foto-propia.jpg'), '');
});

test('sólo faltan las que no están, en el orden de MELI', () => {
  const faltan = fotosFaltantes([meli(1), meli(2), meli(3), meli(4)], [enShopify(3), enShopify(1)]);
  assert.deepStrictEqual(faltan.map(f => f.id), [meli(2).id, meli(4).id]);
});

test('las fotos propias de la tienda no tapan ni bloquean nada', () => {
  const faltan = fotosFaltantes([meli(1)], ['https://cdn.shopify.com/s/files/1/files/foto-propia.jpg']);
  assert.deepStrictEqual(faltan.map(f => f.id), [meli(1).id]);
});

test('un producto sin fotos en Shopify recibe todas', () => {
  assert.strictEqual(fotosFaltantes([meli(1), meli(2)], []).length, 2);
});

test('armarPlan junta las variantes de un mismo producto sin repetir fotos', () => {
  const { productos, sinResolver } = armarPlan(
    [
      { sku: 'A-NEGRO', nombre: 'A', variantId: '1', original: { meli_id: 'MLU1', fotos: [meli(1), meli(2)] } },
      { sku: 'A-ROJO', nombre: 'A', variantId: '2', original: { meli_id: 'MLU2', fotos: [meli(2), meli(3)] } },
      { sku: 'B', nombre: 'B', variantId: '9', original: { meli_id: 'MLU9', fotos: [meli(5)] } },
      { sku: 'C', nombre: 'C', variantId: '3', original: null },
    ],
    {
      1: { productId: 'P1', titulo: 'A', imagenes: [enShopify(1)] },
      2: { productId: 'P1', titulo: 'A', imagenes: [enShopify(1)] },
      3: { productId: 'P3', titulo: 'C', imagenes: [] },
    }
  );
  assert.strictEqual(productos.length, 1);
  assert.deepStrictEqual(productos[0].skus, ['A-NEGRO', 'A-ROJO']);
  assert.deepStrictEqual(productos[0].faltan.map(f => f.id), [meli(2).id, meli(3).id]);
  assert.deepStrictEqual(sinResolver.map(s => s.sku), ['B', 'C']);
});
