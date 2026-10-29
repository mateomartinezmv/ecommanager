// api/shopify/_fotos.js
// Qué fotos tiene que tener cada producto de la tienda, sin tocar MELI ni Shopify.
//
// Las fotos del producto viven en MELI: ahí se suben, se reordenan y se cambian. La tienda
// se cargó en su momento desde MELI y de ahí en más se quedó con lo que había ese día, así
// que un producto puede tener en Shopify menos fotos, otras, o versiones viejas de las mismas.
// El producto de Shopify queda con exactamente las fotos de MELI, en el orden de MELI: lo que
// la tienda tenía de más se saca.
//
// La referencia es la publicación principal (meli_ids[0]), igual que en meli/_fotos.js.
//
// Lo que ya está no se vuelve a subir: Shopify guarda la imagen con el nombre del archivo
// original, que en las fotos de MELI lleva adentro la clave de la imagen
// ("…/files/D_NQ_NP_2X_782955-MLM77584366740_072024-F.webp"), así que se reconoce una foto de
// MELI ya cargada aunque Shopify la haya republicado en su CDN y en otro formato. Esa imagen
// se conserva tal cual (mismo id), sólo cambia de lugar si hace falta.

// La clave de una foto de MELI dentro de cualquier url que la contenga, o '' si no es una.
// El tramo del sitio es MLU, MLM, MLA… pero también CBT en las publicaciones internacionales.
function claveImagen(url) {
  const m = String(url || '').match(/(\d+-[A-Z]{3}\d+_\d+)/);
  return m ? m[1] : '';
}

const claveDe = f => claveImagen(f?.url) || claveImagen(f?.id) || f?.url || '';

// Las fotos de MELI que le corresponden a un producto, en orden y sin repetir. Recibe una
// lista de listas: un producto de Shopify con varias variantes junta las fotos de todos sus
// SKUs, empezando por las del primero.
function fotosObjetivo(listas) {
  const vistas = new Set();
  const objetivo = [];
  for (const fotos of listas || []) {
    for (const f of fotos || []) {
      if (!f?.url) continue;
      const clave = claveDe(f);
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      objetivo.push(f);
    }
  }
  return objetivo;
}

// La lista de imágenes del PUT de producto: las que ya están van por id (Shopify las deja
// como están), las nuevas por src (Shopify las baja), y el orden del arreglo es el orden en
// la tienda. Las imágenes que no figuran en la lista, Shopify las borra.
//
// `existentes`: [{ id, url }] lo que hoy tiene el producto en Shopify.
function cuerpoImagenes(objetivo, existentes) {
  const porClave = new Map();
  for (const img of existentes || []) {
    const clave = claveImagen(img.url);
    if (clave && !porClave.has(clave)) porClave.set(clave, img);
  }
  return (objetivo || []).map(f => {
    const ya = porClave.get(claveDe(f));
    return ya ? { id: Number(ya.id) } : { src: f.url };
  });
}

// El producto ya muestra exactamente las fotos de MELI, en el mismo orden.
function alDia(objetivo, existentes) {
  const unas = (objetivo || []).map(claveDe);
  const otras = (existentes || []).map(i => claveImagen(i.url));
  return unas.length === otras.length && unas.every((c, i) => c === otras[i]);
}

// Arma el plan por producto de Shopify. Varios SKUs del CRM pueden ser variantes del mismo
// producto (un color por SKU): las fotos de todos se juntan en un solo producto, sin repetir.
//
// `productos`: [{ sku, nombre, variantId, original }] donde original es la publicación de
//              MELI con sus fotos (o null si no se pudo leer).
// `shopify`:   { [variantId]: { productId, titulo, imagenes: [{ id, url }] } } (falta si la
//              variante ya no existe en la tienda).
function armarPlan(productos, shopify) {
  const porProducto = new Map();
  const sinResolver = [];

  for (const p of productos || []) {
    const s = shopify?.[p.variantId];
    if (!s) { sinResolver.push({ sku: p.sku, nombre: p.nombre, motivo: 'La variante enlazada ya no existe en Shopify.' }); continue; }
    if (!p.original?.fotos?.length) { sinResolver.push({ sku: p.sku, nombre: p.nombre, motivo: 'No se pudieron leer fotos de la publicación de MELI.' }); continue; }

    if (!porProducto.has(s.productId)) {
      porProducto.set(s.productId, { productId: s.productId, titulo: s.titulo, skus: [], meli_ids: [], listas: [], imagenes: s.imagenes || [] });
    }
    const fila = porProducto.get(s.productId);
    fila.skus.push(p.sku);
    fila.meli_ids.push(p.original.meli_id);
    fila.listas.push(p.original.fotos);
  }

  const filas = [...porProducto.values()].map(({ listas, ...fila }) => {
    const objetivo = fotosObjetivo(listas);
    const cuerpo = cuerpoImagenes(objetivo, fila.imagenes);
    const conservadas = new Set(cuerpo.filter(c => c.id).map(c => c.id));
    return {
      ...fila,
      objetivo,
      cuerpo,
      alDia: alDia(objetivo, fila.imagenes),
      nuevas: cuerpo.filter(c => c.src).length,
      sacadas: fila.imagenes.filter(i => !conservadas.has(Number(i.id))).length,
    };
  });

  return { productos: filas, sinResolver };
}

module.exports = { claveImagen, fotosObjetivo, cuerpoImagenes, alDia, armarPlan };
