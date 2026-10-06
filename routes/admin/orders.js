// Pedidos: listado, detalle, estados, exportacion CSV y avisos al cliente.
const express = require('express');
const { siteUrl } = require('../../lib/siteUrl');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { text, multiline } = require('../../lib/validate');
const { STATUSES, setStatus, orderEvents, StockError } = require('../../lib/orders');
const { STATUS_LABELS } = require('../../lib/format');
const notify = require('../../lib/notify');
const { configured: mailConfigured } = require('../../lib/mailer');

const router = express.Router();

// ---------- Pedidos ----------
router.get(
  '/admin/pedidos',
  requireAdmin,
  wrap(async (req, res) => {
    const estado = STATUSES.includes(req.query.estado) ? req.query.estado : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const where = [];
    const args = [];
    if (estado) {
      where.push('status = ?');
      args.push(estado);
    }
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(CAST(id AS TEXT) = ? OR customer_name LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\')");
      args.push(q.replace(/^#/, ''), like, like);
    }
    const orders = await db.all(
      `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 300`,
      args
    );
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    res.render('admin/orders', {
      orders,
      estado,
      q,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      meta: { title: 'Pedidos', noindex: true },
    });
  })
);

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyeccion de formulas en Excel
  return `"${s.replace(/"/g, '""')}"`;
}

router.get(
  '/admin/pedidos.csv',
  requireAdmin,
  wrap(async (req, res) => {
    const orders = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
    const items = await db.all('SELECT order_id, title, quantity FROM order_items');
    const byOrder = new Map();
    for (const it of items) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(`${it.quantity}x ${it.title}`);
    }
    const header = ['Pedido', 'Fecha', 'Estado', 'Nombre', 'Email', 'Teléfono', 'Dirección', 'Ciudad', 'CP', 'País', 'Total EUR', 'Entrega', 'Notas', 'Seguimiento', 'Artículos', 'Nota interna'];
    const rows = orders.map((o) => {
      let s = {};
      try {
        s = JSON.parse(o.shipping_address || '{}');
      } catch (_) {
        /* sin datos */
      }
      return [
        o.id, o.created_at, STATUS_LABELS[o.status] || o.status, s.name || o.customer_name, s.email || o.customer_email,
        s.phone, s.address, s.city, s.postal_code, s.country, (o.total_cents / 100).toFixed(2),
        o.shipping_method === 'pickup' ? 'Recogida' : 'Envío', s.notes, o.tracking_number, (byOrder.get(o.id) || []).join(' | '), o.admin_notes,
      ].map(csvCell).join(',');
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pedidos-131.csv"');
    res.send('﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n'));
  })
);

router.get(
  '/admin/pedidos/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).render('error', { status: 404 });
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).render('error', { status: 404 });
    const [items, events] = await Promise.all([
      db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]),
      orderEvents(order.id),
    ]);
    let shipTo = {};
    try {
      shipTo = JSON.parse(order.shipping_address || '{}');
    } catch (_) {
      /* sin datos */
    }
    const base = siteUrl(req);
    const link = `${base}/pedido/${order.token}`;
    const body =
      `Hola ${shipTo.name || ''},\n\nTu pedido #${order.id} ya está en camino.\n` +
      (order.tracking_number ? `Número de seguimiento: ${order.tracking_number}\n` : '') +
      `Puedes ver su estado aquí: ${link}\n\nGracias por tu compra!\n131`;
    const mailto = `mailto:${encodeURIComponent(order.customer_email || '')}?subject=${encodeURIComponent(
      `Tu pedido #${order.id} de 131`
    )}&body=${encodeURIComponent(body)}`;

    res.render('admin/order-detail', {
      order,
      items,
      events,
      shipTo,
      mailto,
      publicLink: link,
      statuses: STATUSES,
      mailConfigured: mailConfigured(),
      meta: { title: `Pedido #${order.id}`, noindex: true },
    });
  })
);

// Nota interna: solo la ve el administrador (nunca el cliente)
router.post(
  '/admin/pedidos/:id/nota',
  requireAdmin,
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).render('error', { status: 404 });
    const res1 = await db.run('UPDATE orders SET admin_notes = ? WHERE id = ?', [multiline(req.body.nota, 500) || null, Number(req.params.id)]);
    req.session.flash = res1.changes ? { type: 'success', msg: 'Nota guardada.' } : { type: 'error', msg: 'Pedido no encontrado.' };
    res.redirect(`/admin/pedidos/${req.params.id}`);
  })
);

router.post(
  '/admin/pedidos/:id/estado',
  requireAdmin,
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id) || !STATUSES.includes(req.body.status)) {
      return res.status(400).render('error', { status: 400, title: 'Petición no válida', message: 'Estado no válido.' });
    }
    const tracking = text(req.body.tracking, 40);
    try {
      const { previous } = await setStatus(Number(req.params.id), req.body.status, { tracking });
      if (req.body.notify === '1') {
        const base = res.locals.shop.siteUrl;
        const id = Number(req.params.id);
        if (req.body.status === 'paid' && previous === 'pending') notify.paid(id, base);
        if (req.body.status === 'production' && previous !== 'production') notify.production(id, base);
        if (req.body.status === 'shipped' && previous !== 'shipped') notify.shipped(id, base);
      }
      req.session.flash = { type: 'success', msg: 'Pedido actualizado.' };
    } catch (err) {
      if (!(err instanceof StockError)) throw err;
      req.session.flash = { type: 'error', msg: err.message };
    }
    res.redirect(`/admin/pedidos/${req.params.id}`);
  })
);

module.exports = router;
