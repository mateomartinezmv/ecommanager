// api/_controlEnvios.js
// Lo que necesita la pantalla ✅ Control de despacho del lado del servidor:
//
//   · encontrar el envío de una etiqueta de MELI escaneada, aunque el CRM todavía no tenga
//     guardado el número de envío (Flex, o un envío que la sincronización no alcanzó);
//   · las fotos de los productos, para que quien arma vea qué tiene que ir en la caja;
//   · guardar el resultado del control, sin romper si la migración no corrió.
//
// La etiqueta de Mercado Envíos trae el id del shipment en el código de barras
// ("48412750656"), que el CRM ya tiene adentro del tracking ("MEL48412750656FMDOF01"). La de
// Flex trae un QR con un JSON ({"id":"4…","sender_id":…}) y su tracking es otro código, así
// que la primera vez se le pregunta a MELI de qué órdenes es ese shipment y se guarda.

'use strict';

const { obtenerShipment, ordenesDelShipment } = require('./_meliEnvios');

const MIGRACION = '20261103000000_add_control_envios.sql';
const MIGRACION_ETIQUETA = '20261103010000_add_etiqueta_impresa.sql';
const COLUMNAS = ['meli_shipment_id', 'controlado_at', 'control', 'etiqueta_impresa_at'];

// ¿El error es "esa columna no existe"? Pasa cuando el deploy llega antes que la migración.
function faltaMigracionControl(error) {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const msg = String(error.message || '');
  return COLUMNAS.some(c => msg.includes(c)) && /column|columna/i.test(msg);
}

// Los números que pueden ser un shipment, un pack o una orden de MELI, en el orden en que
// aparecen. El lector "tipea" lo que lee y, si está configurado con otro idioma de teclado
// que la PC, las comillas y llaves del QR de Flex salen cambiadas: los dígitos no, por eso
// se buscan tramos de dígitos y no se parsea el JSON.
function codigosCandidatos(texto) {
  const vistos = new Set();
  for (const m of String(texto || '').matchAll(/\d{8,20}/g)) vistos.add(m[0]);
  return [...vistos];
}

// Busca en la base un envío que corresponda a alguno de los números. Devuelve la fila o null.
async function envioEnLaBase(supabase, numeros) {
  for (const n of numeros) {
    // meli_shipment_id puede no existir todavía (migración sin correr): esa consulta se
    // tolera y se sigue con las otras.
    const consultas = [
      supabase.from('envios').select('*').eq('meli_shipment_id', n).limit(1),
      supabase.from('envios').select('*').eq('pack_id', n).limit(1),
      supabase.from('envios').select('*').eq('orden', n).limit(1),
      supabase.from('envios').select('*').like('tracking', `%${n}%`).limit(1),
    ];
    for (const q of consultas) {
      const { data, error } = await q;
      if (error) {
        if (faltaMigracionControl(error)) continue;
        throw new Error(error.message);
      }
      if (data && data[0]) return data[0];
    }
  }
  return null;
}

// Envío de un paquete a partir de las órdenes que cubre su shipment: por la orden del envío,
// o —en un carrito, donde el envío se guarda con una sola de las órdenes— por la venta o
// el pack de alguna de ellas.
async function envioDeOrdenes(supabase, ordenes) {
  if (!ordenes.length) return null;
  const { data: porOrden, error } = await supabase.from('envios').select('*').in('orden', ordenes).limit(1);
  if (error) throw new Error(error.message);
  if (porOrden && porOrden[0]) return porOrden[0];

  const { data: ventas, error: errV } = await supabase.from('ventas')
    .select('id, pack_id').in('orden_meli', ordenes);
  if (errV) throw new Error(errV.message);
  if (!ventas || !ventas.length) return null;

  const packs = [...new Set(ventas.map(v => v.pack_id).filter(Boolean))];
  if (packs.length) {
    const { data } = await supabase.from('envios').select('*').in('pack_id', packs).limit(1);
    if (data && data[0]) return data[0];
  }
  const { data } = await supabase.from('envios').select('*').in('venta_id', ventas.map(v => v.id)).limit(1);
  return (data && data[0]) || null;
}

// Guarda el shipment en el envío para que la próxima vez lo encuentre la pantalla sola. Si
// la columna no existe todavía no pasa nada: el control funciona igual, sólo que vuelve a
// preguntarle a MELI.
async function guardarShipmentId(supabase, envio, shipmentId) {
  if (!('meli_shipment_id' in envio) || envio.meli_shipment_id) return envio;
  const { error } = await supabase.from('envios')
    .update({ meli_shipment_id: shipmentId }).eq('id', envio.id);
  if (error && !faltaMigracionControl(error)) throw new Error(error.message);
  return error ? envio : { ...envio, meli_shipment_id: shipmentId };
}

// El envío de una etiqueta escaneada. `deps` permite reemplazar las llamadas a MELI en los
// tests. Devuelve { envio, shipmentId, origen } o null.
async function buscarEnvioPorCodigo(supabase, getToken, codigo, deps = {}) {
  const numeros = codigosCandidatos(codigo);
  if (!numeros.length) return null;

  const enBase = await envioEnLaBase(supabase, numeros);
  if (enBase) return { envio: enBase, shipmentId: enBase.meli_shipment_id || null, origen: 'base' };

  const traerShipment = deps.obtenerShipment || obtenerShipment;
  const traerOrdenes = deps.ordenesDelShipment || ordenesDelShipment;
  const token = await getToken();
  for (const n of numeros) {
    const shipment = await traerShipment(token, n).catch(() => null);
    if (!shipment) continue;
    const ordenes = await traerOrdenes(token, n, shipment);
    const envio = await envioDeOrdenes(supabase, ordenes);
    if (!envio) continue;
    return { envio: await guardarShipmentId(supabase, envio, n), shipmentId: n, origen: 'meli' };
  }
  return null;
}

// Foto de cada publicación (la primera, que es la que el comprador vio al comprar).
async function fotosDePublicaciones(token, ids, fetchImpl = fetch) {
  const fotos = {};
  const limpios = [...new Set(ids.map(s => String(s).trim()).filter(s => /^[A-Z]{3}\d+$/.test(s)))].slice(0, 20);
  if (!limpios.length) return fotos;
  const res = await fetchImpl(
    `https://api.mercadolibre.com/items?ids=${limpios.join(',')}&attributes=id,thumbnail,secure_thumbnail,pictures`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  for (const r of Array.isArray(data) ? data : []) {
    const it = r?.body;
    if (!it?.id) continue;
    const url = it.pictures?.[0]?.secure_url || it.secure_thumbnail || it.thumbnail;
    if (url) fotos[it.id] = url;
  }
  return fotos;
}

// Las columnas del control que vienen en un PUT de /api/envios. Sólo lo que viene: así
// "deshacer el control" (controladoAt: null) no toca el resto.
function camposControl(body = {}) {
  const update = {};
  if (body.controladoAt !== undefined) update.controlado_at = body.controladoAt || null;
  if (body.control !== undefined) update.control = body.control || null;
  if (body.meliShipmentId !== undefined) update.meli_shipment_id = body.meliShipmentId || null;
  if (body.etiquetaImpresaAt !== undefined) update.etiqueta_impresa_at = body.etiquetaImpresaAt || null;
  return update;
}

module.exports = {
  MIGRACION,
  MIGRACION_ETIQUETA,
  faltaMigracionControl,
  codigosCandidatos,
  buscarEnvioPorCodigo,
  fotosDePublicaciones,
  camposControl,
};
