require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');

const db = require('./db');
const DbStore = require('./lib/sessionStore');
const { csrf } = require('./lib/security');
const { euro, dateTime, thumb, TYPE_LABELS, TYPE_PLURALS, STATUS_LABELS } = require('./lib/format');
const { shippingCost, freeShippingThreshold, expirePending, trackStock } = require('./lib/orders');

const storeRoutes = require('./routes/store');
const cartRoutes = require('./routes/cart');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');

const isProd = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
const PORT = process.env.PORT || 3000;
const PENDING_EXPIRY_DAYS = parseInt(process.env.PENDING_EXPIRY_DAYS || '5', 10);

let secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 16) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('AVISO: define SESSION_SECRET (16+ caracteres). Se usa una clave temporal: las sesiones se invalidan al reiniciar.');
}
if (!process.env.ADMIN_PASSWORD) console.warn('AVISO: ADMIN_PASSWORD no está definida; el panel de administración queda deshabilitado.');

const app = express();
app.disable('x-powered-by');
if (isProd) app.set('env', 'production');
if (isProd) app.set('trust proxy', 1); // Render va detras de un proxy

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
        connectSrc: ["'self'"],
        formAction: ["'self'", 'https://checkout.stripe.com'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// El webhook de Stripe necesita el cuerpo crudo y se autentica por firma: va antes que
// los parsers, la sesion y el CSRF.
app.use(webhookRoutes);

const assetVersion = Date.now().toString(36);
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    index: false,
    // Las tipografias no cambian nunca: cache de un año
    setHeaders: (res, file) => {
      if (/[\\/]fonts[\\/].+\.woff2$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  })
);

app.use(express.urlencoded({ extended: false, limit: '30kb' }));

app.use(
  session({
    name: isProd ? '__Host-sid' : 'sid',
    store: new DbStore(),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);
// Variables disponibles en todas las vistas
app.use((req, res, next) => {
  const cart = (req.session && req.session.cart) || {};
  res.locals.cartCount = Object.values(cart).reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
  res.locals.artistName = '131';
  res.locals.euro = euro;
  res.locals.dateTime = dateTime;
  res.locals.thumb = thumb;
  res.locals.TYPE_LABELS = TYPE_LABELS;
  res.locals.TYPE_PLURALS = TYPE_PLURALS;
  res.locals.STATUS_LABELS = STATUS_LABELS;
  res.locals.assetVersion = assetVersion;
  res.locals.currentPath = req.path;
  res.locals.meta = {};
  res.locals.isAdmin = !!(req.session && req.session.isAdmin);
  res.locals.shop = {
    shippingCents: shippingCost(),
    freeFrom: freeShippingThreshold(),
    contactEmail: process.env.CONTACT_EMAIL || '',
    trackStock: trackStock(),
    leadTime: (process.env.LEAD_TIME || '').slice(0, 60),
    pickupEnabled: process.env.PICKUP_ENABLED === '1',
    pickupNote: (process.env.PICKUP_NOTE || '').slice(0, 200),
    instagram: (process.env.INSTAGRAM || '').replace(/^@/, '').replace(/[^\w.]/g, ''),
    siteUrl: (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''),
    legalName: process.env.LEGAL_NAME || '',
    legalNif: process.env.LEGAL_NIF || '',
    legalAddress: process.env.LEGAL_ADDRESS || '',
  };
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  next();
});

// Paginas con datos personales: nunca en cache compartida ni del navegador
app.use(['/carrito', '/checkout', '/pedido'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(csrf({ secret, isProd }));

app.use(storeRoutes);
app.use(cartRoutes);
app.use(checkoutRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render('error', { status: 404 });
});

// Manejador de errores: nunca se filtra la traza al visitante.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', { status: 500 }, (renderErr, html) => {
    if (renderErr) return res.type('text/plain').send('Error interno. Inténtalo de nuevo mas tarde.');
    res.send(html);
  });
});

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

db.migrate()
  .then(async () => {
    const released = await expirePending(PENDING_EXPIRY_DAYS).catch((e) => {
      console.error('No se pudieron caducar pedidos pendientes:', e.message);
      return 0;
    });
    if (released) console.log(`Pedidos pendientes caducados: ${released}`);
    setInterval(() => expirePending(PENDING_EXPIRY_DAYS).catch(() => {}), 6 * 60 * 60 * 1000).unref();

    const server = app.listen(PORT, () => {
      console.log(`Tienda 131 corriendo en http://localhost:${PORT}`);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  })
  .catch((err) => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });
