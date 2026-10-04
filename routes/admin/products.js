// Productos: alta, edicion, galeria, temas del producto y borrado.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { deleteImage, UserError } = require('../../lib/imageStorage');
const { MAX_EXTRAS, extrasOf, validateFiles, saveMany, addExtras, removeExtras, removeAllExtras } = require('../../lib/productImages');
const { wrap } = require('../../lib/security');
const { validateProduct } = require('../../lib/validate');
const themesLib = require('../../lib/themes');
const classify = require('../../lib/classify');
const { uploadImages, pickFiles } = require('./shared');

const router = express.Router();

// ---------- Productos ----------
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

async function renderForm(res, { product = null, form = null, errors = {}, error = null, status = 200 }) {
  const extras = product ? await extrasOf(product.id) : [];
  const allThemes = await themesLib.allThemes();
  const selectedThemeIds = form && form.themeIds ? form.themeIds : product ? (await themesLib.themesOf(product.id)).map((t) => Number(t.id)) : [];
  res.status(status).render('admin/product-form', {
    product,
    form,
    errors,
    error,
    extras,
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
    const v = validateProduct(req.body);
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
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return renderForm(res, { form: { ...v.values, ...themeForm(req.body) }, errors: v.errors, error: err.message, status: 400 });
    }

    const created = await db.run(
      `INSERT INTO products (title, description, price_cents, image_path, type, stock, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [v.values.title, v.values.description, v.price_cents, coverPath, v.values.type, v.stock]
    );
    await addExtras(created.lastInsertRowid, extraPaths);
    const detection = await applyThemes(
      { id: created.lastInsertRowid, title: v.values.title, description: v.values.description, image_path: coverPath },
      req.body,
      { buffer: cover.buffer }
    );
    req.session.flash = { type: 'success', msg: `"${v.values.title}" publicado.${describeDetection(detection)}` };
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

    const v = validateProduct(req.body);
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
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return renderForm(res, { product, form, errors: v.errors, error: err.message, status: 400 });
    }

    const image_path = coverPath || product.image_path;
    await db.run(
      `UPDATE products SET title = ?, description = ?, price_cents = ?, image_path = ?, type = ?, stock = ?, active = ?
       WHERE id = ?`,
      [v.values.title, v.values.description, v.price_cents, image_path, v.values.type, v.stock, active ? 1 : 0, product.id]
    );
    if (coverPath) await deleteImage(product.image_path);
    await removeExtras(product.id, removeIds);
    await addExtras(product.id, extraPaths);
    const detection = await applyThemes(
      { id: product.id, title: v.values.title, description: v.values.description, image_path },
      req.body,
      { buffer: cover ? cover.buffer : undefined }
    );
    req.session.flash = { type: 'success', msg: `Cambios guardados.${describeDetection(detection)}` };
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
