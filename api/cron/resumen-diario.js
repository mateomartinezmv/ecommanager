// api/cron/resumen-diario.js
// Cron job — todos los días a las 13:00 UTC (10:00 Uruguay): el resumen del día anterior
// completo, de 00:00 a 23:59 en hora de Montevideo. Envíos y stock son los del momento.
//
// Del stock no manda la lista de todo lo que está bajo (era siempre la misma y no decía nada
// nuevo): sólo mira lo que se vendió ese día y avisa si se quedó sin stock o si lo que queda
// alcanza para menos de DIAS_COBERTURA días al ritmo de venta de los últimos 30.

const { getSupabase } = require('../_supabase');
const { esc, enviar } = require('../_telegram');
const { packsDisponibles } = require('../_packs');
const { llegadasCercanas } = require('../_stockRespuesta');

const DIAS_COBERTURA = 45;
const DIAS_RITMO = 30;
// Hasta cuándo mirar una importación en camino para decir "llega ~dd/mm".
const DIAS_LLEGADA = 120;

// El día de Montevideo, no el del servidor (UTC): a partir de las 21:00 de Uruguay en UTC ya
// es mañana, y el resumen salía vacío o con el día equivocado.
function hoyEnUruguay(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(fecha);
}

// "2026-11-15" → "2026-11-14"
function diaAnterior(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// "2026-11-15" → "domingo 15/11"
function fechaLarga(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ddmm = iso => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;
const unDecimal = n => n.toLocaleString('es-AR', { maximumFractionDigits: 1 });

// Lo vendido ese día que se quedó sin stock o al que le queda poco: { quiebres, cortos }.
// El ritmo sale de los últimos DIAS_RITMO días (incluido ese día), en packs, igual que el stock
// disponible: un par de sliders es una venta y dos unidades del depósito.
function stockDeLoVendido({ ventasDia, ventasRitmo, productos, llegadas = {} }) {
  const sumar = lista => {
    const t = {};
    for (const v of lista || []) {
      if (v.estado === 'cancelada' || !v.sku) continue;
      t[v.sku] = (t[v.sku] || 0) + (Number(v.cantidad) || 0);
    }
    return t;
  };
  const delDia = sumar(ventasDia);
  const delPeriodo = sumar(ventasRitmo);
  const porSku = new Map((productos || []).map(p => [p.sku, p]));

  const quiebres = [];
  const cortos = [];
  for (const [sku, vendidas] of Object.entries(delDia)) {
    const p = porSku.get(sku);
    if (!p || p.discontinuado) continue;   // lo descatalogado no se repone
    const disponibles = packsDisponibles(p.stock_dep, p);
    const porDia = Math.max(delPeriodo[sku] || 0, vendidas) / DIAS_RITMO;
    const fila = { sku, nombre: p.nombre, vendidas, disponibles, porDia, llegada: llegadas[sku] || null };
    if (disponibles <= 0) quiebres.push(fila);
    else {
      fila.dias = disponibles / porDia;
      if (fila.dias < DIAS_COBERTURA) cortos.push(fila);
    }
  }
  quiebres.sort((a, b) => b.vendidas - a.vendidas);
  cortos.sort((a, b) => a.dias - b.dias);
  return { quiebres, cortos };
}

const pesos = n => `$${Math.round(n || 0).toLocaleString('es-AR')}`;

const CANALES = [
  ['meli', '🟡 MELI'],
  ['shopify', '🛍️ Shopify'],
  ['mostrador', '🏪 Mostrador'],
];

function armarResumen({ fecha, ventas, envios, productos, ventasRitmo = [], llegadas = {} }) {
  // Las canceladas (devoluciones, pedidos de Shopify cancelados) no son ventas del día.
  const v = (ventas || []).filter(x => x.estado !== 'cancelada');
  let msg = `📦 <b>Resumen de ayer — ${fechaLarga(fecha)}</b>\n\n`;

  if (v.length === 0) {
    msg += `🛒 Sin ventas.\n`;
  } else {
    const ingresos = v.reduce((a, x) => a + (x.total || 0), 0);
    const comisiones = v.reduce((a, x) => a + (x.comision || 0), 0);
    const porCanal = CANALES
      .map(([canal, etiqueta]) => [etiqueta, v.filter(x => x.canal === canal).length])
      .filter(([, n]) => n > 0)
      .map(([etiqueta, n]) => `${etiqueta}: ${n}`);
    const otros = v.filter(x => !CANALES.some(([c]) => c === x.canal)).length;
    if (otros) porCanal.push(`Otros: ${otros}`);

    msg +=
      `💰 <b>Ingresos:</b> ${pesos(ingresos)}\n` +
      `🛒 <b>Ventas:</b> ${v.length} (${porCanal.join(' | ')})\n` +
      `💸 <b>Comisiones:</b> ${pesos(comisiones)}\n`;

    const porProducto = {};
    for (const x of v) {
      const p = (porProducto[x.producto] ||= { total: 0, cant: 0 });
      p.total += x.total || 0;
      p.cant += x.cantidad || 0;
    }
    const top = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total)[0];
    if (top) msg += `🏆 <b>Más vendido:</b> ${esc(top[0])} (${top[1].cant} uds)\n`;
  }

  const e = envios || [];
  const pendientes = e.filter(x => x.estado === 'pendiente').length;
  msg += `\n🚚 <b>Envíos activos ahora:</b> ${e.length}` +
    (e.length ? ` (⏳ sin despachar: ${pendientes} | en camino: ${e.length - pendientes})` : '');

  if (v.length) {
    const { quiebres, cortos } = stockDeLoVendido({ ventasDia: v, ventasRitmo, productos, llegadas });
    const llega = f => (f.llegada ? ` · llega ~${ddmm(f.llegada)}` : '');
    if (!quiebres.length && !cortos.length) {
      msg += `\n\n✅ <b>Stock:</b> lo que se vendió tiene para más de ${DIAS_COBERTURA} días.`;
    } else {
      msg += `\n\n⚠️ <b>Stock de lo que se vendió</b>`;
      for (const f of quiebres) {
        msg += `\n🔴 ${esc(f.nombre)}: <b>se quedó sin stock</b> (vendió ${f.vendidas})${llega(f)}`;
      }
      for (const f of cortos) {
        msg += `\n🟡 ${esc(f.nombre)}: quedan ${f.disponibles}, para ~${Math.max(1, Math.round(f.dias))} días` +
          ` (vende ${unDecimal(f.porDia)} por día)${llega(f)}`;
      }
    }
  }

  return msg;
}

module.exports = async (req, res) => {
  // Vercel solo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  // El día que terminó anoche a las 23:59 en Montevideo.
  const fecha = diaAnterior(hoyEnUruguay());

  try {
    const [ventasRes, ritmoRes, enviosRes, productosRes, llegadas] = await Promise.all([
      supabase.from('ventas').select('sku, canal, estado, producto, cantidad, total, comision').eq('fecha', fecha),
      supabase.from('ventas').select('sku, cantidad, estado')
        .gte('fecha', sumarDias(fecha, -(DIAS_RITMO - 1))).lte('fecha', fecha),
      supabase.from('envios').select('estado').in('estado', ['pendiente', 'en_camino']),
      supabase.from('productos').select('sku, nombre, stock_dep, unidades_por_venta, discontinuado'),
      llegadasCercanas(supabase, new Date(), DIAS_LLEGADA),
    ]);
    const error = ventasRes.error || ritmoRes.error || enviosRes.error || productosRes.error;
    if (error) throw new Error(error.message);

    await enviar(armarResumen({
      fecha,
      ventas: ventasRes.data,
      ventasRitmo: ritmoRes.data,
      envios: enviosRes.data,
      productos: productosRes.data,
      llegadas,
    }));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error en resumen diario:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.armarResumen = armarResumen;
module.exports.hoyEnUruguay = hoyEnUruguay;
module.exports.diaAnterior = diaAnterior;
module.exports.stockDeLoVendido = stockDeLoVendido;
