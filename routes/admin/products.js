// Productos: alta, edicion, galeria, temas del producto y borrado.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { deleteImage, UserError } = require('../../lib/imageStorage');
const { MAX_EXTRAS, extrasOf, validateFiles, saveMany, addExtras, removeExtras, removeAllExtras } = require('../../lib/productImages');
const { wrap } = require('../../lib/security');
const { validateProduct } = require('../../lib/validate');
const { MAX_VARIANTS, parseVariantsText, toText, variantsOf, replaceVariants } = require('../../lib/variants');
const { parseDetails, toText: toDetailsText, MAX_DETAILS } = require('../../lib/details');
const formats = require('../../lib/formats');
const themesLib = require('../../lib/themes');
const classify = require('../../lib/classify');
const { uploadImages, pickFiles } = require('./shared');

const router = express.Router();

// ---------- Productos ----------
// Fallo del servicio de imagenes (red, Cloudinary...): se registra y el administrador ve un aviso claro
function uploadFailure(err) {
  console.error('[imagenes] no se pudo guardar la imagen:', err && err.message ? err.message : err);
  return new UserError('No se ha podido subir la imagen. Inténtalo de nuevo en unos minutos.');
}

// ---- Temas en el formulario de producto ----
const toIds = (v) =>
  []
    .concat(v || [])
    .map(String)
    .filter((x) => /^\d{1,9}$/.test(x))
    .map(Number)
    .slice(0, 20);

// Lo que el administrador marco/escribio (para no perderlo si hay que repetir el formulario)
const themeForm = (body) => ({
  themeIds: toIds(body.themes),
  newThemes: typeof body.new_themes === 'string' ? body.new_themes.slice(0, 200) : '',
  autoThemes: body.auto_themes === '1',
});

// Guarda la seleccion manual y, si no hay ninguna y esta marcado, detecta los temas solos.
async function applyThemes(product, body, { buffer } = {}) {
  const created = await themesLib.ensureThemes(themesLib.parseNames(body.new_themes));
  const ids = [...new Set([...toIds(body.themes), ...created])];
  await themesLib.setProductThemes(product.id, ids);
  if (!ids.length && body.auto_themes === '1') return classify.classifyProduct(product, { buffer });
  return null;
}

const describeDetection = (d) =>
  d && d.names.length ? ` Temas detectados ${d.source === 'ai' ? 'con IA' : 'por palabras clave'}: ${d.names.join(', ')}.` : '';

const priceText = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// Lee y valida el formulario de producto. Formatos: estandar (casilla + precio) y otros (una linea "A4: 18,00")
function readProduct(body) {
  const chosen = [].concat(body.fmt || []).map(String);
  const fmtPrices = {};
  const variants = [];
  const problems = [];

  for (const p of formats.PRESETS) {
    const raw = typeof body[`fmt_price_${p.id}`] === 'string' ? body[`fmt_price_${p.id}`].trim().slice(0, 12) : '';
    fmtPrices[p.id] = raw;
    if (!chosen.includes(p.id)) continue;
    const priceStr = raw.replace(',', '.');
    const price = Number(priceStr);
    if (!/^\d+(\.\d{1,2})?$/.test(priceStr) || price <= 0 || price > 10000) {
      problems.push(`Indica un precio válido para ${p.id}.`);
      continue;
    }
    variants.push({ label: p.label, price_cents: Math.round(price * 100) });
  }

  const custom = parseVariantsText(body.variants_text);
  problems.push(...custom.errors);
  for (const c of custom.variants) {
    if (variants.some((v) => v.label.toLowerCase() === c.label.toLowerCase())) problems.push(`El formato "${c.label}" está repetido.`);
    else variants.push(c);
  }
  if (variants.length > MAX_VARIANTS) problems.push(`Máximo ${MAX_VARIANTS} formatos.`);

  const v = validateProduct(body, { hasVariants: variants.length > 0 });
  v.values.variants_text = typeof body.variants_text === 'string' ? body.variants_text.slice(0, 700) : '';
  v.values.fmt = chosen.filter((id) => formats.PRESETS.some((p) => p.id === id));
  v.values.fmt_prices = fmtPrices;
  const det = parseDetails(body.details);
  v.values.details = typeof body.details === 'string' ? body.details.slice(0, 1200) : '';
  v.details_text = toDetailsText(det.details);
  if (det.errors.length) {
    v.errors.details = det.errors.join(' ');
    v.ok = false;
  }
  v.values.source_width = typeof body.source_width === 'string' ? body.source_width.trim().slice(0, 6) : '';
  v.values.source_height = typeof body.source_height === 'string' ? body.source_height.trim().slice(0, 6) : '';
  if (problems.length) {
    v.errors.variants = problems.join(' ');
    v.ok = false;
  }
  return { v, variants };
}

// Resolucion del original: la que escribe el administrador (o rellena el navegador al elegir el archivo),
// si no la detectada en el archivo subido, si no la que ya estaba guardada.
function resolveDims(values, buffer, existing) {
  const num = (x) => Number(x);
  const typed = formats.valid(num(values.source_width), num(values.source_height))
    ? { width: num(values.source_width), height: num(values.source_height) }
    : null;
  const stored = existing && existing.source_width ? { width: num(existing.source_width), height: num(existing.source_height) } : null;
  const detected = buffer ? formats.imageSize(buffer) : null;
  const typedChanged = typed && (!stored || typed.width !== stored.width || typed.height !== stored.height);
  return (typedChanged && typed) || detected || typed || stored || null;
}

// Aviso si se activa un formato para el que la imagen no tiene resolucion suficiente
function qualityWarning(variants, dims) {
  if (!dims) return '';
  const low = [];
  for (const vr of variants) {
    const p = formats.presetOfLabel(vr.label);
    const a = p && formats.assess(dims, p);
    if (a && a.level === 'baja') low.push(`${p.id} (${a.ppp} ppp)`);
  }
  return low.length ? ` Atención: resolución baja para ${low.join(', ')} (la imagen mide ${dims.width} × ${dims.height} px).` : '';
}

const lastPriceText = async (label) => {
  const row = await db.get('SELECT price_cents FROM product_variants WHERE label = ? ORDER BY id DESC LIMIT 1', [label]);
  return row ? priceText(Number(row.price_cents)) : '';
};

async function renderForm(res, { product = null, form = null, errors = {}, error = null, status = 200 }) {
  const extras = product ? await extrasOf(product.id) : [];

  // Formatos: casillas estandar + lo demas en el cuadro de texto
  const chosen = new Map();
  let variantsText = '';
  if (form) {
    for (const id of form.fmt || []) chosen.set(id, (form.fmt_prices || {})[id] || '');
    variantsText = form.variants_text || '';
  } else if (product) {
    const others = [];
    for (const vr of await variantsOf(product.id)) {
      const p = formats.presetOfLabel(vr.label);
      if (p) chosen.set(p.id, priceText(Number(vr.price_cents)));
      else others.push(vr);
    }
    variantsText = toText(others);
  }
  const formW = form ? Number(form.source_width) : Number(product && product.source_width);
  const formH = form ? Number(form.source_height) : Number(product && product.source_height);
  const dims = formats.valid(formW, formH) ? { width: formW, height: formH } : null;
  const formatRows = [];
  for (const p of formats.PRESETS) {
    const a = formats.assess(dims, p);
    formatRows.push({
      ...p,
      checked: chosen.has(p.id),
      price: chosen.has(p.id) ? chosen.get(p.id) : await lastPriceText(p.label), // propone el ultimo precio usado
      ppp: a && a.ppp,
      level: a && a.level,
      levelLabel: a && formats.QUALITY_LABELS[a.level],
    });
  }

  const allThemes = await themesLib.allThemes();
  const selectedThemeIds = form && form.themeIds ? form.themeIds : product ? (await themesLib.themesOf(product.id)).map((t) => Number(t.id)) : [];
  res.status(status).render('admin/product-form', {
    product,
    form,
    errors,
    error,
    extras,
    variantsText,
    formatRows,
    dims,
    maxVariants: MAX_VARIANTS,
    maxDetails: MAX_DETAILS,
    maxExtras: MAX_EXTRAS,
    allThemes,
    selectedThemeIds,
    aiEnabled: classify.aiEnabled(),
    meta: { title: product ? 'Editar producto' : 'Nuevo producto', noindex: true },
  });
}

router.get('/admin/productos/nuevo', requireAdmin, wrap((req, res) => renderForm(res, {})));

router.post(
  '/admin/productos/nuevo',
  requireAdmin,
  uploadImages,
  wrap(async (req, res) => {
    const { v, variants } = readProduct(req.body);
    const { cover, extras } = pickFiles(req);
    let error = req.uploadError || null;
    if (!cover && !error) error = 'Sube una imagen del producto.';
    if (!error && extras.length > MAX_EXTRAS) error = `Máximo ${MAX_EXTRAS} imágenes adicionales.`;
    if (!v.ok || error) return renderForm(res, { form: { ...v.values, ...themeForm(req.body) }, errors: v.errors, error, status: 400 });

    let coverPath;
    let extraPaths;
    try {
      validateFiles([cover, ...extras]);
      [coverPath, ...extraPaths] = await saveMany([cover, ...extras]);
    } catch (rawErr) {
      const err = rawErr instanceof UserError ? rawErr : uploadFailure(rawErr);
      return renderForm(res, { form: { ...v.values, ...themeForm(req.body) }, errors: v.errors, error: err.message, status: 400 });
    }

    const dims = resolveDims(v.values, cover.buffer, null);
    const created = await db.run(
      `INSERT INTO products (title, description, price_cents, image_path, type, stock, active, source_width, source_height, details)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [v.values.title, v.values.description, v.price_cents, coverPath, v.values.type, v.stock, dims ? dims.width : null, dims ? dims.height : null, v.details_text]
    );
    await addExtras(created.lastInsertRowid, extraPaths);
    if (variants.length) await replaceVariants(created.lastInsertRowid, variants);
    const detection = await applyThemes(
      { id: created.lastInsertRowid, title: v.values.title, description: v.values.description, image_path: coverPath },
      req.body,
      { buffer: cover.buffer }
    );
    req.session.flash = { type: 'success', msg: `"${v.values.title}" publicado.${describeDetection(detection)}${qualityWarning(variants, dims)}` };
    res.redirect('/admin');
  })
);

async function findProduct(req) {
  if (!/^\d+$/.test(req.params.id)) return null;
  return db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
}

router.get(
  '/admin/productos/:id/editar',
  requireAdmin,
  wrap(async (req, res) => {
    const product = await findProduct(req);
    if (!product) return res.status(404).render('error', { status: 404 });
    await renderForm(res, { product });
  })
);

router.post(
  '/admin/productos/:id/editar',
  requireAdmin,
  uploadImages,
  wrap(async (req, res) => {
    const product = await findProduct(req);
    if (!product) return res.status(404).render('error', { status: 404 });

    const { v, variants } = readProduct(req.body);
    const active = req.body.active === '1';
    const form = { ...v.values, active, ...themeForm(req.body) };
    const { cover, extras } = pickFiles(req);

    // ids de extras a quitar (puede llegar un valor suelto o una lista)
    const removeIds = []
      .concat(req.body.remove_extra || [])
      .map((x) => String(x))
      .filter((x) => /^\d{1,9}$/.test(x))
      .map(Number);
    const current = await extrasOf(product.id);
    const kept = current.filter((e) => !removeIds.includes(Number(e.id))).length;

    let error = req.uploadError || null;
    if (!error && kept + extras.length > MAX_EXTRAS) error = `Máximo ${MAX_EXTRAS} imágenes adicionales (ahora tendrías ${kept + extras.length}).`;
    if (!v.ok || error) return renderForm(res, { product, form, errors: v.errors, error, status: 400 });

    let coverPath = null;
    let extraPaths = [];
    try {
      const incoming = [cover, ...extras].filter(Boolean);
      validateFiles(incoming);
      const saved = await saveMany(incoming);
      coverPath = cover ? saved.shift() : null;
      extraPaths = saved;
    } catch (rawErr) {
      const err = rawErr instanceof UserError ? rawErr : uploadFailure(rawErr);
      return renderForm(res, { product, form, errors: v.errors, error: err.message, status: 400 });
    }

    const image_path = coverPath || product.image_path;
    const dims = resolveDims(v.values, cover ? cover.buffer : null, product);
    await db.run(
      `UPDATE products SET title = ?, description = ?, price_cents = ?, image_path = ?, type = ?, stock = ?, active = ?,
         source_width = ?, source_height = ?, details = ?
       WHERE id = ?`,
      [v.values.title, v.values.description, v.price_cents, image_path, v.values.type, v.stock, active ? 1 : 0, dims ? dims.width : null, dims ? dims.height : null, v.details_text, product.id]
    );
    if (coverPath) await deleteImage(product.image_path);
    await removeExtras(product.id, removeIds);
    await addExtras(product.id, extraPaths);
    await replaceVariants(product.id, variants); // sin formatos: los borra y deja el precio indicado
    const detection = await applyThemes(
      { id: product.id, title: v.values.title, description: v.values.description, image_path },
      req.body,
      { buffer: cover ? cover.buffer : undefined }
    );
    req.session.flash = { type: 'success', msg: `Cambios guardados.${describeDetection(detection)}${qualityWarning(variants, dims)}` };
    res.redirect('/admin');
  })
);

router.post(
  '/admin/productos/:id/eliminar',
  requireAdmin,
  wrap(async (req, res) => {
    const product = await findProduct(req);
    if (product) {
      await removeAllExtras(product.id);
      await db.run('DELETE FROM product_variants WHERE product_id = ?', [product.id]);
      await db.run('DELETE FROM products WHERE id = ?', [product.id]);
      await deleteImage(product.image_path);
      req.session.flash = { type: 'success', msg: `"${product.title}" eliminado.` };
    }
    res.redirect('/admin');
  })
);


router.post(
  '/admin/productos/:id/detectar-temas',
  requireAdmin,
  wrap(async (req, res) => {
    const product = await findProduct(req);
    if (!product) return res.status(404).render('error', { status: 404 });
    const detection = await classify.classifyProduct(product);
    req.session.flash = detection.names.length
      ? { type: 'success', msg: `Temas detectados ${detection.source === 'ai' ? 'con IA' : 'por palabras clave'}: ${detection.names.join(', ')}.` }
      : { type: 'info', msg: 'No se ha podido identificar ningún tema. Márcalos a mano.' };
    res.redirect(`/admin/productos/${product.id}/editar`);
  })
);

module.exports = router;
