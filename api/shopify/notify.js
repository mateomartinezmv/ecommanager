// api/shopify/notify.js
// POST /api/shopify/notify → recibe webhook orders/paid de Shopify

const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    let order = req.body;
    // Vercel a veces entrega el body como string o Buffer
    if (typeof order === 'string') { try { order = JSON.parse(order); } catch(_) {} }
    if (Buffer.isBuffer(order)) { try { order = JSON.parse(order.toString()); } catch(_) {} }

    if (!order || !order.line_items) {
      console.warn('⚠️ shopify/notify: body vacío o sin line_items', typeof order);
      return res.status(200).json({ ok: true });
    }

    const supabase = getSupabase();

    for (const item of order.line_items) {
      const variantId = String(item.variant_id);
      const cantidad = item.quantity;

      // Buscar producto por shopify_id
      const { data: producto } = await supabase
        .from('productos')
        .select('*')
        .eq('shopify_id', variantId)
        .single();

      if (!producto) {
        console.log(`⚠️ Variante Shopify ${variantId} no encontrada en CRM`);
        continue;
      }

      // Nuevo stock
      const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);

      // Actualizar CRM
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep,
        stock_meli: nuevoStockDep,
        stock_shopify: nuevoStockDep,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku);

      // Registrar venta (evitar duplicados por order_id + variant_id)
      const ventaId = `V_SHOP_${order.id}_${variantId}`;
      const { data: ventaExistente } = await supabase
        .from('ventas')
        .select('id')
        .eq('id', ventaId)
        .single();

      if (!ventaExistente) {
        await supabase.from('ventas').insert({
          id: ventaId,
          canal: 'shopify',
          fecha: order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          orden_meli: null,
          comprador: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || '',
          sku: producto.sku,
          producto: producto.nombre,
          cantidad,
          precio_unit: parseFloat(item.price) || 0,
          comision: 0,
          total: parseFloat(item.price) * cantidad,
          estado: 'pagada',
          genera_envio: true,
        });
        console.log(`✅ Venta Shopify registrada: orden ${order.id}, ${producto.nombre} x${cantidad}`);
      }

      // ── Sync → MELI ──
      if (producto.meli_id) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: nuevoStockDep }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn(`⚠️ MELI sync error: ${meliData.message}`);
          else console.log(`✅ MELI sync: ${producto.meli_id} → ${nuevoStockDep}`);
        } catch (meliErr) {
          console.error('❌ Error sync MELI tras venta Shopify:', meliErr.message);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error en /api/shopify/notify:', err.message);
    return res.status(200).json({ ok: true }); // Siempre 200 para que Shopify no reintente
  }
};
