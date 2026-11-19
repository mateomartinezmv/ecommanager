// api/_pil.js
// Consulta el estado de un contenedor en la web de PIL (Pacific International Lines), la misma
// que se ve en pilship.com → Digital Solutions → Track & Trace → Container Number.
//
// La página pide dos cosas por AJAX:
//   1. common/get-n.php?timestamp=…            → { success, n }  (un token de un solo uso)
//   2. trackntrace-containertnt.php?module=TrackContStatus&refNo=<contenedor>&n=<token>&timestamp=…
//      → { success: true, data: '<html con el resumen y los movimientos>' }
//      → { error: true, data: 'No data found for Container Number …' }
// El firewall de PIL rechaza el pedido ("Request Rejected", con un support ID) si no lleva el
// Referer de la página de tracking, así que se manda como lo manda el navegador.
//
// El HTML trae:
//   · una tabla resumen con un renglón por tramo (puerto de carga / transbordo, buque, viaje,
//     próximo puerto y su fecha), y
//   · los movimientos: buque, viaje, fecha ("12-Nov-2026 01:36:00"; con "* " adelante es una
//     fecha estimada; "Information Not Available" es que todavía no pasó), evento y lugar.

const BASE = 'https://www.pilship.com/wp-content/themes/hello-theme-child-master/pil-api';
const REFERER = 'https://www.pilship.com/digital-solutions/?tab=customer&id=track-trace&label=containerTandT';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 12000;

const MESES = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function decodificar(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function limpiar(html) {
  return decodificar(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Las celdas del resumen separan sus datos con <br />.
function partes(html) {
  return String(html ?? '').split(/<br\s*\/?>/i).map(limpiar).filter(Boolean);
}

// "12-Nov-2026 01:36:00" → { fecha: '2026-11-12', hora: '01:36', estimado: false }
// "* 21-Nov-2026 12:00:00" → estimado. Sin fecha reconocible → null.
function fechaPIL(texto) {
  const s = String(texto ?? '').trim();
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (!m || !MESES[m[2].toLowerCase()]) return null;
  return {
    fecha: `${m[3]}-${MESES[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`,
    hora: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : null,
    estimado: s.startsWith('*'),
  };
}

function celda(fila, clase) {
  const m = new RegExp(`<td[^>]*class="[^"]*\\b${clase}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`, 'i').exec(fila);
  return m ? partes(m[1]) : [];
}

function parsearPIL(html) {
  const tramos = [];
  for (const fila of String(html || '').match(/<tr[^>]*class="[^"]*\bresultrow\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const fechas = celda(fila, 'arrival-delivery').map(fechaPIL).filter(Boolean);
    const lugar = celda(fila, 'location');            // ['Load Port', 'NINGBO', 'CNNGB']
    const buque = celda(fila, 'vessel-voyage');       // ['COSCO SHIPPING RHINE', 'VCSN0043W']
    const proximo = celda(fila, 'next-location');     // ['UYMVD', '26-Dec-2026']
    tramos.push({
      tipo: lugar[0] || null,
      puerto: lugar[1] || null,
      codigo: lugar[2] || null,
      llegada: fechas[0]?.fecha || null,
      salida: fechas[1]?.fecha || null,
      buque: buque[0] || null,
      viaje: buque[1] || null,
      proximo: proximo[0] || null,
      eta_proximo: fechaPIL(proximo[1])?.fecha || null,
    });
  }

  const eventos = [];
  const cuerpo = /<tbody[^>]*id="container_info_sub_[^"]*"[^>]*>([\s\S]*?)<\/tbody>/i.exec(String(html || ''));
  for (const fila of (cuerpo ? cuerpo[1].match(/<tr[\s\S]*?<\/tr>/gi) : null) || []) {
    const tds = [...fila.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => limpiar(m[1]));
    if (tds.length < 5 || !tds[3]) continue;
    const f = fechaPIL(tds[2]);
    eventos.push({
      fecha: f?.fecha || null,
      hora: f?.hora || null,
      // Sin fecha todavía no pasó: se muestra como pendiente.
      estimado: f ? f.estimado : true,
      evento: tds[3],
      lugar: tds[4] || null,
      buque: tds[0] || null,
      viaje: tds[1] || null,
    });
  }
  return { tramos, eventos };
}

class ErrorPIL extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo; }
}

async function pedirJSON(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: REFERER,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    });
  } catch (err) {
    const tiempo = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ErrorPIL(tiempo ? 'PIL no respondió a tiempo' : `No se pudo conectar con PIL: ${err.message}`, 'red');
  }
  const texto = await res.text();
  if (/Request Rejected/i.test(texto)) {
    const id = /support ID is:?\s*<?\s*([\w-]+)/i.exec(texto);
    throw new ErrorPIL(`PIL rechazó la consulta${id ? ` (support ID ${id[1]})` : ''}`, 'rechazada');
  }
  if (!res.ok) throw new ErrorPIL(`PIL respondió HTTP ${res.status}`, 'http');
  try { return JSON.parse(texto); } catch { throw new ErrorPIL('PIL respondió algo que no se pudo leer', 'formato'); }
}

// Devuelve { tramos, eventos } o tira un ErrorPIL con `codigo`: 'sin_datos' (PIL no conoce el
// contenedor), 'rechazada', 'red', 'http' o 'formato'.
async function consultarPIL(contenedor, { fetch: fetchImpl = globalThis.fetch, ahora = Date.now() } = {}) {
  const ref = String(contenedor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const token = await pedirJSON(`${BASE}/common/get-n.php?timestamp=${ahora}`, fetchImpl);
  if (!token?.success || !token.n) throw new ErrorPIL('PIL no entregó el permiso para consultar', 'formato');

  const url = `${BASE}/trackntrace-containertnt.php?module=TrackContStatus` +
    `&refNo=${encodeURIComponent(ref)}&n=${encodeURIComponent(token.n)}&timestamp=${ahora}`;
  const r = await pedirJSON(url, fetchImpl);
  if (r?.error || !r?.success) {
    const msg = limpiar(r?.data || '');
    if (/no data found/i.test(msg)) throw new ErrorPIL(`PIL todavía no tiene datos del contenedor ${ref}`, 'sin_datos');
    throw new ErrorPIL(msg ? `PIL: ${msg}` : 'PIL no devolvió el tracking', 'formato');
  }
  const datos = parsearPIL(r.data);
  if (!datos.eventos.length && !datos.tramos.length) throw new ErrorPIL('La respuesta de PIL no trae movimientos', 'formato');
  return datos;
}

module.exports = { consultarPIL, parsearPIL, fechaPIL, ErrorPIL, BASE, REFERER };
