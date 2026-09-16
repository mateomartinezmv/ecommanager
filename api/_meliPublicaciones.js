// api/_meliPublicaciones.js
// Helpers para clonar una publicación de MELI en otra con distinto ángulo de venta.
//
// La idea: un mismo producto se busca de formas distintas ("manillar", "manubrio",
// "para cross"). Una sola publicación sólo aparece en las búsquedas que coinciden con su
// título. Varias publicaciones del mismo producto, cada una apuntada a un ángulo distinto,
// cubren más búsquedas sin tocar la original.
//
// Lo que se copia del ítem original: categoría, precio, moneda, tipo de publicación,
// condición, fotos, atributos de ficha técnica, garantía y envío. Lo que cambia: el título,
// la descripción y el orden de las fotos (así la miniatura no es idéntica).
//
// OJO con lo que MELI no deja clonar y por eso se rechaza antes de intentarlo:
//   · Publicaciones de catálogo: el vendedor tiene una sola por producto de catálogo.
//   · Publicaciones con variaciones: cada variación es su propio producto de usuario y
//     copiarlas mal deja stock colgado. Se resuelven a mano.

const API = 'https://api.mercadolibre.com';

// Con menos de 3 ángulos el producto casi no aparece en búsquedas alternativas.
const ANGULOS_OBJETIVO = 3;

// Tope de MELI cuando la categoría no declara uno propio.
const MAX_TITULO_DEFAULT = 60;

// Atributos que no se mandan al crear: los deriva MELI o los ponemos nosotros aparte.
const ATRIBUTOS_NO_COPIABLES = new Set([
  'ITEM_CONDITION',    // va como `condition` en el cuerpo
  'SELLER_SKU',        // lo reescribimos con el SKU del CRM
  'EMPTY_GTIN_REASON', // depende de la validación de GTIN de la publicación nueva
]);

async function meliFetch(token, path, opciones = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opciones,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
  });
  const texto = await res.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }
  return { ok: res.ok, status: res.status, data };
}

async function meliGet(token, path) {
  const { ok, status, data } = await meliFetch(token, path);
  if (!ok) throw new Error(`MELI ${path}: ${data.message || data.error || `HTTP ${status}`}`);
  return data;
}

// Mensaje legible a partir del cuerpo de error de MELI, que trae el detalle en `cause`.
function mensajeDeError(data, status) {
  const causas = Array.isArray(data?.cause) ? data.cause : [];
  const detalle = causas
    .map(c => c.message || c.code)
    .filter(Boolean);
  if (detalle.length) return detalle.join(' · ');
  return data?.message || data?.error || `HTTP ${status}`;
}

// Atributos nombrados en el error, para poder reintentar sin ellos.
function atributosCulpables(data) {
  const causas = Array.isArray(data?.cause) ? data.cause : [];
  const ids = new Set();
  for (const c of causas) {
    const texto = `${c.message || ''} ${JSON.stringify(c.references || [])}`;
    for (const m of texto.matchAll(/\[?([A-Z][A-Z0-9_]{2,})\]?/g)) ids.add(m[1]);
  }
  return ids;
}

async function obtenerItem(token, itemId) {
  return meliGet(token, `/items/${itemId}`);
}

async function obtenerDescripcion(token, itemId) {
  const { ok, data } = await meliFetch(token, `/items/${itemId}/description`);
  if (!ok) return '';
  return data.plain_text || data.text || '';
}

// max_title_length lo define la categoría; pasarse es error de publicación.
async function maxTitulo(token, categoryId) {
  try {
    const cat = await meliGet(token, `/categories/${categoryId}`);
    return Number(cat?.settings?.max_title_length) || MAX_TITULO_DEFAULT;
  } catch {
    return MAX_TITULO_DEFAULT;
  }
}

// Por qué este ítem no se puede clonar, o null si se puede.
function motivoNoClonable(item) {
  if (!item) return 'No se pudo leer la publicación original en MELI.';
  if (item.catalog_listing) {
    return 'Es una publicación de catálogo: MELI permite una sola por vendedor y producto, no se puede duplicar.';
  }
  if (Array.isArray(item.variations) && item.variations.length) {
    return 'Tiene variaciones (talles, colores). Clonarlas automáticamente puede dejar stock mal repartido: conviene hacerla a mano.';
  }
  if (!item.pictures?.length) return 'La publicación original no tiene fotos.';
  if (!item.category_id) return 'La publicación original no tiene categoría.';
  return null;
}

// Rotar el orden de las fotos cambia la miniatura, que es lo primero que ve el comprador
// en los resultados. Dos publicaciones con la misma primera foto se leen como la misma.
function rotarFotos(pictures, giro) {
  const fotos = (pictures || []).map(p => p.secure_url || p.url).filter(Boolean);
  if (fotos.length < 2 || !giro) return fotos;
  const n = giro % fotos.length;
  return [...fotos.slice(n), ...fotos.slice(0, n)];
}

function atributosCopiables(attributes, sku, excluir = new Set()) {
  const salida = [];
  for (const a of attributes || []) {
    if (!a?.id || ATRIBUTOS_NO_COPIABLES.has(a.id) || excluir.has(a.id)) continue;
    if (a.value_id) salida.push({ id: a.id, value_id: a.value_id });
    else if (a.value_name) salida.push({ id: a.id, value_name: String(a.value_name) });
  }
  // El SKU del CRM viaja en la publicación: así "Importar desde MELI" la reconoce sola.
  if (sku) salida.push({ id: 'SELLER_SKU', value_name: String(sku) });
  return salida;
}

function saleTermsCopiables(saleTerms) {
  return (saleTerms || [])
    .filter(t => t?.id && (t.value_id || t.value_name))
    .map(t => (t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: String(t.value_name) }));
}

function envioCopiable(shipping) {
  if (!shipping) return undefined;
  const envio = {
    mode: shipping.mode,
    local_pick_up: !!shipping.local_pick_up,
    free_shipping: !!shipping.free_shipping,
  };
  if (shipping.dimensions) envio.dimensions = shipping.dimensions;
  return envio;
}

// El cuerpo del POST /items de la publicación nueva.
function construirPayload(item, { titulo, sku, stock, giroFotos = 0, excluirAtributos = new Set() }) {
  const payload = {
    title: titulo,
    category_id: item.category_id,
    price: item.price,
    currency_id: item.currency_id,
    available_quantity: Math.max(0, Number(stock) || 0),
    buying_mode: item.buying_mode || 'buy_it_now',
    condition: item.condition || 'new',
    listing_type_id: item.listing_type_id,
    pictures: rotarFotos(item.pictures, giroFotos).map(source => ({ source })),
    attributes: atributosCopiables(item.attributes, sku, excluirAtributos),
  };

  const terms = saleTermsCopiables(item.sale_terms);
  if (terms.length) payload.sale_terms = terms;

  const envio = envioCopiable(item.shipping);
  if (envio) payload.shipping = envio;

  if (sku) payload.seller_custom_field = String(sku);

  return payload;
}

// Validación previa de MELI: dice si la publicación entraría sin crearla.
// Si el recurso no contesta como se espera, se devuelve "no se pudo validar" en vez de
// frenar: la validación es una ayuda, no la que decide.
async function validarPayload(token, payload) {
  const { ok, status, data } = await meliFetch(token, '/items/validate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (status === 204 || (ok && !data?.cause?.length)) return { valida: true, errores: [] };
  if (status === 400 || status === 422) {
    return { valida: false, errores: [mensajeDeError(data, status)], culpables: atributosCulpables(data) };
  }
  return { valida: null, errores: [], aviso: `No se pudo validar contra MELI (HTTP ${status}).` };
}

// Crea la publicación. Si MELI rechaza por un atributo copiado del original, reintenta una
// vez sin esos atributos: es el fallo más común al clonar y no amerita frenar todo.
async function crearPublicacion(token, item, opciones) {
  let payload = construirPayload(item, opciones);
  let intento = await meliFetch(token, '/items', { method: 'POST', body: JSON.stringify(payload) });

  if (!intento.ok) {
    const culpables = atributosCulpables(intento.data);
    const copiados = new Set(payload.attributes.map(a => a.id));
    const aQuitar = new Set([...culpables].filter(id => copiados.has(id) && id !== 'SELLER_SKU'));

    if (aQuitar.size) {
      payload = construirPayload(item, { ...opciones, excluirAtributos: aQuitar });
      intento = await meliFetch(token, '/items', { method: 'POST', body: JSON.stringify(payload) });
    }
  }

  if (!intento.ok) throw new Error(mensajeDeError(intento.data, intento.status));
  return intento.data;
}

async function ponerDescripcion(token, itemId, texto) {
  const plano = limpiarDescripcion(texto);
  if (!plano) return;
  const { ok, status, data } = await meliFetch(token, `/items/${itemId}/description`, {
    method: 'POST',
    body: JSON.stringify({ plain_text: plano }),
  });
  if (!ok) throw new Error(mensajeDeError(data, status));
}

// MELI sólo acepta texto plano: sin HTML ni emojis, y los saltos de línea como \n.
function limpiarDescripcion(texto) {
  return String(texto || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, 4000);
}

// Un título de MELI no lleva signos, ni menciones a stock, envío o condición.
function limpiarTitulo(texto, max = MAX_TITULO_DEFAULT) {
  const limpio = String(texto || '')
    .replace(/[^\p{L}\p{N}\s./-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpio.length <= max) return limpio;
  // Cortar por palabra: un título cortado al medio se ve peor que uno más corto.
  return limpio.slice(0, max).replace(/\s+\S*$/, '').trim();
}

module.exports = {
  API,
  ANGULOS_OBJETIVO,
  MAX_TITULO_DEFAULT,
  meliFetch,
  meliGet,
  mensajeDeError,
  obtenerItem,
  obtenerDescripcion,
  maxTitulo,
  motivoNoClonable,
  construirPayload,
  validarPayload,
  crearPublicacion,
  ponerDescripcion,
  limpiarDescripcion,
  limpiarTitulo,
  rotarFotos,
};
