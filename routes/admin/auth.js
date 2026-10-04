// Acceso: inicio y cierre de sesion del administrador.
const express = require('express');
const { createLimiter, safeEqual, clientIp } = require('../../lib/security');

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

// ---------- Acceso ----------
router.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null, meta: { title: 'Acceso', noindex: true } });
});

router.post('/admin/login', (req, res, next) => {
  const renderLogin = (error, status = 200) =>
    res.status(status).render('admin/login', { error, meta: { title: 'Acceso', noindex: true } });

  if (loginLimiter.blocked(clientIp(req))) {
    return renderLogin('Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', 429);
  }
  const expected = process.env.ADMIN_PASSWORD;
  const given = typeof req.body.password === 'string' ? req.body.password : '';
  if (!expected || !given || !safeEqual(given, expected)) {
    loginLimiter.hit(clientIp(req));
    return renderLogin('Contraseña incorrecta.', 401);
  }

  loginLimiter.reset(clientIp(req));
  // Nueva sesión al autenticarse (evita fijacion de sesión)
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.cookie.maxAge = ADMIN_SESSION_MS;
    res.redirect('/admin');
  });
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = router;
