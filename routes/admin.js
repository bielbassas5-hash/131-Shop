const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { saveImage } = require('../lib/imageStorage');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten imagenes (png, jpg, webp, gif)'));
  },
});

router.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Contrasena incorrecta.' });
});

router.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

router.get('/admin', requireAdmin, async (req, res) => {
  const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
  res.render('admin/dashboard', { products });
});

router.get('/admin/productos/nuevo', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null, error: null });
});

router.post('/admin/productos/nuevo', requireAdmin, upload.single('image'), async (req, res) => {
  const { title, description, price, type, stock } = req.body;
  if (!title || !price) {
    return res.render('admin/product-form', {
      product: null,
      error: 'Titulo y precio son obligatorios.',
    });
  }
  const price_cents = Math.round(parseFloat(price) * 100);
  const image_path = await saveImage(req.file);

  await db.run(
    `INSERT INTO products (title, description, price_cents, image_path, type, stock, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [title, description || '', price_cents, image_path, type || 'sticker', parseInt(stock, 10) || 1]
  );

  res.redirect('/admin');
});

router.get('/admin/productos/:id/editar', requireAdmin, async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.status(404).render('404');
  res.render('admin/product-form', { product, error: null });
});

router.post(
  '/admin/productos/:id/editar',
  requireAdmin,
  upload.single('image'),
  async (req, res) => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).render('404');

    const { title, description, price, type, stock, active } = req.body;
    const price_cents = Math.round(parseFloat(price) * 100);
    const uploaded = await saveImage(req.file);
    const image_path = uploaded || product.image_path;

    await db.run(
      `UPDATE products
       SET title = ?, description = ?, price_cents = ?, image_path = ?, type = ?, stock = ?, active = ?
       WHERE id = ?`,
      [
        title,
        description || '',
        price_cents,
        image_path,
        type || 'sticker',
        parseInt(stock, 10) || 0,
        active ? 1 : 0,
        product.id,
      ]
    );

    res.redirect('/admin');
  }
);

router.post('/admin/productos/:id/eliminar', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
});

router.get('/admin/pedidos', requireAdmin, async (req, res) => {
  const orders = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
  res.render('admin/orders', { orders });
});

router.get('/admin/pedidos/:id', requireAdmin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).render('404');
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  res.render('admin/order-detail', { order, items });
});

router.post('/admin/pedidos/:id/estado', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).render('404');

  if (status === 'paid' && order.status !== 'paid') {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    for (const item of items) {
      if (item.product_id) {
        await db.run('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?', [
          item.quantity,
          item.product_id,
        ]);
      }
    }
  }

  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, order.id]);
  res.redirect(`/admin/pedidos/${order.id}`);
});

module.exports = router;
