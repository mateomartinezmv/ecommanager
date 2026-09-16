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
// El título viaja en un campo u otro según el modelo en el que esté la cuenta:
//   · Modelo viejo: se manda `title` y eso es lo que se ve.
//   · User Products (cuentas con el tag user_product_seller): se manda `family_name` —un
//     nombre genérico— y MELI arma el título visible pegándole los atributos que distinguen
//     a la variante ("... Ajustable" + "Negro"). Mandar `title` ahí es error.
// Se detecta por el ítem original (si tiene family_name ya está en el modelo nuevo) y por
// los tags del vendedor; si aun así MELI pide el otro campo, se reintenta con ese.
//
// OJO con lo que MELI no deja clonar y por eso se rechaza antes de intentarlo:
//   · Publicaciones con variaciones: cada variación es su propio producto de usuario y
//     copiarlas mal deja stock colgado. Se resuelven a mano.
//
// De una publicación de catálogo sí se puede sacar un ángulo: lo que MELI no permite es una
// segunda publicación DE CATÁLOGO del mismo producto, no una publicación propia. El clon se
// crea siempre como propia —nunca se copia catalog_product_id— con su título, su descripción
// y su portada. En los dominios donde MELI sólo admite catálogo la validación lo va a
// rechazar, y ahí el motivo se muestra tal cual.

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

// Cuánto puede medir el título que ve el comprador.
//
// La categoría declara un max_title_length que en varias categorías de MLU viene en 200,
// pero un título de 200 no existe en la práctica: MELI corta en la búsqueda y queda ilegible.
// El límite real con el que trabaja el vendedor es 60, así que se toma el menor de los dos.
async function maxTitulo(token, categoryId) {
  let deLaCategoria = 0;
  try {
    const cat = await meliGet(token, `/categories/${categoryId}`);
    deLaCategoria = Number(cat?.settings?.max_title_length) || 0;
  } catch { /* se usa el tope */ }
  return Math.min(deLaCategoria || MAX_TITULO_DEFAULT, MAX_TITULO_DEFAULT);
}

// En User Products el vendedor escribe el nombre base y MELI le pega los atributos de la
// variante. Lo que tiene que entrar en los 60 es la suma, así que el nombre base va más
// corto: lo que sobra después del sufijo. Nunca menos de 25, que ya no alcanza para nada.
function maxNombreBase(max, sufijo) {
  const largoSufijo = String(sufijo || '').trim().length;
  if (!largoSufijo) return max;
  return Math.max(25, max - largoSufijo - 1);
}

// ¿En qué campo viaja el título para esta cuenta?
function detectarModoTitulo(item, usuario) {
  if (item && item.family_name) return 'family_name';
  if (usuario && Array.isArray(usuario.tags) && usuario.tags.includes('user_product_seller')) return 'family_name';
  return 'title';
}

// Lo que MELI le agrega al family_name para armar el título visible (el color, la medida).
// Se deduce del original: título visible menos family_name. Sirve para mostrar en pantalla
// cómo va a quedar el título de verdad antes de publicar.
function sufijoTitulo(item) {
  if (!item?.family_name || !item?.title) return '';
  const titulo = String(item.title).trim();
  const base = String(item.family_name).trim();
  if (!titulo.toLowerCase().startsWith(base.toLowerCase())) return '';
  return titulo.slice(base.length).trim();
}

function tituloFinal(base, sufijo) {
  return [String(base || '').trim(), String(sufijo || '').trim()].filter(Boolean).join(' ');
}

// MELI avisa qué campo de título le falta al cuerpo; con eso se reintenta en el otro modelo.
function modoQuePide(data) {
  const texto = JSON.stringify(data || {});
  if (/family_name/.test(texto)) return 'family_name';
  if (/\btitle\b/.test(texto) && /required|does not contain|missing/i.test(texto)) return 'title';
  return null;
}

// Por qué este ítem no se puede clonar, o null si se puede.
function motivoNoClonable(item) {
  if (!item) return 'No se pudo leer la publicación original en MELI.';
  if (Array.isArray(item.variations) && item.variations.length) {
    return 'Tiene variaciones (talles, colores). Clonarlas automáticamente puede dejar stock mal repartido: conviene hacerla a mano.';
  }
  if (!item.pictures?.length) return 'La publicación original no tiene fotos.';
  if (!item.category_id) return 'La publicación original no tiene categoría.';
  return null;
}

// Rotar el orden de las fotos cambia la miniatura, que es lo primero que ve el comprador
// en los resultados. Dos publicaciones con la misma primera foto se leen como la misma.
// Las fotos van en el orden de la original, salvo la portada, que se elige.
//
// Antes se rotaba el orden para que la miniatura no fuera idéntica, pero rotar a ciegas
// asciende a portada una de las últimas fotos, que suelen ser de contexto: se entienden
// acompañando a las primeras y solas quedan raras. La portada ahora la elige el vendedor y
// por defecto es la misma que la original.
function ordenarFotos(pictures, portada = 0) {
  const fotos = (pictures || []).map(p => p.secure_url || p.url).filter(Boolean);
  const i = Number(portada);
  if (fotos.length < 2 || !Number.isInteger(i) || i <= 0 || i >= fotos.length) return fotos;
  return [fotos[i], ...fotos.filter((_, n) => n !== i)];
}

// Cada atributo viaja con value_id Y value_name cuando tiene los dos. Mandar sólo el id
// alcanza mientras el valor esté en el catálogo de MELI, pero con valores propios del
// vendedor (una marca genérica, por ejemplo) el id no resuelve a ningún nombre y MELI
// contesta "Value name of attribute BRAND was not provided and couldn't be resolved".
function atributosCopiables(attributes, sku, excluir = new Set()) {
  const salida = [];
  for (const a of attributes || []) {
    if (!a?.id || ATRIBUTOS_NO_COPIABLES.has(a.id) || excluir.has(a.id)) continue;
    const attr = { id: a.id };
    if (a.value_id) attr.value_id = a.value_id;
    if (a.value_name) attr.value_name = String(a.value_name);
    if (attr.value_id || attr.value_name) salida.push(attr);
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

// El envío se copia en tres escalones, de más fiel a más conservador:
//   'completo'  → modo, retiro en persona, envío gratis y dimensiones tal cual el original.
//   'sin_modo'  → sin el modo. Publicaciones viejas quedaron en modos que la cuenta ya no
//                 tiene habilitados ("User has not mode me1") y ahí MELI rechaza el alta.
//   'ninguno'   → sin el bloque: MELI le pone la configuración de envío por defecto.
function envioCopiable(shipping, nivel = 'completo') {
  if (!shipping || nivel === 'ninguno') return undefined;
  const envio = {
    local_pick_up: !!shipping.local_pick_up,
    free_shipping: !!shipping.free_shipping,
  };
  if (nivel === 'completo' && shipping.mode) envio.mode = shipping.mode;
  if (shipping.dimensions) envio.dimensions = shipping.dimensions;
  return envio;
}

// ¿El rechazo de MELI es por el envío? Entonces conviene bajar un escalón.
function errorDeEnvio(data) {
  return /has not mode|shipping|logistic|me1|me2/i.test(JSON.stringify(data || {}));
}

// Reparos que no hablan de la publicación sino de cómo está configurada la cuenta para
// publicar. Verificado contra la cuenta real: MELI los devuelve incluso al validar una copia
// exacta de una publicación propia que está activa y vendiendo, con cualquier configuración
// de envío y hasta sin bloque de envío. La validación previa se equivoca al rechazar por
// esto, así que no se trata como un rechazo del ángulo sino como validación no concluyente.
const CAUSAS_DE_CUENTA = [
  {
    re: /user has not mode/i,
    texto: 'el modo de envío que MELI le asigna a las publicaciones nuevas no está habilitado en la cuenta',
  },
  {
    re: /free shipping costs exceeds sale/i,
    texto: 'a este precio, el envío gratis que la cuenta tiene configurado para todo el país sale más caro que el producto (con un precio más alto deja de aparecer)',
  },
  {
    re: /mandatory free shipping/i,
    texto: 'MELI le suma envío gratis obligatorio por el precio',
  },
];

// Devuelve las causas explicadas, o null si alguna habla de verdad del ítem —un título largo,
// un atributo que falta—, en cuyo caso el rechazo es real y se muestra como tal.
function causasDeCuenta(data) {
  const causas = Array.isArray(data?.cause) ? data.cause : [];
  const textos = causas.map(c => c.message || c.code || '').filter(Boolean);
  if (!textos.length) return null;

  const explicadas = [];
  for (const t of textos) {
    const conocida = CAUSAS_DE_CUENTA.find(c => c.re.test(t));
    if (!conocida) return null;
    if (!explicadas.includes(conocida.texto)) explicadas.push(conocida.texto);
  }
  return explicadas;
}

const ESCALONES_ENVIO = ['completo', 'sin_modo', 'ninguno'];

// El cuerpo del POST /items de la publicación nueva.
function construirPayload(item, { titulo, sku, stock, portada = 0, excluirAtributos = new Set(), modoTitulo = 'title', envio = 'completo' }) {
  const payload = {
    // En User Products el título lo arma MELI: acá va el nombre genérico de la familia.
    ...(modoTitulo === 'family_name' ? { family_name: titulo } : { title: titulo }),
    category_id: item.category_id,
    price: item.price,
    currency_id: item.currency_id,
    available_quantity: Math.max(0, Number(stock) || 0),
    buying_mode: item.buying_mode || 'buy_it_now',
    condition: item.condition || 'new',
    listing_type_id: item.listing_type_id,
    pictures: ordenarFotos(item.pictures, portada).map(source => ({ source })),
    attributes: atributosCopiables(item.attributes, sku, excluirAtributos),
  };

  const terms = saleTermsCopiables(item.sale_terms);
  if (terms.length) payload.sale_terms = terms;

  const bloqueEnvio = envioCopiable(item.shipping, envio);
  if (bloqueEnvio) payload.shipping = bloqueEnvio;

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

  if (status === 204 || (ok && !data?.cause?.length)) return { valida: true, errores: [], data };
  if (status === 400 || status === 422) {
    return { valida: false, errores: [mensajeDeError(data, status)], culpables: atributosCulpables(data), data };
  }
  return { valida: null, errores: [], aviso: `No se pudo validar contra MELI (HTTP ${status}).`, data };
}

// Prueba un cuerpo y, ante los rechazos de forma que MELI devuelve al clonar, lo ajusta y
// reintenta. Los tres que aparecen en la práctica, en orden de probarlos:
//   1. El título va en el otro campo (title vs family_name).
//   2. El envío copiado no le sirve a la cuenta ("User has not mode me1") → baja un escalón.
//   3. Un atributo copiado no aplica a la publicación nueva → se saca ese.
// Todo esto es forma, no fondo: si el rechazo es otro, se devuelve tal cual para mostrarlo.
async function conAjustes(item, opciones, hacer) {
  let modoTitulo = opciones.modoTitulo || detectarModoTitulo(item);
  let envio = opciones.envio || 'completo';
  const excluir = new Set(opciones.excluirAtributos || []);
  let ultimo = null;

  for (let intento = 0; intento < 6; intento++) {
    const payload = construirPayload(item, { ...opciones, modoTitulo, envio, excluirAtributos: excluir });
    const ajustes = { modoTitulo, envio, atributosQuitados: [...excluir] };
    const r = await hacer(payload);
    if (r.ok) return { ...r, ajustes, payload };
    ultimo = { ...r, ajustes, payload };

    const pide = modoQuePide(r.data);
    if (pide && pide !== modoTitulo) { modoTitulo = pide; continue; }

    const siguienteEnvio = ESCALONES_ENVIO[ESCALONES_ENVIO.indexOf(envio) + 1];
    if (siguienteEnvio && errorDeEnvio(r.data)) { envio = siguienteEnvio; continue; }

    const copiados = new Set((payload.attributes || []).map(a => a.id));
    const aQuitar = [...atributosCulpables(r.data)].filter(id => copiados.has(id) && id !== 'SELLER_SKU');
    if (aQuitar.length) { aQuitar.forEach(id => excluir.add(id)); continue; }

    break;
  }

  return ultimo;
}

// Lo que hubo que tocar para que MELI la aceptara, en castellano y sólo si no fue lo obvio.
function avisosDeAjustes(ajustes) {
  const avisos = [];
  if (ajustes?.envio === 'sin_modo') avisos.push('el modo de envío de la original no está habilitado en la cuenta, así que la nueva usa el que MELI le asigne');
  if (ajustes?.envio === 'ninguno') avisos.push('MELI no aceptó la configuración de envío de la original: la nueva queda con la de por defecto, revisala');
  if (ajustes?.atributosQuitados?.length) avisos.push(`se publicó sin estos atributos porque MELI los rechazó: ${ajustes.atributosQuitados.join(', ')}`);
  return avisos;
}

// Valida un ángulo aplicando los mismos ajustes que usaría al publicar, así lo que se ve en
// pantalla es lo que va a pasar de verdad.
async function validarAngulo(token, item, opciones) {
  const r = await conAjustes(item, opciones, async (payload) => {
    const v = await validarPayload(token, payload);
    return { ok: v.valida !== false, data: v.data, valida: v.valida, errores: v.errores, aviso: v.aviso };
  });

  // Si todo lo que objeta MELI es de la configuración de la cuenta, la validación no sirve
  // para decidir: queda "sin validar" y el ángulo se puede publicar igual.
  const deCuenta = r?.valida === false ? causasDeCuenta(r.data) : null;
  if (deCuenta) {
    return {
      valida: null,
      errores: [],
      aviso: `MELI no la valida por la configuración de envío de la cuenta: ${deCuenta.join('; ')}. No es un problema de este título ni de este ángulo: devuelve lo mismo al validar una copia exacta de una publicación tuya que está activa y vendiendo. Se puede intentar publicar igual.`,
      ajustes: r?.ajustes || null,
      avisos_ajustes: avisosDeAjustes(r?.ajustes),
      modoTitulo: r?.ajustes?.modoTitulo,
    };
  }

  return {
    valida: r?.valida ?? false,
    errores: r?.errores || ['MELI rechazó la publicación y no se pudo ajustar sola.'],
    aviso: r?.aviso || null,
    ajustes: r?.ajustes || null,
    avisos_ajustes: avisosDeAjustes(r?.ajustes),
    modoTitulo: r?.ajustes?.modoTitulo,
  };
}

// Crea la publicación con la misma escalera de ajustes.
async function crearPublicacion(token, item, opciones) {
  const r = await conAjustes(item, opciones, (payload) =>
    meliFetch(token, '/items', { method: 'POST', body: JSON.stringify(payload) }));

  if (!r?.ok) throw new Error(mensajeDeError(r?.data, r?.status));
  return { ...r.data, ajustes: r.ajustes, avisos_ajustes: avisosDeAjustes(r.ajustes) };
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
  // Cortar por palabra: un título cortado al medio se ve peor que uno más corto. Y si el
  // corte deja una palabra colgada ("... Scooter Cuatriciclo Y"), también se va.
  return limpio
    .slice(0, max)
    .replace(/\s+\S*$/, '')
    .replace(/\s+(y|o|de|del|para|con|en|a|la|el|los|las|sin|por)$/i, '')
    .trim();
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
  maxNombreBase,
  motivoNoClonable,
  construirPayload,
  detectarModoTitulo,
  sufijoTitulo,
  tituloFinal,
  validarPayload,
  validarAngulo,
  avisosDeAjustes,
  crearPublicacion,
  ponerDescripcion,
  limpiarDescripcion,
  limpiarTitulo,
  ordenarFotos,
};
