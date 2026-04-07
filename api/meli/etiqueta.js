// api/meli/etiqueta.js
// GET /api/meli/etiqueta?orden=ORDEN_MELI_ID
// Obtiene la etiqueta PDF de envío de Mercado Libre y la devuelve al browser

'use strict';

const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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
