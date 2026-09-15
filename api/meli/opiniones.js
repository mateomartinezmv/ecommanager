// api/meli/opiniones.js
// GET    /api/meli/opiniones              → lee lo cacheado en meli_opiniones (rápido, no pega a MELI)
// POST   /api/meli/opiniones { offset }   → refresca un tramo desde MELI y devuelve el offset siguiente
// PUT    /api/meli/opiniones?meli_id=MLUx { republicada: bool } → marca/desmarca "ya republicada"
//
// Las estrellas de una publicación salen de GET /reviews/item/{item_id} (campo rating_average).
// Eso es una llamada por publicación: pedirlas en vivo cada vez que se abre la pantalla sería
// lento y gastaría rate limit al pedo, así que el refresco se hace a pedido y el resultado
// queda cacheado en meli_opiniones. La pantalla siempre lee la caché.
//
// El refresco es incremental: procesa publicaciones hasta gastar su presupuesto de tiempo y
// devuelve `siguiente_offset` para que el cliente siga desde ahí. Así no importa cuántas
// publicaciones haya, nunca se corta por timeout de la función.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');

const API = 'https://api.mercadolibre.com';

// Publicación "a republicar": con opiniones y promedio igual o menor a esto.
const UMBRAL_REPUBLICAR = 3.9;

const LOTE = 20;            // multiget de MELI: máximo 20 ids por llamada
const CONCURRENCIA = 5;     // reviews en paralelo, sin pasarse de rosca con el rate limit
const PRESUPUESTO_MS = 45000; // la función tiene 60s; se corta antes y sigue en el próximo request

async function meliGet(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`MELI ${path}: ${data.message || res.statusText}`);
  return data;
}

// Opiniones de una publicación. Una publicación sin opiniones no es una publicación mal
// calificada: en ese caso rating queda en null y no entra en la lista de republicar.
async function opinionesDeItem(token, item) {
  const qs = item.catalog_product_id ? `?catalog_product_id=${item.catalog_product_id}` : '';
  const res = await fetch(`${API}/reviews/item/${item.id}${qs}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // 404 = la publicación todavía no tiene opiniones. No es un error.
  if (res.status === 404) return { rating: null, total: 0, niveles: {} };
  if (!res.ok) throw new Error(`reviews/item/${item.id}: HTTP ${res.status}`);

  const data = await res.json().catch(() => ({}));
  const niveles = data.rating_levels || {};
  const totalNiveles = ['one_star', 'two_star', 'three_star', 'four_star', 'five_star']
    .reduce((s, k) => s + (Number(niveles[k]) || 0), 0);
  const total = totalNiveles || Number(data.paging?.total) || 0;
  const promedio = Number(data.rating_average);

  return {
    rating: total > 0 && promedio > 0 ? Math.round(promedio * 100) / 100 : null,
    total,
    niveles,
  };
}

// Corre `fn` sobre todos los items con concurrencia acotada.
async function enParalelo(items, limite, fn) {
  const salida = [];
  for (let i = 0; i < items.length; i += limite) {
    const tanda = items.slice(i, i + limite);
    salida.push(...await Promise.all(tanda.map(fn)));
  }
  return salida;
}

// SKU dueño de cada publicación, para poder mostrar el producto del CRM al lado de la
// publicación floja. Son pocas filas: se arma el mapa completo de una.
async function mapaSkuPorMeliId(supabase) {
  const { data } = await supabase.from('productos').select('sku, meli_id, meli_ids');
  const mapa = {};
  for (const p of data || []) {
    for (const id of meliIdsDe(p)) mapa[id] = p.sku;
  }
  return mapa;
}

function faltaTabla(error) {
  return error && (error.code === '42P01' || /meli_opiniones/.test(error.message || '') && /does not exist|no existe/i.test(error.message || ''));
}

const ERROR_TABLA = 'Falta la tabla meli_opiniones. Corré la migración supabase/migrations/20260915000000_add_meli_opiniones.sql en el SQL Editor de Supabase.';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    // ── Leer la caché ───────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('meli_opiniones')
        .select('*')
        .order('rating', { ascending: true, nullsFirst: false });

      if (error) {
        if (faltaTabla(error)) return res.json({ ok: false, error: ERROR_TABLA, umbral: UMBRAL_REPUBLICAR, publicaciones: [] });
        throw error;
      }

      const aRepublicar = (data || []).filter(o => o.rating !== null && Number(o.rating) <= UMBRAL_REPUBLICAR && !o.republicada_at);
      const actualizado = (data || []).reduce((max, o) => (o.fetched_at > max ? o.fetched_at : max), '');

      return res.json({
        ok: true,
        umbral: UMBRAL_REPUBLICAR,
        total: (data || []).length,
        a_republicar: aRepublicar.length,
        actualizado_at: actualizado || null,
        publicaciones: data || [],
      });
    }

    // ── Marcar / desmarcar como ya republicada ──────────────────
    if (req.method === 'PUT') {
      const meliId = String(req.query.meli_id || '').trim();
      if (!meliId) return res.status(400).json({ ok: false, error: 'Falta meli_id' });

      const republicada = req.body?.republicada !== false;
      const { data, error } = await supabase
        .from('meli_opiniones')
        .update({ republicada_at: republicada ? new Date().toISOString() : null })
        .eq('meli_id', meliId)
        .select()
        .single();

      if (error) {
        if (faltaTabla(error)) return res.status(400).json({ ok: false, error: ERROR_TABLA });
        throw error;
      }
      return res.json({ ok: true, publicacion: data });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    // ── Refrescar desde MELI ────────────────────────────────────
    const arranque = Date.now();
    const offsetInicial = Math.max(0, parseInt(req.body?.offset ?? req.query.offset ?? '0', 10) || 0);

    let token;
    try {
      token = await getMeliToken();
    } catch {
      return res.json({ ok: false, error: 'MELI no está conectado. Autorizá la app primero.' });
    }

    const me = await meliGet(token, '/users/me');
    const skuPorMeliId = await mapaSkuPorMeliId(supabase);

    let offset = offsetInicial;
    let totalPublicaciones = 0;
    let procesadas = 0;
    const errores = [];

    while (true) {
      // Sólo publicaciones activas: son las que tiene sentido republicar.
      const busqueda = await meliGet(
        token,
        `/users/${me.id}/items/search?status=active&limit=${LOTE}&offset=${offset}`
      );
      totalPublicaciones = Number(busqueda.paging?.total) || 0;
      const ids = busqueda.results || [];
      if (!ids.length) { offset = null; break; }

      const detalle = await meliGet(
        token,
        `/items?ids=${ids.join(',')}&attributes=id,title,permalink,status,available_quantity,sold_quantity,catalog_product_id`
      );
      const items = (detalle || []).filter(e => e.code === 200 && e.body?.id).map(e => e.body);

      const filas = await enParalelo(items, CONCURRENCIA, async (item) => {
        try {
          const op = await opinionesDeItem(token, item);
          return {
            meli_id: item.id,
            titulo: item.title || null,
            permalink: item.permalink || null,
            estado: item.status || null,
            sku: skuPorMeliId[item.id] || null,
            stock: Number(item.available_quantity) || 0,
            vendidos: Number(item.sold_quantity) || 0,
            rating: op.rating,
            total_opiniones: op.total,
            una_estrella: Number(op.niveles.one_star) || 0,
            dos_estrellas: Number(op.niveles.two_star) || 0,
            tres_estrellas: Number(op.niveles.three_star) || 0,
            cuatro_estrellas: Number(op.niveles.four_star) || 0,
            cinco_estrellas: Number(op.niveles.five_star) || 0,
            fetched_at: new Date().toISOString(),
          };
        } catch (err) {
          errores.push({ meli_id: item.id, error: err.message });
          return null;
        }
      });

      const aGuardar = filas.filter(Boolean);
      if (aGuardar.length) {
        // republicada_at no va en el payload a propósito: el upsert no debe pisar la marca
        // manual del vendedor cada vez que se refrescan las estrellas.
        const { error } = await supabase
          .from('meli_opiniones')
          .upsert(aGuardar, { onConflict: 'meli_id' });
        if (error) {
          if (faltaTabla(error)) return res.status(400).json({ ok: false, error: ERROR_TABLA });
          throw error;
        }
        procesadas += aGuardar.length;
      }

      offset += ids.length;
      if (offset >= totalPublicaciones) { offset = null; break; }
      if (Date.now() - arranque > PRESUPUESTO_MS) break; // sigue el próximo request desde este offset
    }

    return res.json({
      ok: true,
      umbral: UMBRAL_REPUBLICAR,
      total_publicaciones: totalPublicaciones,
      procesadas,
      desde_offset: offsetInicial,
      siguiente_offset: offset,   // null = terminó
      errores: errores.length,
      fallos: errores.slice(0, 10),
    });
  } catch (err) {
    console.error('Error en /api/meli/opiniones:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
