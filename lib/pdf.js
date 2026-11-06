// PDF -> imagen para la web. Se usa la primera pagina; el archivo original lo conserva quien lo sube.
// pdf.js y el lienzo nativo se cargan solo cuando llega un PDF (arranque rapido y menos memoria en reposo).
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_SIDE_PX = 2000; // igual que el limite de imagen que se guarda en la nube
const MAX_PAGE_PT = 14400; // 200 pulgadas: cualquier cosa mayor no es un dibujo

const isPdf = (buf) => !!buf && buf.length > 8 && buf.toString('latin1', 0, 1024).includes('%PDF-');

let libs = null;
async function load() {
  if (!libs) {
    const [pdfjs, canvas] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), Promise.resolve(require('@napi-rs/canvas'))]);
    libs = { pdfjs, canvas };
  }
  return libs;
}

// Devuelve { buffer, mime, ext, width, height, pageMm: [ancho, alto] } o lanza Error si el PDF no se puede leer
async function renderFirstPage(buffer) {
  const { pdfjs, canvas } = await load();
  const pdfDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // sin eval: un PDF no puede ejecutar codigo en el servidor
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(path.join(pdfDir, 'standard_fonts') + path.sep).href,
    cMapUrl: pathToFileURL(path.join(pdfDir, 'cmaps') + path.sep).href,
    cMapPacked: true,
    maxImageSize: 40 * 1000 * 1000, // pixeles: una imagen enorme dentro del PDF no agota la memoria
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    if (!(base.width > 0 && base.height > 0) || base.width > MAX_PAGE_PT || base.height > MAX_PAGE_PT) {
      throw new Error('Tamaño de página no válido');
    }
    const scale = MAX_SIDE_PX / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const cv = canvas.createCanvas(width, height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; // los PDF suelen ser transparentes: fondo blanco como en papel
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport, canvas: cv }).promise;

    let out = cv.toBuffer('image/png');
    let mime = 'image/png';
    let ext = '.png';
    if (out.length > 7.5 * 1024 * 1024) {
      out = cv.toBuffer('image/jpeg', 90); // dibujos muy detallados: JPEG de calidad alta para no pasar del limite
      mime = 'image/jpeg';
      ext = '.jpg';
    }
    // 1 pt = 1/72 pulgada = 0,3528 mm
    return { buffer: out, mime, ext, width, height, pageMm: [Math.round(base.width * 0.3528), Math.round(base.height * 0.3528)] };
  } finally {
    await task.destroy().catch(() => {});
  }
}

module.exports = { isPdf, renderFirstPage, MAX_PDF_BYTES };
