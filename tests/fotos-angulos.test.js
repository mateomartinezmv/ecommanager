// Las fotos de los ángulos contra las de su original, directo sobre api/meli/_fotos.js
// (sin navegador): qué cuenta como "distintas", qué se puede corregir y qué no.
//
// Lo que se protege es un error que no avisa: un ángulo que muestra las fotos viejas del
// producto. Nadie lo ve desde el CRM —las publicaciones se abren de a una— y el comprador
// que entra por ese ángulo compra mirando otra cosa que el que entra por la original.
//
// Los dos detalles que la comparación no puede equivocar:
//   · El ORDEN cuenta. La primera foto es la miniatura de los resultados: las mismas fotos
//     en otro orden son otra publicación para el que busca.
//   · La misma imagen puede tener dos ids. Cuando MELI no deja reusar un id y hay que
//     remandar la url, la foto vuelve con id nuevo; si la comparación mirara sólo el id,
//     esa publicación quedaría marcada como distinta para siempre y el CRM la estaría
//     reescribiendo en cada pasada.

const { test } = require('node:test');
const assert = require('node:assert');
const { fotosDe, claveFoto, mismasFotos, compararProductos, cuerpoPictures } = require('../api/meli/_fotos');

const foto = (n, id) => ({
  id: id || `FOTO${n}`,
  secure_url: `https://http2.mlstatic.com/D_NQ_NP_2X_${n}00000-MLU${n}0000000_092025-F.jpg`,
});

const item = (meli_id, fotos, extra = {}) => ({
  meli_id,
  titulo: meli_id,
  estado: 'active',
  permalink: null,
  catalogo: false,
  fotos: fotosDe({ pictures: fotos }),
  ...extra,
});

test('fotosDe conserva el orden y descarta lo que no tiene ni id ni url', () => {
  const fotos = fotosDe({ pictures: [foto(1), foto(2), {}, foto(3)] });
  assert.deepStrictEqual(fotos.map(f => f.id), ['FOTO1', 'FOTO2', 'FOTO3']);
});

test('las mismas fotos en otro orden NO son las mismas', () => {
  const original = fotosDe({ pictures: [foto(1), foto(2), foto(3)] });
  const igual = fotosDe({ pictures: [foto(1), foto(2), foto(3)] });
  const rotada = fotosDe({ pictures: [foto(2), foto(1), foto(3)] });
  const corta = fotosDe({ pictures: [foto(1), foto(2)] });

  assert.strictEqual(mismasFotos(original, igual), true);
  assert.strictEqual(mismasFotos(original, rotada), false, 'el orden decide la miniatura');
  assert.strictEqual(mismasFotos(original, corta), false);
});

test('la misma imagen con otro id sigue siendo la misma foto', () => {
  // Lo que pasa cuando MELI no acepta reusar el id y hay que mandarle la url: misma imagen,
  // id nuevo, y además servida en otro tamaño.
  const original = fotosDe({ pictures: [foto(1), foto(2)] });
  const recargada = fotosDe({
    pictures: [
      { id: 'OTRO1', secure_url: 'https://http2.mlstatic.com/D_NQ_NP_100000-MLU10000000_092025-O.jpg' },
      { id: 'OTRO2', secure_url: 'https://http2.mlstatic.com/D_NQ_NP_200000-MLU20000000_092025-O.jpg' },
    ],
  });

  assert.strictEqual(claveFoto(original[0]), claveFoto(recargada[0]));
  assert.strictEqual(mismasFotos(original, recargada), true);
});

test('marca los ángulos con otras fotos y deja afuera lo que MELI no deja tocar', () => {
  const productos = [
    { sku: 'HP-Q0211', nombre: 'Guardamanos', ids: ['MLU-ORIG', 'MLU-ANG1', 'MLU-ANG2', 'MLU-CAT', 'MLU-CERRADA'] },
    { sku: 'HP-SOLA', nombre: 'Una sola publicación', ids: ['MLU-UNICA'] },
  ];
  const mapa = {
    'MLU-ORIG': item('MLU-ORIG', [foto(1), foto(2), foto(3)]),
    'MLU-ANG1': item('MLU-ANG1', [foto(1), foto(2), foto(3)]),            // al día
    'MLU-ANG2': item('MLU-ANG2', [foto(3), foto(1)]),                      // otras fotos y otro orden
    'MLU-CAT': item('MLU-CAT', [foto(9)], { catalogo: true }),             // las pone MELI
    'MLU-CERRADA': item('MLU-CERRADA', [foto(9)], { estado: 'closed' }),   // no se edita
    'MLU-UNICA': item('MLU-UNICA', [foto(1)]),
  };

  const filas = compararProductos(productos, mapa);

  assert.strictEqual(filas.length, 1, 'un producto con una sola publicación no tiene con qué compararse');
  const fila = filas[0];
  assert.strictEqual(fila.original.meli_id, 'MLU-ORIG', 'la referencia es la principal');
  assert.strictEqual(fila.total, 4);
  assert.strictEqual(fila.distintas, 3);
  assert.strictEqual(fila.copiables, 1, 'sólo el ángulo propio y activo se puede corregir');
  assert.strictEqual(fila.trabadas, 2);

  const por = id => fila.publicaciones.find(x => x.meli_id === id);
  assert.strictEqual(por('MLU-ANG1').distintas, false);
  assert.strictEqual(por('MLU-ANG1').motivo, null);
  assert.strictEqual(por('MLU-ANG2').copiable, true);
  assert.match(por('MLU-CAT').motivo, /catálogo/);
  assert.match(por('MLU-CERRADA').motivo, /closed/);
});

test('si la principal no se puede leer, la referencia es la primera que sí', () => {
  const productos = [{ sku: 'HP-X', nombre: 'X', ids: ['MLU-MUERTA', 'MLU-VIVA', 'MLU-ANG'] }];
  const mapa = {
    'MLU-VIVA': item('MLU-VIVA', [foto(1), foto(2)]),
    'MLU-ANG': item('MLU-ANG', [foto(2)]),
  };

  const [fila] = compararProductos(productos, mapa);
  assert.strictEqual(fila.original.meli_id, 'MLU-VIVA');
  assert.strictEqual(fila.distintas, 1);
});

test('una original sin fotos no sirve de molde', () => {
  const productos = [{ sku: 'HP-Y', nombre: 'Y', ids: ['MLU-SINFOTOS', 'MLU-CONFOTOS'] }];
  const mapa = {
    'MLU-SINFOTOS': item('MLU-SINFOTOS', []),
    'MLU-CONFOTOS': item('MLU-CONFOTOS', [foto(1)]),
  };

  const [fila] = compararProductos(productos, mapa);
  // Copiar "ninguna foto" dejaría ciega a la otra publicación: el molde pasa a ser la que
  // sí tiene fotos.
  assert.strictEqual(fila.original.meli_id, 'MLU-CONFOTOS');
});

test('el cuerpo del PUT manda ids, y urls cuando hay que remandar la foto', () => {
  const fotos = fotosDe({ pictures: [foto(1), foto(2)] });

  assert.deepStrictEqual(cuerpoPictures(fotos, 'id'), {
    pictures: [{ id: 'FOTO1' }, { id: 'FOTO2' }],
  });
  assert.deepStrictEqual(cuerpoPictures(fotos, 'source'), {
    pictures: fotos.map(f => ({ source: f.url })),
  });
});
