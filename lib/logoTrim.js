// Recorta los margenes vacios de un logo (transparentes o blancos) y lo reduce a un tamano razonable.
// Asi el dibujo ocupa todo el alto que se le da en la cabecera, aunque se suba sobre un lienzo grande.
const MAX_SIDE = 8000; // no se procesan imagenes mayores (memoria)
const MAX_PIXELS = 40 * 1000 * 1000;
const MAX_OUT_HEIGHT = 600; // se muestra a ~50 px: 600 sobra incluso en pantallas de alta densidad
const PADDING = 0.03; // margen alrededor del dibujo, en proporcion a su lado mayor

const hasInk = (d, i) => {
  const a = d[i + 3];
  if (a <= 20) return false; // transparente
  return !(a >= 250 && d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245); // blanco opaco = fondo
};

// Devuelve { buffer, width, height } (PNG) o null si no se puede recortar (se usa entonces el archivo original)
async function trimLogo(buffer) {
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(buffer);
    if (!(img.width > 0 && img.height > 0) || img.width > MAX_SIDE || img.height > MAX_SIDE || img.width * img.height > MAX_PIXELS) return null;

    const full = createCanvas(img.width, img.height);
    const fctx = full.getContext('2d');
    fctx.drawImage(img, 0, 0);
    const { data } = fctx.getImageData(0, 0, img.width, img.height);

    let minX = img.width;
    let minY = img.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < img.height; y++) {
      const row = y * img.width;
      for (let x = 0; x < img.width; x++) {
        if (hasInk(data, (row + x) * 4)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // sin dibujo visible

    const pad = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * PADDING);
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const sw = Math.min(img.width, maxX + pad + 1) - sx;
    const sh = Math.min(img.height, maxY + pad + 1) - sy;
    const scale = Math.min(1, MAX_OUT_HEIGHT / sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const out = createCanvas(w, h);
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return { buffer: out.toBuffer('image/png'), width: w, height: h };
  } catch (err) {
    console.error('[logo] no se pudo recortar el logo:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { trimLogo };
