// Acceso: inicio y cierre de sesion del administrador.
const express = require('express');
const db = require('../../db');
const { createLimiter, safeEqual, clientIp, wrap } = require('../../lib/security');
const notify = require('../../lib/notify');

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 }); // por IP
const globalFails = createLimiter({ windowMs: 60 * 60 * 1000, max: 40 }); // fallos de TODAS las IPs
const alertLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 1 }); // un aviso por hora
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Acceso ----------
router.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null, meta: { title: 'Acceso', noindex: true } });
});

router.post(
  '/admin/login',
  wrap(async (req, res) => {
    const renderLogin = (error, status = 200) =>
      res.status(status).render('admin/login', { error, meta: { title: 'Acceso', noindex: true } });

    const ip = clientIp(req);
    if (loginLimiter.blocked(ip)) {
      return renderLogin('Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.', 429);
    }
    const expected = process.env.ADMIN_PASSWORD;
    const given = typeof req.body.password === 'string' ? req.body.password : '';
    if (!expected || !given || !safeEqual(given, expected)) {
      loginLimiter.hit(ip);
      globalFails.hit('all');
      // Muchos fallos en total (ataque repartido entre varias IP): cada intento tarda 2 s
      if (globalFails.blocked('all')) await sleep(2000);
      // Aviso al propietario (como mucho uno por hora)
      if (loginLimiter.count(ip) >= 5 && alertLimiter.take('alert')) {
        notify.securityAlert({ ip, attempts: loginLimiter.count(ip) });
      }
      return renderLogin('Contraseña incorrecta.', 401);
    }

    loginLimiter.reset(ip);

    // Acceso anterior: si no fue el tuyo, se nota al instante
    const prev = await db.get("SELECT value FROM settings WHERE key = 'last_login'");
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_login', ?)", [
      JSON.stringify({ at: new Date().toISOString(), ip }),
    ]);
    let notice = null;
    try {
      const p = prev && JSON.parse(prev.value);
      if (p && p.at) {
        const when = new Date(p.at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
        notice = { type: 'info', msg: `Último acceso anterior: ${when} desde ${String(p.ip).slice(0, 45)}. Si no fuiste tú, cambia ADMIN_PASSWORD en Render.` };
      }
    } catch (_) {
      /* sin dato previo */
    }

    // Nueva sesión al autenticarse (evita fijación de sesión)
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.isAdmin = true;
      req.session.cookie.maxAge = ADMIN_SESSION_MS;
      if (notice) req.session.flash = notice;
      res.redirect('/admin');
    });
  })
);

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = router;
