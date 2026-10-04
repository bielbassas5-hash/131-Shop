const express = require('express');
const db = require('../db');
const { wrap } = require('../lib/security');
const { TYPES, TYPE_LABELS, TYPE_PLURALS } = require('../lib/format');
const { extrasOf } = require('../lib/productImages');
const themesLib = require('../lib/themes');
const { trackStock } = require('../lib/orders');

const router = express.Router();

const SORTS = {
  nuevo: 'created_at DESC',
  precio_asc: 'price_cents ASC',
  precio_desc: 'price_cents DESC',
};

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

// Catalogo con filtros. `theme` (opcional) agrupa solo los productos de ese tema.
async function renderCatalog(req, res, theme) {
  const tipo = TYPES.includes(req.query.tipo) ? req.query.tipo : '';
  const orden = SORTS[req.query.orden] ? req.query.orden : 'nuevo';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';

  const where = ['active = 1'];
  const args = [];
  if (theme) {
    where.push('EXISTS (SELECT 1 FROM product_themes pt WHERE pt.product_id = products.id AND pt.theme_id = ?)');
    args.push(theme.id);
  }
  if (tipo) {
    where.push('type = ?');
    args.push(tipo);
  }
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like);
  }

  const [products, themes] = await Promise.all([
    db.all(
    `SELECT * FROM products WHERE ${where.join(' AND ')}
     ORDER BY ${trackStock() ? '(stock > 0) DESC,' : ''} ${SORTS[orden]} LIMIT 120`,
    args
    ),
    themesLib.publicThemes(),
  ]);

  res.render('index', {
    products,
    theme,
    themes,
    filters: { tipo, orden, q, tema: theme ? theme.slug : '' },
    meta: {
      title: theme ? theme.name : tipo ? TYPE_PLURALS[tipo] : 'Tienda',
      description: theme ? `${theme.name}: dibujos, prints y stickers de 131.` : 'Dibujos, prints y stickers de 131.',
      noindex: !!theme && products.length === 0, // un tema vacio no es contenido para buscadores
    },
  });
}

router.get('/', wrap((req, res) => renderCatalog(req, res, null)));

router.get(
  '/tema/:slug',
  wrap(async (req, res) => {
    const theme = SLUG_RE.test(req.params.slug) ? await themesLib.themeBySlug(req.params.slug) : null;
    if (!theme) return res.status(404).render('error', { status: 404 });
    return renderCatalog(req, res, theme);
  })
);

// Vista agrupada: cada tema con sus productos
router.get(
  '/temas',
  wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT p.*, t.id AS theme_id, t.name AS theme_name, t.slug AS theme_slug
       FROM products p
       JOIN product_themes pt ON pt.product_id = p.id
       JOIN themes t ON t.id = pt.theme_id
       WHERE p.active = 1
       ORDER BY t.name COLLATE NOCASE, ${trackStock() ? '(p.stock > 0) DESC,' : ''} p.created_at DESC`
    );
    const groups = [];
    const byId = new Map();
    for (const r of rows) {
      let g = byId.get(r.theme_id);
      if (!g) {
        g = { name: r.theme_name, slug: r.theme_slug, total: 0, products: [] };
        byId.set(r.theme_id, g);
        groups.push(g);
      }
      g.total += 1;
      if (g.products.length < 8) g.products.push(r);
    }
    res.render('themes', {
      groups,
      meta: { title: 'Temas', description: 'Dibujos, prints y stickers de 131 agrupados por tema.' },
    });
  })
);

router.get(
  '/producto/:id',
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).render('error', { status: 404 });
    const product = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [req.params.id]);
    if (!product) return res.status(404).render('error', { status: 404 });

    // Relacionados: primero los que comparten tema, luego el mismo tipo
    const relatedQuery = db.all(
      `SELECT * FROM products p WHERE p.active = 1 ${trackStock() ? 'AND p.stock > 0' : ''} AND p.id != ?
       ORDER BY (SELECT COUNT(*) FROM product_themes a JOIN product_themes b ON a.theme_id = b.theme_id
                 WHERE a.product_id = p.id AND b.product_id = ?) DESC,
                (p.type = ?) DESC, p.created_at DESC LIMIT 4`,
      [product.id, product.id, product.type]
    );
    const [productThemes, related, extras] = await Promise.all([
      themesLib.themesOf(product.id),
      relatedQuery,
      extrasOf(product.id),
    ]);
    const gallery = [product.image_path, ...extras.map((e) => e.image_path)].filter(Boolean);

    res.render('product', {
      product,
      productThemes,
      related,
      gallery,
      meta: {
        title: product.title,
        description: (product.description || '').replace(/\s+/g, ' ').slice(0, 155) ||
          `${product.title} - ${TYPE_LABELS[product.type] || 'Producto'} de 131.`,
        image: product.image_path,
        type: 'product',
      },
    });
  })
);

// ---- Paginas legales ----
const LEGAL = {
  privacidad: 'Política de privacidad',
  condiciones: 'Condiciones de compra y devoluciones',
  'aviso-legal': 'Aviso legal',
};

router.get('/legal/:page', (req, res) => {
  const title = LEGAL[req.params.page];
  if (!title) return res.status(404).render('error', { status: 404 });
  res.render(`legal/${req.params.page}`, { meta: { title, description: title } });
});

// ---- SEO / infraestructura ----
function siteUrl(req) {
  return (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nDisallow: /admin\nDisallow: /pedido/\nDisallow: /carrito\nDisallow: /checkout\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`
  );
});

router.get(
  '/sitemap.xml',
  wrap(async (req, res) => {
    const base = siteUrl(req);
    const products = await db.all('SELECT id, created_at FROM products WHERE active = 1');
    const themes = await themesLib.publicThemes();
    const urls = [`<url><loc>${base}/</loc></url>`, `<url><loc>${base}/temas</loc></url>`]
      .concat(themes.map((t) => `<url><loc>${base}/tema/${t.slug}</loc></url>`))
      .concat(products.map((p) => `<url><loc>${base}/producto/${p.id}</loc></url>`));
    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  })
);

router.get('/healthz', wrap(async (req, res) => {
  await db.get('SELECT 1 AS ok');
  res.json({ ok: true });
}));

module.exports = router;
