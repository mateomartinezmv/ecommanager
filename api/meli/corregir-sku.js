// api/meli/corregir-sku.js
// GET  /api/meli/corregir-sku           → publicaciones cuyo SKU en MELI no coincide con el del CRM
// POST /api/meli/corregir-sku { meliId, sku?, titulo? }  → corrige esa publicación
// POST /api/meli/corregir-sku { todos: true }            → corrige todas las desalineadas
//
// Una publicación de MELI lleva el SKU del CRM en dos lados: el campo
// `seller_custom_field` y el atributo `SELLER_SKU`. Los dos se ven en el panel
// y los dos los lee "Importar desde MELI". Cuando no coinciden con el SKU del
// CRM nada se rompe —el vínculo que cuenta para stock y ventas es
// productos.meli_ids—, pero el que mira la publicación ve un SKU que no existe,
// y una reimportación puede crear un producto fantasma.
//
// El título se corrige por el mismo camino porque sale del mismo PUT. Es
// opcional y sólo se toca si se manda.
//
// Cuidado con el modelo de la cuenta: en User Products el título visible lo
// arma MELI a partir de `family_name` más los atributos de la variante, y
// mandar `title` ahí es error. Se detecta por la propia publicación y, si MELI
// se queja igual, se reintenta con el otro campo (mismo criterio que
// _meliPublicaciones.js).

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliFetch, meliGet, mensajeDeError, limpiarTitulo } = require('../_meliPublicaciones');

const LOTE = 20;

// Lo que la publicación dice que es su SKU, mire donde mire.
function skuDePublicacion(item) {
  const atributo = (item?.attributes || []).find(a => a.id === 'SELLER_SKU');
  return item?.seller_custom_field || atributo?.value_name || null;
}

// Estado de todas las publicaciones enlazadas, con su SKU y su título.
async function publicacionesDe(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    const data = await meliGet(
      token,
      `/items?ids=${lote.join(',')}&attributes=id,title,family_name,status,permalink,seller_custom_field,attributes`
    );
    for (const entrada of data || []) {
      if (entrada.code === 200 && entrada.body?.id) {
        const it = entrada.body;
        mapa[it.id] = {
          meli_id: it.id,
          titulo: it.title || null,
          family_name: it.family_name || null,
          estado: it.status || null,
          permalink: it.permalink || null,
          sku_en_meli: skuDePublicacion(it),
        };
      }
    }
  }
  return mapa;
}

// Publicaciones enlazadas en el CRM cuyo SKU en MELI no es el del producto.
async function desalineadas(supabase, token) {
  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, nombre, meli_id, meli_ids, discontinuado')
    .order('sku');
  if (error) throw error;

  const vivos = (productos || []).filter(p => !p.discontinuado);
  const mapa = await publicacionesDe(token, vivos.flatMap(meliIdsDe));

  const filas = [];
  for (const p of vivos) {
    for (const meliId of meliIdsDe(p)) {
      const pub = mapa[meliId];
      if (!pub) continue;
      if (pub.sku_en_meli === p.sku) continue;
      filas.push({
        sku: p.sku,
        nombre: p.nombre,
        meli_id: meliId,
        sku_en_meli: pub.sku_en_meli,
        titulo: pub.titulo,
        estado: pub.estado,
        permalink: pub.permalink,
        principal: p.meli_id === meliId,
      });
    }
  }
  return filas;
}

// ¿En qué campo viaja el título de esta publicación?
function modoTitulo(item) {
  return item?.family_name ? 'family_name' : 'title';
}

// MELI avisa qué campo le falta al cuerpo; con eso se reintenta en el otro modelo.
function modoQuePide(data) {
  const texto = JSON.stringify(data || {});
  if (/family_name/.test(texto)) return 'family_name';
  if (/\btitle\b/.test(texto) && /required|does not contain|missing/i.test(texto)) return 'title';
  return null;
}

// Corrige una publicación. `sku` y `titulo` son opcionales: lo que no venga, no
// se toca. Devuelve qué quedó cambiado.
async function corregir(token, meliId, { sku, titulo } = {}) {
  const item = await meliGet(token, `/items/${meliId}?attributes=id,title,family_name,seller_custom_field,attributes`);

  const cambios = {};
  const antes = { sku: skuDePublicacion(item), titulo: item.title };

  if (sku) {
    // Los dos lugares a la vez: si se corrige uno solo, el panel sigue
    // mostrando el viejo según por dónde se lo mire.
    cambios.seller_custom_field = String(sku);
    cambios.attributes = [{ id: 'SELLER_SKU', value_name: String(sku) }];
  }

  let modo = titulo ? modoTitulo(item) : null;
  if (titulo) cambios[modo] = limpiarTitulo(titulo);

  if (!Object.keys(cambios).length) {
    return { meli_id: meliId, cambiado: false, motivo: 'No se mandó ni sku ni titulo' };
  }

  let intento = await meliFetch(token, `/items/${meliId}`, {
    method: 'PUT',
    body: JSON.stringify(cambios),
  });

  // Título en el otro campo: se reintenta una vez con el que MELI pide.
  if (!intento.ok && titulo) {
    const pide = modoQuePide(intento.data);
    if (pide && pide !== modo) {
      delete cambios[modo];
      modo = pide;
      cambios[modo] = limpiarTitulo(titulo);
      intento = await meliFetch(token, `/items/${meliId}`, {
        method: 'PUT',
        body: JSON.stringify(cambios),
      });
    }
  }

  if (!intento.ok) throw new Error(mensajeDeError(intento.data, intento.status));

  return {
    meli_id: meliId,
    cambiado: true,
    antes,
    ahora: { sku: sku || antes.sku, titulo: titulo ? limpiarTitulo(titulo) : antes.titulo },
    campo_titulo: titulo ? modo : null,
    permalink: intento.data?.permalink || null,
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
      return res.json({ ok: false, error: 'MELI no está conectado. Autorizá la app primero.', publicaciones: [] });
    }

    // ── Qué está desalineado ───────────────────────────────────
    if (req.method === 'GET') {
      const filas = await desalineadas(supabase, token);
      return res.json({ ok: true, total: filas.length, publicaciones: filas });
    }

    if (req.method === 'POST') {
      const { meliId, sku, titulo, todos } = req.body || {};

      // ── Corregir todas las desalineadas de una ───────────────
      if (todos === true) {
        const filas = await desalineadas(supabase, token);
        const resultados = [];
        for (const f of filas) {
          try {
            const r = await corregir(token, f.meli_id, { sku: f.sku });
            resultados.push({ ok: true, sku: f.sku, ...r });
            console.log(`✅ SKU corregido en ${f.meli_id}: ${f.sku_en_meli} → ${f.sku}`);
          } catch (err) {
            resultados.push({ ok: false, sku: f.sku, meli_id: f.meli_id, error: err.message });
            console.error(`❌ ${f.meli_id}: ${err.message}`);
          }
        }
        return res.json({
          ok: true,
          corregidas: resultados.filter(r => r.ok).length,
          errores: resultados.filter(r => !r.ok).length,
          resultados,
        });
      }

      // ── Corregir una ─────────────────────────────────────────
      if (!meliId) return res.status(400).json({ error: 'Falta meliId' });
      if (!sku && !titulo) return res.status(400).json({ error: 'Mandá sku, titulo o los dos' });

      const r = await corregir(token, meliId, { sku, titulo });
      console.log(`✅ ${meliId} corregida:`, JSON.stringify(r.ahora));
      return res.json({ ok: true, ...r });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en corregir-sku:', err);
    return res.status(500).json({ error: err.message });
  }
};
