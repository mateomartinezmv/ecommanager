// api/_fotosLogo.js
// Le pone el logo de la tienda arriba a la derecha a una imagen generada y la deja en JPEG.
//
// El logo no lo dibuja la IA: lo dibujaría distinto en cada foto. Se pega el archivo real
// (public/marca/), y según lo claro u oscuro del fondo en esa esquina va la versión con
// letras negras o la original con letras blancas.
//
// La portada no lleva logo: MELI pide la foto principal limpia, sin textos ni marcas.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { cajaLogo, varianteLogo } = require('./_fotosIA');

// vercel.json incluye public/marca/** en la función (includeFiles).
const CARPETA = path.join(process.cwd(), 'public', 'marca');
const ARCHIVOS = { blancas: 'logo-letras-blancas.png', negras: 'logo-letras-negras.png' };

const cache = {};
function logo(variante) {
  if (!cache[variante]) cache[variante] = fs.readFileSync(path.join(CARPETA, ARCHIVOS[variante]));
  return cache[variante];
}

// Devuelve { buffer (JPEG), variante } — variante null si no lleva logo.
async function componer(imagen, { conLogo = true } = {}) {
  const base = sharp(imagen).rotate();
  const { width, height } = await base.metadata();

  if (!conLogo) {
    return { buffer: await base.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer(), variante: null };
  }

  const meta = await sharp(logo('blancas')).metadata();
  const caja = cajaLogo(width, height, meta.width, meta.height);

  // Lo claro u oscuro del fondo justo donde va el logo.
  const { channels } = await sharp(imagen)
    .extract({ left: caja.left, top: caja.top, width: caja.width, height: caja.height })
    .greyscale()
    .stats();
  const variante = varianteLogo(channels[0].mean);

  const pegado = await sharp(logo(variante))
    .resize(caja.width, caja.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  // Un halo suave del color opuesto, para que se lea también sobre una foto con textura.
  const alfa = await sharp(pegado).extractChannel('alpha').blur(Math.max(1, caja.width * 0.012)).linear(0.45, 0).toBuffer();
  const color = variante === 'blancas' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const halo = await sharp({ create: { width: caja.width, height: caja.height, channels: 3, background: color } })
    .joinChannel(alfa)
    .png()
    .toBuffer();

  const buffer = await base
    .flatten({ background: '#ffffff' })
    .composite([
      { input: halo, left: caja.left, top: caja.top },
      { input: pegado, left: caja.left, top: caja.top },
    ])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return { buffer, variante };
}

module.exports = { componer };
