const crypto = require('crypto');
const db = require('../db');
const { variantsOfMany } = require('./variants');

const STATUSES = ['pending', 'paid', 'production', 'shipped', 'cancelled'];
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

// Clave de una linea del carrito: "12" (producto sin formatos) o "12:5" (producto 12, formato 5)
const KEY_RE = /^(\d{1,9})(?::(\d{1,9}))?$/;
function parseKey(key) {
  const m = KEY_RE.exec(String(key));
  return m ? { key: m[0], productId: Number(m[1]), variantId: m[2] ? Number(m[2]) : null } : null;
}

// Carrito de la sesión -> lineas validadas contra la base de datos.
// Elimina productos ocultos/agotados o formatos que ya no existen, y recorta cantidades.
async function loadCart(req) {
  const raw = (req.session && req.session.cart) || {};
  const rawKeys = Object.keys(raw);
  const entries = rawKeys.map(parseKey).filter(Boolean).slice(0, 30);

  const cleaned = {};
  const items = [];
  let changed = entries.length !== rawKeys.length;

  if (entries.length) {
    const ids = [...new Set(entries.map((e) => e.productId))];
    const [products, variantsByProduct] = await Promise.all([
      db.all(`SELECT * FROM products WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids),
      variantsOfMany(ids),
    ]);
    const byId = new Map(products.map((p) => [Number(p.id), p]));
    for (const e of entries) {
      const p = byId.get(e.productId);
      if (!p || (trackStock() && p.stock <= 0)) {
        changed = true;
        continue;
      }
      const options = variantsByProduct.get(e.productId) || [];
      let variant = null;
      if (options.length) {
        variant = options.find((v) => Number(v.id) === e.variantId) || null;
        if (!variant) {
          changed = true; // hay que elegir un formato valido
          continue;
        }
      } else if (e.variantId) {
        changed = true;
        continue;
      }
      const cap = trackStock() ? Math.min(p.stock, MAX_PER_LINE) : MAX_PER_LINE;
      const qty = Math.max(1, Math.min(parseInt(raw[e.key], 10) || 1, cap));
      if (qty !== raw[e.key]) changed = true;
      cleaned[e.key] = qty;
      const unit = variant ? variant.price_cents : p.price_cents;
      items.push({
        ...p,
        key: e.key,
        variant,
        price_cents: unit,
        display: variant ? `${p.title} · ${variant.label}` : p.title,
        quantity: qty,
        subtotal: unit * qty,
      });
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

// Crea el pedido (y reserva el stock si se controla) de forma atomica: o se hace todo o nada.
// Los precios y formatos se leen otra vez dentro de la transaccion (nunca del cliente).
async function createOrder({ cart, customer }) {
  return db.transaction(async (tx) => {
    const lines = [];
    let subtotal = 0;

    for (const [key, wanted] of Object.entries(cart)) {
      const pk = parseKey(key);
      const p = pk && (await tx.get('SELECT * FROM products WHERE id = ? AND active = 1', [pk.productId]));
      const qty = Math.min(parseInt(wanted, 10) || 0, MAX_PER_LINE);
      if (!p || qty < 1) throw new StockError('Un producto de tu carrito ya no está disponible.');

      const options = await tx.all('SELECT id, label, price_cents FROM product_variants WHERE product_id = ? ORDER BY position, id', [p.id]);
      let unit = p.price_cents;
      let title = p.title;
      if (options.length) {
        const variant = options.find((v) => Number(v.id) === pk.variantId);
        if (!variant) throw new StockError(`El formato de "${p.title}" ya no está disponible.`);
        unit = variant.price_cents;
        title = `${p.title} · ${variant.label}`;
      } else if (pk.variantId) {
        throw new StockError(`El formato de "${p.title}" ya no está disponible.`);
      }

      if (trackStock()) {
        const res = await tx.run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [qty, p.id, qty]);
        if (res.changes !== 1) throw new StockError(`"${p.title}" se ha agotado o no hay unidades suficientes.`);
      }
      lines.push({ id: p.id, title, price_cents: unit, quantity: qty });
      subtotal += unit * qty;
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
    await tx.run("INSERT INTO order_events (order_id, status) VALUES (?, 'pending')", [order.lastInsertRowid]);
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
    if (order.status !== status) await tx.run('INSERT INTO order_events (order_id, status) VALUES (?, ?)', [orderId, status]);
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

const orderEvents = (orderId) =>
  db.all('SELECT status, created_at FROM order_events WHERE order_id = ? ORDER BY id', [orderId]);

module.exports = {
  orderEvents,
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
  parseKey,
  createOrder,
  setStatus,
  expirePending,
};
