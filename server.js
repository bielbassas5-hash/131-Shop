require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db');
const storeRoutes = require('./routes/store');
const cartRoutes = require('./routes/cart');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-cambia-esto',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

app.use((req, res, next) => {
  res.locals.cartCount = req.session.cart
    ? Object.values(req.session.cart).reduce((a, b) => a + b, 0)
    : 0;
  res.locals.artistName = '131';
  next();
});

app.use(storeRoutes);
app.use(cartRoutes);
app.use(checkoutRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render('404');
});

db.migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tienda 131 corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });
