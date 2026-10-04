const express = require('express');
const db = require('../db');
const { wrap, createLimiter } = require('../lib/security');
const { loadCart, createOrder, setStatus, StockError } = require('../lib/orders');
const { validateCheckout, allowedCountries, COUNTRY_NAMES } = require('../lib/validate');

const router = express.Router();

const stripeConfigured = !!(
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')
);
const stripe = stripeConfigured ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const orderLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
const TOKEN_RE = /^[a-f0-9]{32}$/;

function baseUrl(req) {
  return (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function renderCheckout(res, cart, values, errors, status = 200) {
  const countries = allowedCountries();
  res.status(status).render('checkout', {
    cart,
    values: { country: countries[0], ...values },
    errors,
    countries: countries.map((code) => ({ code, name: COUNTRY_NAMES[code] })),
    stripeConfigured,
    meta: { title: 'Datos de envío', noindex: true },
  });
}

router.get(
  '/checkout',
  wrap(async (req, res) => {
    const cart = await loadCart(req);
    if (!cart.items.length) return res.redirect('/carrito');
    renderCheckout(res, cart, {}, {});
  })
);

router.post(
  '/checkout/crear',
  orderLimiter.middleware('Has hecho demasiados pedidos seguidos. Espera un poco e inténtalo de nuevo.'),
  wrap(async (req, res) => {
    const cart = await loadCart(req);
    if (!cart.items.length) return res.redirect('/carrito');

    const { values, errors, ok } = validateCheckout(req.body);
    if (!ok) return renderCheckout(res, cart, values, errors, 400);

    let order;
    try {
      order = await createOrder({ cart: req.session.cart, customer: values });
    } catch (err) {
      if (err instanceof StockError) {
        req.session.flash = { type: 'error', msg: err.message };
        return res.redirect('/carrito');
      }
      throw err;
    }

    if (stripeConfigured) {
      try {
        const line_items = order.lines.map((l) => ({
          price_data: { currency: 'eur', product_data: { name: l.title }, unit_amount: l.price_cents },
          quantity: l.quantity,
        }));
        if (order.shipping > 0) {
          line_items.push({
            price_data: { currency: 'eur', product_data: { name: 'Envío' }, unit_amount: order.shipping },
            quantity: 1,
          });
        }
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: values.email,
          line_items,
          success_url: `${baseUrl(req)}/pedido/${order.token}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl(req)}/checkout/cancelado?token=${order.token}`,
          metadata: { order_id: String(order.id) },
        });
        await db.run('UPDATE orders SET stripe_session_id = ? WHERE id = ?', [session.id, order.id]);
        return res.redirect(303, session.url);
      } catch (err) {
        console.error('Error creando sesión de Stripe:', err.message);
        await setStatus(order.id, 'cancelled'); // libera el stock reservado
        req.session.flash = { type: 'error', msg: 'No se ha podido iniciar el pago con tarjeta. Inténtalo de nuevo.' };
        return res.redirect('/carrito');
      }
    }

    // Pago manual (Bizum / transferencia): el pedido queda pendiente hasta que se confirme.
    req.session.cart = {};
    res.redirect(`/pedido/${order.token}`);
  })
);

router.get(
  '/pedido/:token',
  wrap(async (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).render('error', { status: 404 });
    let order = await db.get('SELECT * FROM orders WHERE token = ?', [req.params.token]);
    if (!order) return res.status(404).render('error', { status: 404 });

    // Verificación del pago con Stripe: la sesión debe ser la de este pedido y el
    // importe cobrado debe coincidir exactamente.
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (stripeConfigured && sessionId && order.status === 'pending' && order.stripe_session_id) {
      try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        if (
          s.id === order.stripe_session_id &&
          s.payment_status === 'paid' &&
          s.metadata && String(s.metadata.order_id) === String(order.id) &&
          s.amount_total === Number(order.total_cents)
        ) {
          await setStatus(order.id, 'paid');
          req.session.cart = {};
          order = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
        }
      } catch (err) {
        console.error('Error verificando sesión de Stripe:', err.message);
      }
    }

    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    let shipTo = {};
    try {
      shipTo = JSON.parse(order.shipping_address || '{}');
    } catch (_) {
      /* sin datos */
    }

    res.set('Cache-Control', 'no-store');
    res.render('order', {
      order,
      items,
      shipTo,
      stripeConfigured,
      bankIban: process.env.BANK_IBAN || '',
      bizumPhone: process.env.BIZUM_PHONE || '',
      meta: { title: `Pedido #${order.id}`, noindex: true },
    });
  })
);

router.get(
  '/checkout/cancelado',
  wrap(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (TOKEN_RE.test(token)) {
      const order = await db.get('SELECT * FROM orders WHERE token = ?', [token]);
      if (order && order.status === 'pending' && order.stripe_session_id) {
        await setStatus(order.id, 'cancelled');
      }
    }
    req.session.flash = { type: 'info', msg: 'Pago cancelado. No se ha realizado ningún cargo y tu carrito sigue disponible.' };
    res.redirect('/carrito');
  })
);

module.exports = router;
