const express = require('express');
const db = require('../db');
const { wrap, createLimiter } = require('../lib/security');
const { loadCart, MAX_PER_LINE } = require('../lib/orders');

const router = express.Router();
const cartLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 120 });

// Solo se permiten rutas internas (evita redirecciones abiertas).
function safeBack(value, fallback) {
  return typeof value === 'string' && /^\/(?![/\\])[\w\-./?=&%]*$/.test(value) ? value : fallback;
}

function getCart(req) {
  if (!req.session.cart) req.session.cart = {};
  return req.session.cart;
}

function parseId(value) {
  return /^\d{1,9}$/.test(String(value)) ? String(parseInt(value, 10)) : null;
}

router.post(
  '/agregar/:id',
  cartLimiter.middleware(),
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const back = safeBack(req.body.back, '/');
    const product = id && (await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [id]));
    if (!product) return res.status(404).render('error', { status: 404 });

    const cart = getCart(req);
    const current = cart[id] || 0;
    const limit = Math.min(product.stock, MAX_PER_LINE);

    if (product.stock <= 0) {
      req.session.flash = { type: 'error', msg: `"${product.title}" está agotado.` };
    } else if (current >= limit) {
      req.session.flash = { type: 'info', msg: `Ya tienes el máximo disponible de "${product.title}" en el carrito.` };
    } else {
      cart[id] = current + 1;
      req.session.flash = { type: 'success', msg: `"${product.title}" añadido al carrito.`, cta: true };
    }
    res.redirect(back);
  })
);

router.post('/quitar/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id && req.session.cart) delete req.session.cart[id];
  res.redirect('/carrito');
});

router.post(
  '/actualizar/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const cart = getCart(req);
    if (id && cart[id] !== undefined) {
      const qty = parseInt(req.body.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        delete cart[id];
      } else {
        cart[id] = Math.min(qty, MAX_PER_LINE); // loadCart ajusta luego al stock real
      }
    }
    res.redirect('/carrito');
  })
);

router.get(
  '/carrito',
  wrap(async (req, res) => {
    const cart = await loadCart(req);
    if (cart.changed && !res.locals.flash) {
      res.locals.flash = { type: 'info', msg: 'Hemos ajustado tu carrito a la disponibilidad actual.' };
    }
    res.render('cart', { cart, meta: { title: 'Carrito', noindex: true } });
  })
);

module.exports = router;
