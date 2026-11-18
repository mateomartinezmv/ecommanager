// Kits: par de espejos alerón + protectores de levas, par de espejos + porta matrícula.
//
// Lo que no puede fallar en silencio:
//   · el stock de un kit es el de la pieza que menos tiene (y nunca se carga a mano);
//   · vender un kit descuenta las piezas, y vuelve a publicar en MELI las piezas sueltas y el
//     otro kit que comparte el espejo (MELI sólo bajó la publicación que vendió);
//   · vender el espejo suelto baja los dos kits en MELI;
//   · devolver un kit devuelve las piezas;
//   · en el despacho y en la reposición, un kit cuenta como sus piezas.
//
// La base es un Supabase falso en memoria que imita lo que hacen la función descontar_stock y
// los triggers de la migración 20261117000000_add_kits.sql.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// Tokens falsos antes de cargar _stockSync (los toma al cargarse).
require('../api/_meliToken').getMeliToken = async () => 'token-falso';
require('../api/_shopifyToken').getShopifyToken = async () => { throw new Error('sin Shopify en el test'); };

const { stockKit, normalizarPiezas } = require('../api/_kits');
const { descontarStock, sincronizarStock } = require('../api/_stockSync');
const { abrirKits } = require('../api/restock');

// ── MELI falso: registra cada PUT de stock ───────────────────────────────────
let putsMeli;
global.fetch = async (url, opciones = {}) => {
  const m = String(url).match(/\/items\/(MLU\d+)$/);
  if (m && opciones.method === 'PUT') {
    putsMeli[m[1]] = JSON.parse(opciones.body).available_quantity;
    return { json: async () => ({ id: m[1] }) };
  }
  throw new Error(`fetch inesperado: ${url}`);
};

// ── Supabase falso ───────────────────────────────────────────────────────────
function supabaseFalso({ productos, piezas }) {
  const prods = Object.fromEntries(productos.map(p => [p.sku, { unidades_por_venta: 1, meli_ids: [], ...p }]));
  const recetas = piezas.map(r => ({ ...r }));

  const esKit = sku => recetas.some(r => r.kit_sku === sku);
  const stockDeKit = sku => {
    const rs = recetas.filter(r => r.kit_sku === sku);
    return rs.length ? Math.min(...rs.map(r => Math.floor(prods[r.componente_sku].stock_dep / r.cantidad))) : 0;
  };
  // Lo que hacen los triggers: el kit nunca guarda un número propio, y cada pieza que se
  // mueve recalcula los kits que la usan.
  const recalcularKits = () => {
    for (const sku of Object.keys(prods)) {
      if (!esKit(sku)) continue;
      const p = prods[sku];
      p.stock_dep = p.stock_meli = p.stock_shopify = stockDeKit(sku);
    }
  };
  recalcularKits();

  function consulta(tabla) {
    const filtros = [];
    let cambios = null;
    const filas = () => (tabla === 'productos' ? Object.values(prods) : recetas)
      .filter(f => filtros.every(fn => fn(f)));
    const q = {
      select() { return q; },
      eq(col, val) { filtros.push(f => f[col] === val); return q; },
      in(col, vals) { filtros.push(f => vals.includes(f[col])); return q; },
      update(fila) { cambios = fila; return q; },
      then(ok, mal) {
        if (cambios) {
          for (const f of filas()) Object.assign(f, cambios);
          recalcularKits();
          return Promise.resolve({ data: null, error: null }).then(ok, mal);
        }
        return Promise.resolve({ data: filas().map(f => ({ ...f })), error: null }).then(ok, mal);
      },
    };
    return q;
  }

  return {
    prods,
    from: consulta,
    async rpc(nombre, { p_sku, p_unidades }) {
      assert.strictEqual(nombre, 'descontar_stock');
      const p = prods[p_sku];
      if (!p) return { data: null, error: null };
      if (esKit(p_sku)) {
        for (const r of recetas.filter(x => x.kit_sku === p_sku)) {
          const c = prods[r.componente_sku];
          c.stock_dep = Math.max(0, c.stock_dep - p_unidades * r.cantidad);
        }
      } else {
        p.stock_dep = Math.max(0, p.stock_dep - p_unidades);
      }
      recalcularKits();
      return { data: prods[p_sku].stock_dep, error: null };
    },
  };
}

// El stock de hoy (17/11/2026).
function escenario() {
  return supabaseFalso({
    productos: [
      { sku: 'HSJ-20121', stock_dep: 10, meli_ids: ['MLU100'] },
      { sku: 'HP-Q035B1', stock_dep: 9, meli_ids: ['MLU200'] },
      { sku: 'CPJ-62001', stock_dep: 19, meli_ids: ['MLU300'] },
      { sku: 'KIT-ESP-LEVAS', stock_dep: 0, meli_ids: ['MLU900'] },
      { sku: 'KIT-ESP-MATRICULA', stock_dep: 0, meli_ids: ['MLU901'] },
    ],
    piezas: [
      { kit_sku: 'KIT-ESP-LEVAS', componente_sku: 'HSJ-20121', cantidad: 1 },
      { kit_sku: 'KIT-ESP-LEVAS', componente_sku: 'HP-Q035B1', cantidad: 1 },
      { kit_sku: 'KIT-ESP-MATRICULA', componente_sku: 'HSJ-20121', cantidad: 1 },
      { kit_sku: 'KIT-ESP-MATRICULA', componente_sku: 'CPJ-62001', cantidad: 1 },
    ],
  });
}

beforeEach(() => { putsMeli = {}; });

test('el stock del kit es el de la pieza que menos tiene', () => {
  assert.strictEqual(stockKit([{ cantidad: 1, stock_dep: 10 }, { cantidad: 1, stock_dep: 9 }]), 9);
  assert.strictEqual(stockKit([{ cantidad: 2, stock_dep: 5 }, { cantidad: 1, stock_dep: 9 }]), 2);
  assert.strictEqual(stockKit([{ cantidad: 1, stock_dep: 0 }, { cantidad: 1, stock_dep: 9 }]), 0);
  assert.strictEqual(stockKit([]), 0);

  const db = escenario();
  assert.strictEqual(db.prods['KIT-ESP-LEVAS'].stock_dep, 9);
  assert.strictEqual(db.prods['KIT-ESP-MATRICULA'].stock_dep, 10);
});

test('vender un kit descuenta las piezas y republica piezas y el otro kit', async () => {
  const db = escenario();
  const r = await descontarStock(db, { ...db.prods['KIT-ESP-LEVAS'] }, 1);

  assert.strictEqual(db.prods['HSJ-20121'].stock_dep, 9);
  assert.strictEqual(db.prods['HP-Q035B1'].stock_dep, 8);
  assert.strictEqual(db.prods['CPJ-62001'].stock_dep, 19, 'el porta matrícula no se toca');
  assert.strictEqual(r.stockPublicado, 8);
  assert.strictEqual(r.error, null);

  assert.deepStrictEqual(putsMeli, {
    MLU900: 8,   // el kit vendido
    MLU100: 9,   // el espejo suelto
    MLU200: 8,   // las levas sueltas
    MLU901: 9,   // el otro kit, que comparte el espejo
  });
});

test('vender el espejo suelto baja los dos kits en MELI', async () => {
  const db = escenario();
  // Quedan 9 levas: con 9 espejos el kit de levas sigue en 9, el de matrícula baja a 9.
  await descontarStock(db, { ...db.prods['HSJ-20121'] }, 1);
  assert.deepStrictEqual(putsMeli, { MLU100: 9, MLU900: 9, MLU901: 9 });

  putsMeli = {};
  await descontarStock(db, { ...db.prods['HSJ-20121'] }, 4);
  assert.deepStrictEqual(putsMeli, { MLU100: 5, MLU900: 5, MLU901: 5 });
});

test('sin espejos, los dos kits quedan en cero aunque sobren levas y matrículas', async () => {
  const db = escenario();
  await descontarStock(db, { ...db.prods['HSJ-20121'] }, 10);
  assert.strictEqual(db.prods['KIT-ESP-LEVAS'].stock_dep, 0);
  assert.strictEqual(db.prods['KIT-ESP-MATRICULA'].stock_dep, 0);
  assert.strictEqual(putsMeli.MLU900, 0);
  assert.strictEqual(putsMeli.MLU901, 0);
});

test('devolver un kit devuelve una unidad de cada pieza', async () => {
  const db = escenario();
  await descontarStock(db, { ...db.prods['KIT-ESP-MATRICULA'] }, 2);
  assert.strictEqual(db.prods['HSJ-20121'].stock_dep, 8);
  assert.strictEqual(db.prods['CPJ-62001'].stock_dep, 17);

  // Así llama devoluciones.js: el stock que tenía + lo que vuelve.
  putsMeli = {};
  const kit = { ...db.prods['KIT-ESP-MATRICULA'] };
  const r = await sincronizarStock(db, kit, kit.stock_dep + 1);
  assert.strictEqual(db.prods['HSJ-20121'].stock_dep, 9);
  assert.strictEqual(db.prods['CPJ-62001'].stock_dep, 18);
  assert.strictEqual(r.stockPublicado, 9);
  assert.strictEqual(putsMeli.MLU901, 9);
  assert.strictEqual(putsMeli.MLU900, 9, 'el kit de levas también vuelve a tener espejo');
});

test('guardar un kit sin cambiar su número no mueve las piezas', async () => {
  const db = escenario();
  const kit = { ...db.prods['KIT-ESP-LEVAS'] };
  await sincronizarStock(db, kit, kit.stock_dep);
  assert.strictEqual(db.prods['HSJ-20121'].stock_dep, 10);
  assert.strictEqual(db.prods['HP-Q035B1'].stock_dep, 9);
  assert.strictEqual(putsMeli.MLU900, 9);
});

test('un producto común sin kits se mueve como siempre', async () => {
  const db = escenario();
  db.prods.SUELTO = { sku: 'SUELTO', stock_dep: 5, unidades_por_venta: 1, meli_ids: ['MLU555'] };
  const r = await descontarStock(db, { ...db.prods.SUELTO }, 2);
  assert.strictEqual(r.stockPublicado, 3);
  assert.deepStrictEqual(putsMeli, { MLU555: 3 });
  assert.deepStrictEqual(r.kits, []);
});

test('si la tabla de kits no existe, el stock funciona igual', async () => {
  const db = escenario();
  const desde = db.from;
  db.from = tabla => {
    if (tabla === 'kit_componentes') {
      return { select: () => ({ eq: async () => ({ data: null, error: { code: '42P01', message: 'relation "kit_componentes" does not exist' } }) }) };
    }
    return desde(tabla);
  };
  const r = await descontarStock(db, { ...db.prods['CPJ-62001'] }, 1);
  assert.strictEqual(r.stockPublicado, 18);
  assert.deepStrictEqual(putsMeli, { MLU300: 18 });
});

test('las piezas del formulario se normalizan', () => {
  assert.deepStrictEqual(
    normalizarPiezas('KIT-1', [{ sku: ' HSJ-20121 ', cantidad: 1 }, { sku: 'HSJ-20121', cantidad: 1 }, { sku: 'KIT-1' }, { sku: '' }, { sku: 'CPJ-62001', cantidad: 0 }]),
    [{ sku: 'HSJ-20121', cantidad: 2 }, { sku: 'CPJ-62001', cantidad: 1 }]
  );
});

test('en la reposición, una venta de kit es demanda de cada pieza', () => {
  const piezasPorKit = { 'KIT-ESP-LEVAS': [{ sku: 'HSJ-20121', cantidad: 1 }, { sku: 'HP-Q035B1', cantidad: 1 }] };
  const lineas = abrirKits([
    { sku: 'KIT-ESP-LEVAS', cantidad: 3, fecha: '2026-11-10' },
    { sku: 'HSJ-20121', cantidad: 1, fecha: '2026-11-11' },
  ], piezasPorKit);
  assert.deepStrictEqual(lineas, [
    { sku: 'HSJ-20121', cantidad: 3, fecha: '2026-11-10', uds: 3 },
    { sku: 'HP-Q035B1', cantidad: 3, fecha: '2026-11-10', uds: 3 },
    { sku: 'HSJ-20121', cantidad: 1, fecha: '2026-11-11', uds: null },
  ]);
});
