// mcp/meta/_subir.js
// Instagram no acepta archivos: sólo URLs públicas que Meta baja por su cuenta. Para poder
// publicar una foto que está en la compu, se sube primero a un bucket público de Supabase
// Storage (el mismo proyecto de EcomManager) y se le pasa a Meta esa URL.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TIPOS = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

function nombreSeguro(archivo) {
  return path.basename(archivo)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(-80);
}

async function subirArchivoPublico(ruta, { supabase, bucket = 'redes', ahora = new Date() }) {
  const abs = path.resolve(ruta);
  const ext = path.extname(abs).toLowerCase();
  const contentType = TIPOS[ext];
  if (!contentType) {
    throw new Error(`No sé subir archivos ${ext || 'sin extensión'}: usá jpg, png, webp, mp4 o mov.`);
  }
  let datos;
  try {
    datos = await fs.readFile(abs);
  } catch {
    throw new Error(`No encuentro el archivo ${abs}.`);
  }

  const mes = ahora.toISOString().slice(0, 7);
  const destino = `${mes}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${nombreSeguro(abs)}`;
  const almacen = supabase.storage;

  let { error } = await almacen.from(bucket).upload(destino, datos, { contentType, upsert: false });
  if (error && /not found/i.test(error.message || '')) {
    const creado = await almacen.createBucket(bucket, { public: true });
    if (creado.error) throw new Error(`No pude crear el bucket "${bucket}": ${creado.error.message}`);
    ({ error } = await almacen.from(bucket).upload(destino, datos, { contentType, upsert: false }));
  }
  if (error) throw new Error(`No pude subir ${path.basename(abs)} a Supabase: ${error.message}`);

  return almacen.from(bucket).getPublicUrl(destino).data.publicUrl;
}

module.exports = { subirArchivoPublico, TIPOS };
