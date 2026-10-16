// api/meli/ads-cambios.js
// GET  /api/meli/ads-cambios            → los cambios registrados, con su antes y después
// POST /api/meli/ads-cambios            → registra a mano un cambio hecho directo en MELI
//      { nivel, campaign_id, campaign_name, ad_group_id, titulo, campo, valor_anterior, valor_nuevo, fecha, nota }
//
// Los cambios aplicados desde el CRM (api/meli/ads-acciones.js) se registran solos. Este
// endpoint los lee y les suma el antes y después desde el snapshot diario por anuncio,
// para poder contestar "¿subirle el presupuesto a esa campaña sirvió?".

const { getSupabase } = require('../_supabase');
const { cargarEconomia, deSku, contribucionUnitaria } = require('./_economia');
const { antesYDespues, VENTANA_DIAS, sumarDias } = require('./_adsCambios');

const LIMITE = 40;
const CAMPOS = ['presupuesto', 'roas_objetivo', 'estado'];

const faltaTabla = (error, tabla) =>
  error && (error.code === '42P01' || error.code === 'PGRST205' || new RegExp(tabla).test(error.message || ''));

async function registrarCambios(supabase, filas) {
  if (!filas.length) return { ok: true };
  const { error } = await supabase.from('meli_ads_cambios').insert(filas);
  if (faltaTabla(error, 'meli_ads_cambios')) return { ok: false, sin_tabla: true };
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const SIN_TABLA = {
    ok: false, sin_tabla: true,
    mensaje: 'Falta correr la migración 20261016000000_add_ads_cambios.sql para registrar los cambios.',
  };

  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!CAMPOS.includes(b.campo)) return res.status(400).json({ ok: false, error: 'Campo inválido' });
      if (!['campana', 'anuncio'].includes(b.nivel)) return res.status(400).json({ ok: false, error: 'Nivel inválido' });
      const r = await registrarCambios(supabase, [{
        fecha: b.fecha || new Date().toISOString().slice(0, 10),
        nivel: b.nivel,
        campaign_id: b.campaign_id || null, campaign_name: b.campaign_name || null,
        ad_group_id: b.ad_group_id || null, titulo: b.titulo || null,
        campo: b.campo,
        valor_anterior: b.valor_anterior == null ? null : String(b.valor_anterior),
        valor_nuevo: b.valor_nuevo == null ? null : String(b.valor_nuevo),
        origen: 'manual', nota: b.nota || null,
      }]);
      if (r.sin_tabla) return res.json(SIN_TABLA);
      return res.json(r);
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { data: cambios, error } = await supabase.from('meli_ads_cambios')
      .select('*').order('fecha', { ascending: false }).order('id', { ascending: false }).limit(LIMITE);
    if (faltaTabla(error, 'meli_ads_cambios')) return res.json(SIN_TABLA);
    if (error) throw error;
    if (!cambios?.length) return res.json({ ok: true, cambios: [] });

    const hoy = new Date().toISOString().slice(0, 10);
    const desde = sumarDias(cambios.map(c => String(c.fecha).slice(0, 10)).sort()[0], -VENTANA_DIAS);

    const [{ data: snapshot, error: errS }, { data: productos, error: errP }, economia] = await Promise.all([
      supabase.from('meli_ads_anuncios')
        .select('fecha, campaign_id, ad_group_id, sku, spend, facturacion, unidades')
        .gte('fecha', desde).limit(100000),
      supabase.from('productos').select('sku, costo, precio'),
      cargarEconomia(supabase),
    ]);
    if (errP) throw errP;
    const sinSnapshot = faltaTabla(errS, 'meli_ads_anuncios');
    if (errS && !sinSnapshot) throw errS;

    // Lo que deja cada venta de cada SKU, con la misma cuenta que la tabla de anuncios.
    const contrib = new Map();
    for (const p of productos || []) {
      if (!p.sku || !(parseFloat(p.costo) > 0) || !(parseFloat(p.precio) > 0)) continue;
      const e = deSku(economia, p.sku);
      contrib.set(String(p.sku).trim().toUpperCase(), contribucionUnitaria({
        precio: p.precio, costo: p.costo, comision_pct: e.comision_pct, envio_unitario: e.envio_unitario,
      }).contribucion);
    }

    return res.json({
      ok: true,
      sin_snapshot: sinSnapshot,
      ventana_dias: VENTANA_DIAS,
      cambios: cambios.map(c => ({ ...c, ...antesYDespues(c, snapshot || [], contrib, hoy) })),
    });
  } catch (err) {
    console.error('Error en ads-cambios.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.registrarCambios = registrarCambios;
