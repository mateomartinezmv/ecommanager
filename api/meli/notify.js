// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, stock)
// GET  /api/meli/notify → diagnóstico de conexión MELI

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleStatus(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topic, resource } = req.body || {};
  console.log('MELI notify:', topic, resource);

  const supabase = getSupabase();

  // Audit log — registrar ANTES de responder para no perder el evento
  try {
    await supabase.from('meli_notify_log').insert({
      topic: topic || null,
      resource: resource || null,
      recibido_at: new Date().toISOString(),
    });
  } catch (_) {}

  // Responder 200 de inmediato (MELI requiere respuesta en < 5s)
  res.status(200).json({ ok: true });

  // Procesar la notificación en background (Vercel continúa hasta maxDuration)
  try {
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource);
    } else if (topic === 'payments') {
      const token = await getMeliToken();
      const paymentId = (resource || '').replace('/collections/', '').split('/')[0];
      const payRes = await fetch(`https://api.mercadolibre.com/collections/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const pay = await payRes.json();
      if (pay.collection?.order_id) {
        await handleOrder(`/orders/${pay.collection.order_id}`);
      }
    }
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }
};

async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const orderId = resource.replace('/orders/', '').split('/')[0];
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const order = await orderRes.json();
  if (order.error) throw new Error(order.message);
  if (order.status !== 'paid') return;

  const shippingId = order.shipping?.id;
  let logisticType = '';
  let direccion = null;
  let costoEnvioReal = 0;

  if (shippingId) {
    try {
      const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const shipData = await shipRes.json();
      logisticType = shipData?.logistic_type || '';
      costoEnvioReal = shipData?.shipping_option?.list_cost || shipData?.base_cost || 0;
      if (shipData?.receiver_address) {
        const addr = shipData.receiver_address;
        direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`;
      }
    } catch (_) {}
  }

  const esFlex = FLEX_TYPES.includes(logisticType);
  const transportista = esFlex ? 'gestionpost' : 'mercado_envios';
  const costoEnvioFinal = esFlex ? costoEnvioReal : 0;

  const feeDetails = order.fee_details || [];
  const totalFee = feeDetails
    .filter(f => f.type === 'mercadopago_fee' || f.type === 'ml_fee')
    .reduce((s, f) => s + Math.abs(f.amount || 0), 0);
  const hasFeeDetails = totalFee > 0;
  const orderTotalCalc = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

  for (const item of order.order_items) {
    const meliItemId = item.item.id;
    const cantidad = item.quantity;

    let { data: producto } = await supabase
      .from('productos').select('*').eq('meli_id', meliItemId).single();

    if (!producto) {
      // Auto-crear producto para no perder la venta
      console.log(`⚠️ meli_id=${meliItemId} no encontrado — auto-creando`);
      const skuAuto = `MELI-${meliItemId}`;
      let nombreItem = item.item?.title || `Producto MELI ${meliItemId}`;
      try {
        const ir = await fetch(`https://api.mercadolibre.com/items/${meliItemId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const itemData = await ir.json();
        if (!itemData.error) nombreItem = itemData.title;
      } catch (_) {}

      const { data: existeEnDb } = await supabase.from('productos').select('sku').eq('sku', skuAuto).single();
      if (!existeEnDb) {
        await supabase.from('productos').insert({
          sku: skuAuto, nombre: nombreItem,
          stock_dep: 0, stock_meli: 0, costo: 0,
          precio: item.unit_price || 0, alerta_min: 3,
          meli_id: meliItemId, notas: 'Auto-creado por webhook MELI',
        });
      }
      const { data: p2 } = await supabase.from('productos').select('*').eq('sku', skuAuto).single();
      if (!p2) { console.error(`❌ No se pudo crear producto ${meliItemId}`); continue; }
      producto = p2;
    }

    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockDep,
      stock_shopify: nuevoStockDep,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    const comisionItem = hasFeeDetails
      ? Math.round((totalFee * (item.unit_price * cantidad) / orderTotalCalc) * 100) / 100
      : Math.abs(item.sale_fee || 0);

    const ventaId = `V_MELI_${order.id}_${meliItemId}`;
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();

    if (!ventaExistente) {
      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || '',
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: item.unit_price,
        comision: comisionItem,
        total: item.unit_price * cantidad,
        estado: 'pagada',
        genera_envio: !!shippingId,
      });
      if (ventaErr) {
        console.error(`❌ Error insertando venta ${ventaId}:`, ventaErr.message);
        continue;
      }
      console.log(`✅ Venta registrada: ${ventaId} | ${transportista}`);

      const buyerNickname = order.buyer?.nickname;
      if (buyerNickname) {
        try {
          const { data: clienteMeli } = await supabase
            .from('clientes').select('id').eq('meli_nickname', buyerNickname).single();
          if (clienteMeli) {
            await supabase.from('ventas').update({ cliente_id: clienteMeli.id }).eq('id', ventaId);
          }
        } catch (_) {}
      }
    }

    if (shippingId) {
      const envioId = `E_MELI_${order.id}_${meliItemId}`;
      const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single();
      if (!envioExistente) {
        await supabase.from('envios').insert({
          id: envioId,
          venta_id: ventaId,
          orden: String(order.id),
          comprador: order.buyer?.nickname || '',
          producto: producto.nombre,
          transportista,
          tracking: null,
          fecha_despacho: null,
          estado: 'pendiente',
          direccion: direccion || null,
          costo: costoEnvioFinal,
        });
        console.log(`✅ Envío creado: ${envioId} | ${transportista} $${costoEnvioFinal}`);
      }
    }

    if (producto.shopify_id) {
      try {
        await syncShopifyStock(producto.shopify_id, nuevoStockDep);
      } catch (shopErr) {
        console.error('❌ Error sync Shopify:', shopErr.message);
      }
    }
  }
}

async function handleStatus(req, res) {
  const supabase = getSupabase();
  const resultado = {
    timestamp: new Date().toISOString(),
    meli_conectado: false,
    usuario_meli: null,
    token_expira: null,
    ultimas_notificaciones: [],
    error: null,
  };
  try {
    const { data: tokenData } = await supabase
      .from('meli_tokens').select('expires_at, meli_user_id, updated_at').eq('id', 1).single();
    if (tokenData) {
      resultado.meli_conectado = true;
      resultado.token_expira = tokenData.expires_at;
      resultado.meli_user_id = tokenData.meli_user_id;
      resultado.token_actualizado = tokenData.updated_at;
      try {
        const token = await getMeliToken();
        const meRes = await fetch('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const me = await meRes.json();
        resultado.usuario_meli = me.nickname || me.id;
        resultado.token_valido = !me.error;
      } catch (e) {
        resultado.token_valido = false;
        resultado.token_error = e.message;
      }
    }
  } catch (e) {
    resultado.error = 'MELI no conectado: ' + e.message;
  }
  try {
    const { data: logs } = await supabase
      .from('meli_notify_log').select('*')
      .order('recibido_at', { ascending: false }).limit(10);
    resultado.ultimas_notificaciones = logs || [];
  } catch (_) {
    resultado.ultimas_notificaciones = [];
  }
  return res.json(resultado);
}

async function syncShopifyStock(variantId, quantity) {
  const shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) return;
  const locRes = await fetch(`https://${shop}/admin/api/2024-01/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('No location en Shopify');
  const varRes = await fetch(`https://${shop}/admin/api/2024-01/variants/${variantId}.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const varData = await varRes.json();
  const inventoryItemId = varData.variant?.inventory_item_id;
  if (!inventoryItemId) throw new Error(`Variant ${variantId} no encontrado`);
  const setRes = await fetch(`https://${shop}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity }),
  });
  const setData = await setRes.json();
  if (setData.errors) throw new Error(JSON.stringify(setData.errors));
}
