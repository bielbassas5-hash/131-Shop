const crypto = require('crypto');
const db = require('../db');

const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];
const MAX_PER_LINE = 10;

class StockError extends Error {}

// Por defecto la tienda trabaja BAJO DEMANDA: sin unidades ni "agotado".
// TRACK_STOCK=1 reactiva el control de stock (reserva al pedir, devolucion al cancelar).
const trackStock = () => process.env.TRACK_STOCK === '1';

function shippingCost() {
  const n = parseInt(process.env.SHIPPING_COST_CENTS || '350', 10);
  return Number.isFinite(n) && n >= 0 ? n : 350;
}

function freeShippingThreshold() {
  const n = parseInt(process.env.FREE_SHIPPING_THRESHOLD_CENTS || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Datos de cobro manual. Un IBAN de ejemplo (digitos de control 00) nunca se muestra.
function paymentInfo() {
  const iban = (process.env.BANK_IBAN || '').trim();
  const realIban = /^[A-Za-z]{2}\d{2}[A-Za-z0-9 ]{10,}$/.test(iban) && !/^[A-Za-z]{2}00/.test(iban) ? iban : '';
  return { bizum: (process.env.BIZUM_PHONE || '').trim(), iban: realIban };
}

function pickupEnabled() {
  return process.env.PICKUP_ENABLED === '1';
}

function shippingFor(subtotal, method = 'ship') {
  if (method === 'pickup' && pickupEnabled()) return 0;
  const threshold = freeShippingThreshold();
  if (threshold && subtotal >= threshold) return 0;
  return shippingCost();
}

// Carrito de la sesión -> lineas validadas contra la base de datos.
// Elimina productos ocultos/agotados y recorta cantidades al stock disponible.
async function loadCart(req) {
  const raw = (req.session && req.session.cart) || {};
  const ids = Object.keys(raw)
    .filter((k) => /^\d+$/.test(k))
    .slice(0, 30);

  const cleaned = {};
  const items = [];
  let changed = ids.length !== Object.keys(raw).length;

  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const products = await db.all(
      `SELECT * FROM products WHERE active = 1 AND id IN (${placeholders}) ORDER BY id`,
      ids
    );
    const byId = new Map(products.map((p) => [String(p.id), p]));
    for (const id of ids) {
      const p = byId.get(id);
      if (!p || (trackStock() && p.stock <= 0)) {
        changed = true;
        continue;
      }
      const cap = trackStock() ? Math.min(p.stock, MAX_PER_LINE) : MAX_PER_LINE;
      const qty = Math.max(1, Math.min(parseInt(raw[id], 10) || 1, cap));
      if (qty !== raw[id]) changed = true;
      cleaned[id] = qty;
      items.push({ ...p, quantity: qty, subtotal: p.price_cents * qty });
    }
  }

  if (changed && req.session) req.session.cart = cleaned;

  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const shipping = items.length ? shippingFor(subtotal) : 0;
  const threshold = freeShippingThreshold();
  return {
    items,
    subtotal,
    shipping,
    total: subtotal + shipping,
    changed,
    freeShippingLeft: threshold && items.length && subtotal < threshold ? threshold - subtotal : 0,
  };
}

// Crea el pedido reservando el stock de forma atomica: o se reserva todo o nada.
// Los precios se leen otra vez dentro de la transaccion (nunca del cliente).
async function createOrder({ cart, customer }) {
  return db.transaction(async (tx) => {
    const lines = [];
    let subtotal = 0;

    for (const [id, wanted] of Object.entries(cart)) {
      const p = await tx.get('SELECT * FROM products WHERE id = ? AND active = 1', [id]);
      const qty = Math.min(parseInt(wanted, 10) || 0, MAX_PER_LINE);
      if (!p || qty < 1) throw new StockError('Un producto de tu carrito ya no está disponible.');
      if (trackStock()) {
        const res = await tx.run(
          'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
          [qty, p.id, qty]
        );
        if (res.changes !== 1) throw new StockError(`"${p.title}" se ha agotado o no hay unidades suficientes.`);
      }
      lines.push({ id: p.id, title: p.title, price_cents: p.price_cents, quantity: qty });
      subtotal += p.price_cents * qty;
    }
    if (!lines.length) throw new StockError('Tu carrito está vacío.');

    const method = customer.method === 'pickup' && pickupEnabled() ? 'pickup' : 'ship';
    const shipping = shippingFor(subtotal, method);
    const total = subtotal + shipping;
    const token = crypto.randomBytes(16).toString('hex');

    const order = await tx.run(
      `INSERT INTO orders (token, customer_email, customer_name, shipping_address, total_cents, shipping_cents, shipping_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [token, customer.email, customer.name, JSON.stringify(customer), total, shipping, method]
    );
    for (const l of lines) {
      await tx.run(
        'INSERT INTO order_items (order_id, product_id, title, price_cents, quantity) VALUES (?, ?, ?, ?, ?)',
        [order.lastInsertRowid, l.id, l.title, l.price_cents, l.quantity]
      );
    }
    return { id: order.lastInsertRowid, token, total, subtotal, shipping, lines };
  });
}

// Cambia el estado. El stock queda reservado mientras el pedido no este cancelado:
// al cancelar se devuelve, y si se reabre se vuelve a reservar (si queda stock).
async function setStatus(orderId, status, { tracking } = {}) {
  if (!STATUSES.includes(status)) throw new Error('Estado no válido');
  return db.transaction(async (tx) => {
    const order = await tx.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) throw new Error('Pedido no encontrado');

    if (trackStock() && order.status !== status) {
      const items = await tx.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
      if (status === 'cancelled') {
        for (const it of items) {
          if (it.product_id) {
            await tx.run('UPDATE products SET stock = stock + ? WHERE id = ?', [it.quantity, it.product_id]);
          }
        }
      } else if (order.status === 'cancelled') {
        for (const it of items) {
          if (!it.product_id) continue;
          const res = await tx.run(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
            [it.quantity, it.product_id, it.quantity]
          );
          if (res.changes !== 1) throw new StockError(`No queda stock suficiente de "${it.title}" para reabrir el pedido.`);
        }
      }
    }

    const track = tracking !== undefined ? tracking : order.tracking_number;
    await tx.run('UPDATE orders SET status = ?, tracking_number = ? WHERE id = ?', [status, track || null, orderId]);
    return { previous: order.status };
  });
}

// Libera el stock de pedidos que llevan demasiado tiempo sin pagarse.
async function expirePending(days) {
  const rows = await db.all(
    "SELECT id FROM orders WHERE status = 'pending' AND created_at < datetime('now', ?)",
    [`-${Math.max(1, Math.floor(days))} days`]
  );
  for (const r of rows) await setStatus(r.id, 'cancelled');
  return rows.length;
}

module.exports = {
  STATUSES,
  MAX_PER_LINE,
  StockError,
  trackStock,
  shippingCost,
  freeShippingThreshold,
  shippingFor,
  pickupEnabled,
  paymentInfo,
  loadCart,
  createOrder,
  setStatus,
  expirePending,
};
