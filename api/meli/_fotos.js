// api/meli/_fotos.js
// Las reglas de "qué fotos tiene que tener cada publicación", sin tocar MELI ni Supabase.
//
// Un producto se publica varias veces, una por ángulo de venta, y todas tienen que mostrar
// el mismo producto con las mismas fotos y en el mismo orden: las fotos son del producto,
// no del título. Cuando a la original se le agrega una foto, se le saca otra o se le cambia
// el orden, los ángulos se quedan con las viejas y el comprador que entra por ahí ve otra
// cosa —a veces una foto que ya no corresponde al producto que llega.
//
// La referencia es la publicación principal (meli_ids[0], la original), igual que en
// precios.js: es la que el vendedor mantiene a mano y de la que salieron los ángulos.
//
// Acá vive sólo la comparación, que es lo que se puede equivocar en silencio. El endpoint
// fotos.js le pone la lectura de MELI y el PUT.

// Estados en los que MELI deja cambiar las fotos de una publicación.
const ESTADOS_EDITABLES = new Set(['active', 'paused']);

// Las fotos de un ítem, en el orden en el que las ve el comprador. El id es lo que
// identifica a la foto en MELI: la misma foto en dos publicaciones comparte id, y la url
// cambia de tamaño según dónde se muestre, así que comparar urls daría distinto siempre.
function fotosDe(item) {
  return (item?.pictures || [])
    .map(p => ({ id: p.id || null, url: p.secure_url || p.url || null }))
    .filter(f => f.id || f.url);
}

// Con qué se compara una foto contra otra.
//
// Lo normal es el id. Pero cuando MELI no acepta reusar un id y hay que mandarle la url, la
// misma imagen vuelve con un id nuevo y por id dejarían de parecerse para siempre: la
// pantalla marcaría "distintas" en publicaciones que muestran exactamente lo mismo. Las urls
// de MELI llevan adentro la imagen ("…/D_NQ_NP_2X_706811-MLU123_092025-F.jpg"): ese tramo es
// el que se compara cuando los ids no coinciden, sin el prefijo de tamaño ni el sufijo de
// recorte, que cambian según dónde se muestre la foto.
function claveFoto(foto) {
  if (!foto) return '';
  const url = String(foto.url || '');
  const m = url.match(/(\d+-ML[A-Z]\d+_\d+)/);
  if (m) return m[1];
  return foto.id || url;
}

// Dos publicaciones muestran lo mismo si tienen las mismas fotos EN EL MISMO ORDEN. El orden
// no es un detalle: la primera foto es la miniatura que decide el clic en los resultados.
function mismasFotos(a, b) {
  const unas = a || [];
  const otras = b || [];
  if (unas.length !== otras.length) return false;
  return unas.every((f, i) => {
    if (f.id && otras[i].id && f.id === otras[i].id) return true;
    return claveFoto(f) === claveFoto(otras[i]);
  });
}

// Por qué esta publicación no se puede corregir desde acá, o null si se puede.
function motivoNoCopiable(pub) {
  if (!pub.estado || pub.estado === 'desconocida') return 'No se pudo leer la publicación en MELI.';
  if (!ESTADOS_EDITABLES.has(pub.estado)) return `La publicación está ${pub.estado}: MELI no deja editarla.`;
  // En una publicación de catálogo las fotos son las de la ficha de MELI, no las del
  // vendedor: no hay nada que copiarle.
  if (pub.catalogo) return 'Es una publicación de catálogo: las fotos las pone MELI.';
  return null;
}

// Arma la comparación producto por producto a partir de lo que el CRM tiene enlazado
// (`ids`, en orden: la original primero) y de lo que devolvió MELI (`mapa`).
//
// Un producto entra sólo si tiene más de una publicación: con una sola no hay con qué
// comparar, y es justamente el caso del producto que todavía no tiene ángulos.
function compararProductos(productos, mapa) {
  return productos
    .map(p => {
      const ids = p.ids || [];
      const leidas = ids.map(id => mapa[id]).filter(Boolean);

      // La original es la principal; si quedó cerrada o ilegible, la primera que se pueda
      // leer. Sin fotos no sirve de molde: copiar "ninguna foto" dejaría ciegos a los ángulos.
      const original = leidas.find(x => x.meli_id === ids[0] && x.fotos.length)
        || leidas.find(x => x.fotos.length)
        || null;

      const destinos = leidas
        .filter(x => !original || x.meli_id !== original.meli_id)
        .map(x => {
          const motivo = motivoNoCopiable(x);
          const distintas = !!original && !mismasFotos(original.fotos, x.fotos);
          return { ...x, distintas, motivo: distintas ? motivo : null, copiable: distintas && !motivo };
        });

      return {
        sku: p.sku,
        nombre: p.nombre,
        original,
        publicaciones: destinos,
        total: destinos.length,
        distintas: destinos.filter(x => x.distintas).length,
        copiables: destinos.filter(x => x.copiable).length,
        // Lo que no tiene arreglo desde el CRM se muestra igual, con el motivo a la vista.
        trabadas: destinos.filter(x => x.distintas && x.motivo).length,
      };
    })
    .filter(f => f.original && f.total > 0);
}

// El cuerpo del PUT. Se mandan los ids de las fotos de la original: son fotos que ya están
// subidas en la cuenta, así que MELI las reusa sin volver a descargar nada y la publicación
// queda con exactamente la misma imagen, no con una copia nueva.
//
// Si MELI rechaza algún id —pasa con fotos viejas que quedaron fuera de su catálogo—, se
// reintenta mandando la url (`source`): ahí MELI la vuelve a tomar y le da un id nuevo.
function cuerpoPictures(fotos, modo = 'id') {
  const lista = (fotos || [])
    .map(f => (modo === 'id' && f.id ? { id: f.id } : (f.url ? { source: f.url } : null)))
    .filter(Boolean);
  return { pictures: lista };
}

module.exports = {
  ESTADOS_EDITABLES,
  fotosDe,
  claveFoto,
  mismasFotos,
  motivoNoCopiable,
  compararProductos,
  cuerpoPictures,
};
