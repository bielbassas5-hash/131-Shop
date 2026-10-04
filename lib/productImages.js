// Galeria de un producto: imagen de portada (products.image_path) + hasta 5 extras.
const db = require('../db');
const { saveImage, deleteImage, detectImageType, UserError } = require('./imageStorage');

const MAX_EXTRAS = 5;

const extrasOf = (productId) =>
  db.all('SELECT id, image_path FROM product_images WHERE product_id = ? ORDER BY position, id', [productId]);

// Comprueba TODAS las imagenes antes de guardar ninguna (evita subidas a medias).
function validateFiles(files) {
  for (const f of files) {
    if (!detectImageType(f.buffer)) {
      throw new UserError(`"${f.originalname}" no es una imagen válida (usa PNG, JPG, WEBP o GIF).`);
    }
  }
}

// Guarda varias imagenes; si una falla, borra las que ya se habian guardado.
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

// Borra todas las imagenes extra (BD + archivos) de un producto que se elimina.
async function removeAllExtras(productId) {
  const rows = await extrasOf(productId);
  await db.run('DELETE FROM product_images WHERE product_id = ?', [productId]);
  for (const r of rows) await deleteImage(r.image_path);
}

module.exports = { MAX_EXTRAS, extrasOf, validateFiles, saveMany, addExtras, removeExtras, removeAllExtras };
