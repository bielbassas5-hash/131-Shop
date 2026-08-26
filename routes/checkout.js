const express = require('express');
const db = require('../db');

const router = express.Router();

const stripeConfigured = !!(
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')
);
const stripe = stripeConfigured ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const SHIPPING_COST_CENTS = parseInt(process.env.SHIPPING_COST_CENTS || '350', 10);

async function decrementStock(orderId) {
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  for (const item of items) {
    if (item.product_id) {
      await db.run('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?', [
        item.quantity,
        item.product_id,
      ]);
    }
  }
}

async function getCartItems(req) {
  const cart = req.session.cart || {};
  const ids = Object.keys(cart);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const products = await db.all(
    `SELECT * FROM products WHERE id IN (${placeholders}) AND active = 1`,
    ids
  );

  return products.map((p) => ({ ...p, quantity: cart[String(p.id)] }));
}

router.get('/checkout', async (req, res) => {
  const items = await getCartItems(req);
  if (items.length === 0) return res.redirect('/carrito');

  const subtotal = items.reduce((sum, i) => sum + i.price_cents * i.quantity, 0);
  const total = subtotal + SHIPPING_COST_CENTS;

  res.render('checkout', {
    items,
    subtotal,
    shipping: SHIPPING_COST_CENTS,
    total,
    stripeConfigured,
  });
});

router.post('/checkout/crear', async (req, res) => {
  const items = await getCartItems(req);
  if (items.length === 0) return res.redirect('/carrito');

  const { name, email, address, city, postal_code, country } = req.body;
  if (!name || !email || !address || !city || !postal_code) {
    return res.status(400).send('Faltan datos de envio.');
  }

  const subtotal = items.reduce((sum, i) => sum + i.price_cents * i.quantity, 0);
  const total = subtotal + SHIPPING_COST_CENTS;

  const shippingInfo = { name, email, address, city, postal_code, country: country || 'ES' };

  const orderResult = await db.run(
    `INSERT INTO orders (customer_email, customer_name, shipping_address, total_cents, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [email, name, JSON.stringify(shippingInfo), total]
  );
  const orderId = orderResult.lastInsertRowid;

  for (const item of items) {
    await db.run(
      `INSERT INTO order_items (order_id, product_id, title, price_cents, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, item.id, item.title, item.price_cents, item.quantity]
    );
  }

  if (stripeConfigured) {
    try {
      const line_items = items.map((item) => ({
        price_data: {
          currency: 'eur',
          product_data: { name: item.title },
          unit_amount: item.price_cents,
        },
        quantity: item.quantity,
      }));
      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Envio' },
          unit_amount: SHIPPING_COST_CENTS,
        },
        quantity: 1,
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: email,
        line_items,
        success_url: `${req.protocol}://${req.get('host')}/checkout/exito?order_id=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.protocol}://${req.get('host')}/checkout/cancelado?order_id=${orderId}`,
        metadata: { order_id: String(orderId) },
      });

      await db.run('UPDATE orders SET stripe_session_id = ? WHERE id = ?', [session.id, orderId]);
      return res.redirect(303, session.url);
    } catch (err) {
      console.error('Error creando sesion de Stripe:', err);
      return res.status(500).send('Error al conectar con Stripe. Revisa tu STRIPE_SECRET_KEY.');
    }
  }

  // Sin Stripe: pago manual por transferencia/Bizum. El pedido queda "pending"
  // hasta que confirmes el ingreso a mano desde el panel de admin.
  req.session.cart = {};
  return res.redirect(`/checkout/exito?order_id=${orderId}`);
});

router.get('/checkout/exito', async (req, res) => {
  const { order_id, session_id } = req.query;
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [order_id]);
  if (!order) return res.status(404).render('404');

  if (stripeConfigured && session_id && order.status !== 'paid') {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') {
        await db.run("UPDATE orders SET status = 'paid' WHERE id = ?", [order.id]);
        await decrementStock(order.id);
        req.session.cart = {};
        order.status = 'paid';
      }
    } catch (err) {
      console.error('Error verificando sesion de Stripe:', err);
    }
  }

  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  res.render('checkout-success', {
    order,
    items,
    stripeConfigured,
    bankIban: process.env.BANK_IBAN || '',
    bizumPhone: process.env.BIZUM_PHONE || '',
  });
});

router.get('/checkout/cancelado', (req, res) => {
  res.render('checkout-cancel');
});

module.exports = router;
