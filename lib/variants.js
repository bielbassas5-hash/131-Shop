// Formatos de un producto (por ejemplo "A4" a 18 € y "A3" a 28 €): cada uno con su precio.
// Un producto sin formatos usa su precio normal.
const db = require('../db');

// Sin depender de validate.js (que a su vez usa orders.js): evita un ciclo de importaciones
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const MAX_VARIANTS = 8;

// "A4: 18,00" (una linea por formato; se admite ":", "|" o "=" como separador)
const LINE_RE = /^(.{1,40}?)\s*[:|=]\s*([\d.,]+)\s*€?$/;

function parseVariantsText(raw) {
  const variants = [];
  const errors = [];
  const seen = new Set();
  const lines = String(typeof raw === 'string' ? raw : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > MAX_VARIANTS) errors.push(`Máximo ${MAX_VARIANTS} formatos.`);
  for (const line of lines.slice(0, MAX_VARIANTS)) {
    const m = LINE_RE.exec(line);
    const label = m ? text(m[1], 40) : '';
    const priceStr = m ? m[2].replace(',', '.') : '';
    const price = Number(priceStr);
    if (!m || !label || !/^\d+(\.\d{1,2})?$/.test(priceStr) || price <= 0 || price > 10000) {
      errors.push(`Formato no válido: "${text(line, 50)}". Usa el formato "A4: 18,00".`);
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      errors.push(`El formato "${label}" está repetido.`);
      continue;
    }
    seen.add(key);
    variants.push({ label, price_cents: Math.round(price * 100) });
  }
  return { variants, errors };
}

const fmt = (cents) => (cents / 100).toFixed(2).replace('.', ',');
const toText = (variants) => variants.map((v) => `${v.label}: ${fmt(v.price_cents)}`).join('\n');

const variantsOf = (productId) =>
  db.all('SELECT id, label, price_cents FROM product_variants WHERE product_id = ? ORDER BY position, id', [productId]);

async function variantsOfMany(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.all(
    `SELECT id, product_id, label, price_cents FROM product_variants
     WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY position, id`,
    ids
  );
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(r);
  }
  return map;
}

// Sustituye los formatos del producto y deja su precio base en el del formato mas barato
async function replaceVariants(productId, variants) {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM product_variants WHERE product_id = ?', [productId]);
    let pos = 0;
    for (const v of variants) {
      pos += 1;
      await tx.run('INSERT INTO product_variants (product_id, label, price_cents, position) VALUES (?, ?, ?, ?)', [
        productId,
        v.label,
        v.price_cents,
        pos,
      ]);
    }
    if (variants.length) {
      await tx.run('UPDATE products SET price_cents = ? WHERE id = ?', [Math.min(...variants.map((v) => v.price_cents)), productId]);
    }
  });
}

module.exports = { MAX_VARIANTS, parseVariantsText, toText, variantsOf, variantsOfMany, replaceVariants };
