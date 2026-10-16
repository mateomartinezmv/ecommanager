// api/meli/ads-evolucion.js
// GET /api/meli/ads-evolucion?semanas=12
//
// El gasto en ads por semana y por SKU, desde el snapshot diario meli_ads_anuncios.
// La pestaña lo cruza con el segmento de margen de cada producto para ver cómo evoluciona
// cada campaña por margen (inversión, ROAS, ganancia) y si separar las campañas funcionó.
//
// Sale del snapshot local y no de MELI a propósito: es lo único que sobrevive a los 90
// días que sirve la API, y no gasta cuota de requests.

const { getSupabase } = require('../_supabase');

const r2 = v => Math.round(v * 100) / 100;
const num = v => parseFloat(v) || 0;

/** Lunes de la semana de una fecha YYYY-MM-DD, en UTC. */
function lunesDe(fecha) {
  const d = new Date(fecha + 'T00:00:00Z');
  const dia = (d.getUTCDay() + 6) % 7;   // 0 = lunes
  return new Date(d.getTime() - dia * 86400000).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const semanas = Math.min(52, Math.max(2, parseInt(req.query.semanas, 10) || 12));
  // Desde el lunes de hace N−1 semanas: así la primera semana entra entera.
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = lunesDe(new Date(Date.now() - (semanas - 1) * 7 * 86400000).toISOString().slice(0, 10));

  try {
    const supabase = getSupabase();
    // El límite explícito importa: PostgREST corta en 1000 filas y una tanda truncada no
    // da error, da una semana con la mitad del gasto.
    const { data, error } = await supabase.from('meli_ads_anuncios')
      .select('fecha, sku, campaign_id, spend, facturacion, unidades')
      .gte('fecha', desde)
      .lte('fecha', hoy)
      .limit(100000);
    if (error) {
      if (/meli_ads_anuncios/.test(error.message || '') || error.code === '42P01' || error.code === 'PGRST205') {
        return res.json({ ok: false, sin_tabla: true,
          mensaje: 'Falta correr la migración 20261001000000_add_ads_anuncios.sql: sin el snapshot diario no hay evolución.' });
      }
      throw error;
    }

    const acc = new Map();
    let sinSku = 0;
    for (const f of data || []) {
      if (!f.sku) { sinSku += num(f.spend); continue; }
      const semana = lunesDe(String(f.fecha).slice(0, 10));
      const sku = String(f.sku).trim().toUpperCase();
      const k = `${semana}|${sku}`;
      const a = acc.get(k) || { semana, sku, inversion: 0, facturacion: 0, unidades: 0 };
      a.inversion += num(f.spend);
      a.facturacion += num(f.facturacion);
      a.unidades += parseInt(f.unidades, 10) || 0;
      acc.set(k, a);
    }

    const filas = [...acc.values()]
      .map(a => ({ ...a, inversion: r2(a.inversion), facturacion: r2(a.facturacion) }))
      .sort((a, b) => a.semana.localeCompare(b.semana));

    return res.json({
      ok: true,
      desde, hasta: hoy, semanas,
      filas,
      // Gasto de anuncios que no se pudieron vincular a un SKU: no entra en ningún
      // segmento, y decirlo evita que el total por segmento parezca el de la cuenta.
      inversion_sin_sku: r2(sinSku),
    });
  } catch (err) {
    console.error('Error en ads-evolucion.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.lunesDe = lunesDe;
