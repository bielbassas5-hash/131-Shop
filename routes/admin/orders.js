// Pedidos: listado, detalle, estados, exportacion CSV y avisos al cliente.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { text } = require('../../lib/validate');
const { STATUSES, setStatus, StockError } = require('../../lib/orders');
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
    const orders = await db.all(
      `SELECT * FROM orders ${estado ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 300`,
      estado ? [estado] : []
    );
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    res.render('admin/orders', {
      orders,
      estado,
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
    const header = ['Pedido', 'Fecha', 'Estado', 'Nombre', 'Email', 'Teléfono', 'Dirección', 'Ciudad', 'CP', 'País', 'Total EUR', 'Entrega', 'Notas', 'Seguimiento', 'Artículos'];
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
        o.shipping_method === 'pickup' ? 'Recogida' : 'Envío', s.notes, o.tracking_number, (byOrder.get(o.id) || []).join(' | '),
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
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    let shipTo = {};
    try {
      shipTo = JSON.parse(order.shipping_address || '{}');
    } catch (_) {
      /* sin datos */
    }
    const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
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
      shipTo,
      mailto,
      publicLink: link,
      statuses: STATUSES,
      mailConfigured: mailConfigured(),
      meta: { title: `Pedido #${order.id}`, noindex: true },
    });
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
