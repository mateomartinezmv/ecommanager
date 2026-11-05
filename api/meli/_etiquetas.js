// api/meli/_etiquetas.js
// Las etiquetas de MELI de varios envíos a la vez, para ✅ Control de despacho → 🖨️.
//
// La pantalla manda ids de envíos del CRM y acá se traducen al shipment de MELI:
//   · meli_shipment_id, si ya está guardado;
//   · el número que viene adentro del tracking de Mercado Envíos ("MEL48412750656FMDOF01");
//   · si no, la orden → su shipment (Flex que la sincronización todavía no completó), y se guarda.
//
// "¿Ya está impresa?" se le pregunta a MELI y no se anota en el CRM: así cuenta también lo
// que se imprimió desde el panel de Mercado Libre.

'use strict';

const { shipmentIdDeOrden, obtenerShipment } = require('../_meliEnvios');
const { faltaMigracionControl } = require('../_controlEnvios');

const MAX_ETIQUETAS = 50;   // tope de /shipment_labels por pedido

function shipmentDelTracking(tracking) {
  const m = /^MEL(\d+)/.exec(String(tracking || ''));
  return m ? m[1] : null;
}

// [{ envioId, shipmentId }] en el orden pedido; shipmentId null si no se pudo resolver.
async function shipmentsDeEnvios(supabase, token, envioIds, deps = {}) {
  const resolverOrden = deps.shipmentIdDeOrden || shipmentIdDeOrden;
  const { data, error } = await supabase.from('envios').select('*').in('id', envioIds);
  if (error) throw new Error(error.message);
  const porId = Object.fromEntries((data || []).map(e => [e.id, e]));

  const resultado = [];
  for (const envioId of envioIds) {
    const envio = porId[envioId];
    if (!envio) { resultado.push({ envioId, shipmentId: null }); continue; }
    let shipmentId = envio.meli_shipment_id || shipmentDelTracking(envio.tracking);
    if (!shipmentId && envio.orden) {
      shipmentId = await resolverOrden(token, envio.orden).catch(() => null);
    }
    // Se guarda para la próxima (y para el escaneo de la etiqueta). Sin la columna, se sigue.
    if (shipmentId && 'meli_shipment_id' in envio && !envio.meli_shipment_id) {
      const { error: errUpd } = await supabase.from('envios')
        .update({ meli_shipment_id: String(shipmentId) }).eq('id', envioId);
      if (errUpd && !faltaMigracionControl(errUpd)) throw new Error(errUpd.message);
    }
    resultado.push({ envioId, shipmentId: shipmentId ? String(shipmentId) : null });
  }
  return resultado;
}

// Qué dice MELI de la etiqueta de un shipment.
//   impresa    → ya se imprimió alguna vez (desde el CRM o desde el panel de MELI).
//   imprimible → MELI la entrega: el paquete está listo para despachar y todavía no salió.
function estadoEtiqueta(shipment) {
  const status = shipment?.status || null;
  const substatus = shipment?.substatus || null;
  const impresa = substatus === 'printed' || !!shipment?.status_history?.date_first_printed;
  const imprimible = status === 'ready_to_ship' && (!substatus || substatus === 'ready_to_print' || substatus === 'printed');
  return { status, substatus, impresa, imprimible };
}

async function estadosDeEtiquetas(token, envios, deps = {}) {
  const traer = deps.obtenerShipment || obtenerShipment;
  const estados = {};
  await Promise.all(envios.map(async ({ envioId, shipmentId }) => {
    if (!shipmentId) { estados[envioId] = { shipmentId: null, impresa: false, imprimible: false, motivo: 'sin_shipment' }; return; }
    const shipment = await traer(token, shipmentId).catch(() => null);
    estados[envioId] = shipment
      ? { shipmentId, ...estadoEtiqueta(shipment) }
      : { shipmentId, impresa: false, imprimible: false, motivo: 'meli_no_responde' };
  }));
  return estados;
}

// Lo que MELI explica cuando no da las etiquetas, para mostrarlo tal cual en la pantalla.
function mensajeDeMeli(cuerpo, status) {
  if (cuerpo && typeof cuerpo === 'object') {
    const causa = Array.isArray(cuerpo.cause) ? cuerpo.cause.map(c => c?.message || c?.code || c).filter(Boolean).join('; ') : '';
    return [cuerpo.message || cuerpo.error, causa].filter(Boolean).join(' — ') || `MELI respondió ${status}`;
  }
  return `MELI respondió ${status}`;
}

module.exports = { MAX_ETIQUETAS, shipmentsDeEnvios, estadoEtiqueta, estadosDeEtiquetas, mensajeDeMeli, shipmentDelTracking };
