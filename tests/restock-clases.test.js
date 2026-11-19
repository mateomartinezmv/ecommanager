// /api/restock con la clase de compra: lo que no puede faltar nunca, lo que se compra poco y
// lo que se descataloga, contra una base en memoria (tests/fixtures/supabaseMemoria.js).
//
// Lo que no puede fallar en silencio:
//   · un ⭐ "nunca sin stock" se cubre con más meses que el modelo base;
//   · un "descatalogar" no se compra aunque tenga piso manual (alerta_min);
//   · la publicidad de cada producto se compara con lo que facturó en el MISMO tramo del
//     snapshot (meli_ads_anuncios empezó a guardarse después que meli_ads_diario);
//   · un tramo largo sin ventas con 1 unidad "reconstruida" cuenta como agotado (alerón finos);
//   · pasando las 1000 ventas no se pierde ninguna (Supabase corta ahí cada consulta).

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { supabaseMemoria } = require('./fixtures/supabaseMemoria');

const haceDias = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const ventas = [];
let id = 0;
const vender = (sku, dias, total, comision) => ventas.push({
  id: 'V' + String(++id).padStart(6, '0'), sku, fecha: haceDias(dias), cantidad: 1,
  total, comision, canal: 'meli', estado: 'completada',
});

// Alerón: publicado cuando llegaron 104, hace 101 días; desde ahí 1 por día.
for (let d = 99; d >= 0; d--) vender('ALERON', d, 1700, 400);
// Circulares: uno cada 3 días; la publicidad se lleva el 54% de lo que facturan.
for (let d = 89; d >= 0; d -= 3) vender('CIRC', d, 1035, 300);
// Finos: 11 en dos semanas, después 1 unidad "reconstruida" sin vender ~95 días (en la
// práctica, agotado) hasta que llegan 35, que se venden todas.
for (let d = 168; d > 157; d--) vender('FINOS', d, 1444, 350);
for (let d = 59; d > 23; d--) vender('FINOS', d, 1444, 350);
// Nuevo: publicado hace 10 días, 2 ventas.
vender('NUEVO', 5, 900, 150); vender('NUEVO', 2, 900, 150);
// Soportes: 1100 ventas, para pasar las 1000 filas de una consulta.
for (let i = 0; i < 1100; i++) vender('SOPORTE', i % 100, 450, 80);

const prod = (o) => ({ tipo: 'nuevo', discontinuado: false, unidades_por_venta: 1, alerta_min: 0, grupo: 'G', ...o });

const tablas = {
  productos: [
    prod({ sku: 'ALERON', nombre: 'Espejo alerón', stock_dep: 4, costo: 342, fecha_publicacion: haceDias(101), proveedor_id: 'PROV-1' }),
    prod({ sku: 'CIRC', nombre: 'Espejos circulares', stock_dep: 2, costo: 334, fecha_publicacion: haceDias(150) }),
    prod({ sku: 'FINOS', nombre: 'Alerón finos', stock_dep: 0, costo: 333, fecha_publicacion: haceDias(200) }),
    prod({ sku: 'MAN28', nombre: 'Manillar 28mm', stock_dep: 5, costo: 484, alerta_min: 3, fecha_publicacion: haceDias(250) }),
    prod({ sku: 'NUEVO', nombre: 'Producto nuevo', stock_dep: 10, costo: 100, fecha_publicacion: haceDias(10) }),
    prod({ sku: 'SOPORTE', nombre: 'Soporte celular', stock_dep: 2000, costo: 88, fecha_publicacion: haceDias(150) }),
  ],
  ventas,
  devoluciones: [],
  kit_componentes: [],
  importaciones: [
    { id: 'I1', fecha: haceDias(190), llegada: haceDias(101), estado: 'recibido',
      items: [{ sku: 'ALERON', qty: 104 }, { sku: 'CIRC', qty: 32 }, { sku: 'SOPORTE', qty: 3100 }] },
    { id: 'I2', fecha: haceDias(260), llegada: haceDias(170), estado: 'recibido', items: [{ sku: 'FINOS', qty: 12 }] },
    { id: 'I3', fecha: haceDias(150), llegada: haceDias(60), estado: 'recibido', items: [{ sku: 'FINOS', qty: 35 }] },
    { id: 'I4', fecha: haceDias(160), llegada: haceDias(68), estado: 'recibido', items: [{ sku: 'MAN28', qty: 5 }] },
  ],
  // El snapshot por anuncio arranca hace 40 días; el diario de la cuenta, hace 60.
  meli_ads_anuncios: [],
  meli_ads_diario: [],
};
for (let d = 40; d >= 0; d--) {
  tablas.meli_ads_anuncios.push({ sku: 'ALERON', fecha: haceDias(d), spend: 170 / 1.22, ad_group_id: 'A' });
  // 13 ventas de circulares en el tramo × $1.035 × 54% / 1,22, repartido en 41 días.
  tablas.meli_ads_anuncios.push({ sku: 'CIRC', fecha: haceDias(d), spend: (13 * 1035 * 0.54) / 1.22 / 41, ad_group_id: 'C' });
}
for (let d = 60; d >= 0; d--) tablas.meli_ads_diario.push({ fecha: haceDias(d), spend: 1000 });

let resp;
before(async () => {
  require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = { exports: { getSupabase: () => supabaseMemoria(tablas) } };
  delete require.cache[require.resolve('../api/restock')];
  const handler = require('../api/restock');
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, end() {}, json(b) { this.body = b; return this; } };
  await handler({ method: 'GET' }, res);
  assert.ok(!res.body.error, res.body.error);
  resp = res.body;
});
const de = sku => resp.productos.find(p => p.sku === sku);

test('pasando las 1000 ventas no se pierde ninguna', () => {
  assert.strictEqual(de('SOPORTE').total_sold, 1100);
  assert.strictEqual(de('ALERON').total_sold, 100);
});

test('el que más deja es ⭐ y se cubre con ~4,5 meses de venta', () => {
  const p = de('ALERON');
  assert.strictEqual(p.clase, 'nunca');
  assert.strictEqual(p.ads_pct, 10);
  assert.strictEqual(p.ads_estimado, false);
  // Plazo = mediana de las 4 importaciones (90 días); meta = plazo + 55 días de venta.
  assert.strictEqual(resp.lead_time_promedio, 90);
  assert.ok(Math.abs(p.daily_velocity - 1) < 0.03, `velocidad ${p.daily_velocity}`);
  assert.ok(Math.abs(p.objetivo_uds - p.daily_velocity * 145) <= 1, `objetivo ${p.objetivo_uds}`);
  assert.ok(Math.abs(p.cantidad_sugerida - (p.objetivo_uds - 4)) <= 1, `pedir ${p.cantidad_sugerida}`);
  assert.ok(p.objetivo_uds > p.punto_pedido_uds, 'más que el modelo base');
  assert.match(p.clase_motivo, /de los que más dejan/);
  // Trae el proveedor, para filtrar la pantalla; sin proveedor, null.
  assert.strictEqual(p.proveedor_id, 'PROV-1');
  assert.strictEqual(de('CIRC').proveedor_id, null);
});

test('la publicidad de cada producto se mide en el tramo de su snapshot', () => {
  // Si se comparara con lo facturado desde que arranca el diario (60 días), daría ~37%.
  const p = de('CIRC');
  assert.strictEqual(p.ads_pct, 54);
  assert.strictEqual(p.clase, 'poco');
  assert.match(p.clase_motivo, /los Ads \(54% de lo que factura en MELI\)/);
  // Comprar poco: solo el plazo, sin colchón.
  assert.ok(Math.abs(p.objetivo_uds - p.daily_velocity * resp.lead_time_promedio) <= 1, `objetivo ${p.objetivo_uds}`);
});

test('meses con stock y sin ventas: no se compra aunque tenga piso manual', () => {
  const p = de('MAN28');
  assert.strictEqual(p.clase, 'descatalogar');
  assert.strictEqual(p.restock_status, 'no_comprar');
  assert.strictEqual(p.cantidad_sugerida, 0);
  assert.match(p.clase_motivo, /Sin ventas en 68 días con stock y tenés \$2\.420 parados/);
});

test('un tramo largo con 1 unidad residual y sin ventas cuenta como agotado', () => {
  const p = de('FINOS');
  const residual = p.periodos_sin_stock.find(per => per.quedaban);
  assert.ok(residual, JSON.stringify(p.periodos_sin_stock));
  assert.strictEqual(residual.quedaban, 1);
  assert.ok(residual.dias > 80);
  // 47 vendidas en ~75 días con stock, no en 145.
  assert.ok(p.daily_velocity > 0.5, `velocidad ${p.daily_velocity}`);
});

test('poca historia: nuevo, y el resumen cuenta cada clase', () => {
  assert.strictEqual(de('NUEVO').clase, 'nuevo');
  assert.strictEqual(resp.clases.nunca.productos, resp.productos.filter(p => p.clase === 'nunca').length);
  assert.strictEqual(resp.clases.descatalogar.productos, 1);
  assert.strictEqual(resp.clases.descatalogar.valor_stock, 2420);
  assert.strictEqual(resp.clases.nunca.reparto_pct, 35);
  assert.deepStrictEqual(resp.clases_colchon_dias, { nunca: 55, siempre: 25, poco: 0 });
});
