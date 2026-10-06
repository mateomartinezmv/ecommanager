// api/ventas.js
// GET  /api/ventas → listar
// GET  /api/ventas?canceladas=1 → listar canceladas
// POST /api/ventas → crear (también descuenta stock y actualiza MELI si aplica)
// DELETE /api/ventas?id=XX → cancelar (restaura stock, elimina envío, registra cancelación)

const { getSupabase } = require('./_supabase');
const { sincronizarStock, resumenSync } = require('./_stockSync');
const { unidadesDeDeposito, unidadesPorVenta } = require('./_packs');
const { descripcionDePaquete } = require('./_meliPaquetes');

// Las otras líneas del mismo ticket que siguen vivas: carrito de mostrador
// (venta_grupo), carrito de MELI (pack_id) u orden MELI con varios ítems.
async function lineasHermanas(supabase, venta) {
  const campos = 'id, producto, cantidad';
  let q = supabase.from('ventas').select(campos).neq('id', venta.id);

  if (venta.venta_grupo) q = q.eq('venta_grupo', venta.venta_grupo);
  else if (venta.pack_id) q = q.eq('pack_id', venta.pack_id);
  else if (venta.canal === 'meli' && venta.orden_meli) q = q.eq('orden_meli', venta.orden_meli);
  else return [];

  const { data } = await q;
  return (data || []).sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      if (req.query.canceladas) {
        // Devolver ventas canceladas
        const { data, error } = await supabase
          .from('ventas_canceladas')
          .select('*')
          .order('cancelada_at', { ascending: false });
        if (error) throw error;
        return res.json(data);
      }

      const { data, error } = await supabase
        .from('ventas')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const v = req.body;

      // 1. Obtener el producto
      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', v.sku)
        .single();
      if (prodErr || !producto) throw new Error('Producto no encontrado: ' + v.sku);

      // 2. Calcular nuevo stock. `cantidad` viene en unidades vendidas (packs):
      // un par de sliders es 1 de cantidad y 2 unidades del depósito.
      const nuevoStockDep = Math.max(0, producto.stock_dep - unidadesDeDeposito(v.cantidad, producto));

      // 3. Guardar la venta
      const { data: venta, error: ventaErr } = await supabase.from('ventas').insert({
        id: v.id,
        canal: v.canal,
        fecha: v.fecha,
        // Las líneas de un mismo carrito comparten venta_grupo → cuentan como una sola venta
        venta_grupo: v.ventaGrupo || null,
        orden_meli: v.ordenMeli || null,
        comprador: v.comprador || null,
        cliente: v.cliente || null,
        sku: v.sku,
        producto: v.producto,
        cantidad: v.cantidad,
        precio_unit: v.precioUnit,
        comision: v.comision || 0,
        descuento_pct: v.descuentoPct || 0,
        descuento_monto: v.descuentoMonto || 0,
        total: v.total,
        estado: v.estado || 'pagada',
        metodo_pago: v.metodoPago || null,
        // Sin marcar (lo normal al dar de alta) ni se manda: la venta queda con facturada
        // NULL y la facturación se deduce del método de pago. Además así el alta sigue
        // funcionando si el deploy llega antes que la migración de la columna.
        ...(v.facturada !== undefined ? { facturada: v.facturada } : {}),
        genera_envio: v.generaEnvio || false,
        notas: v.notas || null,
      }).select().single();
      if (ventaErr) throw ventaErr;

      // 4. Bajar el depósito y publicar el espejo en los dos canales.
      // La venta descuenta del mismo depósito venga del canal que venga: una
      // venta de mostrador también tiene que bajarle el stock a MELI y a
      // Shopify, o siguen ofreciendo mercadería que ya no está.
      const sync = await sincronizarStock(supabase, producto, nuevoStockDep);
      console.log('📉 Venta:', resumenSync(v.sku, sync));

      return res.json({
        venta,
        nuevoStockDep: sync.stockDep,
        nuevoStockMeli: sync.stockPublicado,
        nuevoStockShopify: sync.stockPublicado,
        sync,
      });
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      const { fecha, estado, comprador, cliente, cantidad, precioUnit, comision, costoEnvioMeli, descuentoPct, descuentoMonto, total, metodoPago, facturada, notas } = req.body;
      const updateData = {};
      if (fecha !== undefined) updateData.fecha = fecha;
      if (estado !== undefined) updateData.estado = estado;
      if (comprador !== undefined) updateData.comprador = comprador;
      if (cliente !== undefined) updateData.cliente = cliente;
      if (cantidad !== undefined) updateData.cantidad = cantidad;
      if (precioUnit !== undefined) updateData.precio_unit = precioUnit;
      if (comision !== undefined) updateData.comision = comision;
      if (costoEnvioMeli !== undefined) updateData.costo_envio_meli = costoEnvioMeli;
      if (descuentoPct !== undefined) updateData.descuento_pct = descuentoPct;
      if (descuentoMonto !== undefined) updateData.descuento_monto = descuentoMonto;
      if (total !== undefined) updateData.total = total;
      if (metodoPago !== undefined) updateData.metodo_pago = metodoPago;
      // Se acepta null a propósito: es volver la venta a "sin marcar".
      if (facturada !== undefined) updateData.facturada = facturada;
      if (notas !== undefined) updateData.notas = notas;

      const { data, error } = await supabase.from('ventas')
        .update(updateData)
        .eq('id', id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;

      // 1. Obtener la venta antes de eliminar
      const { data: venta, error: ventaErr } = await supabase
        .from('ventas')
        .select('*')
        .eq('id', id)
        .single();
      if (ventaErr || !venta) throw new Error('Venta no encontrada: ' + id);

      // 2. Obtener el producto para restaurar stock
      const { data: producto } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', venta.sku)
        .single();

      if (producto) {
        // 3. Devolver la mercadería al depósito (vuelve en unidades sueltas) y
        // republicar el espejo en los dos canales.
        const stockDepRestaurado = producto.stock_dep + unidadesDeDeposito(venta.cantidad, producto);
        const sync = await sincronizarStock(supabase, producto, stockDepRestaurado);

        console.log(`🔄 Stock restaurado: +${unidadesDeDeposito(venta.cantidad, producto)} uds (${venta.cantidad} × ${unidadesPorVenta(producto)}) · ${resumenSync(venta.sku, sync)}`);
      }

      // 5. Envío asociado. Un carrito viaja en un solo paquete y el envío queda
      // colgado de una de sus líneas: si se cancela esa línea pero el resto
      // sigue en pie, el paquete sigue saliendo — se repunta a otra línea en vez
      // de borrarlo.
      const { data: envioAsociado } = await supabase
        .from('envios')
        .select('id')
        .eq('venta_id', id)
        .maybeSingle();

      if (envioAsociado) {
        const hermanas = await lineasHermanas(supabase, venta);
        if (hermanas.length) {
          await supabase.from('envios').update({
            venta_id: hermanas[0].id,
            producto: descripcionDePaquete(hermanas),
          }).eq('id', envioAsociado.id);
          console.log(`🔄 Envío ${envioAsociado.id} repuntado a ${hermanas[0].id} (el paquete sigue con ${hermanas.length} producto/s)`);
        } else {
          await supabase.from('envios').delete().eq('id', envioAsociado.id);
          console.log(`🗑️ Envío eliminado: ${envioAsociado.id}`);
        }
      }

      // 6. Registrar en ventas_canceladas
      const { error: cancelErr } = await supabase.from('ventas_canceladas').insert({
        venta_id: venta.id,
        canal: venta.canal,
        venta_grupo: venta.venta_grupo || null,
        fecha_venta: venta.fecha,
        cancelada_at: new Date().toISOString(),
        orden_meli: venta.orden_meli || null,
        comprador: venta.comprador || venta.cliente || null,
        sku: venta.sku,
        producto: venta.producto,
        cantidad: venta.cantidad,
        precio_unit: venta.precio_unit,
        total: venta.total,
        tenia_envio: !!envioAsociado,
      });
      if (cancelErr) console.warn('No se pudo registrar en ventas_canceladas:', cancelErr.message);

      // 7. Eliminar la venta
      const { error } = await supabase.from('ventas').delete().eq('id', id);
      if (error) throw error;

      return res.json({ ok: true, stockRestaurado: !!producto, envioEliminado: !!envioAsociado });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/ventas:', err);
    res.status(500).json({ error: err.message });
  }
};
