// api/meli/stock.js
// GET  /api/meli/stock            → compara el stock del CRM contra CADA publicación en MELI
// POST /api/meli/stock            → empuja stock_dep a las publicaciones desincronizadas
// POST /api/meli/stock { sku }    → sólo las de ese producto
// POST /api/meli/stock { todas:true } → empuja a todas, estén o no desincronizadas
//
// Un SKU puede tener varias publicaciones y todas venden del mismo depósito, así que todas
// tienen que mostrar el mismo stock. El CRM ya las conoce (productos.meli_ids) y las
// sincroniza cuando cambia el stock o entra una venta, pero eso sólo corre en el momento:
// una publicación creada aparte, un PUT que falló o un cambio hecho desde MELI dejan
// diferencias que nadie vuelve a mirar. Esto las mide contra la API y las corrige.
//
// De paso detecta el agujero que sí rompe las ventas: publicaciones activas del vendedor que
// no están enlazadas a ningún SKU. Las órdenes que entren por ahí no descuentan stock —
// notify.js avisa por Telegram, pero es mejor enlazarlas antes de que pase.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet } = require('../_meliPublicaciones');
const { syncMeliStock } = require('../_stockSync');

const LOTE = 20;                 // multiget de MELI
const ESTADOS_SINCRONIZABLES = new Set(['active', 'paused']);

// Estado de cada publicación: cuánto stock tiene publicado y en qué estado está.
async function traerPublicaciones(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    try {
      const data = await meliGet(
        token,
        `/items?ids=${lote.join(',')}&attributes=id,title,status,sub_status,available_quantity,permalink,user_product_id`
      );
      for (const entrada of data || []) {
        if (entrada.code === 200 && entrada.body?.id) {
          const it = entrada.body;
          mapa[it.id] = {
            meli_id: it.id,
            titulo: it.title || null,
            estado: it.status || null,
            sub_estado: (it.sub_status || [])[0] || null,
            stock_meli: Number.isFinite(it.available_quantity) ? it.available_quantity : null,
            permalink: it.permalink || null,
            user_product_id: it.user_product_id || null,
          };
        }
      }
    } catch (e) {
      console.error('traerPublicaciones:', e.message);
    }
  }
  return mapa;
}

// Publicaciones activas del vendedor, para cruzarlas con lo que el CRM tiene enlazado.
async function idsActivosDelVendedor(token, sellerId) {
  const ids = [];
  let offset = 0;
  while (true) {
    const data = await meliGet(token, `/users/${sellerId}/items/search?status=active&limit=50&offset=${offset}`);
    const pagina = data.results || [];
    ids.push(...pagina);
    offset += pagina.length;
    if (!pagina.length || offset >= (Number(data.paging?.total) || 0)) break;
  }
  return ids;
}

// Arma la foto completa: producto por producto, publicación por publicación.
async function auditar(token, supabase) {
  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, nombre, stock_dep, meli_id, meli_ids, discontinuado')
    .order('nombre');
  if (error) throw error;

  const vivos = (productos || []).filter(p => !p.discontinuado);
  const mapa = await traerPublicaciones(token, vivos.flatMap(meliIdsDe));

  const filas = vivos
    .map(p => {
      const publicaciones = meliIdsDe(p).map(id => {
        const info = mapa[id] || { meli_id: id, titulo: null, estado: 'desconocida', sub_estado: null, stock_meli: null, permalink: null, user_product_id: null };
        const sincronizable = ESTADOS_SINCRONIZABLES.has(info.estado);
        return {
          ...info,
          // Una publicación cerrada o que no se pudo leer no cuenta como desincronizada:
          // no hay nada que arreglarle.
          desincronizada: sincronizable && info.stock_meli !== null && info.stock_meli !== (p.stock_dep || 0),
        };
      });

      return {
        sku: p.sku,
        nombre: p.nombre,
        stock_dep: p.stock_dep || 0,
        publicaciones,
        total: publicaciones.length,
        desincronizadas: publicaciones.filter(x => x.desincronizada).length,
      };
    })
    .filter(f => f.total > 0);

  return filas;
}

// Empuja stock_dep a las publicaciones que lo necesitan. `todas` fuerza también las que ya
// coinciden. No corta ante un fallo: una publicación que MELI no deja tocar no puede dejar a
// las demás desincronizadas.
async function empujar(token, supabase, filas, todas = false) {
  const resultados = [];

  for (const fila of filas) {
    const aEmpujar = fila.publicaciones.filter(p =>
      ESTADOS_SINCRONIZABLES.has(p.estado) && (todas || p.desincronizada));
    if (!aEmpujar.length) continue;

    let alguna = false;
    for (const pub of aEmpujar) {
      try {
        await syncMeliStock(token, pub.meli_id, fila.stock_dep);
        alguna = true;
        resultados.push({ ok: true, sku: fila.sku, meli_id: pub.meli_id, titulo: pub.titulo, antes: pub.stock_meli, ahora: fila.stock_dep });
      } catch (err) {
        resultados.push({ ok: false, sku: fila.sku, meli_id: pub.meli_id, titulo: pub.titulo, antes: pub.stock_meli, error: err.message });
      }
    }

    // El espejo del CRM sólo se mueve si MELI aceptó al menos una: si no, mentiría.
    if (alguna) {
      await supabase.from('productos').update({ stock_meli: fila.stock_dep }).eq('sku', fila.sku);
    }
  }

  return resultados;
}

// Una pasada completa: mide y corrige. La usa el cron.
async function conciliarStock() {
  const token = await getMeliToken();
  const supabase = getSupabase();
  const filas = await auditar(token, supabase);
  const desincronizadas = filas.reduce((s, f) => s + f.desincronizadas, 0);
  const resultados = desincronizadas ? await empujar(token, supabase, filas) : [];
  return {
    productos: filas.length,
    publicaciones: filas.reduce((s, f) => s + f.total, 0),
    desincronizadas,
    sincronizadas: resultados.filter(r => r.ok).length,
    fallidas: resultados.filter(r => !r.ok),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    let token;
    try {
      token = await getMeliToken();
    } catch {
      return res.json({ ok: false, error: 'MELI no está conectado. Autorizá la app primero.', productos: [] });
    }

    // ── Foto del stock publicación por publicación ──────────────
    if (req.method === 'GET') {
      const filas = await auditar(token, supabase);

      // Publicaciones activas que el CRM no conoce: por ahí entran ventas que no se
      // registran ni descuentan stock.
      let sinEnlazar = [];
      try {
        const me = await meliGet(token, '/users/me');
        const activos = await idsActivosDelVendedor(token, me.id);
        const enlazados = new Set(filas.flatMap(f => f.publicaciones.map(p => p.meli_id)));
        const huerfanos = activos.filter(id => !enlazados.has(id));
        const info = await traerPublicaciones(token, huerfanos);
        sinEnlazar = huerfanos.map(id => info[id] || { meli_id: id, titulo: null, estado: 'active', stock_meli: null, permalink: null });
      } catch (e) {
        console.error('sinEnlazar:', e.message);
      }

      const desincronizadas = filas.reduce((s, f) => s + f.desincronizadas, 0);
      return res.json({
        ok: true,
        productos: filas,
        sin_enlazar: sinEnlazar,
        resumen: {
          productos: filas.length,
          publicaciones: filas.reduce((s, f) => s + f.total, 0),
          desincronizadas,
          productos_afectados: filas.filter(f => f.desincronizadas > 0).length,
          sin_enlazar: sinEnlazar.length,
        },
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    // ── Empujar stock_dep a las publicaciones ───────────────────
    const skuFiltro = String(req.body?.sku || '').trim();
    const filas = (await auditar(token, supabase)).filter(f => !skuFiltro || f.sku === skuFiltro);
    if (skuFiltro && !filas.length) {
      return res.status(404).json({ ok: false, error: `El producto ${skuFiltro} no tiene publicaciones enlazadas.` });
    }

    const resultados = await empujar(token, supabase, filas, req.body?.todas === true);
    return res.json({
      ok: true,
      sincronizadas: resultados.filter(r => r.ok).length,
      fallidas: resultados.filter(r => !r.ok).length,
      resultados,
    });
  } catch (err) {
    console.error('Error en /api/meli/stock:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.conciliarStock = conciliarStock;
