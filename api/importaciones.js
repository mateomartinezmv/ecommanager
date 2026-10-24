// api/importaciones.js
// GET    /api/importaciones        → listar todas
// POST   /api/importaciones        → crear importación
// PUT    /api/importaciones?id=XX  → actualizar estado/notas
// DELETE /api/importaciones?id=XX  → eliminar

const { getSupabase } = require('./_supabase');
const { applyImportArrival } = require('./_stockSync');
const { faltaMigracionProveedores, skusDeItems, sincronizarProveedorProductos } = require('./_proveedores');

// Estados que representan que la mercadería ya está físicamente disponible
const ARRIVED_STATES = ['arrived', 'recibido', 'en_deposito'];

// Escribe la fila con proveedor_id y, si la columna todavía no existe en la base, repite el
// write sin ella: un deploy adelantado a la migración no puede impedir cargar una
// importación. La respuesta lo avisa con `migracionProveedorPendiente`.
async function escribirConProveedor(escribir, fila) {
  const primero = await escribir(fila);
  if (!('proveedor_id' in fila) || !faltaMigracionProveedores(primero.error)) {
    return { ...primero, migracionProveedorPendiente: false };
  }
  const { proveedor_id, ...sinProveedor } = fila;
  const reintento = await escribir(sinProveedor);
  return { ...reintento, migracionProveedorPendiente: !reintento.error };
}

// Cada producto queda asignado al proveedor de su importación más reciente. Un error acá no
// deshace la importación ya guardada: se devuelve para que la pantalla lo muestre.
async function asignarProveedorProductos(supabase, skus) {
  try {
    return await sincronizarProveedorProductos(supabase, skus);
  } catch (err) {
    console.error('Error asignando proveedor a productos:', err);
    return { error: err.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const id = req.query.id;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('importaciones')
        .select('*')
        .order('fecha', { ascending: false });
      if (error) throw error;
      return res.json(data || []);
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.fecha) return res.status(400).json({ error: 'La fecha es obligatoria' });

      const traslado = Number(b.traslado) || 0;
      const nacional = Number(b.nacional) || 0;
      const items    = Array.isArray(b.items) ? b.items : [];
      // Cálculo inverso: el usuario ingresa el total que ya incluye IVA
      const total    = Number(b.total) || 0;
      const subtotal = total / 1.22;   // base imponible
      const iva      = total - subtotal;

      const fila = {
        id:       'IMP' + Date.now(),
        fecha:    b.fecha,
        llegada:  b.llegada || null,
        estado:   b.estado || 'en_transito',
        notas:    b.notas?.trim() || null,
        items,
        traslado,
        nacional,
        subtotal,
        iva,
        total,
        saldo_pendiente: b.saldo_pendiente === true,
      };
      if (b.proveedor_id) fila.proveedor_id = b.proveedor_id;

      const { data, error, migracionProveedorPendiente } = await escribirConProveedor(
        f => supabase.from('importaciones').insert(f).select().single(), fila);
      if (error) throw error;
      if (migracionProveedorPendiente) data.migracionProveedorPendiente = true;
      if (data.proveedor_id) data.proveedor_sync = await asignarProveedorProductos(supabase, skusDeItems(items));
      return res.json(data);
    }

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const b = req.body || {};

      // select('*') y no una lista de columnas: proveedor_id puede no existir todavía.
      const { data: actual, error: actualErr } = await supabase
        .from('importaciones').select('*').eq('id', id).single();
      if (actualErr) throw actualErr;

      const fields = {};
      if (b.estado          !== undefined) fields.estado          = b.estado;
      if (b.notas           !== undefined) fields.notas           = b.notas?.trim() || null;
      if (b.llegada         !== undefined) fields.llegada         = b.llegada || null;
      if (b.saldo_pendiente !== undefined) fields.saldo_pendiente = b.saldo_pendiente === true;
      if (b.items           !== undefined) fields.items           = Array.isArray(b.items) ? b.items : [];
      if (b.proveedor_id    !== undefined) fields.proveedor_id    = b.proveedor_id || null;

      const { data, error, migracionProveedorPendiente } = await escribirConProveedor(
        f => supabase.from('importaciones').update(f).eq('id', id).select().single(), fields);
      if (error) throw error;
      if (migracionProveedorPendiente) data.migracionProveedorPendiente = true;

      // Sólo se recalcula el proveedor de los productos si cambió a quién se le compró o
      // qué SKUs trae la importación: editar una nota de una compra vieja no tiene que pisar
      // una asignación hecha a mano después.
      const skusAntes   = skusDeItems(actual.items);
      const skusAhora   = skusDeItems(data.items);
      const cambioProv  = (actual.proveedor_id || null) !== (data.proveedor_id || null);
      const cambioSkus  = skusAntes.length !== skusAhora.length || skusAhora.some(s => !skusAntes.includes(s));
      if (!migracionProveedorPendiente && (data.proveedor_id || actual.proveedor_id) && (cambioProv || cambioSkus)) {
        data.proveedor_sync = await asignarProveedorProductos(supabase, [...new Set([...skusAntes, ...skusAhora])]);
      }

      // Si la importación acaba de pasar a un estado de "llegada", sumamos el
      // stock de cada ítem una sola vez (idempotente: solo dispara en la transición).
      const yaHabiaLlegado = ARRIVED_STATES.includes(actual.estado);
      const llegaAhora     = fields.estado !== undefined && ARRIVED_STATES.includes(fields.estado);
      if (llegaAhora && !yaHabiaLlegado) {
        const items = fields.items !== undefined ? fields.items : (actual.items || []);
        try {
          data.stock_sync = await applyImportArrival(supabase, items);
        } catch (syncErr) {
          console.error('Error actualizando stock tras llegada de importación:', syncErr);
          data.stock_sync = { error: syncErr.message };
        }
      }

      return res.json(data);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { error } = await supabase.from('importaciones').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/importaciones:', err);
    return res.status(500).json({ error: err.message });
  }
};
