// api/devoluciones.js
// GET  /api/devoluciones            → listar todas
// POST /api/devoluciones            → crear devolución pendiente (no toca stock todavía)
// PUT  /api/devoluciones?id=XX      → confirmar recepción → restaura stock y sincroniza
// DELETE /api/devoluciones?id=XX   → eliminar

const { getSupabase } = require('./_supabase');
const { sincronizarStock, resumenSync } = require('./_stockSync');
const { unidadesDeDeposito } = require('./_packs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('devoluciones')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const d = req.body;
      if (!d.sku || !d.producto || !d.cantidad) {
        return res.status(400).json({ error: 'Faltan campos: sku, producto, cantidad' });
      }
      const { data, error } = await supabase.from('devoluciones').insert({
        id: 'DEV-' + Date.now(),
        venta_id: d.ventaId || null,
        sku: d.sku,
        producto: d.producto,
        cantidad: d.cantidad,
        estado: 'pendiente',
        notas: d.notas || null,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const { data: dev, error: devErr } = await supabase
        .from('devoluciones')
        .select('*')
        .eq('id', id)
        .single();
      if (devErr || !dev) return res.status(404).json({ error: 'Devolución no encontrada' });
      if (dev.estado === 'recibida') return res.status(400).json({ error: 'Ya fue confirmada' });

      // Obtener producto para saber stock actual y sus publicaciones
      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('sku, stock_dep, unidades_por_venta, meli_id, meli_ids, shopify_id')
        .eq('sku', dev.sku)
        .single();
      if (prodErr || !producto) throw new Error('Producto no encontrado: ' + dev.sku);

      // La devolución vuelve en unidades vendidas (packs): un par devuelto
      // repone 2 unidades sueltas al depósito.
      const nuevoStock = producto.stock_dep + unidadesDeDeposito(dev.cantidad, producto);

      // Devolver al depósito y republicar el espejo en MELI y Shopify.
      const sync = await sincronizarStock(supabase, producto, nuevoStock);
      console.log('↩️ Devolución:', resumenSync(dev.sku, sync));

      // Marcar devolución como recibida
      const { data: devActualizada, error: updErr } = await supabase
        .from('devoluciones')
        .update({ estado: 'recibida', recibida_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (updErr) throw updErr;

      return res.json({ devolucion: devActualizada, nuevoStock: sync.stockDep, sync });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const { error } = await supabase.from('devoluciones').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/devoluciones:', err);
    res.status(500).json({ error: err.message });
  }
};
