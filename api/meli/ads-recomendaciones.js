// api/meli/ads-recomendaciones.js
// GET /api/meli/ads-recomendaciones?dias=30
//
// Qué conviene anunciar y qué conviene apagar, mirando el catálogo entero y no sólo los
// productos que ya tienen un anuncio.
//
// La pestaña de Ads contesta "cómo le va a lo que estoy anunciando". Le falta la pregunta
// de atrás: *qué debería estar anunciando*. Esa respuesta no está en el panel de MELI,
// porque MELI sólo conoce los productos que ya pusiste a competir — no sabe que tenés un
// producto con 63% de margen sin una sola impresión, ni que el que andaba bien en agosto
// lleva seis semanas apagado.
//
// Se cruzan cuatro cosas que el CRM ya tiene por separado:
//
//   · el catálogo con costo, precio y stock             → productos
//   · lo que se vendió, con y sin ads                   → ventas
//   · la comisión y el envío reales de cada SKU         → _economia
//   · lo que está (y estuvo) anunciado y cómo le fue    → MELI Ads, dos ventanas
//
// Las dos ventanas de Ads son lo que permite distinguir "nunca se anunció" de "se anunció
// y se apagó": MELI sirve 90 días de métricas, así que se pide el período elegido y el
// tramo anterior de la misma ventana. Un producto con gasto atrás y sin gasto ahora es un
// anuncio apagado, y si en su momento pagaba, apagarlo fue plata que se dejó de ganar.
//
// Cada recomendación sale con su cuenta a la vista: el motivo, la evidencia que lo
// sostiene y la plata en juego. Sin eso es un horóscopo.

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsGet, resolverRango, enLotes, API, aFecha, sumarDias } = require('./_adsClient');
const { cargarEconomia, deSku, contribucionUnitaria } = require('./_economia');

const METRICS_AD_GROUP = ['CLICKS', 'PRINTS', 'COST', 'UNITS_QUANTITY', 'TOTAL_AMOUNT'].join(',');
const CONCURRENCIA = 6;
const PAGINA = 200;
const MAX_AD_GROUPS = 400;

// ── Umbrales ────────────────────────────────────────────────────────────────────────
// Elegidos para que una recomendación no se dispare con tres clics de muestra. Son el
// único lugar donde vive el criterio: tocar acá cambia todo el tablero.
const UMBRALES = {
  // Para juzgar un anuncio que está corriendo hace falta que haya gastado algo real:
  // media contribución o 40 clics, lo que llegue primero.
  clics_para_juzgar: 40,
  // Cuánto por encima del equilibrio tiene que estar un anuncio para decir "escalalo".
  holgura_escalar: 1.35,
  // Meses de stock a partir de los cuales el inventario está dormido.
  meses_stock_dormido: 4,
  // Un ROAS de equilibrio por encima de esto es un producto que ads no puede sostener:
  // haría falta que casi tres de cada cuatro pesos facturados fueran margen.
  roas_be_inviable: 4,
  // Mínimo de unidades vendidas sin ads para decir que un producto "se vende solo".
  unidades_ganador: 3,
};

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const ent = v => (v === null || v === undefined ? 0 : parseInt(v, 10) || 0);
const r2 = v => Math.round(v * 100) / 100;
const normSku = s => String(s || '').trim().toUpperCase();

/**
 * Trae todos los ad groups del anunciante en un rango, con métricas.
 *
 * Sin `filters[campaign_id]`: acá interesa qué productos están anunciados en cualquier
 * campaña, no el detalle de una. Devuelve los crudos de MELI tal cual.
 */
async function traerAdGroups(ctx, desde, hasta) {
  const url = (offset) =>
    `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/ad_groups/search`
    + `?date_from=${desde}&date_to=${hasta}`
    + `&metrics=${METRICS_AD_GROUP}&metrics_summary=true`
    + `&limit=${PAGINA}&offset=${offset}&sort=desc&sort_by=cost`;

  const salida = [];
  let offset = 0;
  let total = null;
  while (offset === 0 || offset < total) {
    const pagina = await adsGet(url(offset), ctx.headers);
    if (!pagina.ok) {
      const err = new Error(`MELI devolvió ${pagina.status} al listar los anuncios`);
      err.detalle = pagina.body;
      throw err;
    }
    const lote = pagina.body.results || [];
    salida.push(...lote);
    total = pagina.body.paging?.total ?? salida.length;
    offset += PAGINA;
    if (!lote.length || salida.length >= MAX_AD_GROUPS) break;
  }
  return salida;
}

/** Resume las métricas de un ad group en los números que usan las reglas. */
function metricas(g) {
  const m = g?.metrics || {};
  return {
    clics: ent(m.clicks),
    impresiones: ent(m.prints),
    inversion: r2(num(m.cost)),
    facturacion: r2(num(m.total_amount)),
    unidades: ent(m.units_quantity),
    roas: num(m.cost) > 0 ? r2(num(m.total_amount) / num(m.cost)) : 0,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rango = resolverRango(req.query);
  if (rango.vacio) {
    return res.json({ ok: false, error: `Rango vacío: ${rango.desde} es posterior a ${rango.hasta}.` });
  }

  // El tramo anterior, del mismo largo, para poder comparar contra el pasado. Se recorta
  // solo contra la ventana de 90 días que sirve MELI.
  const largo = Math.max(1, Math.round((new Date(rango.hasta) - new Date(rango.desde)) / 86400000) + 1);
  const previoHasta = aFecha(sumarDias(new Date(rango.desde), -1));
  const previoRango = resolverRango({ desde: aFecha(sumarDias(new Date(rango.desde), -largo)), hasta: previoHasta });
  const hayPrevio = !previoRango.vacio && previoRango.desde <= previoRango.hasta;

  try {
    let ctx = null;
    let errorAds = null;
    try {
      ctx = await getAdsContext();
    } catch (e) {
      // Sin perfil de anunciante igual se puede recomendar: el catálogo y las ventas
      // alcanzan para decir qué anunciar. Lo que se pierde es el "ya lo estás anunciando".
      errorAds = e.sinAcceso ? 'La cuenta no tiene perfil de anunciante en MELI Ads.' : e.message;
    }

    // ── 1. Datos del CRM ─────────────────────────────────────────────────────────
    const supabase = getSupabase();
    const desdeVentas = aFecha(sumarDias(new Date(rango.desde), -largo));

    const [{ data: productos, error: errProd }, { data: ventasRaw, error: errV }, economia] = await Promise.all([
      supabase.from('productos')
        .select('sku, nombre, costo, precio, stock_dep, stock_meli, discontinuado, meli_id, meli_ids, fecha_publicacion')
        .limit(5000),
      supabase.from('ventas').select('sku, cantidad, total, fecha, canal, estado')
        .gte('fecha', desdeVentas).limit(50000),
      cargarEconomia(supabase, { envio: req.query.envio === undefined ? 'auto' : req.query.envio }),
    ]);
    if (errProd) throw errProd;
    if (errV) throw errV;

    // Ventas de MELI partidas en las dos mismas ventanas que las métricas de ads.
    const ventas = (ventasRaw || []).filter(v =>
      /meli/i.test(v.canal || '') && (v.estado || '') !== 'cancelada' && v.sku
    );
    const ventasPorSku = new Map();
    for (const v of ventas) {
      const sku = normSku(v.sku);
      if (!ventasPorSku.has(sku)) ventasPorSku.set(sku, { ahora: 0, antes: 0, facturacion_ahora: 0 });
      const a = ventasPorSku.get(sku);
      const unidades = Math.max(1, ent(v.cantidad));
      if (v.fecha >= rango.desde && v.fecha <= rango.hasta) {
        a.ahora += unidades;
        a.facturacion_ahora += num(v.total);
      } else if (v.fecha < rango.desde) {
        a.antes += unidades;
      }
    }

    // ── 2. Lo que está y estuvo anunciado ────────────────────────────────────────
    const porMeliId = new Map();
    for (const p of productos || []) {
      for (const id of [p.meli_id, ...(p.meli_ids || [])]) {
        if (id) porMeliId.set(String(id).trim().toUpperCase(), p);
      }
    }

    const adsPorSku = new Map();   // sku -> { ahora, antes, status, titulo, ad_group_id }
    let adGroupsLeidos = 0;
    let adsIncompleto = null;

    if (ctx) {
      try {
        const [gruposAhora, gruposAntes] = await Promise.all([
          traerAdGroups(ctx, rango.desde, rango.hasta),
          hayPrevio ? traerAdGroups(ctx, previoRango.desde, previoRango.hasta) : Promise.resolve([]),
        ]);
        adGroupsLeidos = gruposAhora.length;

        // Las publicaciones de cada ad group salen de una llamada por grupo; se resuelven
        // una sola vez sobre la unión de las dos ventanas.
        const union = new Map();
        for (const g of [...gruposAhora, ...gruposAntes]) {
          if (!union.has(String(g.id))) union.set(String(g.id), g);
        }
        // Cada id dispara una llamada a MELI: la unión de las dos ventanas se acota igual
        // que cada una por separado, o una cuenta grande se come el tiempo del lambda.
        const ids = [...union.keys()].slice(0, MAX_AD_GROUPS);
        if (union.size > ids.length) {
          adsIncompleto = `Se resolvieron ${ids.length} de ${union.size} anuncios; puede faltar alguno.`;
        }
        const itemsPorGrupo = await enLotes(ids, CONCURRENCIA, async (id) => {
          const r = await adsGet(
            `${API}/advertising/${ctx.siteId}/product_ads/ad_groups/${id}/ads`
            + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=clicks`,
            ctx.headers
          );
          return r.ok ? (r.body.results || []).map(a => a.item_id).filter(Boolean) : [];
        });

        const skuDeGrupo = new Map();
        ids.forEach((id, i) => {
          const producto = (itemsPorGrupo[i] || [])
            .map(it => porMeliId.get(String(it).toUpperCase()))
            .find(Boolean);
          if (producto) skuDeGrupo.set(id, normSku(producto.sku));
        });

        const acumular = (grupos, ventana) => {
          for (const g of grupos) {
            const sku = skuDeGrupo.get(String(g.id));
            if (!sku) continue;
            if (!adsPorSku.has(sku)) {
              adsPorSku.set(sku, {
                ahora: { clics: 0, impresiones: 0, inversion: 0, facturacion: 0, unidades: 0, roas: 0 },
                antes: { clics: 0, impresiones: 0, inversion: 0, facturacion: 0, unidades: 0, roas: 0 },
                status: g.status || null,
                titulo: g.title || null,
                ad_group_id: String(g.id),
              });
            }
            const a = adsPorSku.get(sku);
            const m = metricas(g);
            // Un SKU puede tener más de un ad group (dos campañas, dos publicaciones):
            // se suman, y el ROAS se recalcula sobre los totales.
            for (const k of ['clics', 'impresiones', 'inversion', 'facturacion', 'unidades']) {
              a[ventana][k] += m[k];
            }
            a[ventana].roas = a[ventana].inversion > 0
              ? r2(a[ventana].facturacion / a[ventana].inversion) : 0;
            if (ventana === 'ahora' && g.status) a.status = g.status;
          }
        };
        acumular(gruposAhora, 'ahora');
        acumular(gruposAntes, 'antes');

        if (!adsIncompleto && adGroupsLeidos >= MAX_AD_GROUPS) {
          adsIncompleto = `Se leyeron los ${MAX_AD_GROUPS} anuncios de mayor gasto; puede faltar alguno.`;
        }
      } catch (e) {
        errorAds = e.message;
      }
    }

    // ── 3. Una recomendación por producto ────────────────────────────────────────
    const mesesVentana = largo / 30;
    const candidatos = [];
    const descartados = { discontinuados: 0, sin_costo: 0, sin_publicar: 0 };

    for (const p of productos || []) {
      if (p.discontinuado) { descartados.discontinuados += 1; continue; }

      const sku = normSku(p.sku);
      const publicado = !!(p.meli_id || (p.meli_ids || []).length);
      if (!publicado) { descartados.sin_publicar += 1; continue; }

      const costo = num(p.costo);
      const precio = num(p.precio);
      if (costo <= 0 || precio <= 0) { descartados.sin_costo += 1; continue; }

      const eco = deSku(economia, p.sku);
      const c = contribucionUnitaria({
        precio, costo,
        comision_pct: eco.comision_pct,
        envio_unitario: eco.envio_unitario,
      });

      const ads = adsPorSku.get(sku) || null;
      const ahora = ads?.ahora || { clics: 0, inversion: 0, unidades: 0, facturacion: 0, roas: 0, impresiones: 0 };
      const antes = ads?.antes || { clics: 0, inversion: 0, unidades: 0, facturacion: 0, roas: 0, impresiones: 0 };
      const vts = ventasPorSku.get(sku) || { ahora: 0, antes: 0, facturacion_ahora: 0 };

      const stock = ent(p.stock_dep);
      const stockPublicado = ent(p.stock_meli);
      // Unidades que se vendieron sin que las trajera un anuncio. Es la señal más fuerte
      // de que un producto tiene demanda propia: si se vende sin pagar por el tráfico,
      // pagarlo debería multiplicarlo, no inventarlo.
      const organicas = Math.max(0, vts.ahora - ahora.unidades);
      const rotacionMensual = mesesVentana > 0 ? vts.ahora / mesesVentana : 0;
      const mesesStock = rotacionMensual > 0 ? stock / rotacionMensual : (stock > 0 ? Infinity : 0);

      const anunciado = ahora.inversion > 0;
      const anunciadoAntes = antes.inversion > 0;
      const activo = String(ads?.status || '').toUpperCase() === 'ACTIVE';
      const be = c.roas_breakeven;
      // Muestra suficiente para juzgar un anuncio: o gastó más de una contribución entera
      // o juntó clics como para que el silencio signifique algo.
      const juzgable = ahora.clics >= UMBRALES.clics_para_juzgar
        || (c.contribucion > 0 && ahora.inversion >= c.contribucion);

      const base = {
        sku: p.sku,
        nombre: p.nombre,
        precio: r2(precio),
        costo: r2(costo),
        comision_pct: eco.comision_pct,
        envio_unitario: eco.envio_unitario,
        economia_fuente: eco.fuente,
        contribucion: c.contribucion,
        margen: c.margen_pct,
        roas_breakeven: be,
        stock, stock_publicado: stockPublicado,
        meses_stock: mesesStock === Infinity ? null : r2(mesesStock),
        unidades_periodo: vts.ahora,
        unidades_organicas: organicas,
        unidades_previas: vts.antes,
        ads: ads ? { ahora, antes, status: ads.status, ad_group_id: ads.ad_group_id } : null,
        anunciado,
      };

      // Las reglas, en orden de prioridad. La primera que encaja manda; el resto se
      // guardan como motivos secundarios para que la tarjeta pueda decir "además...".
      const reglas = [];

      // ── Plata que se está perdiendo ahora ──────────────────────────────────────
      if (anunciado && stock <= 0) {
        reglas.push({
          motivo: 'anunciado_sin_stock',
          accion: 'Pausar ya',
          urgencia: 'alta',
          detalle: `Gastaste ${r2(ahora.inversion)} en ads de un producto sin stock en el depósito.`,
          plata: r2(ahora.inversion),
        });
      }
      if (be == null) {
        reglas.push({
          motivo: 'sin_margen',
          accion: anunciado ? 'Pausar y revisar el precio' : 'No anunciar',
          urgencia: anunciado ? 'alta' : 'baja',
          detalle: `A ${r2(precio)} no queda nada: costo ${r2(costo)} + comisión ${eco.comision_pct}%`
            + (eco.envio_unitario ? ` + envío ${eco.envio_unitario}` : '')
            + ` se comen el precio entero. Ningún ROAS lo salva.`,
          plata: r2(ahora.inversion),
        });
      } else if (anunciado && juzgable && ahora.roas > 0 && ahora.roas < be) {
        const perdido = r2(ahora.inversion - c.contribucion * ahora.unidades);
        reglas.push({
          motivo: 'perdiendo',
          accion: 'Pausar o bajar la puja',
          urgencia: 'alta',
          detalle: `ROAS ${ahora.roas.toFixed(2)}x contra un equilibrio de ${be.toFixed(2)}x.`
            + ` Lleva ${perdido > 0 ? `${perdido} perdidos` : 'apenas por debajo'} en el período.`,
          plata: Math.max(0, perdido),
        });
      } else if (anunciado && juzgable && ahora.unidades === 0) {
        reglas.push({
          motivo: 'quema_sin_vender',
          accion: 'Revisar la publicación',
          urgencia: 'alta',
          detalle: `${ahora.clics} clics y ${r2(ahora.inversion)} gastados sin una sola venta.`
            + ` El tráfico llega y no compra: precio, fotos o ficha.`,
          plata: r2(ahora.inversion),
        });
      }

      // ── Plata que se está dejando de ganar ─────────────────────────────────────
      if (anunciado && be != null && ahora.roas >= be * UMBRALES.holgura_escalar && ahora.unidades > 0 && stock > 0) {
        reglas.push({
          motivo: 'escalar',
          accion: 'Subir presupuesto',
          urgencia: 'media',
          detalle: `ROAS ${ahora.roas.toFixed(2)}x contra un equilibrio de ${be.toFixed(2)}x:`
            + ` cada peso de ads deja ${r2(c.margen_pct / 100 * ahora.roas - 1)} limpios.`
            + ` Hay ${stock} unidades para sostenerlo.`,
          plata: r2(c.contribucion * ahora.unidades - ahora.inversion),
        });
      }
      if (!anunciado && anunciadoAntes && be != null && antes.roas >= be && antes.unidades > 0) {
        reglas.push({
          motivo: 'se_apago_y_andaba',
          accion: 'Volver a prenderlo',
          urgencia: 'alta',
          detalle: `Entre ${previoRango.desde} y ${previoRango.hasta} invertiste ${r2(antes.inversion)}`
            + ` a ROAS ${antes.roas.toFixed(2)}x (equilibrio ${be.toFixed(2)}x) y vendió ${antes.unidades} unidades.`
            + ` En este período no gastó nada.`,
          plata: r2(c.contribucion * antes.unidades - antes.inversion),
        });
      }
      if (!anunciado && organicas >= UMBRALES.unidades_ganador && be != null && stock > 0) {
        reglas.push({
          motivo: 'ganador_sin_anunciar',
          accion: 'Empezar a anunciar',
          urgencia: 'alta',
          detalle: `Vendió ${organicas} unidades sin un peso de publicidad, con ${c.margen_pct}% de margen.`
            + ` Se vende solo: con ads debería vender más.`,
          plata: r2(c.contribucion * organicas),
        });
      }
      if (!anunciado && be != null && be <= 2.5 && organicas < UMBRALES.unidades_ganador && stock > 0) {
        reglas.push({
          motivo: 'margen_alto_sin_probar',
          accion: 'Probar con poco',
          urgencia: 'baja',
          detalle: `${c.margen_pct}% de margen y nunca se anunció. Aguanta hasta ${r2(c.contribucion)}`
            + ` por venta: con ${be.toFixed(2)}x de ROAS ya empata.`,
          plata: r2(c.contribucion * Math.max(1, Math.round(rotacionMensual))),
        });
      }
      if (!anunciado && be != null && stock > 0 && mesesStock !== Infinity
          && mesesStock >= UMBRALES.meses_stock_dormido && vts.ahora > 0) {
        reglas.push({
          motivo: 'stock_dormido',
          accion: 'Anunciar para rotar',
          urgencia: 'media',
          detalle: `${stock} unidades y ${r2(mesesStock)} meses de stock al ritmo actual.`
            + ` Cada venta deja ${r2(c.contribucion)}: ads lo mueve más rápido que esperar.`,
          plata: r2(c.contribucion * stock),
        });
      }
      if (!anunciado && stock > 0 && vts.ahora === 0 && vts.antes === 0 && be != null) {
        reglas.push({
          motivo: 'nunca_vendio',
          accion: 'Probar o descatalogar',
          urgencia: 'baja',
          detalle: `${stock} unidades inmovilizadas (${r2(stock * costo)} de capital) sin una venta`
            + ` en los últimos ${largo * 2} días. Ads le da una chance antes de darlo por perdido.`,
          plata: r2(stock * costo),
        });
      }
      if (be != null && be > UMBRALES.roas_be_inviable && !reglas.some(r => r.motivo === 'sin_margen')) {
        reglas.push({
          motivo: 'margen_flaco',
          accion: anunciado ? 'Subir precio o apagar' : 'Arreglar el precio antes de anunciar',
          urgencia: anunciado ? 'media' : 'baja',
          detalle: `Haría falta ROAS ${be.toFixed(2)}x para empatar, muy por encima de lo que rinde`
            + ` la cuenta. Con ${c.margen_pct}% de margen, ads no cierra.`,
          plata: r2(ahora.inversion),
        });
      }

      if (!reglas.length) continue;

      // El orden dentro del producto: primero lo urgente, después lo que mueve más plata.
      const peso = { alta: 3, media: 2, baja: 1 };
      reglas.sort((a, b) => (peso[b.urgencia] - peso[a.urgencia]) || (b.plata - a.plata));
      const principal = reglas[0];

      candidatos.push({
        ...base,
        motivo: principal.motivo,
        accion: principal.accion,
        urgencia: principal.urgencia,
        detalle: principal.detalle,
        plata_en_juego: principal.plata,
        // El score ordena el tablero entero: la urgencia manda, la plata desempata.
        score: r2(peso[principal.urgencia] * 1000 + Math.min(principal.plata, 999)),
        otros_motivos: reglas.slice(1).map(r => ({ motivo: r.motivo, detalle: r.detalle })),
      });
    }

    candidatos.sort((a, b) => b.score - a.score);

    // ── 4. Resumen por motivo, para las pestañas de la pantalla ──────────────────
    const porMotivo = {};
    for (const c of candidatos) {
      if (!porMotivo[c.motivo]) porMotivo[c.motivo] = { motivo: c.motivo, productos: 0, plata: 0 };
      porMotivo[c.motivo].productos += 1;
      porMotivo[c.motivo].plata = r2(porMotivo[c.motivo].plata + c.plata_en_juego);
    }

    return res.json({
      ok: true,
      periodo: { desde: rango.desde, hasta: rango.hasta, dias: largo },
      periodo_previo: hayPrevio ? { desde: previoRango.desde, hasta: previoRango.hasta } : null,
      recortado: rango.recortado,
      currency: ctx?.currency || 'UYU',
      // Sin acceso a Ads las recomendaciones siguen saliendo, pero no se puede saber qué
      // está anunciado: decirlo evita que "nunca se anunció" se lea como un hecho.
      ads_disponible: !!ctx && !errorAds,
      error_ads: errorAds,
      ads_incompleto: adsIncompleto,
      economia: {
        comision_pct: economia.global.comision_pct,
        envio_unitario: economia.global.envio_unitario,
        envios: economia.envios,
      },
      umbrales: UMBRALES,
      resumen: {
        catalogo: (productos || []).length,
        evaluados: (productos || []).length - descartados.discontinuados - descartados.sin_publicar - descartados.sin_costo,
        con_recomendacion: candidatos.length,
        anuncios_leidos: adGroupsLeidos,
        skus_anunciados: adsPorSku.size,
        descartados,
        por_motivo: Object.values(porMotivo).sort((a, b) => b.plata - a.plata),
      },
      recomendaciones: candidatos,
    });

  } catch (err) {
    console.error('Error en ads-recomendaciones.js:', err);
    return res.status(500).json({ ok: false, error: err.message, detalle: err.detalle });
  }
};
