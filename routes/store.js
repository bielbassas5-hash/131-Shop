const express = require('express');
const { siteUrl } = require('../lib/siteUrl');
const db = require('../db');
const { wrap } = require('../lib/security');
const { TYPES, TYPE_LABELS, TYPE_PLURALS } = require('../lib/format');
const { extrasOf } = require('../lib/productImages');
const { variantsOf } = require('../lib/variants');
const themesLib = require('../lib/themes');
const { trackStock } = require('../lib/orders');
const { parseDetails, skuOf } = require('../lib/details');
const { buildFaq } = require('../lib/faq');
const siteSettings = require('../lib/siteSettings');
const { slugOf } = db;

const router = express.Router();

const SORTS = {
  nuevo: 'created_at DESC',
  precio_asc: 'price_cents ASC',
  precio_desc: 'price_cents DESC',
};

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

// Primera imagen extra del producto: se muestra al pasar el raton por la tarjeta
const hoverImage = (alias) =>
  `(SELECT x.image_path FROM product_images x WHERE x.product_id = ${alias}.id ORDER BY x.position, x.id LIMIT 1) AS hover_image,
   (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = ${alias}.id) AS variant_count`;

// Catalogo con filtros. `theme` (opcional) agrupa solo los productos de ese tema.
async function renderCatalog(req, res, theme) {
  const tipo = TYPES.includes(req.query.tipo) ? req.query.tipo : '';
  const orden = typeof req.query.orden === 'string' && Object.hasOwn(SORTS, req.query.orden) ? req.query.orden : 'nuevo';
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
    `SELECT products.*, ${hoverImage('products')} FROM products WHERE ${where.join(' AND ')}
     ORDER BY ${trackStock() ? '(stock > 0) DESC,' : ''} ${SORTS[orden]} LIMIT 120`,
    args
    ),
    themesLib.publicThemes(),
  ]);

  // Portada sin filtros: la obra mas reciente se muestra grande y el resto va en la cuadricula
  const featured = !theme && !tipo && !q && orden === 'nuevo' && products.length >= 5 && products[0].image_path ? products[0] : null;

  res.render('index', {
    products: featured ? products.slice(1) : products,
    featured,
    total: products.length,
    theme,
    themes,
    filters: { tipo, orden, q, tema: theme ? theme.slug : '' },
    meta: {
      title: theme ? theme.name : tipo ? TYPE_PLURALS[tipo] : 'Tienda',
      description: theme ? `${theme.name}: dibujos, prints y stickers de 131.` : 'Dibujos, prints y stickers de 131.',
      noindex: !!theme && products.length === 0, // un tema vacio no es contenido para buscadores
      image: (products[0] && products[0].image_path) || undefined, // vista previa al compartir el enlace
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
      `SELECT p.*, ${hoverImage('p')}, t.id AS theme_id, t.name AS theme_name, t.slug AS theme_slug
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
    // Acepta /producto/12 y /producto/12-gato-astronauta
    const m = /^(\d{1,9})(?:-([a-z0-9-]{0,60}))?$/.exec(req.params.id);
    if (!m) return res.status(404).render('error', { status: 404 });
    const product = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [Number(m[1])]);
    if (!product) return res.status(404).render('error', { status: 404 });
    const canonicalPath = res.locals.productUrl(product);
    // Si la direccion lleva un nombre antiguo o incorrecto, se redirige a la buena (SEO)
    if (m[2] !== undefined && `/producto/${req.params.id}` !== canonicalPath) return res.redirect(301, canonicalPath);

    // Relacionados: primero los que comparten tema, luego el mismo tipo
    const relatedQuery = db.all(
      `SELECT p.*, ${hoverImage('p')} FROM products p WHERE p.active = 1 ${trackStock() ? 'AND p.stock > 0' : ''} AND p.id != ?
       ORDER BY (SELECT COUNT(*) FROM product_themes a JOIN product_themes b ON a.theme_id = b.theme_id
                 WHERE a.product_id = p.id AND b.product_id = ?) DESC,
                (p.type = ?) DESC, p.created_at DESC LIMIT 4`,
      [product.id, product.id, product.type]
    );
    const [productThemes, related, extras, variants] = await Promise.all([
      themesLib.themesOf(product.id),
      relatedQuery,
      extrasOf(product.id),
      variantsOf(product.id),
    ]);
    const gallery = [product.image_path, ...extras.map((e) => e.image_path)].filter(Boolean);

    res.render('product', {
      product,
      productThemes,
      variants,
      related,
      gallery,
      details: parseDetails(product.details || '').details,
      sku: skuOf(product.id),
      meta: {
        title: product.title,
        description: (product.description || '').replace(/\s+/g, ' ').slice(0, 155) ||
          `${product.title} - ${TYPE_LABELS[product.type] || 'Producto'} de 131.`,
        image: product.image_path,
        type: 'product',
        canonicalPath,
      },
    });
  })
);

// ---- Paginas informativas ----
router.get('/preguntas-frecuentes', (req, res) => {
  res.render('faq', {
    items: buildFaq(res.locals.shop),
    meta: { title: 'Preguntas frecuentes', description: 'Envíos, plazos, formatos y pagos.' },
  });
});

router.get('/contacto', (req, res) => {
  res.render('contact', {
    meta: { title: 'Contacto', description: 'Cómo ponerte en contacto con 131.' },
  });
});

router.get('/sobre-mi', (req, res) => {
  const about = siteSettings.getAbout();
  if (!about) return res.status(404).render('error', { status: 404 });
  res.render('about', {
    paragraphs: about.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
    meta: { title: 'Sobre mí', description: about.replace(/\s+/g, ' ').slice(0, 155) },
  });
});

// ---- Paginas legales ----
const LEGAL = {
  privacidad: 'Política de privacidad',
  condiciones: 'Condiciones de compra y devoluciones',
  'aviso-legal': 'Aviso legal',
};

router.get('/legal/:page', (req, res) => {
  const title = Object.hasOwn(LEGAL, req.params.page) ? LEGAL[req.params.page] : null;
  if (!title) return res.status(404).render('error', { status: 404 });
  res.render(`legal/${req.params.page}`, { meta: { title, description: title } });
});

// ---- SEO / infraestructura ----

// RFC 9116: a quien avisar si alguien encuentra un fallo de seguridad
router.get('/.well-known/security.txt', (req, res) => {
  const mail = process.env.CONTACT_EMAIL;
  if (!mail || /[\s<>]/.test(mail)) return res.status(404).render('error', { status: 404 });
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  res.type('text/plain; charset=utf-8').send(`Contact: mailto:${mail}
Expires: ${expires}
Preferred-Languages: es, en
Canonical: ${siteUrl(req)}/.well-known/security.txt
`);
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nDisallow: /admin\nDisallow: /pedido/\nDisallow: /carrito\nDisallow: /checkout\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`
  );
});

router.get(
  '/sitemap.xml',
  wrap(async (req, res) => {
    const base = siteUrl(req);
    const products = await db.all('SELECT id, title FROM products WHERE active = 1');
    const themes = await themesLib.publicThemes();
    const urls = [`<url><loc>${base}/</loc></url>`, `<url><loc>${base}/temas</loc></url>`, `<url><loc>${base}/preguntas-frecuentes</loc></url>`, `<url><loc>${base}/contacto</loc></url>`]
      .concat(siteSettings.getAbout() ? [`<url><loc>${base}/sobre-mi</loc></url>`] : [])
      .concat(themes.map((t) => `<url><loc>${base}/tema/${t.slug}</loc></url>`))
      .concat(products.map((p) => `<url><loc>${base}${res.locals.productUrl(p)}</loc></url>`));
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
