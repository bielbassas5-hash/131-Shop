const express = require('express');
const db = require('../db');
const { wrap, createLimiter } = require('../lib/security');
const { loadCart, parseKey, trackStock, MAX_PER_LINE } = require('../lib/orders');
const { variantsOf } = require('../lib/variants');

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

const parseId = (value) => (/^\d{1,9}$/.test(String(value)) ? String(parseInt(value, 10)) : null);
// Clave de linea valida ("12" o "12:5") o null
const lineKey = (value) => {
  const pk = parseKey(value);
  return pk ? pk.key : null;
};

router.post(
  '/agregar/:id',
  cartLimiter.middleware(),
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const back = safeBack(req.body.back, '/');
    const product = id && (await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [id]));
    if (!product) return res.status(404).render('error', { status: 404 });

    // Si el producto tiene formatos hay que elegir uno (y debe ser de ESTE producto)
    const options = await variantsOf(product.id);
    let variant = null;
    if (options.length) {
      const wanted = parseId(req.body.variant);
      variant = wanted ? options.find((v) => String(v.id) === wanted) || null : null;
      if (!variant) {
        req.session.flash = { type: 'error', msg: 'Elige un formato antes de añadir al carrito.' };
        return res.redirect(back);
      }
    }
    const key = variant ? `${id}:${variant.id}` : id;
    const name = variant ? `${product.title} · ${variant.label}` : product.title;

    const cart = getCart(req);
    const current = cart[key] || 0;
    const limit = trackStock() ? Math.min(product.stock, MAX_PER_LINE) : MAX_PER_LINE;

    if (trackStock() && product.stock <= 0) {
      req.session.flash = { type: 'error', msg: `"${product.title}" está agotado.` };
    } else if (current >= limit) {
      req.session.flash = { type: 'info', msg: `Ya tienes el máximo disponible de "${name}" en el carrito.` };
    } else {
      cart[key] = current + 1;
      req.session.flash = { type: 'success', msg: `"${name}" añadido al carrito.`, cta: true };
    }
    res.redirect(back);
  })
);

router.post('/quitar/:key', (req, res) => {
  const key = lineKey(req.params.key);
  if (key && req.session.cart) delete req.session.cart[key];
  res.redirect('/carrito');
});

router.post(
  '/actualizar/:key',
  wrap(async (req, res) => {
    const key = lineKey(req.params.key);
    const cart = getCart(req);
    if (key && cart[key] !== undefined) {
      const qty = parseInt(req.body.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        delete cart[key];
      } else {
        cart[key] = Math.min(qty, MAX_PER_LINE); // loadCart lo ajusta luego al limite real
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
