// La cuenta que decide si un anuncio se apaga: margen de contribución y ROAS de equilibrio.
//
// Igual que descatalogado-reglas.test.js, esto no abre el navegador: api/meli/_economia.js
// es un módulo puro (salvo la lectura de Supabase, que acá se reemplaza por un doble) y es
// el único lugar donde vive el criterio. Los dos endpoints que lo usan —ads-anuncios y
// ads-recomendaciones— quedan cubiertos por estas pruebas.
//
// Lo que se protege es un error que ya pasó: calcular el margen con una comisión fija del
// 15% y sin envío inflaba el margen ~6 puntos, bajaba el ROAS de equilibrio de 2,4x a 1,9x
// y pintaba de verde anuncios que estaban perdiendo plata.

const { test } = require('node:test');
const assert = require('node:assert');
const { cargarEconomia, deSku, contribucionUnitaria, COMISION_DEFAULT } = require('../api/meli/_economia');

/**
 * Doble de Supabase: devuelve filas fijas por tabla.
 *
 * El encadenado es thenable en cualquier punto, igual que el cliente real: `select()`,
 * `.gte()` y `.limit()` devuelven lo mismo y se puede `await` en cualquiera. Si el doble
 * sólo soportara la cadena de hoy, agregar un `.limit()` al módulo rompería estos tests
 * en vez de probarlos — que es exactamente lo que pasó la primera vez.
 */
function fakeSupabase(tablas) {
  return {
    from(tabla) {
      const resultado = Promise.resolve({ data: tablas[tabla] || [], error: null });
      const api = new Proxy({ then: (...a) => resultado.then(...a) }, {
        get: (destino, prop) => (prop === 'then' ? destino.then : () => api),
      });
      return api;
    },
  };
}

const hoy = new Date().toISOString().slice(0, 10);

test('la contribución descuenta costo, comisión y envío, y el equilibrio es su inversa', () => {
  const c = contribucionUnitaria({ precio: 1000, costo: 400, comision_pct: 14, envio_unitario: 100 });
  // 1000 − 400 − 140 − 100 = 360 → 36% de margen → hace falta 1/0,36 = 2,78x para empatar.
  assert.strictEqual(c.comision, 140);
  assert.strictEqual(c.envio, 100);
  assert.strictEqual(c.contribucion, 360);
  assert.strictEqual(c.margen_pct, 36);
  assert.strictEqual(c.roas_breakeven, 2.78);
});

test('ignorar el envío baja el ROAS de equilibrio: es el error que se vino a arreglar', () => {
  const conEnvio = contribucionUnitaria({ precio: 1000, costo: 400, comision_pct: 14, envio_unitario: 100 });
  const sinEnvio = contribucionUnitaria({ precio: 1000, costo: 400, comision_pct: 14, envio_unitario: 0 });
  const viejo = contribucionUnitaria({ precio: 1000, costo: 400, comision_pct: 15, envio_unitario: 0 });

  assert.ok(sinEnvio.roas_breakeven < conEnvio.roas_breakeven);
  // Con la cuenta vieja, un anuncio a ROAS 2,3x parecía estar ganando; con la real, pierde.
  assert.ok(2.3 > viejo.roas_breakeven, 'la cuenta vieja daba verde a 2,3x');
  assert.ok(2.3 < conEnvio.roas_breakeven, 'la cuenta real lo marca en rojo');
});

test('sin margen positivo no hay ROAS de equilibrio, y se dice que no lo hay', () => {
  // Un producto que se vende por debajo de lo que cuesta ponerlo en la calle: ningún ROAS
  // lo salva, y un número grande se leería como una meta alcanzable.
  const c = contribucionUnitaria({ precio: 500, costo: 400, comision_pct: 15, envio_unitario: 100 });
  assert.ok(c.contribucion < 0);
  assert.strictEqual(c.roas_breakeven, null);
});

test('la comisión sale de lo que MELI cobró, no de un porcentaje supuesto', async () => {
  const eco = await cargarEconomia(fakeSupabase({
    ventas: [
      // 12% efectivo, bien lejos del 15% que se usaba antes.
      { id: 'V1', sku: 'ABC', cantidad: 1, total: 1000, comision: 120, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V2', sku: 'ABC', cantidad: 1, total: 1000, comision: 120, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V3', sku: 'ABC', cantidad: 1, total: 1000, comision: 120, canal: 'meli', estado: 'pagada', fecha: hoy },
    ],
    envios: [],
  }), { envio: 0 });

  const e = deSku(eco, 'ABC');
  assert.strictEqual(e.comision_pct, 12);
  assert.strictEqual(e.fuente, 'sku');
  assert.strictEqual(e.ventas_muestra, 3);
});

test('un envío que cubre un carrito se reparte entre sus ventas, no se cobra dos veces', async () => {
  const eco = await cargarEconomia(fakeSupabase({
    ventas: [
      { id: 'V1', sku: 'AAA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy, pack_id: 'P1' },
      { id: 'V2', sku: 'BBB', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy, pack_id: 'P1' },
    ],
    // Un solo paquete de 200 para las dos ventas.
    envios: [{ id: 'E1', venta_id: null, pack_id: 'P1', costo: 200 }],
  }), { envio: 0 });

  // 200 repartidos entre 2 unidades = 100 por venta, no 200 a cada una.
  assert.strictEqual(eco.global.envio_unitario, 100);
  assert.strictEqual(deSku(eco, 'AAA').envio_unitario, 100);
});

test('un envío propio sin costo se completa con el promedio; Mercado Envíos en 0 no', async () => {
  const tablas = {
    ventas: [
      { id: 'V1', sku: 'AAA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V2', sku: 'AAA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V3', sku: 'AAA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V4', sku: 'AAA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
    ],
    envios: [
      { id: 'E1', venta_id: 'V1', costo: 200, transportista: 'enviosuy' },
      { id: 'E2', venta_id: 'V2', costo: 200, transportista: 'gestionpost' },
      // Flex despachado y todavía sin costo cargado: es un dato que falta.
      { id: 'E3', venta_id: 'V3', costo: 0, transportista: 'enviosuy' },
      // Mercado Envíos: el 0 es real. Lo que MELI cobra ya está en la comisión (total − neto
      // recibido), y con las ventas reales su comisión es igual a la de Flex. Antes se
      // completaba con el promedio y le sumaba ~$200 inexistentes a la mitad de las ventas.
      { id: 'E4', venta_id: 'V4', costo: 0, transportista: 'mercado_envios' },
    ],
  };

  const auto = await cargarEconomia(fakeSupabase(tablas), {});
  assert.strictEqual(auto.envios.promedio_real, 200);
  assert.strictEqual(auto.envios.sin_costo, 1, 'sólo el propio cuenta como faltante');
  assert.strictEqual(auto.envios.mercado_envios, 1);
  assert.strictEqual(auto.envios.estimados, 1);
  // 200 + 200 + 200 (estimado) + 0 (Mercado Envíos) sobre 4 unidades.
  assert.strictEqual(auto.global.envio_unitario, 150);

  // Con envio: 0 no se completa nada.
  const crudo = await cargarEconomia(fakeSupabase(tablas), { envio: 0 });
  assert.strictEqual(crudo.envios.fallback_usado, 0);
  assert.strictEqual(crudo.global.envio_unitario, 100);
});

test('un SKU con una sola venta usa su comisión pero el envío del promedio', async () => {
  const eco = await cargarEconomia(fakeSupabase({
    ventas: [
      { id: 'V1', sku: 'POCA', cantidad: 1, total: 1000, comision: 130, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V2', sku: 'MUCHA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V3', sku: 'MUCHA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V4', sku: 'MUCHA', cantidad: 1, total: 1000, comision: 150, canal: 'meli', estado: 'pagada', fecha: hoy },
    ],
    envios: [{ id: 'E1', venta_id: 'V1', costo: 900 }],
  }), {});

  // Un envío carísimo en la única venta del SKU no puede definir su envío promedio.
  const poca = deSku(eco, 'POCA');
  assert.strictEqual(poca.fuente, 'mixto');
  assert.strictEqual(poca.comision_pct, 13);
  assert.strictEqual(poca.envio_unitario, eco.global.envio_unitario);
});

test('un SKU sin ventas hereda el promedio del negocio, y sin ventas en absoluto, el 15%', async () => {
  const conHistoria = await cargarEconomia(fakeSupabase({
    ventas: [
      { id: 'V1', sku: 'OTRO', cantidad: 1, total: 1000, comision: 140, canal: 'meli', estado: 'pagada', fecha: hoy },
    ],
    envios: [],
  }), { envio: 0 });
  const nuevo = deSku(conHistoria, 'RECIEN-CREADO');
  assert.strictEqual(nuevo.fuente, 'global');
  assert.strictEqual(nuevo.comision_pct, 14);

  const vacia = await cargarEconomia(fakeSupabase({ ventas: [], envios: [] }), {});
  const sinNada = deSku(vacia, 'LO-QUE-SEA');
  assert.strictEqual(sinNada.fuente, 'default');
  assert.strictEqual(sinNada.comision_pct, COMISION_DEFAULT);
});

test('las ventas canceladas y las de otros canales no entran en la cuenta', async () => {
  const eco = await cargarEconomia(fakeSupabase({
    ventas: [
      { id: 'V1', sku: 'AAA', cantidad: 1, total: 1000, comision: 100, canal: 'meli', estado: 'pagada', fecha: hoy },
      { id: 'V2', sku: 'AAA', cantidad: 1, total: 1000, comision: 900, canal: 'meli', estado: 'cancelada', fecha: hoy },
      // Mostrador no paga comisión de MELI: mezclarlo bajaría la comisión efectiva.
      { id: 'V3', sku: 'AAA', cantidad: 1, total: 1000, comision: 0, canal: 'mostrador', estado: 'pagada', fecha: hoy },
    ],
    envios: [],
  }), { envio: 0 });

  assert.strictEqual(eco.global.ventas, 1);
  assert.strictEqual(eco.global.comision_pct, 10);
});

// ── Reparto de un anuncio entre las variantes que lo comparten ───────────────────────────
// MELI agrupa todas las variantes de una publicación en un solo ad group (el "5 variantes"
// del panel) y no abre las métricas por variante: los endpoints por anuncio quedaron
// deprecados. Cuando esas variantes son SKU distintos del CRM, atribuirle el total a cada
// uno multiplica el gasto por la cantidad de colores: tres manillares mostraban $1.002 cada
// uno de un anuncio que gastó $1.002.
const { sumarGrupos } = require('../api/meli/ads-recomendaciones');

const grupoManillar = {
  id: '7068115768680593',
  metrics: { prints: 23265, clicks: 238, cost: 1002, total_amount: 9419, units_quantity: 9 },
};

test('un anuncio propio se cuenta entero', () => {
  const t = sumarGrupos([grupoManillar]);
  assert.strictEqual(t.inversion, 1002);
  assert.strictEqual(t.clics, 238);
  assert.strictEqual(t.unidades, 9);
});

test('un anuncio compartido por tres variantes aporta un tercio a cada una', () => {
  const unTercio = () => 1 / 3;
  const t = sumarGrupos([grupoManillar], unTercio);
  assert.strictEqual(t.inversion, 334);
  assert.strictEqual(t.clics, 79);          // 238/3 = 79,33 → se cierra redondeando
  assert.strictEqual(t.unidades, 3);
  // Lo importante: tres productos sumados dan el anuncio, no el triple.
  assert.strictEqual(t.inversion * 3, 1002);
});

test('el ROAS no se deforma al repartir: es un cociente, no un total', () => {
  const entero = sumarGrupos([grupoManillar]);
  const parte = sumarGrupos([grupoManillar], () => 1 / 3);
  const roas = t => Math.round((t.facturacion / t.inversion) * 100) / 100;
  assert.strictEqual(roas(entero), roas(parte));
});

test('las unidades fraccionadas se guardan exactas para no perderse al sumar fuentes', () => {
  // Media unidad de la API más media del snapshot tienen que dar una, no cero.
  const t = sumarGrupos([grupoManillar], () => 1 / 2);
  assert.strictEqual(t.unidades_exactas, 4.5);
  assert.strictEqual(t.unidades, 5);
});
