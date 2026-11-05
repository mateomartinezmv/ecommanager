// api/devoluciones.js
// GET  /api/devoluciones            → listar todas
// POST /api/devoluciones            → crear devolución pendiente (una común no toca stock todavía)
// PUT  /api/devoluciones?id=XX      → confirmar recepción → restaura stock y sincroniza
// PATCH /api/devoluciones?id=XX     → cambiar el costo del envío de vuelta { costoEnvio }
// DELETE /api/devoluciones?id=XX   → eliminar
//
// costoEnvio = lo que se paga para que el producto vuelva desde la dirección del cliente
// hasta el depósito. Entra en Reportes como "Envíos de devoluciones".
//
// skuRecibido = producto equivocado: el cliente pidió A (sku de la venta), le mandamos B y
// devuelve B. El correcto se le reenvía sin cargar otra venta, así que A ya está bien
// descontado y no se toca. B salió del depósito sin descontarse:
//   · al registrar  → B −cantidad (está en lo del cliente)
//   · al confirmar  → B +cantidad (vuelve; no se le suma a A)
//   · borrar una pendiente → B +cantidad (se deshace el descuento del registro)

const { getSupabase } = require('./_supabase');
const { sincronizarStock, descontarStock, resumenSync } = require('./_stockSync');
const { unidadesDeDeposito } = require('./_packs');
const {
  MIGRACION_COSTO_ENVIO, normalizarCostoEnvio, faltaMigracionCostoEnvio,
  MIGRACION_SKU_RECIBIDO, skuDeStock, faltaMigracionSkuRecibido,
} = require('./_devoluciones');

const COLUMNAS_PRODUCTO = 'sku, nombre, stock_dep, unidades_por_venta, meli_id, meli_ids, shopify_id';

async function leerProducto(supabase, sku) {
  const { data, error } = await supabase.from('productos').select(COLUMNAS_PRODUCTO).eq('sku', sku).single();
  return error ? null : data;
}

// Suma unidades al depósito y republica el espejo en MELI y Shopify.
async function sumarStock(supabase, producto, cantidad) {
  // La devolución vuelve en unidades vendidas (packs): un par devuelto repone 2 unidades sueltas.
  return sincronizarStock(supabase, producto, producto.stock_dep + unidadesDeDeposito(cantidad, producto));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
      const costoEnvio = normalizarCostoEnvio(d.costoEnvio);
      if (costoEnvio === null) return res.status(400).json({ error: 'El costo de envío tiene que ser un monto mayor o igual a 0' });

      // Producto equivocado: tiene que existir y ser otro que el de la venta.
      const skuRecibido = String(d.skuRecibido || '').trim();
      let recibido = null;
      if (skuRecibido) {
        if (skuRecibido === d.sku) return res.status(400).json({ error: 'El producto que recibió el cliente es el mismo que pidió: registrala como una devolución común' });
        recibido = await leerProducto(supabase, skuRecibido);
        if (!recibido) return res.status(400).json({ error: `No existe el producto ${skuRecibido}` });
      }

      const fila = {
        id: 'DEV-' + Date.now(),
        venta_id: d.ventaId || null,
        sku: d.sku,
        producto: d.producto,
        cantidad: d.cantidad,
        estado: 'pendiente',
        notas: d.notas || null,
      };
      if (costoEnvio > 0) fila.costo_envio = costoEnvio;
      if (recibido) { fila.sku_recibido = recibido.sku; fila.producto_recibido = recibido.nombre || recibido.sku; }
      const insertar = f => supabase.from('devoluciones').insert(f).select().single();
      let { data, error } = await insertar(fila);
      // Sin las columnas del producto equivocado no se registra: si se guardara como una
      // devolución común, al confirmarla le sumaría stock al producto que nunca salió.
      if (error && recibido && faltaMigracionSkuRecibido(error)) {
        return res.status(503).json({ error: `Falta correr la migración ${MIGRACION_SKU_RECIBIDO} en Supabase.`, migracionPendiente: true });
      }
      // Sin la migración la devolución se registra igual (lo importante es que quede pendiente
      // de recibir); la respuesta avisa que el costo no se guardó.
      if (error && 'costo_envio' in fila && faltaMigracionCostoEnvio(error)) {
        const { costo_envio, ...sinCosto } = fila;
        ({ data, error } = await insertar(sinCosto));
        if (!error) data.migracionCostoEnvioPendiente = MIGRACION_COSTO_ENVIO;
      }
      if (error) throw error;

      if (recibido) {
        // B salió del depósito sin descontarse y ahora está en lo del cliente.
        const sync = await descontarStock(supabase, recibido, unidadesDeDeposito(d.cantidad, recibido));
        console.log('↩️ Producto equivocado en lo del cliente:', resumenSync(recibido.sku, sync));
        if (sync.error) {
          // Sin el descuento, confirmarla después dejaría a B con unidades de más: se deshace.
          await supabase.from('devoluciones').delete().eq('id', data.id);
          return res.status(500).json({ error: `No se pudo descontar el stock de ${recibido.sku}: ${sync.error}` });
        }
        return res.json({ ...data, stockRecibido: sync.stockDep, sync });
      }
      return res.json(data);
    }

    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const costoEnvio = normalizarCostoEnvio((req.body || {}).costoEnvio);
      if (costoEnvio === null) return res.status(400).json({ error: 'El costo de envío tiene que ser un monto mayor o igual a 0' });
      const { data, error } = await supabase
        .from('devoluciones')
        .update({ costo_envio: costoEnvio })
        .eq('id', id)
        .select()
        .single();
      if (error && faltaMigracionCostoEnvio(error)) {
        return res.status(503).json({ error: `Falta correr la migración ${MIGRACION_COSTO_ENVIO} en Supabase.`, migracionPendiente: true });
      }
      // PGRST116 = .single() sin filas: el id no existe.
      if ((error && error.code === 'PGRST116') || (!error && !data)) return res.status(404).json({ error: 'Devolución no encontrada' });
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

      // Vuelve lo que tenía el cliente: el producto equivocado si fue uno, si no el de la venta.
      const sku = skuDeStock(dev);
      const producto = await leerProducto(supabase, sku);
      if (!producto) throw new Error('Producto no encontrado: ' + sku);

      // Devolver al depósito y republicar el espejo en MELI y Shopify.
      const sync = await sumarStock(supabase, producto, dev.cantidad);
      console.log('↩️ Devolución:', resumenSync(sku, sync));

      // Marcar devolución como recibida
      const { data: devActualizada, error: updErr } = await supabase
        .from('devoluciones')
        .update({ estado: 'recibida', recibida_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (updErr) throw updErr;

      return res.json({ devolucion: devActualizada, skuRepuesto: sku, nuevoStock: sync.stockDep, sync });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const { data: dev } = await supabase.from('devoluciones').select('*').eq('id', id).single();
      const { error } = await supabase.from('devoluciones').delete().eq('id', id);
      if (error) throw error;

      // Una pendiente de producto equivocado ya le descontó a B al registrarse: se le devuelve.
      // Las recibidas no se tocan (B bajó y volvió a subir) y las comunes nunca movieron stock.
      if (dev && dev.estado === 'pendiente' && dev.sku_recibido) {
        const producto = await leerProducto(supabase, dev.sku_recibido);
        if (!producto) return res.json({ ok: true, error: `No se encontró ${dev.sku_recibido} para devolverle el stock` });
        const sync = await sumarStock(supabase, producto, dev.cantidad);
        console.log('↩️ Devolución borrada, se le devuelve a', resumenSync(dev.sku_recibido, sync));
        return res.json({ ok: true, skuRepuesto: dev.sku_recibido, nuevoStock: sync.stockDep, sync });
      }
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/devoluciones:', err);
    res.status(500).json({ error: err.message });
  }
};
