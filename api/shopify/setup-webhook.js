// api/shopify/setup-webhook.js
// GET /api/shopify/setup-webhook → registra el webhook de órdenes en Shopify
// Ejecutar una sola vez después del deploy

const { getShopifyToken } = require('../_shopifyToken');

module.exports = async (req, res) => {
  try {
    const token = await getShopifyToken();
    const SHOP = 'martinez-motos.myshopify.com';
    const CALLBACK_URL = 'https://ecommanager.vercel.app/api/shopify/notify';

    // Listar webhooks existentes
    const listRes = await fetch(`https://${SHOP}/admin/api/2024-01/webhooks.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });
    const listData = await listRes.json();
    const existentes = listData.webhooks || [];

    // Verificar si ya existe
    const yaExiste = existentes.find(w => w.address === CALLBACK_URL && w.topic === 'orders/paid');
    if (yaExiste) {
      return res.json({ ok: true, mensaje: 'Webhook ya estaba registrado ✅', webhook: yaExiste });
    }

    // Crear webhook para orders/paid
    const webhookRes = await fetch(`https://${SHOP}/admin/api/2024-01/webhooks.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        webhook: {
          topic: 'orders/paid',
          address: CALLBACK_URL,
          format: 'json',
        },
      }),
    });

    const webhookData = await webhookRes.json();
    if (webhookData.errors) throw new Error(JSON.stringify(webhookData.errors));

    res.json({
      ok: true,
      mensaje: 'Webhook registrado correctamente ✅',
      webhook: webhookData.webhook,
      webhooks_existentes: existentes.map(w => ({ topic: w.topic, address: w.address })),
    });

  } catch (err) {
    console.error('Error setup webhook Shopify:', err);
    res.status(500).json({ error: err.message });
  }
};
