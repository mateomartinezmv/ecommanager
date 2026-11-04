// api/meli/factura.js
// POST /api/meli/factura  { ventaId, pdf (base64), nombre }
//   → adjunta el PDF de la factura (eTicket de Gesta) a esa venta en MELI y marca todas las
//     líneas de la venta como facturadas, con la fecha en que se subió.
//
// La pantalla es Ventas → 📎 Subir facturas a MELI (ver api/meli/_facturaMeli.js).

'use strict';

const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');
const { mensajeDeMeli } = require('./_etiquetas');
const { packDeVenta, filtroDeVenta, pdfDesdeBase64, subirFacturaMeli } = require('./_facturaMeli');

// Si la migración de factura_meli_at todavía no corrió, la marca de facturada entra igual.
function faltaColumnaFacturaMeli(error) {
  return !!error && /factura_meli_at/.test(error.message || '');
}

async function marcarFacturada(supabase, venta, cuando) {
  const { columna, valor } = filtroDeVenta(venta);
  let { data, error } = await supabase.from('ventas')
    .update({ facturada: true, factura_meli_at: cuando })
    .eq(columna, valor).eq('canal', 'meli').select('id');
  if (error && faltaColumnaFacturaMeli(error)) {
    ({ data, error } = await supabase.from('ventas')
      .update({ facturada: true })
      .eq(columna, valor).eq('canal', 'meli').select('id'));
    if (!error) return { ids: (data || []).map(v => v.id), migracionPendiente: true };
  }
  if (error) throw error;
  return { ids: (data || []).map(v => v.id), migracionPendiente: false };
}

function handler({ getSupabaseImpl = getSupabase, getTokenImpl = getMeliToken, fetchImpl } = {}) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      const { ventaId, pdf: base64, nombre } = req.body || {};
      if (!ventaId) return res.status(400).json({ error: 'Falta la venta.' });

      let pdf;
      try { pdf = pdfDesdeBase64(base64); } catch (e) { return res.status(400).json({ error: e.message }); }

      const supabase = getSupabaseImpl();
      const { data: venta, error } = await supabase.from('ventas')
        .select('id, canal, orden_meli, pack_id').eq('id', ventaId).single();
      if (error || !venta) return res.status(404).json({ error: 'No encontré esa venta en el CRM.' });
      if (venta.canal !== 'meli') return res.status(400).json({ error: 'Esa venta no es de Mercado Libre.' });
      const pack = packDeVenta(venta);
      if (!pack) return res.status(400).json({ error: 'La venta no tiene número de orden de MELI.' });

      const token = await getTokenImpl();
      const r = await subirFacturaMeli({ token, pack, pdf, nombre, ...(fetchImpl ? { fetchImpl } : {}) });
      if (!r.ok) {
        return res.status(502).json({ error: `MELI no aceptó la factura: ${mensajeDeMeli(r.cuerpo, r.status)}`, pack });
      }

      const cuando = new Date().toISOString();
      const marca = await marcarFacturada(supabase, venta, cuando);
      console.log(`🧾 Factura subida a MELI: venta #${pack} (${marca.ids.length} línea/s)`);
      return res.json({ ok: true, pack, ventas: marca.ids, facturaMeliAt: cuando, meli: r.cuerpo,
        ...(marca.migracionPendiente ? { migracionPendiente: true } : {}) });
    } catch (err) {
      console.error('Error en /api/meli/factura:', err);
      return res.status(500).json({ error: err.message });
    }
  };
}

module.exports = handler();
module.exports.handler = handler;
