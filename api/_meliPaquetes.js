// api/_meliPaquetes.js
// Un paquete = un envío.
//
// Cuando alguien compra varios productos de una, MELI no manda una orden con
// varios ítems: parte el carrito en una orden por publicación y las ata con un
// mismo `pack_id` y un único shipment. Registrar el envío por orden —o peor,
// por ítem— cobraba el flete tantas veces como productos tuviera la compra.
//
// La regla vive acá: el envío se identifica por el paquete (el pack del
// carrito, o la propia orden cuando la compra fue de un solo producto), nunca
// por la línea de venta.

'use strict';

const { ordenesDelShipment } = require('./_meliEnvios');

function packIdDeOrden(order) {
  const pack = order?.pack_id;
  return pack ? String(pack) : null;
}

// Identificador del paquete. Sin carrito, la orden es el paquete.
function claveDePaquete(order) {
  return packIdDeOrden(order) || String(order?.id ?? '');
}

function envioIdDePaquete(clave) {
  return `E_MELI_${clave}`;
}

// Todas las órdenes que viajan en el mismo paquete. El shipment es la fuente
// autorizada (resuelve el carrito completo); si no contesta, queda al menos la
// orden que estamos procesando.
async function ordenesDelPaquete(token, order, shipmentId) {
  const ordenes = new Set([String(order.id)]);
  if (shipmentId) {
    try {
      for (const o of await ordenesDelShipment(token, String(shipmentId))) {
        ordenes.add(String(o));
      }
    } catch (err) {
      console.error(`⚠ No se pudieron resolver las órdenes del shipment ${shipmentId}: ${err.message}`);
    }
  }
  return [...ordenes];
}

// Las líneas de venta ya registradas del paquete, en orden estable (el mismo
// criterio que usa el CRM para elegir la "primera" línea de un carrito).
async function lineasDelPaquete(supabase, { packId, ordenes }) {
  const porId = new Map();
  const campos = 'id, producto, cantidad, orden_meli';

  if (ordenes && ordenes.length) {
    const { data } = await supabase.from('ventas').select(campos).in('orden_meli', ordenes);
    for (const fila of data || []) porId.set(fila.id, fila);
  }
  // Respaldo por si el shipment no listó todas las órdenes del carrito.
  if (packId) {
    const { data } = await supabase.from('ventas').select(campos).eq('pack_id', packId);
    for (const fila of data || []) porId.set(fila.id, fila);
  }

  return [...porId.values()].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
}

// Lo que se escribe en el envío: un producto suelto va con su nombre tal cual,
// un carrito lista todo lo que entra en la caja.
function descripcionDePaquete(lineas) {
  if (!lineas.length) return null;
  if (lineas.length === 1) return lineas[0].producto;
  return lineas.map(v => `${v.producto} x${v.cantidad}`).join(' + ');
}

// El envío del paquete, si ya está registrado. Busca por el id nuevo y también
// por líneas y órdenes: los envíos viejos (uno por ítem) tienen otro id y
// tampoco hay que duplicarlos.
async function buscarEnvioDePaquete(supabase, { envioId, ordenes, ventaIds }) {
  const { data: porId } = await supabase.from('envios').select('*').eq('id', envioId).maybeSingle();
  if (porId) return porId;

  if (ventaIds && ventaIds.length) {
    const { data } = await supabase.from('envios').select('*')
      .in('venta_id', ventaIds).order('created_at', { ascending: true });
    if (data && data.length) return data[0];
  }

  if (ordenes && ordenes.length) {
    const { data } = await supabase.from('envios').select('*')
      .in('orden', ordenes).order('created_at', { ascending: true });
    if (data && data.length) return data[0];
  }

  return null;
}

// Registra —o completa— el único envío del paquete.
//
// Es idempotente y aguanta webhooks simultáneos: las órdenes de un carrito
// llegan casi en el mismo segundo y todas calculan el mismo id, así que la
// clave primaria resuelve el empate. El que llega después no duplica: suma su
// producto a la descripción del paquete.
async function registrarEnvioDePaquete(supabase, { order, packId = null, ordenes = [], datos = {} }) {
  const envioId = envioIdDePaquete(packId || String(order.id));
  const lineas = await lineasDelPaquete(supabase, { packId, ordenes });
  const ventaIds = lineas.map(l => l.id);
  const producto = descripcionDePaquete(lineas);

  const existente = await buscarEnvioDePaquete(supabase, { envioId, ordenes, ventaIds });

  if (existente) {
    // Lo único que puede haber cambiado es qué entra en la caja: llegó el
    // webhook de otra orden del mismo carrito. Lo demás (estado, costo, zona)
    // puede venir corregido a mano y no se pisa.
    const update = {};
    if (producto && producto !== existente.producto) update.producto = producto;
    if (packId && !existente.pack_id) update.pack_id = packId;
    if (Object.keys(update).length) {
      await supabase.from('envios').update(update).eq('id', existente.id);
    }
    return { id: existente.id, creado: false, producto: update.producto || existente.producto };
  }

  // Sin ninguna línea registrada no hay nada que despachar (la publicación no
  // está vinculada a ningún SKU): el envío se crea cuando la venta exista.
  if (!lineas.length) return { id: null, creado: false, motivo: 'sin_ventas' };

  const { error } = await supabase.from('envios').insert({
    id: envioId,
    venta_id: ventaIds[0],
    orden: String(order.id),
    pack_id: packId,
    comprador: datos.comprador || '',
    producto,
    transportista: datos.transportista,
    tracking: datos.tracking || null,
    fecha_despacho: datos.fechaDespacho || null,
    estado: datos.estado || 'pendiente',
    direccion: datos.direccion || null,
    costo: datos.costo ?? 0,
    zona: datos.zona ?? null,
  });

  if (!error) return { id: envioId, creado: true, producto };

  // 23505 = otra orden del mismo carrito ganó la carrera. No es un error: es
  // exactamente lo que buscamos, un solo envío.
  if (error.code === '23505') {
    if (producto) await supabase.from('envios').update({ producto }).eq('id', envioId);
    return { id: envioId, creado: false, producto };
  }

  throw new Error(`Error creando envío ${envioId}: ${error.message}`);
}

module.exports = {
  packIdDeOrden,
  claveDePaquete,
  envioIdDePaquete,
  ordenesDelPaquete,
  lineasDelPaquete,
  descripcionDePaquete,
  buscarEnvioDePaquete,
  registrarEnvioDePaquete,
};
