// api/meli/debug-shipment.js
// GET /api/meli/debug-shipment?orden_id=XXX
// Devuelve los datos crudos del shipment para diagnosticar costos de envío

const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { orden_id } = req.query;
  if (!orden_id) return res.status(400).json({ error: 'Falta orden_id' });

  try {
    const token = await getMeliToken();

    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orden_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const order = await orderRes.json();
    if (order.error) return res.status(400).json({ error: order.message });

    const shippingId = order.shipping?.id;
    let shipData = null;
    if (shippingId) {
      const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      shipData = await shipRes.json();
    }

    const paymentId = (order.payments || []).find(p => p.status === 'approved')?.id;
    let payData = null;
    if (paymentId) {
      const payRes = await fetch(`https://api.mercadolibre.com/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      payData = await payRes.json();
    }

    return res.json({
      orden_id,
      order_status: order.status,
      order_items: order.order_items?.map(i => ({ id: i.item?.id, title: i.item?.title, price: i.unit_price, qty: i.quantity, sale_fee: i.sale_fee })),
      shipping_id: shippingId,
      shipping_option: shipData?.shipping_option,
      logistic_type: shipData?.logistic_type,
      base_cost: shipData?.base_cost,
      receiver_shipping_cost: shipData?.receiver_shipping_cost,
      shipping_mode: shipData?.mode,
      payment_id: paymentId,
      net_received_amount: payData?.net_received_amount,
      marketplace_fee: payData?.marketplace_fee,
      gross_total: order.order_items?.reduce((s, i) => s + i.unit_price * i.quantity, 0),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
