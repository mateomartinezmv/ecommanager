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

    const otras = publicaciones.filter(x => x.meli_id !== referencia?.meli_id);
    const desc = referencia?.descuento || null;

    // ¿MELI deja meter esta publicación en la campaña de la original, al precio de la
    // original? Las campañas piden un descuento mínimo y a cada publicación le exigen uno
    // distinto: a las nuevas, más que a la original.
    const entraEnLaCampana = (x) => {
      if (!desc) return false;
      if (desc.replicable) return true;            // descuento individual: se copia siempre
      const inv = x.candidaturas?.[desc.id];
      return !!inv &&
        (!inv.min || referencia.precio_final >= inv.min) &&
        (!inv.max || referencia.precio_final <= inv.max);
    };

    // Lo que hay que arreglar, según la regla: mismo precio de lista en todas y, encima, el
    // mismo descuento que la original o ninguno.
    const listaDistinta = otras.filter(x => x.precio !== referencia?.precio);
    const descuentoPropio = otras.filter(x => x.descuento && x.precio_final !== referencia?.precio_final);
    const sinEtiqueta = desc ? otras.filter(x => x.precio_final !== referencia.precio_final) : [];
    const sumables = sinEtiqueta.filter(entraEnLaCampana);

    return {
      sku: p.sku,
      nombre: p.nombre,
      referencia,
      publicaciones,
      // Cuántas publicaciones se apartan de la regla, y de ésas cuántas tienen arreglo.
      lista_distinta: listaDistinta.length,
      descuento_propio: descuentoPropio.length,
      sin_etiqueta: sinEtiqueta.length - sumables.length,
      sumables: sumables.length,
      // Hay algo para hacer desde acá: alinear el precio de lista, sacar un descuento propio
      // o sumar una publicación al descuento de la original.
      accionable: !!(listaDistinta.length || descuentoPropio.length || sumables.length),
      // Lo que no se puede: esas publicaciones se quedan en el precio de lista, sin etiqueta.
      campana_no_replicable: desc && sinEtiqueta.length > sumables.length ? desc.tipo : null,
    };
  }).filter(f => f.publicaciones.length > 1);
}

// Fecha en el formato que pide MELI (sólo cuenta el día).
const soloFecha = d => new Date(d).toISOString().slice(0, 19);

// Empareja un producto. La regla es la de la vidriera, no la de la calculadora:
//
//   · Todas las publicaciones de un producto muestran el MISMO precio de lista: el de la
//     original. Es el precio real del producto; no se toca por estar de oferta.
//   · Encima de ese precio, cada una lleva EL MISMO descuento que la original, así el
//     comprador paga lo mismo y todas muestran la etiqueta.
//   · Si MELI no deja meter una publicación en ese descuento —las campañas piden un
//     descuento mínimo y a las publicaciones nuevas les exigen más que a la original—,
//     esa publicación se queda en el precio de lista, sin descuento. Nunca con un
//     descuento propio: un ángulo más barato que la original le come las ventas al mismo
//     vendedor, y uno más caro que el precio de lista es mentira.
//
// O sea: el descuento se copia o no está. No se inventa un precio intermedio.
async function emparejar(token, fila) {
  const ref = fila.referencia;
  const pasos = [];
  if (!ref) return pasos;

  const lista = ref.precio;          // el precio de lista de la original: la base de todo
  const final = ref.precio_final;    // lo que paga el comprador en la original
  const anotar = (pub, accion, extra) => pasos.push({ sku: fila.sku, meli_id: pub.meli_id, titulo: pub.titulo, accion, ...extra });

  const sacarDeLaPromo = async (pub, promo) => {
    const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?promotion_type=${promo.tipo}&promotion_id=${promo.id || ''}&app_version=v2`, { method: 'DELETE' });
    return r.ok;
  };

  for (const pub of fila.publicaciones) {
    if (pub.meli_id === ref.meli_id) continue;
    if (pub.precio === lista && pub.precio_final === final) continue;   // ya está igual

    let descuento = pub.descuento;

    // 1. Está en la misma campaña que la original pero a otro precio: se corrige ahí mismo.
    if (descuento && ref.descuento && descuento.id === ref.descuento.id && descuento.precio !== final) {
      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'PUT',
        body: JSON.stringify({ promotion_type: descuento.tipo, promotion_id: descuento.id, deal_price: final }),
      });
      if (r.ok) {
        anotar(pub, 'precio en la campaña', { ok: true, antes: pub.precio_final, ahora: final });
        descuento = { ...descuento, precio: final };
      }
    }

    // 2. Cualquier descuento que no sea el de la original se saca: es el que la deja más
    //    barata que la madre. Además, con una promo puesta MELI no deja mover el precio.
    if (descuento && descuento.precio !== final) {
      if (await sacarDeLaPromo(pub, descuento)) {
        anotar(pub, 'sin el descuento propio', { ok: true, antes: pub.precio_final, nota: `tenía un descuento a ${descuento.precio}, más barato que la original` });
        descuento = null;
      } else {
        anotar(pub, 'sin el descuento propio', { ok: false, error: `MELI no dejó sacar esta publicación de ${descuento.nombre || descuento.tipo}` });
        continue;
      }
    }

    // 3. Mismo precio de lista que la original.
    if (pub.precio !== lista) {
      const r = await meliFetch(token, `/items/${pub.meli_id}`, { method: 'PUT', body: JSON.stringify({ price: lista }) });
      if (!r.ok) {
        anotar(pub, 'precio de lista', { ok: false, error: mensajeDeError(r.data, r.status) });
        continue;
      }
      anotar(pub, 'precio de lista', { ok: true, antes: pub.precio, ahora: lista });
    }

    // 4. La etiqueta: el mismo descuento que la original, si MELI lo permite.
    if (!ref.descuento || descuento) continue;   // la original no tiene, o ésta ya quedó con el mismo

    const invitacion = pub.candidaturas?.[ref.descuento.id];
    const entra = invitacion &&
      (!invitacion.min || final >= invitacion.min) &&
      (!invitacion.max || final <= invitacion.max);

    if (entra) {
      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'POST',
        body: JSON.stringify({ promotion_type: ref.descuento.tipo, promotion_id: ref.descuento.id, deal_price: final }),
      });
      if (r.ok) {
        anotar(pub, 'mismo descuento', { ok: true, campana: ref.descuento.nombre || ref.descuento.id, antes: pub.precio_final, ahora: final });
        continue;
      }
    }

    // Descuento individual de la original: ése sí se puede copiar a cualquiera.
    if (ref.descuento.replicable) {
      const tope = new Date(Date.now() + MAX_DIAS_DESCUENTO * 86400000);
      const fin = ref.descuento.finish_date && new Date(ref.descuento.finish_date) < tope
        ? new Date(ref.descuento.finish_date)
        : tope;

      const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_type: PROMO_REPLICABLE,
          deal_price: final,
          start_date: soloFecha(Date.now()),
          finish_date: soloFecha(fin),
        }),
      });
      if (r.ok) {
        anotar(pub, 'mismo descuento', { ok: true, antes: pub.precio_final, ahora: final, hasta: soloFecha(fin) });
        continue;
      }
    }

    // No se pudo: queda en el precio de lista, sin descuento. Es el resultado buscado, no
    // un error: mejor sin etiqueta que con un precio que se pelee con la original.
    anotar(pub, 'queda al precio de lista', {
      ok: true,
      ahora: lista,
      nota: ref.descuento.cofondeada
        ? `${ref.descuento.nombre || ref.descuento.tipo} es una campaña cofondeada: MELI la arma y hay que sumar esta publicación desde Promociones`
        : `MELI no acepta esta publicación en ${ref.descuento.nombre || ref.descuento.tipo} al precio de la original (pide un descuento más grande)`,
    });
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
      return res.json({
        ok: true,
        productos: filas,
        resumen: {
          productos: filas.length,
          desparejos: filas.filter(f => f.accionable).length,
          lista_distinta: filas.filter(f => f.lista_distinta).length,
          descuento_propio: filas.filter(f => f.descuento_propio).length,
          sin_etiqueta: filas.filter(f => !f.accionable && f.sin_etiqueta).length,
          parejos: filas.filter(f => !f.accionable && !f.sin_etiqueta).length,
        },
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const sku = String(req.body?.sku || '').trim();
    // Se toca sólo lo que está desparejo de verdad: si el precio final ya coincide, moverle
    // promociones a una publicación sana no cambia nada y arriesga a que MELI la recalcule.
    const filas = (await auditar(token, supabase, sku)).filter(f => f.accionable);

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
