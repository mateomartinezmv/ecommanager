// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// GET /api/meli/ads?dias=N
//
// Trae el gasto DIARIO de Mercado Ads y lo guarda en meli_ads_diario, una fila por día.
// Como la fecha es la clave primaria, volver a pedir un rango pisa los mismos registros en
// lugar de acumular: se puede recolectar las veces que haga falta sin ensuciar los datos.
//
// Límites de la API de MELI (verificados contra la API, no sólo la doc):
//   · Sólo sirve métricas de los últimos 90 días. Más atrás devuelve 400 y no hay forma de
//     recuperarlo, así que lo que no se capture dentro de esa ventana se pierde.
//   · El rango de un request no puede superar los 90 días.
//   · Las métricas del día se terminan de consolidar a las 10:00 GMT-3 del día siguiente.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const METRICS = 'clicks,prints,cost,direct_amount,indirect_amount,total_amount';
const VENTANA_DIAS = 90;

const aFecha = d => d.toISOString().slice(0, 10);
const hoyUTC = () => new Date();
const sumarDias = (d, n) => new Date(d.getTime() + n * 86400000);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const hoy = hoyUTC();
  // Un día de margen sobre los 90: el corte de MELI se mueve durante el día y pedir el
  // borde exacto devuelve 400 para todo el rango, no sólo para ese día.
  const masViejoDisponible = aFecha(sumarDias(hoy, -(VENTANA_DIAS - 1)));

  let desde, hasta;
  if (req.query.desde || req.query.hasta) {
    desde = req.query.desde || masViejoDisponible;
    hasta = req.query.hasta || aFecha(hoy);
  } else {
    const dias = Math.max(1, parseInt(req.query.dias || '7', 10));
    desde = aFecha(sumarDias(hoy, -(dias - 1)));
    hasta = aFecha(hoy);
  }

  // Recortar a lo que MELI puede contestar, avisando en la respuesta cuando se recortó.
  const desdePedido = desde;
  if (desde < masViejoDisponible) desde = masViejoDisponible;
  if (hasta > aFecha(hoy)) hasta = aFecha(hoy);
  if (desde > hasta) {
    return res.json({ ok: false, error: `Rango vacío: ${desde} es posterior a ${hasta}.` });
  }

  try {
    let token;
    try {
      token = await getMeliToken();
    } catch {
      return res.json({ ok: false, error: 'MELI no conectado' });
    }

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });

    const advRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${me.id}&product_id=PADS`,
      { headers: { ...headers, 'Api-Version': '1' } }
    );
    const advData = await advRes.json();
    if (!advRes.ok || !advData.advertisers?.length) {
      return res.json({ ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' });
    }
    const { advertiser_id: advertiserId, site_id: siteId } = advData.advertisers[0];

    // aggregation_type=DAILY devuelve un registro por día con las métricas planas (sin el
    // objeto "metrics" que usa la agregación por campaña) y sin discriminar campaña.
    const url = `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}`
      + `/product_ads/campaigns/search?date_from=${desde}&date_to=${hasta}`
      + `&metrics=${METRICS}&aggregation_type=DAILY&limit=200&offset=0`;

    const r = await fetch(url, { headers: { ...headers, 'Api-Version': '2' } });
    const text = await r.text();
    let body = {};
    if (text) { try { body = JSON.parse(text); } catch { body = { raw: text }; } }

    if (!r.ok) {
      return res.json({
        ok: false,
        error: `Error ${r.status} al pedir métricas diarias a MELI`,
        periodo: { desde, hasta },
        detalle: body,
      });
    }

    const dias = (body.results || []).map(d => ({
      fecha: d.date,
      spend: parseFloat(d.cost || 0),
      clicks: parseInt(d.clicks || 0, 10),
      impressions: parseInt(d.prints || 0, 10),
      facturacion: parseFloat(d.total_amount || 0),
    })).filter(d => d.fecha);

    if (dias.length) {
      const supabase = getSupabase();
      const currency = me.currency_id || (siteId === 'MLU' ? 'UYU' : 'USD');
      const fetchedAt = new Date().toISOString();
      const { error } = await supabase
        .from('meli_ads_diario')
        .upsert(dias.map(d => ({ ...d, currency, fetched_at: fetchedAt })), { onConflict: 'fecha' });
      if (error) throw error;
    }

    const totalSpend = dias.reduce((s, d) => s + d.spend, 0);
    const totalFact = dias.reduce((s, d) => s + d.facturacion, 0);

    return res.json({
      ok: true,
      periodo: { desde, hasta },
      recortado: desdePedido < desde ? { pedido: desdePedido, motivo: 'MELI sólo sirve 90 días de métricas' } : null,
      dias_guardados: dias.length,
      total_spend: totalSpend,
      total_facturacion: totalFact,
      roas: totalSpend > 0 ? parseFloat((totalFact / totalSpend).toFixed(2)) : 0,
      clicks: dias.reduce((s, d) => s + d.clicks, 0),
      impressions: dias.reduce((s, d) => s + d.impressions, 0),
      por_dia: dias,
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
