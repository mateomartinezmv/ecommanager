// api/cron/sync-envios.js
// Cron — cada 30 minutos.
//
// Red de contención del webhook de `shipments`: si MELI no notifica (o la
// notificación falla), los envíos quedarían congelados en "pendiente" aunque el
// paquete ya esté en camino o entregado. Acá se vuelve a preguntar por los
// envíos que todavía no llegaron.
//
// De paso, lo mismo con los pedidos de Shopify: si un webhook no llegó, el
// pedido se trae igual en la próxima pasada (ver api/shopify/notify.js).

const { sincronizarEnviosMeli } = require('../meli/sync-envios');
const { sincronizarPedidosShopify } = require('../shopify/notify');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Shopify va primero y por separado: son unos pocos pedidos y entra en un par de
    // segundos, mientras que MELI puede llegar al límite de la función. Un problema con
    // Shopify tampoco tiene que tirar la reconciliación de MELI.
    let shopify;
    try {
      shopify = await sincronizarPedidosShopify({ dias: 3 });
      console.log(`sync-envios · Shopify: ${shopify.revisados} pedidos | ${shopify.nuevos} nuevos | ${shopify.actualizados} actualizados | ${shopify.errores} errores`);
      for (const linea of shopify.log) console.log(linea);
    } catch (err) {
      console.error('sync-envios · Shopify:', err.message);
      shopify = { error: err.message };
    }

    // limit 60: dos llamadas a MELI por orden entran holgadas en los 60s de la
    // función, y la cola real de envíos abiertos es de una decena.
    const r = await sincronizarEnviosMeli({ dias: 45, limit: 60 });
    console.log(`sync-envios: ${r.actualizados} actualizados | ${r.sinCambio} sin cambio | ${r.errores} errores`);
    for (const linea of r.log) console.log(linea);

    return res.json({
      ok: true,
      actualizados: r.actualizados,
      sinCambio: r.sinCambio,
      errores: r.errores,
      cambios: r.cambios,
      shopify,
    });
  } catch (err) {
    console.error('Error en sync-envios.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
