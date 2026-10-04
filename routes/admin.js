const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAdmin, adminHeaders } = require('../middleware/auth');
const { deleteImage, UserError } = require('../lib/imageStorage');
const { MAX_EXTRAS, extrasOf, validateFiles, saveMany, addExtras, removeExtras, removeAllExtras } = require('../lib/productImages');
const { wrap, createLimiter, safeEqual } = require('../lib/security');
const { validateProduct, text } = require('../lib/validate');
const { STATUSES, setStatus, StockError } = require('../lib/orders');
const { STATUS_LABELS } = require('../lib/format');
const notify = require('../lib/notify');
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

// ---------- Acceso ----------
router.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null, meta: { title: 'Acceso', noindex: true } });
});

router.post('/admin/login', (req, res, next) => {
  const renderLogin = (error, status = 200) =>
    res.status(status).render('admin/login', { error, meta: { title: 'Acceso', noindex: true } });

  if (loginLimiter.blocked(req.ip)) {
    return renderLogin('Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', 429);
  }
  const expected = process.env.ADMIN_PASSWORD;
  const given = typeof req.body.password === 'string' ? req.body.password : '';
  if (!expected || !given || !safeEqual(given, expected)) {
    loginLimiter.hit(req.ip);
    return renderLogin('Contraseña incorrecta.', 401);
  }

  loginLimiter.reset(req.ip);
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
      "SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status IN ('paid', 'shipped')"
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const stats = {
      revenue: Number(revenue.total),
      pending: byStatus.pending || 0,
      toShip: byStatus.paid || 0,
      soldOut: products.filter((p) => p.active && p.stock <= 0).length,
      lowStock: products.filter((p) => p.active && p.stock > 0 && p.stock <= 2).length,
    };
    res.render('admin/dashboard', { products, stats, weakPassword: isWeak(), meta: { title: 'Panel', noindex: true } });
  })
);

// ---------- Productos ----------
async function renderForm(res, { product = null, form = null, errors = {}, error = null, status = 200 }) {
  const extras = product ? await extrasOf(product.id) : [];
  res.status(status).render('admin/product-form', {
    product,
    form,
    errors,
    error,
    extras,
    maxExtras: MAX_EXTRAS,
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
    if (!v.ok || error) return renderForm(res, { form: v.values, errors: v.errors, error, status: 400 });

    let coverPath;
    let extraPaths;
    try {
      validateFiles([cover, ...extras]);
      [coverPath, ...extraPaths] = await saveMany([cover, ...extras]);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return renderForm(res, { form: v.values, errors: v.errors, error: err.message, status: 400 });
    }

    const created = await db.run(
      `INSERT INTO products (title, description, price_cents, image_path, type, stock, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [v.values.title, v.values.description, v.price_cents, coverPath, v.values.type, v.stock]
    );
    await addExtras(created.lastInsertRowid, extraPaths);
    req.session.flash = { type: 'success', msg: `"${v.values.title}" publicado.` };
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
    const form = { ...v.values, active };
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
    req.session.flash = { type: 'success', msg: 'Cambios guardados.' };
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
