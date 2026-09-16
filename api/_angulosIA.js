// api/_angulosIA.js
// Redacta los ángulos de venta (título + descripción) de las publicaciones nuevas.
//
// Un ángulo no es un sinónimo del título viejo: es otra forma de buscar el mismo producto.
// Si los tres títulos dicen lo mismo con otras palabras, las tres publicaciones compiten por
// la misma búsqueda y no se gana alcance. Por eso el prompt pide ángulos explícitamente
// distintos entre sí y distintos de lo que ya está publicado.

const MODELO = 'claude-opus-5';

function construirPrompt({ tituloOriginal, otrosTitulos, categoria, atributos, descripcion, producto, cantidad, maxTitulo }) {
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

Reglas de los títulos (MELI las moderá):
- Máximo ${maxTitulo} caracteres. Estructura: Producto + Marca + Modelo + especificación que lo identifique.
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

async function redactarAngulos(opciones) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY: no se pueden redactar los ángulos automáticamente. Podés escribirlos a mano.');
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
      max_tokens: 4000,
      messages: [{ role: 'user', content: construirPrompt(opciones) }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);
  }

  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
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

module.exports = { MODELO, redactarAngulos, construirPrompt, extraerJson };
