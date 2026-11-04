// api/meli/_facturaMeli.js
// Adjuntar a una venta de MELI el PDF de su factura (el eTicket que se emitió en Gesta).
//
// MELI recibe la factura por paquete: POST /packs/{pack_id}/fiscal_documents, multipart con el
// archivo en el campo `fiscal_document`. Una venta sin carrito no tiene pack_id: ahí el número
// del "paquete" es el de la orden. Es el mismo número que el CRM pone en la ADENDA del Excel de
// Gesta (ver public/gesta.js), así que el PDF ya trae impreso a qué venta va.
//
// MELI acepta un solo .pdf de hasta 1 MB por venta (lo dice la pantalla de "Adjunta el
// comprobante"): se valida acá antes de mandarlo, para devolver un error claro en vez del de MELI.

'use strict';

const MAX_PDF_BYTES = 1024 * 1024;

// El número con el que MELI identifica el paquete de la venta.
function packDeVenta(venta) {
  if (!venta) return null;
  return String(venta.pack_id || venta.orden_meli || '').trim() || null;
}

// Las líneas del CRM que son la misma venta de MELI: todo el carrito si hay pack, si no la orden.
function filtroDeVenta(venta) {
  if (venta.pack_id) return { columna: 'pack_id', valor: String(venta.pack_id) };
  return { columna: 'orden_meli', valor: String(venta.orden_meli) };
}

// Valida el PDF que manda la pantalla (en base64) y lo devuelve como Buffer.
function pdfDesdeBase64(base64) {
  if (!base64 || typeof base64 !== 'string') throw new Error('No llegó ningún PDF.');
  const limpio = base64.replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(limpio, 'base64');
  if (!buf.length) throw new Error('El PDF llegó vacío.');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('El archivo no es un PDF.');
  if (buf.length > MAX_PDF_BYTES) {
    throw new Error(`El PDF pesa ${(buf.length / 1024 / 1024).toFixed(2)} MB y MELI acepta hasta 1 MB.`);
  }
  return buf;
}

function nombrePdf(nombre, pack) {
  const base = String(nombre || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  if (base) return /\.pdf$/i.test(base) ? base : base + '.pdf';
  return `factura-${pack}.pdf`;
}

// Sube el PDF a MELI. `fetchImpl` se inyecta en los tests.
async function subirFacturaMeli({ token, pack, pdf, nombre, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('fiscal_document', new Blob([pdf], { type: 'application/pdf' }), nombrePdf(nombre, pack));
  const r = await fetchImpl(`https://api.mercadolibre.com/packs/${encodeURIComponent(pack)}/fiscal_documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = { message: texto.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, cuerpo };
}

module.exports = { MAX_PDF_BYTES, packDeVenta, filtroDeVenta, pdfDesdeBase64, nombrePdf, subirFacturaMeli };
