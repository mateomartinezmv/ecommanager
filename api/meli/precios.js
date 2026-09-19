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
const CONCURRENCIA = 8;          // consultas de promociones en paralelo
const PROMO_REPLICABLE = 'PRICE_DISCOUNT';   // descuento individual: lo define el vendedor
const PROMO_CAMPANA = 'DEAL';                // campaña tradicional: se suma el ítem si está invitado
// Campañas donde Mercado Libre pone parte del descuento.
const COFONDEADAS = new Set(['MARKETPLACE_CAMPAIGN', 'SMART', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK']);
const MAX_DIAS_DESCUENTO = 14;   // tope de MELI para un descuento individual

// Todas las promociones que MELI asocia a una publicación: las que están corriendo y las
// invitaciones (status candidate). Si el recurso falla, se devuelve vacío: no saber de
// descuentos no puede romper la comparación de precios.
async function promocionesDeItem(token, itemId) {
  const { ok, data } = await meliFetch(token, `/seller-promotions/items/${itemId}?app_version=v2`);
  if (!ok || !Array.isArray(data)) return [];
  return data.filter(Boolean);
}

// Las campañas a las que esta publicación está invitada, por id, con el rango de precios que
// MELI acepta. Sin esto, sumar un ítem a una campaña falla por "precio no creíble".
function candidaturas(promos) {
  const mapa = {};
  for (const p of promos || []) {
    if (p.status !== 'candidate' || !p.id) continue;
    mapa[p.id] = {
      tipo: p.type,
      min: Number(p.min_discounted_price) || null,
      max: Number(p.max_discounted_price) || null,
      sugerido: Number(p.suggested_discounted_price) || null,
    };
  }
  return mapa;
}

// El descuento que está corriendo: el que baja el precio de verdad.
function descuentoVigente(promos) {
  const activos = (promos || []).filter(p => p.status === 'started' && Number(p.price) > 0 && Number(p.price) < Number(p.original_price || 0));
  if (!activos.length) return null;
  // Si hay varias, manda la más barata: es la que ve el comprador.
  const p = activos.slice().sort((a, b) => a.price - b.price)[0];
  return {
    id: p.id || null,
    tipo: p.type,
    precio: Number(p.price),
    precio_lista: Number(p.original_price),
    nombre: p.name || null,
    finish_date: p.finish_date || null,
    // El descuento individual lo define el vendedor y se copia. Una campaña tradicional se
    // puede copiar sólo si MELI invitó también a la otra publicación; el resto (SMART,
    // co-fondeadas, price matching) no se puede tocar por API.
    replicable: p.type === PROMO_REPLICABLE,
    por_invitacion: p.type === PROMO_CAMPANA && !!p.id,
    // En estas campañas parte del descuento lo paga MELI. Igualar el precio final por precio
    // de lista en otra publicación no es lo mismo: ahí lo pagaría entero el vendedor.
    cofondeada: Number(p.meli_percentage) > 0 || COFONDEADAS.has(p.type),
    meli_percentage: Number(p.meli_percentage) || 0,
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

  // Las promociones no tienen multiget: es una llamada por publicación. De a una son más de
  // dos minutos para un catálogo como éste, así que van en tandas.
  const activos = Object.keys(mapa).filter(id => mapa[id].estado === 'active');
  for (let i = 0; i < activos.length; i += CONCURRENCIA) {
    const tanda = activos.slice(i, i + CONCURRENCIA);
    await Promise.all(tanda.map(async (id) => {
      const promos = await promocionesDeItem(token, id);
      mapa[id].descuento = descuentoVigente(promos);
      mapa[id].candidaturas = candidaturas(promos);
      mapa[id].precio_final = mapa[id].descuento ? mapa[id].descuento.precio : mapa[id].precio;
    }));
  }

  // Las que no son activas no se consultan: no tienen promoción vigente ni sentido comparar.
  for (const id of Object.keys(mapa)) {
    if (mapa[id].precio_final === undefined) mapa[id].precio_final = mapa[id].precio;
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
      // Lo que se puede arreglar desde acá: el descuento individual de la referencia, o su
      // campaña tradicional cuando MELI también invitó a la otra publicación.
      descuento_replicable: !!(referencia?.descuento && publicaciones.some(x =>
        x.meli_id !== referencia.meli_id && !x.descuento && (
          referencia.descuento.replicable ||
          (referencia.descuento.por_invitacion && x.candidaturas?.[referencia.descuento.id])
        ))),
      // Lo que no se puede: campañas que MELI arma sola, o tradicionales sin invitación.
      campana_no_replicable: referencia?.descuento && !referencia.descuento.replicable &&
        !publicaciones.some(x => x.meli_id !== referencia.meli_id && x.candidaturas?.[referencia.descuento.id])
        ? referencia.descuento.tipo
        : null,
    };
  }).filter(f => f.publicaciones.length > 1);
}

// Fecha en el formato que pide MELI (sólo cuenta el día).
const soloFecha = d => new Date(d).toISOString().slice(0, 19);

// Empareja un producto: mismo precio de lista en todas y, si la referencia tiene descuento
// individual, el mismo descuento en las demás.
// Empareja un producto: que todas sus publicaciones queden en el MISMO precio final que la
// principal. El objetivo es el precio que paga el comprador en la original, no "que tenga
// descuento": un ángulo con un descuento más grande sale más barato que la original y le
// come las ventas al mismo vendedor, que es peor que no tener descuento.
//
// Por eso nunca se acepta un precio distinto al objetivo. Se intenta, en orden:
//   1. Si ya está en el objetivo, no se toca.
//   2. Si está en una promo con otro precio, se corrige el precio de esa promo.
//   3. Si MELI no acepta ese precio en la promo (lo considera poco creíble), se saca de la
//      promo y se baja el precio de lista al objetivo: el comprador paga lo mismo, sin la
//      etiqueta de descuento.
//   4. Si no tiene promo y está invitado a la de la referencia con el objetivo dentro del
//      rango permitido, se suma a la campaña con ese precio.
//   5. Si no, precio de lista al objetivo.
async function emparejar(token, fila) {
  const ref = fila.referencia;
  const pasos = [];
  if (!ref) return pasos;

  const objetivo = ref.precio_final;
  const anotar = (pub, accion, extra) => pasos.push({ sku: fila.sku, meli_id: pub.meli_id, titulo: pub.titulo, accion, ...extra });

  // Deja la publicación en el precio objetivo sin promociones de por medio.
  const ponerPrecioDeLista = async (pub, quitarPromo) => {
    if (quitarPromo) {
      await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?promotion_type=${quitarPromo.tipo}&promotion_id=${quitarPromo.id || ''}&app_version=v2`, { method: 'DELETE' });
    }
    const r = await meliFetch(token, `/items/${pub.meli_id}`, {
      method: 'PUT',
      body: JSON.stringify({ price: objetivo }),
    });
    anotar(pub, 'precio de lista', r.ok
      ? { ok: true, antes: pub.precio_final, ahora: objetivo, nota: quitarPromo ? 'se sacó de la campaña: MELI no aceptaba ese precio dentro de ella' : null }
      : { ok: false, error: mensajeDeError(r.data, r.status) });
  };

  for (const pub of fila.publicaciones) {
    if (pub.meli_id === ref.meli_id) continue;
    if (pub.precio_final === objetivo) continue;

    // Ya está en una promo, pero a otro precio.
    if (pub.descuento) {
      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'PUT',
        body: JSON.stringify({
          promotion_type: pub.descuento.tipo,
          promotion_id: pub.descuento.id,
          deal_price: objetivo,
        }),
      });
      if (r.ok) {
        anotar(pub, 'precio en la campaña', { ok: true, antes: pub.precio_final, ahora: objetivo });
      } else {
        await ponerPrecioDeLista(pub, pub.descuento);
      }
      continue;
    }

    // Sin promo: si está invitada a la de la referencia y el objetivo entra en el rango que
    // MELI acepta para ESA publicación, se suma con ese precio. Si no entra, no se la suma
    // con otro precio: se iguala por precio de lista.
    const invitacion = ref.descuento?.por_invitacion ? pub.candidaturas?.[ref.descuento.id] : null;
    const entraEnRango = invitacion &&
      (!invitacion.min || objetivo >= invitacion.min) &&
      (!invitacion.max || objetivo <= invitacion.max);

    if (entraEnRango) {
      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_type: PROMO_CAMPANA,
          promotion_id: ref.descuento.id,
          deal_price: objetivo,
        }),
      });
      if (r.ok) {
        anotar(pub, 'campaña', { ok: true, campana: ref.descuento.nombre || ref.descuento.id, antes: pub.precio_final, ahora: objetivo });
        continue;
      }
    }

    // Descuento individual de la referencia: mismo precio, sin campaña de por medio.
    if (ref.descuento?.replicable) {
      const tope = new Date(Date.now() + MAX_DIAS_DESCUENTO * 86400000);
      const fin = ref.descuento.finish_date && new Date(ref.descuento.finish_date) < tope
        ? new Date(ref.descuento.finish_date)
        : tope;

      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_type: PROMO_REPLICABLE,
          deal_price: objetivo,
          start_date: soloFecha(Date.now()),
          finish_date: soloFecha(fin),
        }),
      });
      if (r.ok) {
        anotar(pub, 'descuento', { ok: true, antes: pub.precio_final, ahora: objetivo, hasta: soloFecha(fin) });
        continue;
      }
    }

    // Última opción: bajar el precio de lista. No se hace cuando el descuento de la
    // referencia es co-fondeado: ahí una parte la pone MELI, y copiar el precio final a
    // pulmón significa regalar esa parte en cada venta de esta publicación.
    if (ref.descuento?.cofondeada) {
      anotar(pub, 'sin igualar', {
        ok: false,
        error: `La original está en una campaña ${ref.descuento.tipo} donde MELI pone ${ref.descuento.meli_percentage || 'parte'}% del descuento. ` +
               `Igualar el precio acá saldría de tu bolsillo: se deja como está y conviene sumar esta publicación a la campaña desde MELI.`,
      });
      continue;
    }

    await ponerPrecioDeLista(pub, null);
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
