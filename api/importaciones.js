// api/importaciones.js
// GET    /api/importaciones        → listar todas
// POST   /api/importaciones        → crear importación
// PUT    /api/importaciones?id=XX  → actualizar estado/notas/costos/pagos
// DELETE /api/importaciones?id=XX  → eliminar
//
// Las importaciones con costo_puerto (esquema GrupoRAS, sin IVA) calculan solas el total, el
// factor sobre China y los tres pagos (public/costo-importacion.js). Al llegar, además de sumar
// el stock, le ponen a cada producto su costo por PPP (precio promedio ponderado).

const { getSupabase } = require('./_supabase');
const { applyImportArrival } = require('./_stockSync');
const { marcarAvisosListos } = require('./_avisosStock');
const { faltaMigracionProveedores, skusDeItems, sincronizarProveedorProductos } = require('./_proveedores');
const Costo = require('../public/costo-importacion');

// Estados que representan que la mercadería ya está físicamente disponible
const ARRIVED_STATES = ['arrived', 'recibido', 'en_deposito'];

// Columnas de supabase/migrations/20261111000000_importaciones_puerto_ppp.sql.
const COLS_PUERTO = ['importador', 'costo_puerto', 'cotizacion_usd', 'pagos', 'costos_aplicados', 'costos_aplicados_at'];
const MIGRACION_PUERTO = '20261111000000_importaciones_puerto_ppp.sql';

function faltaMigracionPuerto(error) {
  const msg = String(error?.message || '');
  return (error?.code === 'PGRST204' || error?.code === '42703' || /column/i.test(msg)) &&
    COLS_PUERTO.some(c => msg.includes(c));
}

function errorMigracionPuerto(error) {
  return faltaMigracionPuerto(error)
    ? new Error(`Falta correr la migración ${MIGRACION_PUERTO} en Supabase para guardar los costos de puesta en puerto y los pagos.`)
    : error;
}

const numOrNull = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// Campos del esquema de puesta en puerto que llegan en el body.
function camposPuerto(b) {
  const f = {};
  if (b.importador     !== undefined) f.importador     = String(b.importador || '').trim() || null;
  if (b.costo_puerto   !== undefined) f.costo_puerto   = numOrNull(b.costo_puerto);
  if (b.cotizacion_usd !== undefined) f.cotizacion_usd = numOrNull(b.cotizacion_usd);
  if (b.nacional       !== undefined) f.nacional       = Number(b.nacional) || 0;
  if (b.traslado       !== undefined) f.traslado       = Number(b.traslado) || 0;
  return f;
}

// Con costo_puerto el total es la suma de los costos, sin IVA, y los pagos salen de ahí.
// `pagosUsuario` trae lo que se marcó en pantalla (pagado, fechas); los montos se recalculan.
function completarPuerto(fila, pagosUsuario) {
  const t = Costo.totales(fila);
  const pagos = Costo.armarPagos(fila, pagosUsuario !== undefined ? pagosUsuario : fila.pagos);
  return {
    total: t.total,
    subtotal: t.total,
    iva: 0,
    pagos,
    saldo_pendiente: !Costo.resumenPagos(pagos).completos,
  };
}

// PPP al llegar: se lee el stock y el costo de cada SKU ANTES de sumar la mercadería.
async function planCostos(supabase, imp) {
  const skus = skusDeItems(imp.items);
  if (!skus.length) return Costo.planPPP(imp, []);
  const { data, error } = await supabase.from('productos').select('sku, stock_dep, costo').in('sku', skus);
  if (error) throw error;
  return Costo.planPPP(imp, data || []);
}

// Escribe el costo nuevo sólo de los SKUs a los que de verdad se les sumó stock.
async function guardarCostos(supabase, id, plan, skusAplicados) {
  const aplicados = [];
  const errores = [];
  for (const c of plan.cambios) {
    if (!skusAplicados.includes(c.sku)) continue;
    const { error } = await supabase.from('productos').update({ costo: c.costoNuevo }).eq('sku', c.sku);
    if (error) errores.push({ sku: c.sku, error: error.message });
    else aplicados.push(c);
  }
  const { error } = await supabase.from('importaciones')
    .update({ costos_aplicados: aplicados, costos_aplicados_at: new Date().toISOString() }).eq('id', id);
  if (error) errores.push({ sku: null, error: 'No se pudo registrar el PPP en la importación: ' + error.message });
  return { aplicados, sinProducto: plan.sinProducto, errores };
}

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

      let fila = {
        id:       'IMP' + Date.now(),
        fecha:    b.fecha,
        llegada:  b.llegada || null,
        estado:   b.estado || 'en_transito',
        notas:    b.notas?.trim() || null,
        items,
        traslado,
        nacional,
      };

      if (numOrNull(b.costo_puerto) > 0) {
        // Esquema de puesta en puerto: sin IVA, total = puerto (China + all in) + otros gastos + traslado.
        fila = { ...fila, ...camposPuerto(b) };
        if (!fila.cotizacion_usd) fila.cotizacion_usd = Costo.COTIZACION_DEFAULT;
        fila = { ...fila, ...completarPuerto(fila, b.pagos) };
      } else {
        // Esquema anterior. Cálculo inverso: el usuario ingresa el total que ya incluye IVA.
        const total = Number(b.total) || 0;
        const subtotal = total / 1.22;   // base imponible
        fila = { ...fila, subtotal, iva: total - subtotal, total, saldo_pendiente: b.saldo_pendiente === true };
      }
      if (b.proveedor_id) fila.proveedor_id = b.proveedor_id;

      const { data, error, migracionProveedorPendiente } = await escribirConProveedor(
        f => supabase.from('importaciones').insert(f).select().single(), fila);
      if (error) throw errorMigracionPuerto(error);
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
      if (b.fecha) fields.fecha = b.fecha;
      Object.assign(fields, camposPuerto(b));

      // Con el esquema de puesta en puerto, cualquier cambio en costos, ítems o fechas
      // recalcula el total y los montos de los pagos.
      const unida = { ...actual, ...fields };
      if (Costo.esPuerto(unida)) {
        if (!unida.cotizacion_usd) fields.cotizacion_usd = unida.cotizacion_usd = Costo.COTIZACION_DEFAULT;
        Object.assign(fields, completarPuerto(unida, b.pagos));
      }

      const { data, error, migracionProveedorPendiente } = await escribirConProveedor(
        f => supabase.from('importaciones').update(f).eq('id', id).select().single(), fields);
      if (error) throw errorMigracionPuerto(error);
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

        // El PPP necesita el stock de ANTES de que llegue la mercadería: se calcula primero y
        // se escribe después, sólo para los SKUs a los que se les sumó stock.
        let plan = null;
        if (Costo.esPuerto(data) && !actual.costos_aplicados_at) {
          try {
            plan = await planCostos(supabase, { ...data, items });
          } catch (planErr) {
            console.error('Error calculando el PPP de la importación:', planErr);
            data.costos_ppp = { error: planErr.message };
          }
        }

        try {
          data.stock_sync = await applyImportArrival(supabase, items);
        } catch (syncErr) {
          console.error('Error actualizando stock tras llegada de importación:', syncErr);
          data.stock_sync = { error: syncErr.message };
        }

        if (plan) {
          const sumados = (data.stock_sync?.aplicados || []).map(a => a.sku);
          data.costos_ppp = await guardarCostos(supabase, id, plan, sumados);
          data.costos_aplicados = data.costos_ppp.aplicados;
          data.costos_aplicados_at = new Date().toISOString();
        }
        // Los clientes que esperaban estos SKUs quedan listos para avisar. Sólo los SKUs a
        // los que de verdad se les sumó stock: uno que no existe en productos o cuyo stock
        // no se pudo guardar no volvió.
        const llegaron = (data.stock_sync?.aplicados || []).map(a => a.sku);
        data.avisos_stock = await marcarAvisosListos(supabase, llegaron, id);
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
