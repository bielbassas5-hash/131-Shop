// Galeria de un producto: imagen de portada (products.image_path) + hasta 5 extras.
const db = require('../db');
const { saveImage, deleteImage, detectImageType, UserError } = require('./imageStorage');
const pdf = require('./pdf');

const MAX_EXTRAS = 5;

const extrasOf = (productId) =>
  db.all('SELECT id, image_path FROM product_images WHERE product_id = ? ORDER BY position, id', [productId]);

// Comprueba TODAS las imágenes antes de guardar ninguna (evita subidas a medias).
function validateFiles(files) {
  for (const f of files) {
    if (!detectImageType(f.buffer)) {
      throw new UserError(`"${f.originalname}" no es una imagen válida (usa PNG, JPG, WEBP o GIF).`);
    }
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDFS_PER_REQUEST = 2;
const CONVERT_TIMEOUT_MS = 40 * 1000;

// Valida TODOS los archivos antes de guardar ninguno. Las imagenes pasan tal cual; los PDF se convierten
// (primera pagina) a una imagen para la web y el archivo queda marcado con fromPdf = true.
async function prepareFiles(files) {
  const list = files.filter(Boolean);
  let pdfCount = 0;
  for (const f of list) {
    if (pdf.isPdf(f.buffer)) {
      pdfCount += 1;
      if (pdfCount > MAX_PDFS_PER_REQUEST) throw new UserError('Sube como máximo 2 PDF a la vez.');
      if (f.buffer.length > pdf.MAX_PDF_BYTES) throw new UserError(`"${f.originalname}" supera los 20 MB.`);
      let page;
      try {
        page = await Promise.race([
          pdf.renderFirstPage(f.buffer),
          new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo agotado')), CONVERT_TIMEOUT_MS).unref()),
        ]);
      } catch (err) {
        console.error('[pdf] no se pudo convertir:', err && err.message ? err.message : err);
        throw new UserError(`No se ha podido leer "${f.originalname}". Comprueba que el PDF no esté protegido con contraseña ni dañado.`);
      }
      f.buffer = page.buffer;
      f.fromPdf = true;
      f.pdfPageMm = page.pageMm;
      f.mimetype = page.mime;
    } else if (!detectImageType(f.buffer)) {
      throw new UserError(`"${f.originalname}" no es válido (usa PNG, JPG, WEBP, GIF o PDF).`);
    } else if (f.buffer.length > MAX_IMAGE_BYTES) {
      throw new UserError(`"${f.originalname}" supera los 8 MB (los PDF admiten hasta 20 MB).`);
    }
  }
  return list;
}

// Guarda varias imágenes; si una falla, borra las que ya se habian guardado.
async function saveMany(files) {
  const saved = [];
  try {
    for (const f of files) saved.push(await saveImage(f));
    return saved;
  } catch (err) {
    for (const p of saved) await deleteImage(p);
    throw err;
  }
}

async function addExtras(productId, paths) {
  const row = await db.get('SELECT COALESCE(MAX(position), 0) AS p FROM product_images WHERE product_id = ?', [productId]);
  let pos = Number(row.p);
  for (const p of paths) {
    pos += 1;
    await db.run('INSERT INTO product_images (product_id, image_path, position) VALUES (?, ?, ?)', [productId, p, pos]);
  }
}

async function removeExtras(productId, ids) {
  for (const id of ids) {
    const row = await db.get('SELECT image_path FROM product_images WHERE id = ? AND product_id = ?', [id, productId]);
    if (!row) continue;
    await db.run('DELETE FROM product_images WHERE id = ?', [id]);
    await deleteImage(row.image_path);
  }
}

// Borra todas las imágenes extra (BD + archivos) de un producto que se elimina.
async function removeAllExtras(productId) {
  const rows = await extrasOf(productId);
  await db.run('DELETE FROM product_images WHERE product_id = ?', [productId]);
  for (const r of rows) await deleteImage(r.image_path);
}

module.exports = { MAX_EXTRAS, extrasOf, validateFiles, prepareFiles, saveMany, addExtras, removeExtras, removeAllExtras };
