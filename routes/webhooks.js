const express = require('express');
const { siteUrl } = require('../lib/siteUrl');
const { stripe, stripeConfigured, confirmSession, expireSession } = require('../lib/payments');

const router = express.Router();

// Webhook de Stripe. Necesita el cuerpo SIN parsear para verificar la firma, por eso
// se monta antes de los parsers, la sesion y el CSRF (la autenticidad la da la firma).
router.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeConfigured || !secret) return res.status(404).end();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', secret);
  } catch (err) {
    return res.status(400).send('Firma no valida');
  }

  try {
    const base = siteUrl(req);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await confirmSession(event.data.object, base);
    } else if (event.type === 'checkout.session.expired') {
      await expireSession(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] error procesando evento:', err.message);
    res.status(500).end(); // Stripe reintentara
  }
});

module.exports = router;
