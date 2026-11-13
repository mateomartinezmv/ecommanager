// api/meli/promos.js
// GET  /api/meli/promos  → cada publicación con stock, sus propuestas de MELI y qué hacer con
//                          cada una según las reglas de _promosReglas.js.
// POST /api/meli/promos  { meli_id, accion: 'aceptar', promo_id }  → entra a la promoción
//                        { meli_id, accion: 'propio' }              → descuento propio (objetivo)
//                        { meli_id, accion: 'sacar', promo_id }     → sale de la promoción
//
// El POST no confía en lo que mande la pantalla: vuelve a leer la publicación y sus
// promociones, recalcula la regla y sólo aplica si sigue permitida. Un clic viejo, con
// precios de hace una hora, no puede meter un 40%.
//
// Además se lee la referencia de precio de MELI (/suggestions/items/{id}/details), que es
// de donde sale la etiqueta "PRECIO ALTO": MELI compara el precio con productos parecidos,
// no con el costo. Se muestra para ver cuánto habría que bajar para sacarla y si las reglas
// lo permiten.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet, meliFetch, mensajeDeError } = require('../_meliPublicaciones');
const R = require('./_promosReglas');

const LOTE = 20;
const CONCURRENCIA = 8;
const DIAS_VENTAS = 60;
const DIAS_DESCUENTO_PROPIO = 14;   // tope de MELI para un descuento individual

const num = v => (v === null || v === undefined ? 0 : Number(v) || 0);
const normSku = s => String(s || '').trim().toUpperCase();
const soloFecha = d => new Date(d).toISOString().slice(0, 19);

async function enTandas(lista, fn) {
  for (let i = 0; i < lista.length; i += CONCURRENCIA) {
    await Promise.all(lista.slice(i, i + CONCURRENCIA).map(fn));
  }
}

// Productos con publicaciones y lo que vendió cada SKU en MELI en los últimos 60 días.
async function cargarProductos(supabase) {
  const desde = new Date(Date.now() - DIAS_VENTAS * 86400000).toISOString().slice(0, 10);
  const [{ data: productos, error: e1 }, { data: ventas, error: e2 }] = await Promise.all([
    supabase.from('productos')
      .select('sku, nombre, costo, precio, stock_meli, discontinuado, unidades_por_venta, meli_id, meli_ids')
      .limit(5000),
    supabase.from('ventas')
      .select('sku, cantidad, canal, estado, fecha')
      .gte('fecha', desde)
      .limit(50000),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const vendidas = new Map();
  for (const v of ventas || []) {
    if (!/meli/i.test(v.canal || '') || v.estado === 'cancelada' || !v.sku) continue;
    const k = normSku(v.sku);
    vendidas.set(k, (vendidas.get(k) || 0) + Math.max(1, num(v.cantidad)));
  }

  return (productos || [])
    .filter(p => meliIdsDe(p).length)
    .map(p => {
      const costo = num(p.costo) * Math.max(1, num(p.unidades_por_venta) || 1);
      const vendidas60 = vendidas.get(normSku(p.sku)) || 0;
      const seg = R.segmento({ stock: p.stock_meli, vendidas60, discontinuado: p.discontinuado, costo });
      return {
        sku: p.sku,
        nombre: p.nombre,
        costo,
        stock: num(p.stock_meli),
        vendidas60,
        dias_stock: R.diasDeStock(p.stock_meli, vendidas60),
        discontinuado: !!p.discontinuado,
        segmento: seg,
        segmento_txt: R.SEGMENTOS[seg].txt,
        meli_ids: meliIdsDe(p),
      };
    });
}

async function leerItems(token, ids) {
  const mapa = {};
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    try {
      const data = await meliGet(token, `/items?ids=${lote.join(',')}&attributes=id,title,status,price,permalink`);
      for (const e of data || []) {
        if (e.code === 200 && e.body?.id) {
          mapa[e.body.id] = {
            meli_id: e.body.id,
            titulo: e.body.title || null,
            estado: e.body.status || null,
            precio: num(e.body.price),
            permalink: e.body.permalink || null,
          };
        }
      }
    } catch (err) {
      console.error('promos leerItems:', err.message);
    }
  }
  return mapa;
}

async function promocionesDeItem(token, itemId) {
  const { ok, data } = await meliFetch(token, `/seller-promotions/items/${itemId}?app_version=v2`);
  return ok && Array.isArray(data) ? data.filter(Boolean) : [];
}

// La referencia de precio de MELI. Si la cuenta o la categoría no la tienen, null: no saber
// la referencia no puede romper la pantalla.
async function referenciaDePrecio(token, itemId) {
  const { ok, data } = await meliFetch(token, `/suggestions/items/${itemId}/details`);
  if (!ok || !data) return null;
  const sugerido = num(data.suggested_price?.amount);
  const actual = num(data.current_price?.amount);
  if (!sugerido) return null;
  return {
    estado: data.status || null,
    actual: actual || null,
    sugerido,
    mas_bajo: num(data.lowest_price?.amount) || null,
  };
}

// Todo lo de una publicación: sus promociones evaluadas, la que está corriendo y el
// descuento propio que corresponde.
function armarPublicacion(prod, item, promosCrudas, referencia) {
  const ctx = { costo: prod.costo, seg: prod.segmento };
  const promos = promosCrudas.map(p => R.normalizarPromo(p, item.precio));

  const vigentes = promos.filter(p => p.estado === 'started' && p.precio && p.precio < p.lista);
  const vigente = vigentes.sort((a, b) => a.precio - b.precio)[0] || null;

  const propuestas = promos
    .filter(p => p.estado === 'candidate' && p.lista > 0 && p.precio && p.precio < p.lista)
    .map(p => {
      const evaluacion = R.evaluarPromo(p, ctx);
      // Las ofertas con cupo (relámpago, oferta del día) piden un mínimo de unidades. Sin
      // ese stock, MELI la rechaza: se avisa antes en vez de dejar que falle.
      if (p.stock_min && num(prod.stock) < p.stock_min && evaluacion.veredicto !== 'rechazar') {
        return { ...p, evaluacion: { ...evaluacion, veredicto: 'rechazar',
          motivo: `MELI pide al menos ${p.stock_min} unidades para esta oferta y tenés ${num(prod.stock)}.` } };
      }
      return { ...p, evaluacion };
    });

  const lim = R.limites({ precioLista: item.precio, costo: prod.costo, seg: prod.segmento });
  const propio = R.descuentoPropio({ precioLista: item.precio, costo: prod.costo, seg: prod.segmento });

  // ¿Bajar hasta la referencia de MELI entra en las reglas? Es la pregunta de "PRECIO ALTO".
  let ref = null;
  if (referencia && referencia.sugerido < item.precio) {
    const pct = 1 - referencia.sugerido / item.precio;
    ref = {
      ...referencia,
      baja_pct: Math.round(pct * 1000) / 10,
      permitido: pct <= lim.maximo + 0.005,
      rompe_piso: referencia.sugerido < 2 * prod.costo,
    };
  } else if (referencia) {
    ref = { ...referencia, baja_pct: 0, permitido: true, rompe_piso: false };
  }

  return {
    meli_id: item.meli_id,
    titulo: item.titulo,
    permalink: item.permalink,
    precio: item.precio,
    maximo_pct: Math.round(lim.maximo * 1000) / 10,
    objetivo_pct: Math.round(lim.objetivo * 1000) / 10,
    precio_minimo: Math.ceil(item.precio * (1 - lim.maximo)),
    piso_precio: lim.piso_precio,
    vigente: vigente ? { ...vigente, evaluacion: R.evaluarPromo(vigente, { ...ctx, corriendo: true }) } : null,
    propuestas,
    propio: vigente ? null : propio,   // con una promo corriendo MELI no deja sumar otra
    referencia: ref,
  };
}

async function auditar(token, supabase, soloMeliId = null) {
  const productos = await cargarProductos(supabase);
  const conStock = productos.filter(p => p.stock > 0 || soloMeliId);
  const ids = [...new Set(conStock.flatMap(p => p.meli_ids))]
    .filter(id => !soloMeliId || id === soloMeliId);

  const items = await leerItems(token, ids);
  // Para una sola publicación (el POST), si MELI no la devolvió se reintenta de a una: en
  // los lotes, entre tantas llamadas seguidas, el multiget a veces vuelve vacío.
  if (soloMeliId && !items[soloMeliId]) {
    for (let intento = 0; intento < 2 && !items[soloMeliId]; intento++) {
      await new Promise(r => setTimeout(r, 700));
      const { ok, data } = await meliFetch(token, `/items/${soloMeliId}?attributes=id,title,status,price,permalink`);
      if (ok && data?.id) {
        items[soloMeliId] = { meli_id: data.id, titulo: data.title || null, estado: data.status || null,
          precio: num(data.price), permalink: data.permalink || null };
      }
    }
  }
  const activos = Object.values(items).filter(i => i.estado === 'active').map(i => i.meli_id);
  const promos = {};
  const refs = {};
  await enTandas(activos, async id => {
    const [p, r] = await Promise.all([promocionesDeItem(token, id), soloMeliId ? null : referenciaDePrecio(token, id)]);
    promos[id] = p;
    refs[id] = r;
  });

  return conStock
    .map(prod => ({
      ...prod,
      publicaciones: prod.meli_ids
        .filter(id => items[id]?.estado === 'active')
        .map(id => armarPublicacion(prod, items[id], promos[id] || [], refs[id])),
    }))
    .filter(p => p.publicaciones.length);
}

// ── Acciones ────────────────────────────────────────────────────────────────

// Cuántas unidades van a una oferta que las pide (relámpagos: entre 5 y 10; oferta del día:
// 15 o más): todo el stock del CRM, recortado al máximo de MELI. Nunca más de lo que hay:
// si no llega al mínimo, la propuesta ya viene rechazada desde armarPublicacion.
function stockParaOferta(p, stock) {
  let s = Math.max(1, Math.floor(num(stock)));
  if (p.stock_max) s = Math.min(s, p.stock_max);
  return s;
}

const pideStock = p => !!(p.stock_min || p.stock_max) || /LIGHTNING|DOD/.test(p.tipo || '');

// El cuerpo que pide MELI para entrar, según el tipo de promoción.
function cuerpoParaAceptar(p, ev, stock) {
  // Candidata PRICE_DISCOUNT: no es una campaña, es MELI diciendo "podés poner un descuento".
  // Se crea como descuento individual, con fechas (sin fechas MELI lo rechaza).
  if (p.tipo === 'PRICE_DISCOUNT') {
    const fin = new Date(Date.now() + DIAS_DESCUENTO_PROPIO * 86400000);
    return {
      promotion_type: 'PRICE_DISCOUNT',
      deal_price: ev.deal_price || p.precio,
      start_date: soloFecha(Date.now()),
      finish_date: soloFecha(fin),
    };
  }
  const body = { promotion_id: p.id, promotion_type: p.tipo };
  if (p.offer_id) body.offer_id = p.offer_id;
  if (ev.deal_price) body.deal_price = Math.round(ev.deal_price * 100) / 100;
  if (pideStock(p)) body.stock = stockParaOferta(p, stock);
  return body;
}

async function aceptar(token, pub, promoClave, stock) {
  const p = pub.propuestas.find(x => x.clave === promoClave || (x.id && x.id === promoClave));
  if (!p) return { ok: false, error: 'Esa propuesta ya no está: MELI la sacó o cambió. Actualizá la pantalla.' };
  const ev = p.evaluacion;
  if (ev.veredicto === 'rechazar') return { ok: false, error: `No se aplica: ${ev.motivo}` };

  const body = cuerpoParaAceptar(p, ev, stock);
  const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
    method: 'POST', body: JSON.stringify(body),
  });
  if (!r.ok) {
    // Se registra todo: MELI a veces contesta un "Invalid request" pelado y el detalle
    // sólo se ve comparando lo que se mandó con lo que había en la candidata.
    console.error('promos aceptar:', pub.meli_id, p.tipo, JSON.stringify(body), r.status,
      JSON.stringify(r.data), 'candidata:', JSON.stringify(p.crudo));
    return { ok: false, error: errorDetallado(r) };
  }
  return { ok: true, precio: body.deal_price || p.precio, veredicto: ev.veredicto };
}

// El mensaje de MELI, y si viene genérico, el cuerpo entero (recortado) para ver qué pidió.
function errorDetallado(r) {
  const msg = mensajeDeError(r.data, r.status);
  if (/^(invalid request|bad request|http \d+)$/i.test(String(msg).trim())) {
    return `${msg} — ${JSON.stringify(r.data).slice(0, 300)}`;
  }
  return msg;
}

async function ponerPropio(token, pub) {
  if (pub.vigente) return { ok: false, error: 'Ya tiene una promoción corriendo: sacala primero.' };
  if (!pub.propio) return { ok: false, error: 'Para este producto las reglas no permiten un descuento propio.' };
  const fin = new Date(Date.now() + DIAS_DESCUENTO_PROPIO * 86400000);
  const r = await meliFetch(token, `/seller-promotions/items/${pub.meli_id}?app_version=v2`, {
    method: 'POST',
    body: JSON.stringify({
      promotion_type: 'PRICE_DISCOUNT',
      deal_price: pub.propio.precio,
      start_date: soloFecha(Date.now()),
      finish_date: soloFecha(fin),
    }),
  });
  if (!r.ok) return { ok: false, error: errorDetallado(r) };
  return { ok: true, precio: pub.propio.precio, hasta: soloFecha(fin) };
}

async function sacar(token, pub, promoId) {
  const v = pub.vigente;
  if (!v || (promoId && v.id && v.id !== promoId)) return { ok: false, error: 'Esa promoción ya no está corriendo.' };
  const r = await meliFetch(token,
    `/seller-promotions/items/${pub.meli_id}?promotion_type=${v.tipo}&promotion_id=${v.id || ''}&app_version=v2`,
    { method: 'DELETE' });
  if (!r.ok) return { ok: false, error: errorDetallado(r) };
  return { ok: true };
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
      const productos = await auditar(token, supabase);
      const pubs = productos.flatMap(p => p.publicaciones);
      const props = pubs.flatMap(p => p.propuestas);
      return res.json({
        ok: true,
        reglas: {
          piso_multiplo: R.PISO_MULTIPLO,
          tope_absoluto: R.TOPE_ABSOLUTO * 100,
          dias_bien: R.DIAS_BIEN,
          min_ventas_algo_60d: R.MIN_VENTAS_ALGO,
          segmentos: R.SEGMENTOS,
        },
        productos,
        resumen: {
          productos: productos.length,
          publicaciones: pubs.length,
          propuestas: props.length,
          aceptar: props.filter(p => p.evaluacion.veredicto === 'aceptar').length,
          contraoferta: props.filter(p => p.evaluacion.veredicto === 'contraoferta').length,
          rechazar: props.filter(p => p.evaluacion.veredicto === 'rechazar').length,
          vigentes_fuera_de_regla: pubs.filter(p => p.vigente && p.vigente.evaluacion.veredicto === 'rechazar').length,
          precio_alto: pubs.filter(p => p.referencia && p.referencia.baja_pct > 0).length,
        },
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const meliId = String(req.body?.meli_id || '').trim();
    const accion = String(req.body?.accion || '');
    if (!meliId || !['aceptar', 'propio', 'sacar'].includes(accion)) {
      return res.status(400).json({ ok: false, error: 'Falta meli_id o la acción no es válida.' });
    }

    // Se recalcula todo con datos frescos antes de tocar nada.
    const filas = await auditar(token, supabase, meliId);
    const fila = filas.find(f => f.publicaciones.some(p => p.meli_id === meliId));
    const pub = fila?.publicaciones.find(p => p.meli_id === meliId);
    if (!pub) return res.status(404).json({ ok: false, error: 'No encontré esa publicación activa en el CRM.' });

    const r = accion === 'aceptar' ? await aceptar(token, pub, req.body.promo_id, fila.stock)
      : accion === 'propio' ? await ponerPropio(token, pub)
      : await sacar(token, pub, req.body.promo_id);
    return res.status(r.ok ? 200 : 422).json(r);
  } catch (err) {
    console.error('Error en /api/meli/promos:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.armarPublicacion = armarPublicacion;
module.exports.cuerpoParaAceptar = cuerpoParaAceptar;
