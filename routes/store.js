const express = require('express');
const db = require('../db');
const { wrap } = require('../lib/security');
const { TYPES, TYPE_LABELS, TYPE_PLURALS } = require('../lib/format');
const { extrasOf } = require('../lib/productImages');

const router = express.Router();

const SORTS = {
  nuevo: 'created_at DESC',
  precio_asc: 'price_cents ASC',
  precio_desc: 'price_cents DESC',
};

router.get(
  '/',
  wrap(async (req, res) => {
    const tipo = TYPES.includes(req.query.tipo) ? req.query.tipo : '';
    const orden = SORTS[req.query.orden] ? req.query.orden : 'nuevo';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';

    const where = ['active = 1'];
    const args = [];
    if (tipo) {
      where.push('type = ?');
      args.push(tipo);
    }
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like);
    }

    const products = await db.all(
      `SELECT * FROM products WHERE ${where.join(' AND ')}
       ORDER BY (stock > 0) DESC, ${SORTS[orden]} LIMIT 120`,
      args
    );

    res.render('index', {
      products,
      filters: { tipo, orden, q },
      meta: {
        title: tipo ? TYPE_PLURALS[tipo] : 'Tienda',
        description:
          'Dibujos, prints y stickers de 131.',
      },
    });
  })
);

router.get(
  '/producto/:id',
  wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).render('error', { status: 404 });
    const product = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [req.params.id]);
    if (!product) return res.status(404).render('error', { status: 404 });

    const related = await db.all(
      `SELECT * FROM products WHERE active = 1 AND stock > 0 AND id != ?
       ORDER BY (type = ?) DESC, created_at DESC LIMIT 4`,
      [product.id, product.type]
    );

    const extras = await extrasOf(product.id);
    const gallery = [product.image_path, ...extras.map((e) => e.image_path)].filter(Boolean);

    res.render('product', {
      product,
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
    const urls = [`<url><loc>${base}/</loc></url>`].concat(
      products.map((p) => `<url><loc>${base}/producto/${p.id}</loc></url>`)
    );
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
