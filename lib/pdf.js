// PDF -> imagen para la web. Se usa la primera pagina; el archivo original lo conserva quien lo sube.
// pdf.js y el lienzo nativo se cargan solo cuando llega un PDF (arranque rapido y menos memoria en reposo).
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_SIDE_PX = 2000; // igual que el limite de imagen que se guarda en la nube
const MAX_PAGE_PT = 14400; // 200 pulgadas: cualquier cosa mayor no es un dibujo

// Resolucion (ppp) de las imagenes incrustadas en la pagina, a su tamano de pagina: recorre las operaciones
// de dibujo siguiendo la matriz de transformacion. Solo cuentan las que ocupan al menos un 5 % de la pagina
// (un logotipo pequeno no define la calidad). Devuelve el valor mas bajo, o null si la pagina es vectorial.
const MIN_AREA_SHARE = 0.05;
function concat(m, c) {
  return [
    m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
  ];
}
async function embeddedImagePpp(pdfjs, page, pageW, pageH) {
  const { OPS } = pdfjs;
  const list = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let min = null;
  const seen = (pxW, pxH) => {
    const wPt = Math.hypot(ctm[0], ctm[1]);
    const hPt = Math.hypot(ctm[2], ctm[3]);
    if (!(pxW > 0 && pxH > 0 && wPt > 0 && hPt > 0)) return;
    if ((wPt * hPt) / (pageW * pageH) < MIN_AREA_SHARE) return;
    const ppp = Math.min(pxW / (wPt / 72), pxH / (hPt / 72));
    if (min === null || ppp < min) min = ppp;
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = concat(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args) && Array.isArray(args[0])) ctm = concat(args[0], ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject) seen(args[1], args[2]);
    else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) seen(args[0] && args[0].width, args[0] && args[0].height);
  }
  return min;
}

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
    // Resolucion del PDF: se expresa como un tamano en pixeles equivalente (pagina x ppp de sus imagenes),
    // el mismo dato que para una imagen normal. Vectorial (sin imagenes): null = sin limite de resolucion.
    let imagePpp = null;
    try {
      imagePpp = await embeddedImagePpp(pdfjs, page, base.width, base.height);
    } catch (_) {
      /* no se pudo medir: sin dato */
    }
    const dims = imagePpp
      ? { width: Math.min(30000, Math.max(1, Math.round((base.width / 72) * imagePpp))), height: Math.min(30000, Math.max(1, Math.round((base.height / 72) * imagePpp))) }
      : null;
    // 1 pt = 1/72 pulgada = 0,3528 mm
    return { imagePpp: imagePpp ? Math.round(imagePpp) : null, dims, buffer: out, mime, ext, width, height, pageMm: [Math.round(base.width * 0.3528), Math.round(base.height * 0.3528)] };
  } finally {
    await task.destroy().catch(() => {});
  }
}

module.exports = { isPdf, renderFirstPage, MAX_PDF_BYTES };
