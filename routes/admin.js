const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAdmin, adminHeaders } = require('../middleware/auth');
const { saveImage, UserError } = require('../lib/imageStorage');
const { wrap, createLimiter, safeEqual } = require('../lib/security');
const { validateProduct, text } = require('../lib/validate');
const { STATUSES, setStatus, StockError } = require('../lib/orders');
const { STATUS_LABELS, TYPE_LABELS } = require('../lib/format');

const router = express.Router();
router.use('/admin', adminHeaders);

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const WEAK_PASSWORDS = ['arte131', 'admin', 'password', '123456', '131', 'contraseña'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// Multer sin romper el flujo: el error se guarda en req.uploadError y la ruta lo muestra.
function uploadImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera los 8 MB.' : 'No se ha podido leer la imagen.';
    }
    next();
  });
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
function renderForm(res, { product = null, form = null, errors = {}, error = null, status = 200 }) {
  res.status(status).render('admin/product-form', {
    product,
    form,
    errors,
    error,
    meta: { title: product ? 'Editar producto' : 'Nuevo producto', noindex: true },
  });
}

router.get('/admin/productos/nuevo', requireAdmin, (req, res) => renderForm(res, {}));

router.post(
  '/admin/productos/nuevo',
  requireAdmin,
  uploadImage,
  wrap(async (req, res) => {
    const v = validateProduct(req.body);
    let error = req.uploadError || null;
    if (!req.file && !error) error = 'Sube una imagen del producto.';
    if (!v.ok || error) return renderForm(res, { form: v.values, errors: v.errors, error, status: 400 });

    let image_path;
    try {
      image_path = await saveImage(req.file);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return renderForm(res, { form: v.values, errors: v.errors, error: err.message, status: 400 });
    }

    await db.run(
      `INSERT INTO products (title, description, price_cents, image_path, type, stock, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [v.values.title, v.values.description, v.price_cents, image_path, v.values.type, v.stock]
    );
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
    renderForm(res, { product });
  })
);

router.post(
  '/admin/productos/:id/editar',
  requireAdmin,
  uploadImage,
  wrap(async (req, res) => {
    const product = await findProduct(req);
    if (!product) return res.status(404).render('error', { status: 404 });

    const v = validateProduct(req.body);
    const active = req.body.active === '1';
    let error = req.uploadError || null;
    if (!v.ok || error) {
      return renderForm(res, { product, form: { ...v.values, active }, errors: v.errors, error, status: 400 });
    }

    let image_path = product.image_path;
    try {
      const uploaded = await saveImage(req.file);
      if (uploaded) image_path = uploaded;
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return renderForm(res, { product, form: { ...v.values, active }, errors: v.errors, error: err.message, status: 400 });
    }

    await db.run(
      `UPDATE products SET title = ?, description = ?, price_cents = ?, image_path = ?, type = ?, stock = ?, active = ?
       WHERE id = ?`,
      [v.values.title, v.values.description, v.price_cents, image_path, v.values.type, v.stock, active ? 1 : 0, product.id]
    );
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
      await db.run('DELETE FROM products WHERE id = ?', [product.id]);
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
    const header = ['Pedido', 'Fecha', 'Estado', 'Nombre', 'Email', 'Teléfono', 'Dirección', 'Ciudad', 'CP', 'País', 'Total EUR', 'Seguimiento', 'Artículos'];
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
        o.tracking_number, (byOrder.get(o.id) || []).join(' | '),
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
      await setStatus(Number(req.params.id), req.body.status, { tracking });
      req.session.flash = { type: 'success', msg: 'Pedido actualizado.' };
    } catch (err) {
      if (!(err instanceof StockError)) throw err;
      req.session.flash = { type: 'error', msg: err.message };
    }
    res.redirect(`/admin/pedidos/${req.params.id}`);
  })
);

module.exports = router;
