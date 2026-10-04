// Panel: estadisticas y lista de puesta en marcha.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { paymentInfo, trackStock } = require('../../lib/orders');
const { stripeConfigured } = require('../../lib/payments');
const classify = require('../../lib/classify');
const { configured: mailConfigured } = require('../../lib/mailer');
const { isWeak } = require('./shared');

const router = express.Router();

// Lista de puesta en marcha: lo que falta configurar antes de vender de verdad.
function launchChecklist() {
  const e = process.env;
  const pay = paymentInfo();
  return [
    { ok: !isWeak(), label: 'Contraseña de administrador segura', hint: 'ADMIN_PASSWORD (12 caracteres o más)' },
    { ok: stripeConfigured || !!pay.bizum || !!pay.iban, label: 'Forma de cobro configurada (Bizum, IBAN real o Stripe)', hint: 'BIZUM_PHONE / BANK_IBAN' },
    { ok: !!e.CONTACT_EMAIL, label: 'Email de contacto visible en la web', hint: 'CONTACT_EMAIL' },
    { ok: !!(e.LEGAL_NAME && e.LEGAL_NIF && e.LEGAL_ADDRESS), label: 'Datos del titular en las páginas legales', hint: 'LEGAL_NAME, LEGAL_NIF, LEGAL_ADDRESS' },
    { ok: !!e.SITE_URL, label: 'Dirección pública de la web (para enlaces y SEO)', hint: 'SITE_URL' },
    { ok: mailConfigured() && !!e.OWNER_EMAIL, label: 'Avisos por email de pedidos nuevos (opcional)', hint: 'BREVO_API_KEY, MAIL_FROM, OWNER_EMAIL', optional: true },
    { ok: classify.aiEnabled(), label: 'Detección de temas con IA a partir de la imagen (opcional; sin ella se usan palabras del título)', hint: 'ANTHROPIC_API_KEY', optional: true },
    ...(trackStock() ? [] : [{ ok: !!e.LEAD_TIME, label: 'Plazo de elaboración que se muestra a los clientes (opcional)', hint: 'LEAD_TIME', optional: true }]),
  ];
}


// ---------- Panel ----------
router.get(
  '/admin',
  requireAdmin,
  wrap(async (req, res) => {
    const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    const revenue = await db.get(
      "SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status IN ('paid', 'production', 'shipped')"
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const stats = {
      revenue: Number(revenue.total),
      pending: byStatus.pending || 0,
      toShip: (byStatus.paid || 0) + (byStatus.production || 0),
      soldOut: trackStock() ? products.filter((p) => p.active && p.stock <= 0).length : 0,
      lowStock: trackStock() ? products.filter((p) => p.active && p.stock > 0 && p.stock <= 2).length : 0,
    };
    res.render('admin/dashboard', {
      products,
      stats,
      weakPassword: isWeak(),
      checklist: launchChecklist(),
      meta: { title: 'Panel', noindex: true },
    });
  })
);

// Copia de seguridad completa: catalogo, temas y pedidos (contiene datos personales: guardala en sitio seguro)
const BACKUP_TABLES = ['products', 'product_images', 'themes', 'product_themes', 'orders', 'order_items', 'order_events'];

router.get(
  '/admin/copia-seguridad.json',
  requireAdmin,
  wrap(async (req, res) => {
    const data = { generado: new Date().toISOString(), version: 1 };
    for (const table of BACKUP_TABLES) data[table] = await db.all(`SELECT * FROM ${table}`);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="copia-131-${data.generado.slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  })
);

module.exports = router;
