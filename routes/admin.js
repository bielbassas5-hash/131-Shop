const express = require('express');
const multer = require('multer');
const db = require('../db');
const { slugOf } = db;
const { requireAdmin, adminHeaders } = require('../middleware/auth');
const { deleteImage, UserError } = require('../lib/imageStorage');
const { MAX_EXTRAS, extrasOf, validateFiles, saveMany, addExtras, removeExtras, removeAllExtras } = require('../lib/productImages');
const { wrap, createLimiter, safeEqual, clientIp } = require('../lib/security');
const { validateProduct, text } = require('../lib/validate');
const { STATUSES, setStatus, paymentInfo, trackStock, StockError } = require('../lib/orders');
const { stripeConfigured } = require('../lib/payments');
const { STATUS_LABELS } = require('../lib/format');
const notify = require('../lib/notify');
const themesLib = require('../lib/themes');
const classify = require('../lib/classify');
const { configured: mailConfigured } = require('../lib/mailer');

const router = express.Router();
router.use('/admin', adminHeaders);

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const WEAK_PASSWORDS = ['arte131', 'admin', 'password', '123456', '131', 'contraseña'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 + MAX_EXTRAS },
});
const imageFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'extra', maxCount: MAX_EXTRAS + 1 },
]);

// Multer sin romper el flujo: el error se guarda en req.uploadError y la ruta lo muestra.
function uploadImages(req, res, next) {
  imageFields(req, res, (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE' ? 'Alguna imagen supera los 8 MB.' : 'No se han podido leer las imágenes.';
    }
    next();
  });
}

function pickFiles(req) {
  const f = req.files || {};
  return { cover: (f.image || [])[0], extras: f.extra || [] };
}

const isWeak = () => {
  const pw = process.env.ADMIN_PASSWORD || '';
  return pw.length < 10 || WEAK_PASSWORDS.includes(pw.toLowerCase());
};

// Lista de puesta en marcha: lo que falta configurar antes de vender de verdad.
function launchChecklist() {
  const e = process.env;
  const pay = paymentInfo();
  return [
    { ok: !isWeak(), label: 'Contraseña de administrador segura', hint: 'ADMIN_PASSWORD (12 caracteres o más)' },
    { ok: stripeConfigured || !!pay.bizum || !!pay.iban, label: 'Forma de cobro configurada (Bizum, IBAN real o Stripe)', hint: 'BIZUM_PHONE / BANK_IBAN' },
    { ok: !!e.CONTACT_EMAIL, label: 'Email de contacto visible en la web', hint: 'CONTACT_EMAIL' },
    { ok: !!(e.LEGAL_NAME && e.LEGAL_NIF && e.LEGAL_ADDRESS), label: 'Datos del titular en las páginas legales', hint: 'LEGAL_NAME, LEGAL_NIF, LEGAL_ADDRESS' },
    { ok: !!e.SITE_URL, label: 'Dirección pública de la web (para enlaces y SEO)', hint: 'SITE_URL' },
    { ok: mailConfigured() && !!e.OWNER_EMAIL, label: 'Avisos por email de pedidos nuevos (opcional)', hint: 'BREVO_API_KEY, MAIL_FROM, OWNER_EMAIL', optional: true },
    { ok: classify.aiEnabled(), label: 'Detección de temas con IA a partir de la imagen (opcional; sin ella se usan palabras del título)', hint: 'ANTHROPIC_API_KEY', optional: true },
    ...(trackStock() ? [] : [{ ok: !!e.LEAD_TIME, label: 'Plazo de elaboración que se muestra a los clientes (opcional)', hint: 'LEAD_TIME', optional: true }]),
  ];
}

// ---------- Acceso ----------
router.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null, meta: { title: 'Acceso', noindex: true } });
});

router.post('/admin/login', (req, res, next) => {
  const renderLogin = (error, status = 200) =>
    res.status(status).render('admin/login', { error, meta: { title: 'Acceso', noindex: true } });

  if (loginLimiter.blocked(clientIp(req))) {
    return renderLogin('Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', 429);
  }
  const expected = process.env.ADMIN_PASSWORD;
  const given = typeof req.body.password === 'string' ? req.body.password : '';
  if (!expected || !given || !safeEqual(given, expected)) {
    loginLimiter.hit(clientIp(req));
    return renderLogin('Contraseña incorrecta.', 401);
  }

  loginLimiter.reset(clientIp(req));
  // Nueva sesión al autenticarse (evita fijacion de sesión)
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.cookie.maxAge = ADMIN_SESSION_MS;
    res.redirect('/admin');
  });
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ---------- Panel ----------
router.get(
  '/admin',
  requireAdmin,
  wrap(async (req, res) => {
    const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    const revenue = await db.get(
      "SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status IN ('paid', 'production', 'shipped')"
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const stats = {
      revenue: Number(revenue.total),
      pending: byStatus.pending || 0,
      toShip: (byStatus.paid || 0) + (byStatus.production || 0),
      soldOut: trackStock() ? products.filter((p) => p.active && p.stock <= 0).length : 0,
      lowStock: trackStock() ? products.filter((p) => p.active && p.stock > 0 && p.stock <= 2).length : 0,
    };
    res.render('admin/dashboard', {
      products,
      stats,
      weakPassword: isWeak(),
      checklist: launchChecklist(),
      meta: { title: 'Panel', noindex: true },
    });
  })
);

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

// ---------- Temas ----------
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

router.get(
  '/admin/temas',
  requireAdmin,
  wrap(async (req, res) => {
    const withoutThemes = await themesLib.productsWithoutThemes(1000);
    res.render('admin/themes', {
      themes: await themesLib.allThemes(),
      unclassified: withoutThemes.length,
      aiEnabled: classify.aiEnabled(),
      meta: { title: 'Temas', noindex: true },
    });
  })
);

router.post(
  '/admin/temas',
  requireAdmin,
  wrap(async (req, res) => {
    const names = themesLib.parseNames(req.body.name);
    if (!names.length) {
      req.session.flash = { type: 'error', msg: 'Nombre no válido (2-30 letras, números, espacios o guiones).' };
    } else {
      await themesLib.ensureThemes(names);
      req.session.flash = { type: 'success', msg: `Tema "${names[0]}" creado.` };
    }
    res.redirect('/admin/temas');
  })
);

// Clasifica (como máximo 15 por vez) los productos que aún no tienen ningún tema
router.post(
  '/admin/temas/clasificar',
  requireAdmin,
  wrap(async (req, res) => {
    const batch = classify.aiEnabled() ? 5 : 30; // la IA tarda unos segundos por imagen
    const pending = await themesLib.productsWithoutThemes(batch);
    let done = 0;
    for (const p of pending) {
      const d = await classify.classifyProduct(p);
      if (d.names.length) done += 1;
    }
    const left = (await themesLib.productsWithoutThemes(1000)).length;
    req.session.flash = {
      type: pending.length ? 'success' : 'info',
      msg: pending.length
        ? `Clasificados ${done} de ${pending.length} productos.${left ? ` Quedan ${left} sin tema; vuelve a pulsar el botón.` : ''}`
        : 'Todos los productos ya tienen algún tema.',
    };
    res.redirect('/admin/temas');
  })
);

router.post(
  '/admin/temas/:id/renombrar',
  requireAdmin,
  wrap(async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const name = themesLib.cleanName(req.body.name);
    const slug = name ? slugOf(name) : '';
    const clash = slug ? await db.get('SELECT id FROM themes WHERE slug = ? AND id != ?', [slug, id]) : null;
    if (!id || !name || !slug) req.session.flash = { type: 'error', msg: 'Nombre no válido.' };
    else if (clash) req.session.flash = { type: 'error', msg: 'Ya existe un tema con ese nombre.' };
    else {
      await db.run('UPDATE themes SET name = ?, slug = ? WHERE id = ?', [name, slug, id]);
      req.session.flash = { type: 'success', msg: 'Tema renombrado.' };
    }
    res.redirect('/admin/temas');
  })
);

router.post(
  '/admin/temas/:id/eliminar',
  requireAdmin,
  wrap(async (req, res) => {
    if (/^\d+$/.test(req.params.id)) {
      await db.run('DELETE FROM product_themes WHERE theme_id = ?', [req.params.id]);
      await db.run('DELETE FROM themes WHERE id = ?', [req.params.id]);
      req.session.flash = { type: 'success', msg: 'Tema eliminado (los productos se conservan).' };
    }
    res.redirect('/admin/temas');
  })
);

// ---------- Pedidos ----------
router.get(
  '/admin/pedidos',
  requireAdmin,
  wrap(async (req, res) => {
    const estado = STATUSES.includes(req.query.estado) ? req.query.estado : '';
    const orders = await db.all(
      `SELECT * FROM orders ${estado ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 300`,
      estado ? [estado] : []
    );
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    res.render('admin/orders', {
      orders,
      estado,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      meta: { title: 'Pedidos', noindex: true },
    });
  })
);

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyeccion de formulas en Excel
  return `"${s.replace(/"/g, '""')}"`;
}

router.get(
  '/admin/pedidos.csv',
  requireAdmin,
  wrap(async (req, res) => {
    const orders = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
    const items = await db.all('SELECT order_id, title, quantity FROM order_items');
    const byOrder = new Map();
    for (const it of items) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(`${it.quantity}x ${it.title}`);
    }
    const header = ['Pedido', 'Fecha', 'Estado', 'Nombre', 'Email', 'Teléfono', 'Dirección', 'Ciudad', 'CP', 'País', 'Total EUR', 'Entrega', 'Notas', 'Seguimiento', 'Artículos'];
    const rows = orders.map((o) => {
      let s = {};
      try {
        s = JSON.parse(o.shipping_address || '{}');
      } catch (_) {
        /* sin datos */
      }
      return [
        o.id, o.created_at, STATUS_LABELS[o.status] || o.status, s.name || o.customer_name, s.email || o.customer_email,
        s.phone, s.address, s.city, s.postal_code, s.country, (o.total_cents / 100).toFixed(2),
        o.shipping_method === 'pickup' ? 'Recogida' : 'Envío', s.notes, o.tracking_number, (byOrder.get(o.id) || []).join(' | '),
      ].map(csvCell).join(',');
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pedidos-131.csv"');
    res.send('﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n'));
  })
);

router.get(
  '/admin/pedidos/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).render('error', { status: 404 });
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).render('error', { status: 404 });
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    let shipTo = {};
    try {
      shipTo = JSON.parse(order.shipping_address || '{}');
    } catch (_) {
      /* sin datos */
    }
    const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const link = `${base}/pedido/${order.token}`;
    const body =
      `Hola ${shipTo.name || ''},\n\nTu pedido #${order.id} ya está en camino.\n` +
      (order.tracking_number ? `Número de seguimiento: ${order.tracking_number}\n` : '') +
      `Puedes ver su estado aquí: ${link}\n\nGracias por tu compra!\n131`;
    const mailto = `mailto:${encodeURIComponent(order.customer_email || '')}?subject=${encodeURIComponent(
      `Tu pedido #${order.id} de 131`
    )}&body=${encodeURIComponent(body)}`;

    res.render('admin/order-detail', {
      order,
      items,
      shipTo,
      mailto,
      publicLink: link,
      statuses: STATUSES,
      mailConfigured: mailConfigured(),
      meta: { title: `Pedido #${order.id}`, noindex: true },
    });
  })
);

router.post(
  '/admin/pedidos/:id/estado',
  requireAdmin,
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id) || !STATUSES.includes(req.body.status)) {
      return res.status(400).render('error', { status: 400, title: 'Petición no válida', message: 'Estado no válido.' });
    }
    const tracking = text(req.body.tracking, 40);
    try {
      const { previous } = await setStatus(Number(req.params.id), req.body.status, { tracking });
      if (req.body.notify === '1') {
        const base = res.locals.shop.siteUrl;
        const id = Number(req.params.id);
        if (req.body.status === 'paid' && previous === 'pending') notify.paid(id, base);
        if (req.body.status === 'production' && previous !== 'production') notify.production(id, base);
        if (req.body.status === 'shipped' && previous !== 'shipped') notify.shipped(id, base);
      }
      req.session.flash = { type: 'success', msg: 'Pedido actualizado.' };
    } catch (err) {
      if (!(err instanceof StockError)) throw err;
      req.session.flash = { type: 'error', msg: err.message };
    }
    res.redirect(`/admin/pedidos/${req.params.id}`);
  })
);

module.exports = router;
