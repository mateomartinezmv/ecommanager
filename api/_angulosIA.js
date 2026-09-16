// api/_angulosIA.js
// Redacta los ángulos de venta (título + descripción) de las publicaciones nuevas.
//
// Un ángulo no es un sinónimo del título viejo: es otra forma de buscar el mismo producto.
// Si los tres títulos dicen lo mismo con otras palabras, las tres publicaciones compiten por
// la misma búsqueda y no se gana alcance. Por eso el prompt pide ángulos explícitamente
// distintos entre sí y distintos de lo que ya está publicado.

const MODELO = 'claude-opus-5';

function construirPrompt({ tituloOriginal, otrosTitulos, categoria, atributos, descripcion, producto, cantidad, maxTitulo, modoTitulo = 'title', sufijo = '' }) {
  const ficha = (atributos || [])
    .filter(a => a.value_name)
    .slice(0, 25)
    .map(a => `- ${a.name || a.id}: ${a.value_name}`)
    .join('\n');

  const yaPublicados = (otrosTitulos || []).length
    ? `\nTítulos que este producto YA tiene publicados (no los repitas ni los parafrasees):\n${otrosTitulos.map(t => `- ${t}`).join('\n')}`
    : '';

  return `Sos quien redacta las publicaciones de una tienda de repuestos y accesorios de moto en Mercado Libre Uruguay.

Necesito ${cantidad} ángulos de venta NUEVOS para este producto, que ya está publicado. La publicación original queda como está: estas son publicaciones adicionales para aparecer en búsquedas que hoy no cubrimos.

Producto en el sistema: ${producto?.nombre || '(sin nombre)'}${producto?.sku ? ` (SKU ${producto.sku})` : ''}
Título de la publicación original: ${tituloOriginal}
Categoría de MELI: ${categoria || '(desconocida)'}${yaPublicados}
${ficha ? `\nFicha técnica cargada:\n${ficha}` : ''}
${descripcion ? `\nDescripción actual:\n${descripcion.slice(0, 800)}` : ''}

Cada ángulo tiene que atacar una búsqueda REALMENTE distinta. Ideas de por dónde diferenciarlos:
- El sinónimo que usa el comprador (manillar / manubrio, cubierta / neumático, luz / faro).
- El uso o el tipo de moto (calle, cross, enduro, scooter, cuatriciclo, delivery).
- La compatibilidad o la medida (22 mm, 12V, universal, para tal modelo).
- El problema que resuelve (repuesto de fábrica roto, mejora estética, seguridad).

${modoTitulo === 'family_name' ? `IMPORTANTE — cómo se arma el título en esta cuenta:
Lo que escribas NO es el título completo: es el nombre base del producto. Mercado Libre le
pega solo los atributos que distinguen a la variante${sufijo ? ` (en este producto le agrega "${sufijo}")` : ''} y así arma el título que ve el comprador.
O sea: nombre base que escribís${sufijo ? ` + "${sufijo}"` : ''} = título publicado.
No repitas${sufijo ? ` "${sufijo}" ni` : ''} los atributos de variante en el nombre base: quedarían duplicados en el título.

` : ''}Reglas de los títulos:
- MÁXIMO ${maxTitulo} caracteres. Contalos: uno de ${maxTitulo + 1} no sirve. Apuntá a entre 5 y 9 palabras.
- Un ángulo = UNA idea. Elegí un uso, un sinónimo o una compatibilidad y armá el título alrededor de eso.
  Encadenar todo lo que se te ocurre no hace que aparezca en más búsquedas: hace un título que
  no se entiende y que MELI puede moderar por título armado con palabras clave.
  MAL: Colero Guardabarros Trasero Moto Cross Enduro Y Cuatriciclo Para Rueda 17 A 21 Pulgadas Con Soportes
  BIEN: Guardabarros Trasero Para Moto De Cross Y Enduro
  BIEN (otro ángulo, otra publicación): Colero Universal Para Cuatriciclo Con Soportes
- Estructura: Producto + marca o modelo si aporta + una o dos especificaciones que lo identifiquen.
  Nada más. Si dudás entre poner un dato o dejarlo, dejalo: va en la ficha técnica y en la descripción.
- Tiene que leerse como lo escribiría el vendedor, no como una lista de palabras separadas.
- Sin signos de puntuación, símbolos, comillas ni emojis. Palabras separadas por espacios.
- No menciones stock, envío gratis, cuotas, precios, ofertas ni si es nuevo o usado.
- Marcas de terceros sólo para compatibilidad, escritas como "para" o "compatible con".
- Sin errores de ortografía y sin inventar medidas, materiales ni compatibilidades que no estén en los datos de arriba.

Reglas de las descripciones:
- Texto plano, sin HTML ni emojis. Saltos de línea simples.
- Entre 400 y 900 caracteres, arrancando por para qué sirve y a qué moto le va.
- Coherente con el ángulo del título y con la ficha técnica. Nada de datos inventados.
- No menciones envío, pagos, garantía ni la competencia.

Devolvé SOLO un array JSON, sin texto alrededor, con esta forma exacta:
[{"angulo":"resumen del ángulo en 3 a 6 palabras","titulo":"...","descripcion":"..."}]`;
}

// La IA a veces devuelve el JSON envuelto en explicaciones o en un bloque de código.
function extraerJson(texto) {
  const limpio = String(texto || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    const desde = limpio.indexOf('[');
    const hasta = limpio.lastIndexOf(']');
    if (desde === -1 || hasta <= desde) return null;
    try { return JSON.parse(limpio.slice(desde, hasta + 1)); } catch { return null; }
  }
}

// Reescribe la descripción para un título que el vendedor editó a mano.
//
// Cambiar el título cambia el ángulo: si pasa de "Para Cuatriciclo" a "Para Moto", la
// descripción que hablaba de cuatriciclos dejó de corresponder. Esto la vuelve a escribir
// para el título que quedó, con los mismos datos del producto y sin inventar nada nuevo.
function construirPromptDescripcion({ tituloFinal, tituloOriginal, categoria, atributos, descripcion, producto }) {
  const ficha = (atributos || [])
    .filter(a => a.value_name)
    .slice(0, 25)
    .map(a => `- ${a.name || a.id}: ${a.value_name}`)
    .join('\n');

  return `Sos quien redacta las publicaciones de una tienda de repuestos y accesorios de moto en Mercado Libre Uruguay.

Necesito la descripción de esta publicación:

TÍTULO: ${tituloFinal}

Producto en el sistema: ${producto?.nombre || '(sin nombre)'}${producto?.sku ? ` (SKU ${producto.sku})` : ''}
Título de la publicación original del mismo producto: ${tituloOriginal}
Categoría de MELI: ${categoria || '(desconocida)'}
${ficha ? `\nFicha técnica cargada:\n${ficha}` : ''}
${descripcion ? `\nDescripción de la publicación original:\n${descripcion.slice(0, 800)}` : ''}

La descripción tiene que corresponderse con ESE título, que es lo que el comprador leyó antes de
entrar. Si el título habla de moto, la descripción habla de moto; si dice cuatriciclo, de
cuatriciclo. No mezcles el ángulo de la publicación original.

Reglas:
- Texto plano, sin HTML ni emojis. Saltos de línea simples.
- Entre 400 y 900 caracteres, arrancando por para qué sirve y a qué le va.
- Coherente con la ficha técnica. No inventes medidas, materiales ni compatibilidades.
- No menciones envío, pagos, garantía, precios ni la competencia.

Devolvé SOLO el texto de la descripción, sin comillas, sin títulos y sin explicaciones.`;
}

async function redactarDescripcion(opciones) {
  const texto = await pedirTexto(construirPromptDescripcion(opciones), 1500);
  return texto.replace(/^["'`]+|["'`]+$/g, '').trim();
}

// Llamada a la API de Anthropic. La comparten los dos usos.
async function pedirTexto(prompt, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY: no se puede redactar automáticamente. Podés escribirlo a mano.');
    err.code = 'SIN_API_KEY';
    throw err;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);

  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!texto) throw new Error('La IA no devolvió texto');
  return texto;
}

async function redactarAngulos(opciones) {
  const texto = await pedirTexto(construirPrompt(opciones), 4000);
  const angulos = extraerJson(texto);
  if (!Array.isArray(angulos) || !angulos.length) {
    throw new Error('La IA no devolvió ángulos utilizables.');
  }

  return angulos
    .filter(a => a && a.titulo)
    .slice(0, opciones.cantidad)
    .map(a => ({
      angulo: String(a.angulo || '').trim() || 'Ángulo alternativo',
      titulo: String(a.titulo).trim(),
      descripcion: String(a.descripcion || '').trim(),
    }));
}

module.exports = { MODELO, redactarAngulos, redactarDescripcion, construirPrompt, construirPromptDescripcion, extraerJson };
