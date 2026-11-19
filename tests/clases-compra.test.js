// Clase de compra de cada producto (api/_clasesCompra.js).
//
// Los casos salen de los números reales de agosto a noviembre de 2026: los espejos alerón y
// el baúl 45L son los que más dejan; el gato elevador deja bien por mes pero poco por cada
// peso; a los espejos circulares la publicidad les come todo; los señaleros finos no dejan
// nada ni sin publicidad; los manillares de 28 mm llevan meses con stock y sin una venta.

const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../api/_clasesCompra');

// Producto con economía medida: `ud` y `udSinAds` son lo que deja cada unidad.
const prod = (o) => ({
  vendidas: 40, dias_activos: 100, dias_publicado: 200, ventana_dias: 180,
  stock: 5, costo: 300, ventas_mes: 12, econ_uds: 40,
  contrib_ud: 0, contrib_ud_sin_ads: 0, ads_pct: 0.15, ads_estimado: false, en_camino: 0,
  dias_desde_llegada: null, ...o,
});

test('los que más dejan, en total y por peso, nunca pueden quedar sin stock', () => {
  // Espejo alerón grande: ~26 por mes, costo $342, deja ~$828 por unidad después de Ads.
  const r = C.clasificar(prod({ ventas_mes: 26.4, costo: 342, contrib_ud: 828, contrib_ud_sin_ads: 947, vendidas: 131 }));
  assert.strictEqual(r.clase, 'nunca');
  assert.strictEqual(r.retorno, 242);
  assert.ok(r.contrib_mes > 20000);
  assert.match(r.motivo, /de los que más dejan/);
  assert.strictEqual(r.motivo_sugerido, null);
  assert.match(r.motivo, /Meta: ~4,6 meses de venta/); // plazo por defecto 82 + 55 días
  // Con el plazo real (95 días) la meta son ~5 meses.
  assert.match(C.clasificar(prod({ ventas_mes: 26.4, costo: 342, contrib_ud: 828, contrib_ud_sin_ads: 947, vendidas: 131, lead_dias: 95 })).motivo, /Meta: ~5 meses/);
});

test('deja bien por mes pero poco por cada peso: con stock siempre, no nunca', () => {
  // Gato elevador: $1.170 de costo, deja ~$655 por unidad → $56 por cada $100.
  const r = C.clasificar(prod({ ventas_mes: 5.4, costo: 1170, contrib_ud: 655, contrib_ud_sin_ads: 1228 }));
  assert.strictEqual(r.clase, 'siempre');
  assert.strictEqual(r.retorno, 56);
});

test('pocas unidades vendidas no alcanzan para ser ⭐ aunque los números den', () => {
  const r = C.clasificar(prod({ vendidas: 8, ventas_mes: 20, costo: 300, contrib_ud: 500, contrib_ud_sin_ads: 600 }));
  assert.strictEqual(r.clase, 'siempre');
});

test('si los Ads se llevan casi todo, comprar poco y el motivo dice que es la publicidad', () => {
  // Espejos circulares: sin Ads $155 por cada $100, con Ads (54%) $2.
  const r = C.clasificar(prod({ ventas_mes: 6, costo: 334, contrib_ud: 7, contrib_ud_sin_ads: 518, ads_pct: 0.54 }));
  assert.strictEqual(r.clase, 'poco');
  assert.match(r.motivo, /los Ads \(54% de lo que factura en MELI\)/);
  assert.match(r.motivo, /Sacalo de Ads/);
});

test('si con Ads pierde plata, comprar poco y dice cuánto pierde por unidad', () => {
  const r = C.clasificar(prod({ ventas_mes: 2, costo: 237, contrib_ud: -40, contrib_ud_sin_ads: 300, ads_pct: 0.54, ads_estimado: true }));
  assert.strictEqual(r.clase, 'poco');
  assert.match(r.motivo, /pierde \$40 por unidad/);
  assert.match(r.motivo, /estimado con el promedio de la cuenta/);
});

test('deja poco por peso aun sin Ads: comprar poco por inmovilizar plata', () => {
  // Señaleros secuenciales: $45 por cada $100 sin Ads, $10 con Ads.
  const r = C.clasificar(prod({ ventas_mes: 4.8, costo: 198, contrib_ud: 20, contrib_ud_sin_ads: 89 }));
  assert.strictEqual(r.clase, 'poco');
  assert.match(r.motivo, /inmoviliza mucha plata/);
  assert.strictEqual(r.motivo_sugerido, 'poco_margen');
});

test('deja poco en total: comprar poco', () => {
  const r = C.clasificar(prod({ ventas_mes: 0.9, costo: 117, contrib_ud: 170, contrib_ud_sin_ads: 200 }));
  assert.strictEqual(r.clase, 'poco');
  assert.match(r.motivo, /Deja poco en total/);
  assert.strictEqual(r.motivo_sugerido, 'poca_venta');
});

test('ni sin publicidad deja plata: descatalogar', () => {
  // Señaleros finos: $19 por cada $100 de costo antes de Ads.
  const r = C.clasificar(prod({ ventas_mes: 3.3, costo: 236, contrib_ud: -20, contrib_ud_sin_ads: 45 }));
  assert.strictEqual(r.clase, 'descatalogar');
  assert.match(r.motivo, /Aun sin publicidad deja solo \$19 por cada \$100/);
  assert.strictEqual(r.motivo_sugerido, 'poco_margen');
  const pierde = C.clasificar(prod({ costo: 236, contrib_ud: -90, contrib_ud_sin_ads: -10 }));
  assert.strictEqual(pierde.clase, 'descatalogar');
  assert.match(pierde.motivo, /pierde \$10 por unidad/);
});

test('meses con stock y ni una venta: descatalogar, con la plata parada', () => {
  // Manillar 28 mm: publicado en marzo, llegaron 5 el 12/09, ninguna venta.
  const r = C.clasificar(prod({ vendidas: 0, dias_activos: 0, ventas_mes: 0, econ_uds: 0, stock: 5, costo: 484, dias_publicado: 247, dias_desde_llegada: 68 }));
  assert.strictEqual(r.clase, 'descatalogar');
  assert.match(r.motivo, /Sin ventas en 68 días con stock/);
  assert.strictEqual(r.motivo_sugerido, 'poca_venta');
  assert.match(r.motivo, /\$2\.420 parados en 5 unidades/);
  // Una sola unidad: singular.
  assert.match(C.clasificar(prod({ vendidas: 0, econ_uds: 0, stock: 1, costo: 484, dias_publicado: 247, dias_desde_llegada: 68 })).motivo, /en 1 unidad:/);
});

test('llegó hace poco y todavía no vendió: es nuevo, no descatalogar', () => {
  const r = C.clasificar(prod({ vendidas: 0, econ_uds: 0, ventas_mes: 0, stock: 10, dias_publicado: 247, dias_desde_llegada: 20 }));
  assert.strictEqual(r.clase, 'nuevo');
  assert.match(r.motivo, /Tiene stock hace 20 días/);
});

test('sin stock ni ventas: nuevo si viene algo en camino, descatalogar si no', () => {
  const conPedido = C.clasificar(prod({ vendidas: 0, econ_uds: 0, ventas_mes: 0, stock: 0, en_camino: 5 }));
  assert.strictEqual(conPedido.clase, 'nuevo');
  assert.match(conPedido.motivo, /Cuando lleguen los 5 en camino/);
  const sinPedido = C.clasificar(prod({ vendidas: 0, econ_uds: 0, ventas_mes: 0, stock: 0, dias_publicado: 300 }));
  assert.strictEqual(sinPedido.clase, 'descatalogar');
  assert.match(sinPedido.motivo, /marcalo como descatalogado/);
  // Recién publicado y sin stock todavía: nuevo.
  assert.strictEqual(C.clasificar(prod({ vendidas: 0, econ_uds: 0, stock: 0, dias_publicado: 6 })).clase, 'nuevo');
});

test('descatalogar con un pedido en camino avisa que no pida más', () => {
  const r = C.clasificar(prod({ costo: 236, contrib_ud: -20, contrib_ud_sin_ads: 40, en_camino: 30 }));
  assert.strictEqual(r.clase, 'descatalogar');
  assert.match(r.motivo, /ya vienen 30 en camino; no pidas más/);
});

test('poca historia: lotes de prueba', () => {
  const r = C.clasificar(prod({ vendidas: 5, dias_activos: 21, ventas_mes: 7, costo: 1125, contrib_ud: 650, contrib_ud_sin_ads: 960 }));
  assert.strictEqual(r.clase, 'nuevo');
  assert.match(r.motivo, /5 vendidas en 21 días con stock/);
  assert.match(C.clasificar(prod({ vendidas: 1, dias_activos: 21, dias_publicado: 30 })).motivo, /\(1 vendida en 21 días/);
  // Un producto viejo que vende poco no es "nuevo": se juzga por lo que deja.
  assert.strictEqual(C.clasificar(prod({ vendidas: 3, dias_activos: 150, dias_publicado: 250, ventas_mes: 0.6, contrib_ud: 150, contrib_ud_sin_ads: 180 })).clase, 'poco');
});

test('sin costo cargado no hay cómo medir', () => {
  const r = C.clasificar(prod({ costo: 0 }));
  assert.strictEqual(r.clase, 'sin_datos');
  assert.match(r.motivo, /Sin costo cargado/);
});

test('con stock para muchos meses lo avisa aunque sea un buen producto', () => {
  // Soportes de celular: ~8 por mes y 79 en stock.
  const r = C.clasificar(prod({ stock: 79, ventas_mes: 7.8, costo: 88, contrib_ud: 324, contrib_ud_sin_ads: 380 }));
  assert.strictEqual(r.clase, 'siempre');
  assert.match(r.motivo, /Ya tenés stock para ~10 meses: no hace falta comprar ahora/);
});

test('la meta de cada clase: más colchón para los ⭐, sin colchón para comprar poco', () => {
  const base = { velocidad: 1, leadDias: 82, puntoPedido: 95 };
  assert.strictEqual(C.objetivoUnidades('nunca', base), 137);
  assert.strictEqual(C.objetivoUnidades('siempre', base), 107);
  assert.strictEqual(C.objetivoUnidades('poco', base), 82);
  assert.strictEqual(C.objetivoUnidades('descatalogar', base), 0);
  assert.strictEqual(C.objetivoUnidades('nuevo', base), 95);
  // La clase nunca baja la protección del modelo para los que se reponen.
  assert.strictEqual(C.objetivoUnidades('siempre', { ...base, puntoPedido: 130 }), 130);
});

test('el resumen reparte contribución y compra por clase', () => {
  const r = C.resumenClases([
    { clase: 'nunca', contrib_mes: 6000, compra_mes: 2000, valor_stock: 1000 },
    { clase: 'siempre', contrib_mes: 3000, compra_mes: 4000, valor_stock: 500 },
    { clase: 'poco', contrib_mes: 1000, compra_mes: 2000, valor_stock: 3000 },
    { clase: 'descatalogar', contrib_mes: -50, compra_mes: 0, valor_stock: 2420 },
  ]);
  assert.strictEqual(r.nunca.productos, 1);
  assert.strictEqual(r.nunca.contrib_pct, 60);
  assert.strictEqual(r.nunca.compra_pct, 25);
  assert.strictEqual(r.nunca.reparto_pct, 35);
  assert.strictEqual(r.descatalogar.contrib_mes, 0); // lo que pierde no resta del total
  assert.strictEqual(r.descatalogar.valor_stock, 2420);
});
