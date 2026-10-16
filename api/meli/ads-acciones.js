// api/meli/ads-acciones.js
// POST /api/meli/ads-acciones
//
// Aplica en Mercado Ads lo que la pestaña recomienda, para no tener que ir a MELI a hacerlo
// a mano. Dos niveles:
//
//   { nivel: 'campana', campaign_id, campaign_name,
//     cambios: { presupuesto?, roas_objetivo?, estado? },   ← lo nuevo
//     anterior: { presupuesto?, roas_objetivo?, estado? } } ← lo que había, para el registro
//
//   { nivel: 'anuncio', ad_group_id, titulo, campaign_id, campaign_name,
//     cambios: { estado: 'paused' | 'active' }, anterior: { estado } }
//
// Toca plata real, así que la pantalla siempre confirma antes de llamar. Si MELI rechaza
// el cambio, la respuesta trae su mensaje tal cual: es lo único que dice qué campo o qué
// valor no aceptó.
//
// MELI configura las campañas por ACOS objetivo (gasto / facturación). La pantalla habla
// en ROAS, que es el inverso, así que acá se convierte: ROAS 4x = ACOS 25%.
//
// Cada cambio aplicado queda en meli_ads_cambios (si la migración corrió), que es lo que
// alimenta el "antes y después".

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsPut, API } = require('./_adsClient');
const { registrarCambios } = require('./ads-cambios');

const r2 = v => Math.round(v * 100) / 100;
const ESTADOS = ['active', 'paused'];

/** El cuerpo que se le manda a MELI para una campaña. Exportado para testearlo. */
function cuerpoCampana(cambios) {
  const body = {};
  if (cambios.presupuesto != null) {
    const p = parseFloat(cambios.presupuesto);
    if (!(p > 0)) throw new Error('El presupuesto diario tiene que ser mayor a 0.');
    body.budget = r2(p);
  }
  if (cambios.roas_objetivo != null) {
    const roas = parseFloat(cambios.roas_objetivo);
    if (!(roas > 0)) throw new Error('El ROAS objetivo tiene que ser mayor a 0.');
    body.acos_target = r2(100 / roas);
  }
  if (cambios.estado != null) {
    if (!ESTADOS.includes(cambios.estado)) throw new Error('Estado inválido.');
    body.status = cambios.estado;
  }
  if (!Object.keys(body).length) throw new Error('No hay nada para cambiar.');
  return body;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const cambios = b.cambios || {};
  const anterior = b.anterior || {};

  let url, cuerpo;
  try {
    if (b.nivel === 'campana') {
      if (!b.campaign_id) throw new Error('Falta la campaña.');
      cuerpo = cuerpoCampana(cambios);
    } else if (b.nivel === 'anuncio') {
      if (!b.ad_group_id) throw new Error('Falta el anuncio.');
      if (!ESTADOS.includes(cambios.estado)) throw new Error('A un anuncio sólo se le puede cambiar el estado.');
      // Los ad groups vienen de MELI con el estado en mayúsculas (ACTIVE / PAUSED).
      cuerpo = { status: cambios.estado.toUpperCase() };
    } else {
      throw new Error('Nivel inválido.');
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  try {
    let ctx;
    try {
      ctx = await getAdsContext();
    } catch (e) {
      return res.json({ ok: false, sin_acceso: !!e.sinAcceso, error: e.message || 'MELI no conectado' });
    }

    url = b.nivel === 'campana'
      ? `${API}/advertising/${ctx.siteId}/product_ads/campaigns/${encodeURIComponent(b.campaign_id)}`
      : `${API}/advertising/${ctx.siteId}/product_ads/ad_groups/${encodeURIComponent(b.ad_group_id)}`;

    const r = await adsPut(url, ctx.headers, cuerpo);
    if (!r.ok) {
      return res.json({
        ok: false,
        error: `MELI rechazó el cambio (${r.status}): ${r.body?.message || r.body?.error || r.body?.raw || 'sin detalle'}`,
        detalle: r.body,
        enviado: cuerpo,
      });
    }

    // El registro es lo que permite ver después si el cambio sirvió. Que falle no deshace
    // el cambio en MELI, así que se avisa sin devolver error.
    const hoy = new Date().toISOString().slice(0, 10);
    const filas = Object.keys(cambios).filter(k => cambios[k] != null).map(campo => ({
      fecha: hoy,
      nivel: b.nivel,
      campaign_id: b.campaign_id ? String(b.campaign_id) : null,
      campaign_name: b.campaign_name || null,
      ad_group_id: b.ad_group_id ? String(b.ad_group_id) : null,
      titulo: b.titulo || null,
      campo,
      valor_anterior: anterior[campo] == null ? null : String(anterior[campo]),
      valor_nuevo: String(cambios[campo]),
      origen: 'crm',
      nota: b.nota || null,
    }));
    const reg = await registrarCambios(getSupabase(), filas);

    return res.json({
      ok: true,
      enviado: cuerpo,
      respuesta: r.body,
      registrado: reg.ok,
      aviso_registro: reg.sin_tabla
        ? 'El cambio se aplicó en MELI, pero no quedó registrado: falta correr la migración 20261016000000_add_ads_cambios.sql.'
        : reg.ok ? null : `El cambio se aplicó en MELI, pero no se pudo registrar: ${reg.error}`,
    });
  } catch (err) {
    console.error('Error en ads-acciones.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.cuerpoCampana = cuerpoCampana;
