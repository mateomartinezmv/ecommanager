// api/meli/precios.js
// GET  /api/meli/precios          → compara precio y descuento entre las publicaciones de un SKU
// POST /api/meli/precios { sku }  → empareja: mismo precio y el mismo descuento en todas
// POST /api/meli/precios          → empareja todos los productos desparejos
//
// Los ángulos son publicaciones nuevas y salen con el precio de lista de la original, pero
// sin sus descuentos: la original queda más barata para el comprador y MELI, que agrupa las
// publicaciones parecidas, marca a las otras como "PERDIENDO" contra uno mismo.
//
// Acá la referencia es la publicación principal (meli_ids[0], la original): su precio de
// lista y su descuento individual se copian a las demás.
//
// Qué se puede copiar y qué no:
//   · PRICE_DISCOUNT (descuento individual, lo define el vendedor) → sí, se replica.
//   · DEAL, MARKETPLACE_CAMPAIGN, SMART, PRICE_MATCHING… (campañas de MELI) → no. El ítem
//     tiene que estar invitado; no se puede sumar una publicación a dedo. Se informa para
//     que el vendedor lo resuelva desde MELI.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet, meliFetch, mensajeDeError } = require('../_meliPublicaciones');

const LOTE = 20;
const PROMO_REPLICABLE = 'PRICE_DISCOUNT';
const MAX_DIAS_DESCUENTO = 14;   // tope de MELI para un descuento individual

// Promociones vigentes de una publicación. Si el recurso falla, se devuelve vacío: no saber
// de descuentos no puede romper la comparación de precios.
async function promocionesDeItem(token, itemId) {
  const { ok, data } = await meliFetch(token, `/seller-promotions/items/${itemId}?app_version=v2`);
  if (!ok || !Array.isArray(data)) return [];
  return data.filter(p => p && (p.status === 'started' || p.status === 'pending'));
}

// El descuento que está corriendo: el que baja el precio de verdad.
function descuentoVigente(promos) {
  const activos = (promos || []).filter(p => p.status === 'started' && Number(p.price) > 0 && Number(p.price) < Number(p.original_price || 0));
  if (!activos.length) return null;
  // Si hay varias, manda la más barata: es la que ve el comprador.
  const p = activos.slice().sort((a, b) => a.price - b.price)[0];
  return {
    tipo: p.type,
    precio: Number(p.price),
    precio_lista: Number(p.original_price),
    nombre: p.name || null,
    finish_date: p.finish_date || null,
    replicable: p.type === PROMO_REPLICABLE,
  };
}

async function datosDePublicaciones(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};

  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    try {
      const data = await meliGet(token, `/items?ids=${lote.join(',')}&attributes=id,title,status,price,original_price,permalink,listing_type_id`);
      for (const entrada of data || []) {
        if (entrada.code === 200 && entrada.body?.id) {
          const it = entrada.body;
          mapa[it.id] = {
            meli_id: it.id,
            titulo: it.title || null,
            estado: it.status || null,
            precio: Number(it.price) || 0,
            permalink: it.permalink || null,
            listing_type_id: it.listing_type_id || null,
          };
        }
      }
    } catch (e) {
      console.error('datosDePublicaciones:', e.message);
    }
  }

  // El descuento se consulta de a una: no hay multiget para promociones.
  for (const id of Object.keys(mapa)) {
    if (mapa[id].estado !== 'active') continue;
    const promos = await promocionesDeItem(token, id);
    mapa[id].descuento = descuentoVigente(promos);
    mapa[id].precio_final = mapa[id].descuento ? mapa[id].descuento.precio : mapa[id].precio;
  }

  return mapa;
}

async function auditar(token, supabase, skuFiltro = '') {
  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, nombre, precio, meli_id, meli_ids, discontinuado')
    .order('nombre');
  if (error) throw error;

  const vivos = (productos || [])
    .filter(p => !p.discontinuado && meliIdsDe(p).length > 1)
    .filter(p => !skuFiltro || p.sku === skuFiltro);

  const mapa = await datosDePublicaciones(token, vivos.flatMap(meliIdsDe));

  return vivos.map(p => {
    const ids = meliIdsDe(p);
    const publicaciones = ids
      .map(id => mapa[id])
      .filter(Boolean)
      .filter(x => x.estado === 'active');

    // La referencia es la principal (la original); si no está activa, la primera que esté.
    const referencia = publicaciones.find(x => x.meli_id === ids[0]) || publicaciones[0] || null;

    const precios = new Set(publicaciones.map(x => x.precio));
    const finales = new Set(publicaciones.map(x => x.precio_final));

    return {
      sku: p.sku,
      nombre: p.nombre,
      referencia,
      publicaciones,
      precio_desparejo: precios.size > 1,
      precio_final_desparejo: finales.size > 1,
      // Lo que se puede arreglar desde acá: el descuento de la referencia que las otras no tienen.
      descuento_replicable: !!(referencia?.descuento?.replicable &&
        publicaciones.some(x => x.meli_id !== referencia.meli_id && !x.descuento)),
      // Lo que no: una campaña de MELI en la referencia.
      campana_no_replicable: referencia?.descuento && !referencia.descuento.replicable
        ? referencia.descuento.tipo
        : null,
    };
  }).filter(f => f.publicaciones.length > 1);
}

// Fecha en el formato que pide MELI (sólo cuenta el día).
const soloFecha = d => new Date(d).toISOString().slice(0, 19);

// Empareja un producto: mismo precio de lista en todas y, si la referencia tiene descuento
// individual, el mismo descuento en las demás.
async function emparejar(token, fila) {
  const ref = fila.referencia;
  const pasos = [];
  if (!ref) return pasos;

  for (const pub of fila.publicaciones) {
    if (pub.meli_id === ref.meli_id) continue;

    // 1) precio de lista
    if (pub.precio !== ref.precio) {
      const r = await meliFetch(token, `/items/${pub.meli_id}`, {
        method: 'PUT',
        body: JSON.stringify({ price: ref.precio }),
      });
      pasos.push(r.ok
        ? { ok: true, sku: fila.sku, meli_id: pub.meli_id, accion: 'precio', antes: pub.precio, ahora: ref.precio }
        : { ok: false, sku: fila.sku, meli_id: pub.meli_id, accion: 'precio', error: mensajeDeError(r.data, r.status) });
      if (!r.ok) continue;
    }

    // 2) descuento individual de la referencia
    if (ref.descuento?.replicable && !pub.descuento) {
      // MELI tapa los descuentos de más de 14 días: si la original termina más lejos, se
      // corta ahí y se vuelve a aplicar cuando el vendedor lo renueve.
      const tope = new Date(Date.now() + MAX_DIAS_DESCUENTO * 86400000);
      const fin = ref.descuento.finish_date && new Date(ref.descuento.finish_date) < tope
        ? new Date(ref.descuento.finish_date)
        : tope;

      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_type: PROMO_REPLICABLE,
          deal_price: ref.descuento.precio,
          start_date: soloFecha(Date.now()),
          finish_date: soloFecha(fin),
        }),
      });
      pasos.push(r.ok
        ? { ok: true, sku: fila.sku, meli_id: pub.meli_id, accion: 'descuento', ahora: ref.descuento.precio, hasta: soloFecha(fin) }
        : { ok: false, sku: fila.sku, meli_id: pub.meli_id, accion: 'descuento', error: mensajeDeError(r.data, r.status) });
    }
  }

  return pasos;
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

    if (req.method === 'GET') {
      const filas = await auditar(token, supabase);
      const desparejos = filas.filter(f => f.precio_final_desparejo || f.descuento_replicable);
      return res.json({
        ok: true,
        productos: filas,
        resumen: {
          productos: filas.length,
          desparejos: desparejos.length,
          precio_distinto: filas.filter(f => f.precio_desparejo).length,
          sin_descuento: filas.filter(f => f.descuento_replicable).length,
          campanas_no_replicables: filas.filter(f => f.campana_no_replicable).length,
        },
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const sku = String(req.body?.sku || '').trim();
    const filas = (await auditar(token, supabase, sku))
      .filter(f => f.precio_final_desparejo || f.descuento_replicable);

    const resultados = [];
    for (const fila of filas) resultados.push(...await emparejar(token, fila));

    return res.json({
      ok: true,
      productos: filas.length,
      emparejadas: resultados.filter(r => r.ok).length,
      fallidas: resultados.filter(r => !r.ok).length,
      resultados,
    });
  } catch (err) {
    console.error('Error en /api/meli/precios:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
