const express = require('express');
const db = require('../db');

const router = express.Router();

function getCart(req) {
  if (!req.session.cart) req.session.cart = {};
  return req.session.cart;
}

router.post('/agregar/:id', async (req, res) => {
  const product = await db.get(
    'SELECT * FROM products WHERE id = ? AND active = 1',
    [req.params.id]
  );
  if (!product) return res.status(404).send('Producto no encontrado');

  const cart = getCart(req);
  const id = String(product.id);
  cart[id] = (cart[id] || 0) + 1;

  res.redirect(req.get('Referer') || '/');
});

router.post('/quitar/:id', (req, res) => {
  const cart = getCart(req);
  delete cart[String(req.params.id)];
  res.redirect('/carrito');
});

router.post('/actualizar/:id', (req, res) => {
  const cart = getCart(req);
  const id = String(req.params.id);
  const qty = parseInt(req.body.quantity, 10);
  if (!qty || qty < 1) {
    delete cart[id];
  } else {
    cart[id] = qty;
  }
  res.redirect('/carrito');
});

router.get('/carrito', async (req, res) => {
  const cart = getCart(req);
  const ids = Object.keys(cart);

  let items = [];
  let total = 0;

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const products = await db.all(
      `SELECT * FROM products WHERE id IN (${placeholders})`,
      ids
    );

    items = products.map((p) => {
      const quantity = cart[String(p.id)];
      const subtotal = p.price_cents * quantity;
      total += subtotal;
      return { ...p, quantity, subtotal };
    });
  }

  res.render('cart', { items, total });
});

module.exports = router;
