// api/meli/reprocesar-ordenes.js
// POST /api/meli/reprocesar-ordenes { orden_ids: [...] }
// Importa órdenes específicas de MELI al CRM

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orden_ids } = req.body;
  if (!orden_ids || !Array.isArray(orden_ids) || !orden_ids.length) {
    return res.status(400).json({ error: 'Falta orden_ids (array de IDs de órdenes MELI)' });
  }

  const token = await getMeliToken();
  const supabase = getSupabase();

  const resultados = [];

  for (const orderId of orden_ids) {
    try {
      // Intentar endpoint directo
      let orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      let order = await orderRes.json();

      // Fallback para Mercado Shops
      if (order.error) {
        const meRes = await fetch('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const me = await meRes.json();
        const searchRes = await fetch(
          `https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const search = await searchRes.json();
        if (search.results?.length > 0) {
          order = search.results.find(o => String(o.id) === String(orderId));
        }
        if (!order || order.error) {
          resultados.push({ orden: orderId, status: 'error', msg: 'Order do not exists (marketplace + shops)' });
          continue;
        }
      }

      // Procesar cada ítem de la orden
      for (const item of order.order_items) {
        const meliItemId = item.item.id;
        const cantidad = item.quantity;

        // Buscar producto por meli_id
        const { data: producto } = await supabase
          .from('productos')
          .select('*')
          .eq('meli_id', meliItemId)
          .single();

        const ventaId = 'V_MELI_' + order.id + '_' + item.item.id;

        // Verificar si ya existe
        const { data: ventaExistente } = await supabase
          .from('ventas')
          .select('id')
          .eq('id', ventaId)
          .single();

        if (ventaExistente) {
          resultados.push({ orden: orderId, producto: item.item.title, status: 'ya_existia' });
          continue;
        }

        // Estado de la orden
        const estadoMeli = order.status; // paid, cancelled, etc.
        const estadoCRM = estadoMeli === 'cancelled' ? 'cancelada' : 'pagada';

        // Descontar stock solo si está pagada y hay producto
        if (producto && estadoMeli === 'paid') {
          const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
          const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);
          await supabase.from('productos').update({
            stock_dep: nuevoStockDep,
            stock_meli: nuevoStockMeli,
            updated_at: new Date().toISOString(),
          }).eq('sku', producto.sku);
        }

        // Insertar venta
        const { error: insertErr } = await supabase.from('ventas').insert({
          id: ventaId,
          canal: 'meli',
          fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          orden_meli: String(order.id),
          comprador: order.buyer?.nickname || '',
          sku: producto?.sku || null,
          producto: producto?.nombre || item.item.title,
          cantidad,
          precio_unit: item.unit_price,
          comision: 0,
          total: item.unit_price * cantidad,
          estado: estadoCRM,
          genera_envio: estadoMeli === 'paid',
        });

        if (insertErr) {
          resultados.push({ orden: orderId, producto: item.item.title, status: 'error_insert', msg: insertErr.message });
        } else {
          resultados.push({
            orden: orderId,
            producto: producto?.nombre || item.item.title,
            comprador: order.buyer?.nickname,
            total: item.unit_price * cantidad,
            estado: estadoCRM,
            status: 'importada',
          });
        }
      }
    } catch (err) {
      resultados.push({ orden: orderId, status: 'error', msg: err.message });
    }
  }

  const importadas = resultados.filter(r => r.status === 'importada').length;
  const yaExistian = resultados.filter(r => r.status === 'ya_existia').length;
  const errores = resultados.filter(r => r.status === 'error' || r.status === 'error_insert').length;

  return res.json({
    ok: true,
    importadas,
    ya_existian: yaExistian,
    errores,
    detalle: resultados,
  });
};
