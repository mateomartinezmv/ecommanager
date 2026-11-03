// api/meli/etiqueta.js
// GET /api/meli/etiqueta?orden=ORDEN_MELI_ID          → la etiqueta PDF de una orden (botón 📄 de Ventas)
// GET /api/meli/etiqueta?envios=E1,E2,…               → un solo PDF con las etiquetas de esos envíos del CRM
// GET /api/meli/etiqueta?envios=E1,E2,…&estado=1      → { estados: { E1: { impresa, imprimible, … } } }
//
// Las dos últimas son las de ✅ Control de despacho → 🖨️ (ver api/meli/_etiquetas.js).

'use strict';

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { MAX_ETIQUETAS, shipmentsDeEnvios, estadosDeEtiquetas, mensajeDeMeli } = require('./_etiquetas');

async function etiquetasDeEnvios(req, res) {
  const envioIds = [...new Set(String(req.query.envios).split(',').map(s => s.trim()).filter(Boolean))];
  if (!envioIds.length) return res.status(400).json({ error: 'No se eligió ningún envío.' });
  if (envioIds.length > MAX_ETIQUETAS) return res.status(400).json({ error: `MELI entrega hasta ${MAX_ETIQUETAS} etiquetas por vez.` });

  const token = await getMeliToken();
  const envios = await shipmentsDeEnvios(getSupabase(), token, envioIds);

  if (req.query.estado) {
    return res.json({ estados: await estadosDeEtiquetas(token, envios) });
  }

  const conShipment = envios.filter(e => e.shipmentId);
  const sinShipment = envios.filter(e => !e.shipmentId).map(e => e.envioId);
  if (!conShipment.length) {
    return res.status(404).json({ error: 'Ninguno de los envíos elegidos tiene envío de MELI asociado.', sinShipment });
  }

  const ids = conShipment.map(e => e.shipmentId).join(',');
  const labelRes = await fetch(
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${ids}&response_type=pdf`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const tipo = labelRes.headers.get('content-type') || '';
  if (!labelRes.ok || tipo.includes('application/json')) {
    const cuerpo = await labelRes.json().catch(() => null);
    return res.status(502).json({ error: `MELI no entregó las etiquetas: ${mensajeDeMeli(cuerpo, labelRes.status)}`, sinShipment });
  }

  const fecha = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="etiquetas-meli-${fecha}.pdf"`);
  if (sinShipment.length) res.setHeader('X-Etiquetas-Omitidas', sinShipment.join(','));
  res.send(Buffer.from(await labelRes.arrayBuffer()));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.query.envios !== undefined) {
    try { return await etiquetasDeEnvios(req, res); }
    catch (err) {
      console.error('Error en /api/meli/etiqueta (envios):', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  const ordenId = req.query.orden;
  if (!ordenId) return res.status(400).json({ error: 'Falta parámetro orden' });

  try {
    const token = await getMeliToken();

    // 1. Obtener la orden para extraer el shipping_id
    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${ordenId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const order = await orderRes.json();
    if (order.error) return res.status(404).json({ error: `Orden no encontrada: ${order.message}` });

    const shippingId = order.shipping?.id;
    if (!shippingId) return res.status(404).json({ error: 'Esta orden no tiene envío asociado' });

    // 2. Obtener la etiqueta PDF del shipment
    const labelRes = await fetch(
      `https://api.mercadolibre.com/shipments/${shippingId}/labels?response_type=pdf2&savePDF=Y`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!labelRes.ok) {
      return res.status(502).json({ error: `Error obteniendo etiqueta: ${labelRes.status} ${labelRes.statusText}` });
    }

    const contentType = labelRes.headers.get('content-type') || 'application/pdf';

    // Si MELI devuelve JSON con una URL de descarga, redirigir
    if (contentType.includes('application/json')) {
      const data = await labelRes.json();
      const pdfUrl = data?.print_url || data?.url || data?.download_url;
      if (pdfUrl) return res.redirect(302, pdfUrl);
      return res.status(502).json({ error: 'Respuesta inesperada de MELI', data });
    }

    // Si devuelve el PDF directamente, hacer proxy del stream
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="etiqueta_${shippingId}.pdf"`);

    const buffer = await labelRes.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error('Error en /api/meli/etiqueta:', err.message);
    res.status(500).json({ error: err.message });
  }
};
