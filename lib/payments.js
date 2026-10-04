// Confirmacion de pagos con Stripe, compartida por la pagina de exito y el webhook.
const db = require('../db');
const { setStatus, StockError } = require('./orders');
const notify = require('./notify');

const stripeConfigured = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_'));
const stripe = stripeConfigured ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Marca el pedido como pagado SOLO si la sesion de Stripe es la de ese pedido y el
// importe cobrado coincide exactamente. Es idempotente (se puede llamar varias veces).
async function confirmSession(session, base) {
  if (!session || session.payment_status !== 'paid') return null;
  const order = await db.get('SELECT * FROM orders WHERE stripe_session_id = ?', [session.id]);
  if (!order) return null;
  if (
    !session.metadata ||
    String(session.metadata.order_id) !== String(order.id) ||
    session.amount_total !== Number(order.total_cents) ||
    session.currency !== 'eur'
  ) {
    console.error(`[pagos] Sesion ${session.id} no coincide con el pedido #${order.id}`);
    return null;
  }
  if (order.status === 'paid' || order.status === 'shipped') return order;

  try {
    await setStatus(order.id, 'paid');
  } catch (err) {
    if (!(err instanceof StockError)) throw err;
    // El cliente pago un pedido que ya habia caducado y el stock se ha vendido: aviso manual.
    console.error(`[pagos] Pago recibido del pedido #${order.id} ya cancelado y sin stock: revisar`);
    return null;
  }
  notify.paid(order.id, base);
  notify.ownerPaid(order.id, base);
  return db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
}

// Sesion caducada o abandonada: se libera el stock reservado.
async function expireSession(session) {
  if (!session) return;
  const order = await db.get('SELECT * FROM orders WHERE stripe_session_id = ?', [session.id]);
  if (order && order.status === 'pending') await setStatus(order.id, 'cancelled');
}

module.exports = { stripe, stripeConfigured, confirmSession, expireSession };
