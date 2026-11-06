// Panel: estadisticas y lista de puesta en marcha.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { paymentInfo, trackStock } = require('../../lib/orders');
const { stripeConfigured } = require('../../lib/payments');
const classify = require('../../lib/classify');
const { configured: mailConfigured } = require('../../lib/mailer');
const formats = require('../../lib/formats');
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
    const products = await db.all(
      'SELECT p.*, (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count FROM products p ORDER BY p.created_at DESC'
    );
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
    // Formatos activados cuya resolucion no llega (solo si se conoce el tamano del original)
    const byId = new Map(products.map((p) => [Number(p.id), p]));
    const lowQuality = {};
    for (const v of await db.all('SELECT product_id, label FROM product_variants')) {
      const preset = formats.presetOfLabel(v.label);
      const prod = byId.get(Number(v.product_id));
      if (!preset || !prod || !prod.source_width) continue;
      const a = formats.assess({ width: Number(prod.source_width), height: Number(prod.source_height) }, preset);
      if (a && a.level === 'baja') (lowQuality[prod.id] = lowQuality[prod.id] || []).push(`${preset.id} (${a.ppp} ppp)`);
    }

    // Recordatorio de copia de seguridad: nunca hecha o de hace mas de 30 dias (si ya hay datos que perder)
    const last = await db.get("SELECT value FROM settings WHERE key = 'last_backup'");
    const lastMs = last && Date.parse(last.value);
    const backupDays = lastMs ? Math.floor((Date.now() - lastMs) / 86400000) : null;
    const hasData = products.length > 0 || counts.length > 0;
    const backupDue = hasData && (backupDays === null || backupDays > 30);

    res.render('admin/dashboard', {
      products,
      lowQuality,
      backupDue,
      backupDays,
      stats,
      weakPassword: isWeak(),
      checklist: launchChecklist(),
      meta: { title: 'Panel', noindex: true },
    });
  })
);

// Copia de seguridad completa: catalogo, temas y pedidos (contiene datos personales: guardala en sitio seguro)
const BACKUP_TABLES = ['products', 'product_images', 'product_variants', 'themes', 'product_themes', 'orders', 'order_items', 'order_events'];
const BACKUP_SETTINGS_SKIP = ['last_login']; // la IP del ultimo acceso no hace falta en la copia

router.get(
  '/admin/copia-seguridad.json',
  requireAdmin,
  wrap(async (req, res) => {
    const data = { generado: new Date().toISOString(), version: 1 };
    for (const table of BACKUP_TABLES) data[table] = await db.all(`SELECT * FROM ${table}`);
    data.settings = (await db.all('SELECT key, value FROM settings')).filter((s) => !BACKUP_SETTINGS_SKIP.includes(s.key));
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_backup', ?)", [data.generado]);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="copia-131-${data.generado.slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  })
);

module.exports = router;
