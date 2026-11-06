// api/_fotosIA.js
// Las reglas de las fotos con IA (Marketing → 📸 Fotos), sin tocar Higgsfield, MELI ni Supabase.
//
// El recorrido es:
//   1. "Preparar": se leen las publicaciones de MELI de las variantes elegidas (fotos, ficha,
//      descripción) y la IA de texto redacta los textos de cada infografía. El vendedor los
//      revisa y corrige ANTES de gastar en imágenes: un dato mal puesto en la foto de medidas
//      (22 mm en vez de 28 mm) se paga en devoluciones.
//   2. "Generar": una fila por imagen y variante en fotos_ia, con su prompt ya armado. La de
//      instalación se genera una sola vez y se publica en todas las variantes.
//   3. "Avanzar": se mandan a Higgsfield de a pocas, se espera que terminen, se les pone el
//      logo y se guardan. Lo maneja api/fotos-ia.js.
//   4. "Publicar": las fotos de una variante reemplazan (o se suman a) las de todas sus
//      publicaciones de MELI.
//
// Acá vive lo que se puede equivocar en silencio: qué texto termina dentro de la imagen, qué
// filas se crean, qué fotos se mandan a MELI y en qué orden.

// En el orden en que quedan en la publicación: la primera es la miniatura de los resultados.
const TIPOS = ['portada', 'medidas', 'compatible', 'beneficios', 'instalacion'];

const TIPO_LABEL = {
  portada: 'Portada',
  medidas: 'Medidas',
  compatible: 'Compatibilidad',
  beneficios: 'Beneficios',
  instalacion: 'Instalación',
};

// El modelo de Higgsfield con el que se hicieron las primeras fotos de la tienda: GPT Image
// "Sunburst" de Marketing Studio. Copia bien el producto de las fotos de referencia y escribe
// texto en español sin errores, que es lo que más falla en otros modelos.
const MODELO_HF = 'marketing-studio/image/sunburst';

// Un pedido grande se paga entero aunque las primeras salgan mal: mejor probar con pocas.
const MAX_FOTOS_LOTE = 30;
// Higgsfield rechaza (429) si hay muchas generando a la vez en la cuenta.
const EN_VUELO_MAX = 4;
// MELI no acepta más de 12 fotos por publicación.
const MAX_FOTOS_MELI = 12;
// Fotos de la publicación que se le pasan a la IA como referencia del producto real.
const MAX_REFERENCIAS = 2;

// Lo que entra en cada infografía. Son textos que van DENTRO de la imagen: cortos, o la IA
// los achica hasta que no se leen en el celular.
const LIMITES = {
  datos: 4,          // medidas: "80 cm de largo", "Ø 22 mm"
  destacados: 3,     // medidas: "ALUMINIO ANODIZADO"
  etiquetas: 3,      // compatibilidad: "CALLE", "NAKED"
  verificaciones: 3, // compatibilidad: "Diámetro 22 mm"
  items: 4,          // beneficios
  pasos: 4,          // instalación
};
const MAX_LARGO_TITULO = 45;
const MAX_LARGO_ITEM = 50;

const ESTADOS_ACTIVOS = ['pendiente', 'enviando', 'generando', 'procesando'];
// Estados en los que MELI deja cambiar las fotos de una publicación.
const ESTADOS_MELI_EDITABLES = new Set(['active', 'paused']);

// ── Textos ────────────────────────────────────────────────────────

function textosVacios() {
  return {
    medidas: { titulo: 'MEDIDAS', subtitulo: '', datos: [], destacados: [] },
    compatible: { titulo: '', etiquetas: [], verificaciones: [], escena: '' },
    beneficios: { titulo: '', items: [] },
    instalacion: { titulo: '', pasos: [], escena: '' },
  };
}

const limpiar = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Acepta un array o un texto con un renglón por elemento (lo que se edita en pantalla).
function lista(valor, max) {
  const crudos = Array.isArray(valor) ? valor : String(valor ?? '').split('\n');
  return crudos
    // Viñetas que la IA o el vendedor ponen al principio del renglón.
    .map(x => limpiar(String(x ?? '').replace(/^\s*(?:[-•*✓✔]|\d+[.)])\s*/, ''), MAX_LARGO_ITEM))
    .filter(Boolean)
    .slice(0, max);
}

// Deja los textos con la forma exacta que esperan los prompts, venga de la IA o del formulario.
function normalizarTextos(t) {
  const x = t || {};
  const m = x.medidas || {}, c = x.compatible || {}, b = x.beneficios || {}, i = x.instalacion || {};
  return {
    medidas: {
      titulo: limpiar(m.titulo, MAX_LARGO_TITULO) || 'MEDIDAS',
      subtitulo: limpiar(m.subtitulo, MAX_LARGO_TITULO + 15),
      datos: lista(m.datos, LIMITES.datos),
      destacados: lista(m.destacados, LIMITES.destacados),
    },
    compatible: {
      titulo: limpiar(c.titulo, MAX_LARGO_TITULO),
      etiquetas: lista(c.etiquetas, LIMITES.etiquetas),
      verificaciones: lista(c.verificaciones, LIMITES.verificaciones),
      escena: limpiar(c.escena, 300),
    },
    beneficios: {
      titulo: limpiar(b.titulo, MAX_LARGO_TITULO),
      items: lista(b.items, LIMITES.items),
    },
    instalacion: {
      titulo: limpiar(i.titulo, MAX_LARGO_TITULO),
      pasos: lista(i.pasos, LIMITES.pasos),
      escena: limpiar(i.escena, 300),
    },
  };
}

// Por qué no se puede generar un tipo con estos textos, o null si se puede. Una infografía de
// medidas sin medidas, o de instalación sin pasos, sale inventada.
function motivoSinDatos(tipo, textos) {
  const t = normalizarTextos(textos);
  if (tipo === 'medidas' && !t.medidas.datos.length) return 'Faltan las medidas.';
  if (tipo === 'compatible' && !t.compatible.titulo) return 'Falta el título de compatibilidad.';
  if (tipo === 'beneficios' && (!t.beneficios.titulo || !t.beneficios.items.length)) return 'Faltan los beneficios.';
  if (tipo === 'instalacion' && (!t.instalacion.titulo || !t.instalacion.pasos.length)) return 'Faltan los pasos de instalación.';
  return null;
}

// ── Prompts de imagen ─────────────────────────────────────────────

const comillas = arr => arr.map(x => `"${String(x).replace(/"/g, "'")}"`).join(', ');

const SIN_MARCAS = 'No brand names, no logos, no phone numbers, no addresses, no websites, no prices, no watermark.';
const TIPOGRAFIA = 'All text in Spanish exactly as written between quotes, perfectly spelled with its accents, bold geometric sans-serif typography (Montserrat style), highly legible. Do not add any other text.';
const ESQUINA_LIBRE = 'IMPORTANT: keep the top-right corner (top 15% of the height, right 32% of the width) completely empty plain background with nothing in it: a logo goes there later.';

// Cómo se nombra el producto en cada prompt. Lo que manda son las fotos de referencia: la IA
// tiene que copiar ESE producto, no uno parecido.
function descripcionProducto({ nombre, color }) {
  const quien = limpiar(nombre, 120) || 'the product';
  return `the exact product shown in the reference images (${quien}${color ? `, color ${limpiar(color, 40)}` : ''}). ` +
    'Reproduce it faithfully as in the reference photos: same shape, proportions, details, color and finish. Do not invent or remove parts';
}

function armarPrompt(tipo, textos, variante = {}) {
  const t = normalizarTextos(textos);
  const producto = descripcionProducto(variante);

  if (tipo === 'portada') {
    // La portada va limpia: MELI pide producto solo sobre fondo blanco, sin textos ni logos.
    return `Professional e-commerce main product photo, square. ${producto}. ` +
      'The product alone, centered, filling about 85% of the image, slight three-quarter perspective, on a PURE WHITE seamless background (#FFFFFF). ' +
      'Soft realistic contact shadow, crisp studio lighting with clean highlights. Ultra sharp, photorealistic. ' +
      'No text, no logos, no props, no watermark.';
  }

  if (tipo === 'medidas') {
    const m = t.medidas;
    return 'Premium e-commerce technical infographic in Spanish, square, clean modern layout on a light gray studio background (#F2F2F2) with thin red accent lines. ' +
      `Product: ${producto}, photorealistic, shown in a clear straight-on view across the middle of the image. ` +
      `Top-left: big bold black headline "${m.titulo}"${m.subtitulo ? ` and below it smaller text "${m.subtitulo}"` : ''}. ` +
      `Annotate the product with thin black dimension lines with arrows and circular zoom callouts showing exactly these measurements, each label next to the part it measures: ${comillas(m.datos)}. ` +
      (m.destacados.length ? `Bottom row: rounded white badges with simple red line icons and bold text: ${comillas(m.destacados)}. ` : '') +
      `${TIPOGRAFIA} ${ESQUINA_LIBRE} ${SIN_MARCAS}`;
  }

  if (tipo === 'compatible') {
    const c = t.compatible;
    return 'Premium accessory ad image in Spanish, square. ' +
      `Photorealistic photo: ${c.escena || 'the product installed and in use in a real everyday setting'}. ` +
      `The hero of the image is ${producto}, clearly visible and in focus. Shallow depth of field, warm cinematic light. ` +
      `Bottom 35% of the image has a dark gradient overlay with white text: bold headline "${c.titulo}"` +
      (c.etiquetas.length ? `; below it rounded red pill chips with white text: ${comillas(c.etiquetas)}` : '') +
      (c.verificaciones.length ? `; below that a small line with check marks: ${comillas(c.verificaciones.map(v => `✓ ${v}`))}` : '') +
      `. ${TIPOGRAFIA} IMPORTANT: keep the top-right corner (top 15% of the height, right 32% of the width) free of text and objects, showing only calm out-of-focus background: a logo goes there later. ` +
      `${SIN_MARCAS} No visible brand logos on any vehicle or object.`;
  }

  if (tipo === 'beneficios') {
    const b = t.beneficios;
    return 'Premium e-commerce benefits infographic in Spanish, square, modern design on a dark charcoal background (#1C1C1C) with a subtle red light glow. ' +
      `Hero product: ${producto}, photorealistic with dramatic studio rim lighting so it stands out from the dark background, placed diagonally across the lower-middle of the image. ` +
      `Top-left: bold white headline "${b.titulo}". ` +
      `On the left side, a vertical list, each item with a small red circular line icon and white text: ${comillas(b.items)}. ` +
      `${TIPOGRAFIA} IMPORTANT: keep the top-right corner (top 15% of the height, right 32% of the width) completely empty dark background: a logo goes there later. ${SIN_MARCAS}`;
  }

  if (tipo === 'instalacion') {
    const i = t.instalacion;
    const n = i.pasos.length;
    const grilla = n === 4 ? 'a 2x2 grid' : n === 1 ? 'one large card' : `a row of ${n} cards`;
    return 'Clean e-commerce installation guide infographic in Spanish, square, light gray background (#F2F2F2) with red accents. ' +
      `Top-left bold black headline "${i.titulo}". ` +
      `Below, ${grilla} of rounded white cards, each with a large red number circle and a realistic close-up photo of hands performing that step` +
      `${i.escena ? ` (${i.escena})` : ''}, with a short bold caption under each photo: ` +
      i.pasos.map((p, k) => `card ${k + 1} "${p}"`).join('; ') + '. ' +
      `The product being installed is ${producto}. ` +
      `${TIPOGRAFIA} ${ESQUINA_LIBRE} ${SIN_MARCAS} No visible brand logos on any vehicle.`;
  }

  throw new Error(`Tipo de foto desconocido: ${tipo}`);
}

// ── Prompt de los textos (IA de texto) ────────────────────────────

function construirPromptTextos({ titulo, descripcion, atributos, variantes, producto }) {
  const ficha = (atributos || [])
    .filter(a => a && a.value_name)
    .slice(0, 30)
    .map(a => `- ${a.name || a.id}: ${a.value_name}`)
    .join('\n');
  const colores = (variantes || []).map(v => `- ${v.sku}: ${v.nombre}${v.color ? ` (color ${v.color})` : ''}`).join('\n');

  return `Sos quien diseña las fotos de las publicaciones de una tienda de repuestos y accesorios de moto en Mercado Libre Uruguay.

Vamos a generar con IA las infografías de este producto. Necesito los TEXTOS que van escritos dentro de las imágenes.

Producto: ${producto || titulo || '(sin nombre)'}
Título de la publicación: ${titulo || '(sin título)'}
Variantes:
${colores || '- (una sola)'}
${ficha ? `\nFicha técnica cargada:\n${ficha}` : ''}
${descripcion ? `\nDescripción de la publicación:\n${String(descripcion).slice(0, 2500)}` : ''}

Las imágenes son:
- medidas: infografía técnica con las medidas sobre el producto y hasta 3 destacados del material o la calidad.
- compatible: foto del producto puesto/en uso, con un título de compatibilidad, hasta 3 etiquetas cortas (tipos de moto o usos) y hasta 3 verificaciones que el comprador puede chequear antes de comprar.
- beneficios: título en forma de pregunta o gancho y hasta 4 beneficios.
- instalacion: título y hasta 4 pasos cortos.

Reglas:
- TODO tiene que salir de los datos de arriba. No inventes medidas, materiales, compatibilidades, garantías ni pasos. Si un dato no está, dejá la lista vacía: es preferible no hacer esa imagen a que diga algo falso.
- Las medidas tal cual figuran en los datos, con su unidad ("80 cm de largo", "Ø 22 mm en todo el manillar").
- Textos MUY cortos: títulos de hasta 40 caracteres, cada elemento de hasta 32. Van dentro de una imagen que se mira en el celular.
- Español rioplatense con voseo ("Aflojá", "Elegí"). Títulos en mayúsculas.
- "escena" describe en una oración dónde se ve el producto puesto (ej: "un manillar negro montado en una moto naked estacionada en una calle de ciudad al atardecer"). Sin marcas.
- Nada de precios, envío, cuotas, stock, teléfonos ni direcciones.

Devolvé SOLO un objeto JSON, sin texto alrededor, con esta forma exacta:
{"medidas":{"titulo":"MEDIDAS","subtitulo":"...","datos":["..."],"destacados":["..."]},
 "compatible":{"titulo":"...","etiquetas":["..."],"verificaciones":["..."],"escena":"..."},
 "beneficios":{"titulo":"...","items":["..."]},
 "instalacion":{"titulo":"...","pasos":["..."],"escena":"..."}}`;
}

// La IA a veces envuelve el JSON en explicaciones o en un bloque de código.
function extraerObjetoJson(texto) {
  const limpio = String(texto || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const v = JSON.parse(limpio);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    const desde = limpio.indexOf('{');
    const hasta = limpio.lastIndexOf('}');
    if (desde === -1 || hasta <= desde) return null;
    try { return JSON.parse(limpio.slice(desde, hasta + 1)); } catch { return null; }
  }
}

// ── Datos de MELI ─────────────────────────────────────────────────

// Color de la variante: el atributo de MELI, o lo que viene después del último " - " en el
// nombre del CRM ("Manillar ... 22mm - Rojo").
function colorDe(item, producto) {
  const attrs = [...(item?.attributes || [])];
  for (const v of item?.variations || []) attrs.push(...(v.attribute_combinations || []));
  const attr = attrs.find(a => ['COLOR', 'MAIN_COLOR'].includes(a?.id) && a.value_name);
  if (attr) return attr.value_name;
  const nombre = String(producto?.nombre || '');
  const i = nombre.lastIndexOf(' - ');
  return i > 0 ? nombre.slice(i + 3).trim() || null : null;
}

// Las fotos de la publicación que van de referencia a la IA, en su orden (la primera es la
// portada, que suele ser la que mejor muestra el producto entero).
function referenciasDe(item) {
  return (item?.pictures || [])
    .map(p => p.secure_url || p.url)
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
    .map(u => u.replace(/^http:\/\//, 'https://'))
    .slice(0, MAX_REFERENCIAS);
}

// ── Lote ──────────────────────────────────────────────────────────

// Las filas a crear para un pedido. `variantes`: [{ sku, nombre, color, referencias }].
// Devuelve { filas } o { error }.
function planLote({ variantes, tipos, textos }) {
  const vars = (variantes || []).filter(v => v && v.sku);
  const pedidos = TIPOS.filter(t => (tipos || []).includes(t));
  if (!vars.length) return { error: 'Elegí al menos una variante.' };
  if (!pedidos.length) return { error: 'Elegí al menos un tipo de foto.' };

  const sinReferencia = vars.filter(v => !(v.referencias || []).length);
  if (sinReferencia.length) {
    return { error: `Sin foto de referencia en MELI: ${sinReferencia.map(v => v.sku).join(', ')}. La IA necesita ver el producto real.` };
  }
  for (const tipo of pedidos) {
    const motivo = motivoSinDatos(tipo, textos);
    if (motivo) return { error: `${TIPO_LABEL[tipo]}: ${motivo}` };
  }

  const filas = [];
  for (const tipo of pedidos) {
    // La guía de instalación es la misma para todos los colores: se paga una sola vez.
    const para = tipo === 'instalacion' ? [vars[0]] : vars;
    for (const v of para) {
      filas.push({
        sku: v.sku,
        tipo,
        compartida: tipo === 'instalacion' && vars.length > 1,
        prompt: armarPrompt(tipo, textos, v),
        referencias: v.referencias.slice(0, MAX_REFERENCIAS),
        estado: 'pendiente',
      });
    }
  }
  if (filas.length > MAX_FOTOS_LOTE) {
    return { error: `Son ${filas.length} imágenes: el máximo por pedido es ${MAX_FOTOS_LOTE}. Elegí menos variantes o tipos.` };
  }
  return { filas };
}

// El cuerpo que se le manda a Higgsfield para una fila.
function inputHiggsfield(fila) {
  return {
    prompt: fila.prompt,
    image_urls: (fila.referencias || []).slice(0, MAX_REFERENCIAS),
    aspect_ratio: '1:1',
    resolution: '2k',
    quality: 'high',
  };
}

// Las URLs de la imagen en la respuesta de estado: { images: [{ url }] } o variantes.
function urlsDeSalida(respuesta) {
  const urls = [];
  for (const [clave, valor] of Object.entries(respuesta || {})) {
    if (clave.endsWith('_url')) continue;   // status_url, cancel_url
    for (const item of Array.isArray(valor) ? valor : [valor]) {
      if (item && typeof item === 'object' && typeof item.url === 'string') urls.push(item.url);
    }
  }
  return [...new Set(urls)];
}

// Qué hacer cuando Higgsfield no aceptó un pedido.
//   reintentar: no lo tomó (límite de simultáneas): vuelve a pendiente, sin costo.
//   rechazada:  lo rechazó por el pedido en sí (4xx): no se cobró, no tiene sentido repetirlo igual.
//   incierta:   se cortó la conexión o falló su servidor: puede haberlo tomado y cobrado.
//               NO se reenvía solo: se marca con error y el vendedor decide.
function clasificarFalloEnvio(status) {
  if (status === 429) return 'reintentar';
  if (status >= 400 && status < 500) return 'rechazada';
  return 'incierta';
}

// Filas que quedaron trabadas a mitad de camino (la función se cortó), con qué hacer con cada una.
const TRABADA_MS = { enviando: 5 * 60 * 1000, procesando: 3 * 60 * 1000 };
function resolverTrabadas(filas, ahora = Date.now()) {
  const cambios = [];
  for (const f of filas || []) {
    const limite = TRABADA_MS[f.estado];
    if (!limite || ahora - new Date(f.estado_desde).getTime() < limite) continue;
    if (f.estado === 'enviando') {
      // No se sabe si Higgsfield la tomó: reenviarla podría cobrarla dos veces.
      cambios.push({ id: f.id, estado: 'error', error: 'Se cortó mientras se mandaba a Higgsfield: no se sabe si la tomó. Revisá la consola de Higgsfield antes de regenerarla.' });
    } else if (f.hf_request_id) {
      // La imagen ya está en Higgsfield: solo falta bajarla otra vez y ponerle el logo.
      cambios.push({ id: f.id, estado: 'generando' });
    } else {
      cambios.push({ id: f.id, estado: 'error', error: 'Se cortó al procesarla y no tiene pedido de Higgsfield.' });
    }
  }
  return cambios;
}

// ── Publicar en MELI ──────────────────────────────────────────────

// Las fotos terminadas de una variante, en el orden de TIPOS: las suyas más las compartidas
// del lote (la de instalación). Si hay dos del mismo tipo (se regeneró), va la más nueva.
function fotosParaPublicar(filasLote, sku) {
  const utiles = (filasLote || []).filter(f =>
    (f.sku === sku || f.compartida) && ['lista', 'publicada'].includes(f.estado) && f.url_final);
  return TIPOS
    .map(tipo => utiles.filter(f => f.tipo === tipo).sort((a, b) => Number(b.id) - Number(a.id))[0])
    .filter(Boolean);
}

// Por qué no se le pueden cambiar las fotos a esta publicación, o null si se puede.
function motivoNoPublicable(item) {
  if (!item) return 'No se pudo leer la publicación en MELI.';
  if (!ESTADOS_MELI_EDITABLES.has(item.status)) return `La publicación está ${item.status}: MELI no deja editarla.`;
  if (item.catalog_listing) return 'Es una publicación de catálogo: las fotos las pone MELI.';
  // Con variaciones clásicas cada variación elige sus fotos por id: cambiar `pictures` a
  // secas las deja apuntando a fotos que ya no están.
  if ((item.variations || []).length) return 'Tiene variaciones clásicas: subí las fotos a mano desde MELI.';
  return null;
}

// El cuerpo del PUT de fotos. `nuevas`: [{ source }] o [{ id }]; `actuales`: los ids que ya
// tiene la publicación. Con `conservar`, las actuales van después de las nuevas.
function cuerpoFotosMeli(nuevas, actuales, conservar) {
  const lista = [...nuevas];
  if (conservar) {
    const ya = new Set(nuevas.map(f => f.id).filter(Boolean));
    for (const id of actuales || []) if (id && !ya.has(id)) lista.push({ id });
  }
  return { pictures: lista.slice(0, MAX_FOTOS_MELI) };
}

// ── Logo ──────────────────────────────────────────────────────────

// Dónde va el logo: arriba a la derecha, 23% del ancho, con un margen del 3,5%.
function cajaLogo(ancho, alto, logoAncho, logoAlto) {
  const w = Math.round(ancho * 0.23);
  const h = Math.round(w * logoAlto / logoAncho);
  const m = Math.round(ancho * 0.035);
  return { left: ancho - m - w, top: m, width: w, height: Math.min(h, alto - 2 * m) };
}

// Sobre fondo claro va el logo con letras negras; sobre oscuro, el original de letras blancas.
function varianteLogo(luminanciaMedia) {
  return luminanciaMedia > 140 ? 'negras' : 'blancas';
}

module.exports = {
  TIPOS,
  TIPO_LABEL,
  MODELO_HF,
  MAX_FOTOS_LOTE,
  EN_VUELO_MAX,
  MAX_FOTOS_MELI,
  LIMITES,
  ESTADOS_ACTIVOS,
  textosVacios,
  normalizarTextos,
  motivoSinDatos,
  armarPrompt,
  construirPromptTextos,
  extraerObjetoJson,
  colorDe,
  referenciasDe,
  planLote,
  inputHiggsfield,
  urlsDeSalida,
  clasificarFalloEnvio,
  resolverTrabadas,
  fotosParaPublicar,
  motivoNoPublicable,
  cuerpoFotosMeli,
  cajaLogo,
  varianteLogo,
};
