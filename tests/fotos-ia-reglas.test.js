// Las reglas de las fotos con IA, directo sobre api/_fotosIA.js (sin navegador ni red).
//
// Lo que se protege:
//   · El texto que termina DENTRO de la imagen es exactamente el que revisó el vendedor: una
//     medida mal puesta en la infografía se paga en devoluciones.
//   · No se generan infografías sin datos (medidas sin medidas = medidas inventadas).
//   · La guía de instalación se paga una sola vez por producto, no una por color.
//   · Nunca se reenvía solo un pedido que Higgsfield pudo haber cobrado.
//   · A MELI van las fotos en el orden correcto (la portada primero) y nunca más de 12.

const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../api/_fotosIA');

const TEXTOS = {
  medidas: { titulo: 'MEDIDAS', subtitulo: 'Manillar universal de aluminio', datos: ['80 cm de largo', 'Ø 22 mm en todo el manillar'], destacados: ['ALUMINIO ANODIZADO'] },
  compatible: { titulo: 'COMPATIBLE CON LA MAYORÍA DE LAS MOTOS', etiquetas: ['CALLE', 'NAKED'], verificaciones: ['Diámetro 22 mm'], escena: 'montado en una moto naked en la ciudad' },
  beneficios: { titulo: '¿POR QUÉ CAMBIAR TU MANILLAR?', items: ['Mejor posición de manejo', 'Más control y confort'] },
  instalacion: { titulo: 'INSTALACIÓN EN 4 PASOS', pasos: ['Aflojá las abrazaderas', 'Retirá los controles', 'Colocá el manillar', 'Alineá y ajustá'], escena: '' },
};
const NEGRO = { sku: 'HP-CB0381', nombre: 'Manillar 22mm - Negro', color: 'Negro', referencias: ['https://http2.mlstatic.com/negro-O.jpg'] };
const ROJO = { sku: 'HP-CB0385', nombre: 'Manillar 22mm - Rojo', color: 'Rojo', referencias: ['https://http2.mlstatic.com/rojo-O.jpg'] };

test('los textos se normalizan: viñetas fuera, renglones vacíos fuera, topes por lista', () => {
  const t = F.normalizarTextos({
    medidas: { titulo: '  MEDIDAS  ', datos: '- 80 cm de largo\n\n• Ø 22 mm\n3) uno\n4) dos\n5) tres', destacados: ['A', 'B', 'C', 'D'] },
    beneficios: { titulo: 'X', items: ['✓ uno', '  ', 'dos'] },
  });
  assert.strictEqual(t.medidas.titulo, 'MEDIDAS');
  assert.deepStrictEqual(t.medidas.datos, ['80 cm de largo', 'Ø 22 mm', 'uno', 'dos'], 'hasta 4 medidas, sin viñetas');
  assert.deepStrictEqual(t.medidas.destacados, ['A', 'B', 'C']);
  assert.deepStrictEqual(t.beneficios.items, ['uno', 'dos']);
  // Lo que no vino queda vacío con la forma esperada, no undefined.
  assert.deepStrictEqual(t.instalacion, { titulo: '', pasos: [], escena: '' });
});

test('el texto revisado entra tal cual en el prompt, entre comillas', () => {
  const p = F.armarPrompt('medidas', TEXTOS, NEGRO);
  assert.match(p, /"MEDIDAS"/);
  assert.match(p, /"80 cm de largo", "Ø 22 mm en todo el manillar"/);
  assert.match(p, /"ALUMINIO ANODIZADO"/);
  assert.match(p, /color Negro/);
  assert.match(p, /top-right corner/, 'deja la esquina libre para el logo');

  const c = F.armarPrompt('compatible', TEXTOS, ROJO);
  assert.match(c, /"✓ Diámetro 22 mm"/);
  assert.match(c, /"CALLE", "NAKED"/);
  assert.match(c, /montado en una moto naked/);

  const i = F.armarPrompt('instalacion', TEXTOS, NEGRO);
  assert.match(i, /2x2 grid/);
  assert.match(i, /card 1 "Aflojá las abrazaderas"; card 2 "Retirá los controles"/);
});

test('la portada va limpia: sin textos, sin logo, sin esquina reservada', () => {
  const p = F.armarPrompt('portada', TEXTOS, NEGRO);
  assert.match(p, /PURE WHITE/);
  assert.match(p, /No text, no logos/);
  assert.doesNotMatch(p, /top-right corner/);
  assert.doesNotMatch(p, /MEDIDAS/);
});

test('una comilla del vendedor no rompe el prompt', () => {
  const p = F.armarPrompt('medidas', { ...TEXTOS, medidas: { ...TEXTOS.medidas, datos: ['Rosca 7/8"'] } }, NEGRO);
  assert.match(p, /"Rosca 7\/8'"/);
});

test('sin datos no se genera la infografía: se avisa cuál falta', () => {
  const vacios = F.textosVacios();
  assert.strictEqual(F.motivoSinDatos('portada', vacios), null, 'la portada no necesita textos');
  assert.match(F.motivoSinDatos('medidas', vacios), /medidas/);
  assert.match(F.motivoSinDatos('beneficios', vacios), /beneficios/);
  assert.match(F.motivoSinDatos('instalacion', vacios), /instalación/);

  const plan = F.planLote({ variantes: [NEGRO], tipos: ['portada', 'medidas'], textos: vacios });
  assert.match(plan.error, /Medidas: Faltan las medidas/);
});

test('el lote: una por variante y tipo, y la de instalación una sola, compartida', () => {
  const { filas, error } = F.planLote({ variantes: [NEGRO, ROJO], tipos: F.TIPOS, textos: TEXTOS });
  assert.strictEqual(error, undefined);
  assert.strictEqual(filas.length, 9, '4 tipos × 2 colores + 1 instalación');
  const inst = filas.filter(f => f.tipo === 'instalacion');
  assert.strictEqual(inst.length, 1);
  assert.strictEqual(inst[0].compartida, true);
  assert.ok(filas.every(f => f.estado === 'pendiente'));
  // Cada variante usa SUS fotos de referencia: el rojo no se genera mirando el negro.
  assert.ok(filas.filter(f => f.sku === ROJO.sku).every(f => f.referencias[0].includes('rojo')));
  // En el orden de la publicación.
  assert.deepStrictEqual([...new Set(filas.map(f => f.tipo))], F.TIPOS);
});

test('una sola variante: la instalación no se marca compartida', () => {
  const { filas } = F.planLote({ variantes: [NEGRO], tipos: ['instalacion'], textos: TEXTOS });
  assert.strictEqual(filas[0].compartida, false);
});

test('sin foto de referencia no se genera: la IA inventaría el producto', () => {
  const plan = F.planLote({ variantes: [NEGRO, { ...ROJO, referencias: [] }], tipos: ['portada'], textos: TEXTOS });
  assert.match(plan.error, /HP-CB0385/);
});

test('pedidos demasiado grandes se frenan antes de gastar', () => {
  const muchas = Array.from({ length: 8 }, (_, i) => ({ ...NEGRO, sku: `SKU${i}` }));
  const plan = F.planLote({ variantes: muchas, tipos: F.TIPOS, textos: TEXTOS });
  assert.match(plan.error, /máximo por pedido es 30/);
});

test('el pedido a Higgsfield: cuadrado, 2k, con las fotos de referencia', () => {
  const input = F.inputHiggsfield({ prompt: 'P', referencias: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'] });
  assert.deepStrictEqual(input, { prompt: 'P', image_urls: ['https://a/1.jpg', 'https://a/2.jpg'], aspect_ratio: '1:1', resolution: '2k', quality: 'high' });
});

test('de la respuesta de Higgsfield sale la imagen, no la URL de estado', () => {
  const urls = F.urlsDeSalida({
    status: 'completed', request_id: 'x',
    status_url: 'https://api.higgsfield.ai/requests/x/status',
    images: [{ url: 'https://cdn/1.png' }],
  });
  assert.deepStrictEqual(urls, ['https://cdn/1.png']);
});

test('un fallo al mandar: sólo se reintenta solo lo que seguro no se cobró', () => {
  assert.strictEqual(F.clasificarFalloEnvio(429), 'reintentar');
  assert.strictEqual(F.clasificarFalloEnvio(422), 'rechazada');
  assert.strictEqual(F.clasificarFalloEnvio(500), 'incierta');
  assert.strictEqual(F.clasificarFalloEnvio(null), 'incierta', 'sin respuesta: pudo haberla tomado');
});

test('filas trabadas: la que se cortó mandándose NO se reenvía; la que se cortó procesando, sí', () => {
  const ahora = Date.parse('2026-11-07T12:00:00Z');
  const hace = min => new Date(ahora - min * 60000).toISOString();
  const cambios = F.resolverTrabadas([
    { id: 1, estado: 'enviando', estado_desde: hace(10) },
    { id: 2, estado: 'procesando', estado_desde: hace(10), hf_request_id: 'req-2' },
    { id: 3, estado: 'enviando', estado_desde: hace(1) },          // recién: sigue en curso
    { id: 4, estado: 'generando', estado_desde: hace(60) },        // Higgsfield todavía no terminó
  ], ahora);
  assert.deepStrictEqual(cambios.map(c => [c.id, c.estado]), [[1, 'error'], [2, 'generando']]);
  assert.match(cambios[0].error, /no se sabe si la tomó/);
});

test('a MELI van las fotos listas de la variante más la compartida, portada primero', () => {
  const filas = [
    { id: 1, sku: 'A', tipo: 'medidas', estado: 'lista', url_final: 'u/med-viejo' },
    { id: 2, sku: 'A', tipo: 'portada', estado: 'lista', url_final: 'u/portada' },
    { id: 3, sku: 'A', tipo: 'beneficios', estado: 'error', url_final: null },
    { id: 4, sku: 'B', tipo: 'portada', estado: 'lista', url_final: 'u/otra-variante' },
    { id: 5, sku: 'B', tipo: 'instalacion', compartida: true, estado: 'lista', url_final: 'u/instalacion' },
    { id: 6, sku: 'A', tipo: 'medidas', estado: 'lista', url_final: 'u/med-nuevo' },          // regenerada
    { id: 7, sku: 'A', tipo: 'compatible', estado: 'descartada', url_final: 'u/descartada' },
  ];
  assert.deepStrictEqual(F.fotosParaPublicar(filas, 'A').map(f => f.url_final), ['u/portada', 'u/med-nuevo', 'u/instalacion']);
});

test('qué publicaciones de MELI se pueden tocar', () => {
  assert.strictEqual(F.motivoNoPublicable({ status: 'active', pictures: [] }), null);
  assert.strictEqual(F.motivoNoPublicable({ status: 'paused' }), null);
  assert.match(F.motivoNoPublicable({ status: 'closed' }), /closed/);
  assert.match(F.motivoNoPublicable({ status: 'active', catalog_listing: true }), /catálogo/);
  assert.match(F.motivoNoPublicable({ status: 'active', variations: [{ id: 1 }] }), /variaciones/);
});

test('el cuerpo para MELI: reemplazar, o sumar las actuales después, sin pasar de 12', () => {
  const nuevas = [{ source: 'u1' }, { source: 'u2' }];
  assert.deepStrictEqual(F.cuerpoFotosMeli(nuevas, ['V1', 'V2'], false), { pictures: nuevas });
  assert.deepStrictEqual(F.cuerpoFotosMeli(nuevas, ['V1', 'V2'], true).pictures, [{ source: 'u1' }, { source: 'u2' }, { id: 'V1' }, { id: 'V2' }]);
  const muchas = Array.from({ length: 15 }, (_, i) => `V${i}`);
  assert.strictEqual(F.cuerpoFotosMeli(nuevas, muchas, true).pictures.length, 12);
  // Reusando ids (en los ángulos) no se duplica una que ya estaba.
  assert.deepStrictEqual(F.cuerpoFotosMeli([{ id: 'N1' }], ['N1', 'V1'], true).pictures, [{ id: 'N1' }, { id: 'V1' }]);
});

test('color y referencias salen de la publicación de MELI', () => {
  const item = {
    attributes: [{ id: 'COLOR', value_name: 'Azul' }],
    pictures: [{ secure_url: 'https://m/1.jpg' }, { url: 'http://m/2.jpg' }, { secure_url: 'https://m/3.jpg' }],
  };
  assert.strictEqual(F.colorDe(item, { nombre: 'X - Rojo' }), 'Azul');
  assert.strictEqual(F.colorDe({}, { nombre: 'Manillar 22mm - Rojo' }), 'Rojo', 'sin atributo, del nombre del CRM');
  assert.strictEqual(F.colorDe({}, { nombre: 'Sin color' }), null);
  assert.deepStrictEqual(F.referenciasDe(item), ['https://m/1.jpg', 'https://m/2.jpg'], 'las dos primeras, siempre https');
});

test('el JSON de la IA se rescata aunque venga envuelto', () => {
  assert.deepStrictEqual(F.extraerObjetoJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(F.extraerObjetoJson('Acá van: {"a":{"b":2}} listo'), { a: { b: 2 } });
  assert.strictEqual(F.extraerObjetoJson('[1,2]'), null);
  assert.strictEqual(F.extraerObjetoJson('nada'), null);
});

test('el logo: arriba a la derecha, y la versión que se lee sobre ese fondo', () => {
  assert.deepStrictEqual(F.cajaLogo(2048, 2048, 300, 123), { left: 1505, top: 72, width: 471, height: 193 });
  assert.strictEqual(F.varianteLogo(239), 'negras', 'fondo claro → letras negras');
  assert.strictEqual(F.varianteLogo(12), 'blancas', 'fondo oscuro → el original');
});

test('fotos subidas a mano: van en el orden que les dio el vendedor, después de las generadas', () => {
  const filas = [
    { id: 10, sku: 'A', tipo: 'subida', orden: 2, estado: 'lista', url_final: 'u/tercera' },
    { id: 11, sku: 'A', tipo: 'subida', orden: 0, estado: 'lista', url_final: 'u/primera' },
    { id: 12, sku: 'A', tipo: 'subida', orden: 1, estado: 'publicada', url_final: 'u/segunda' },
    { id: 13, sku: 'A', tipo: 'subida', orden: 3, estado: 'descartada', url_final: 'u/sacada' },
    { id: 14, sku: 'B', tipo: 'subida', orden: 0, estado: 'lista', url_final: 'u/otra-variante' },
  ];
  assert.deepStrictEqual(F.fotosParaPublicar(filas, 'A').map(f => f.url_final), ['u/primera', 'u/segunda', 'u/tercera']);
  const mezcla = [...filas, { id: 1, sku: 'A', tipo: 'portada', estado: 'lista', url_final: 'u/portada-ia' }];
  assert.deepStrictEqual(F.fotosParaPublicar(mezcla, 'A').map(f => f.url_final)[0], 'u/portada-ia');
});

test('la imagen subida llega como data URL o base64; se rechaza lo que no es imagen o pesa de más', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  assert.deepStrictEqual(F.decodificarSubida(`data:image/png;base64,${png.toString('base64')}`).buffer, png);
  assert.deepStrictEqual(F.decodificarSubida(png.toString('base64')).buffer, png);
  assert.match(F.decodificarSubida('data:application/pdf;base64,AAAA').error, /no es una imagen/);
  assert.match(F.decodificarSubida('').error, /vacía/);
  assert.match(F.decodificarSubida('no es base64 ###').error, /dañada/);
  const grande = Buffer.alloc(F.SUBIDA_MAX_BYTES + 1).toString('base64');
  assert.match(F.decodificarSubida(grande).error, /3 MB/);
});

test('MELI no acepta fotos de menos de 500 px de lado', () => {
  assert.strictEqual(F.motivoTamanoSubida(2048, 2048), null);
  assert.strictEqual(F.motivoTamanoSubida(500, 900), null);
  assert.match(F.motivoTamanoSubida(499, 900), /499×900.*500 px/);
  assert.match(F.motivoTamanoSubida(0, 0), /No se pudo leer/);
});
