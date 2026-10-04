// Texto de la pagina "Sobre mi".
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { multiline } = require('../../lib/validate');
const siteSettings = require('../../lib/siteSettings');

const MAX = 3000;
const router = express.Router();

router.get('/admin/sobre-mi', requireAdmin, (req, res) => {
  res.render('admin/about', { about: siteSettings.getAbout(), max: MAX, meta: { title: 'Sobre mí', noindex: true } });
});

router.post(
  '/admin/sobre-mi',
  requireAdmin,
  wrap(async (req, res) => {
    await siteSettings.setAbout(multiline(req.body.about, MAX));
    req.session.flash = { type: 'success', msg: siteSettings.getAbout() ? 'Texto guardado.' : 'Página "Sobre mí" ocultada (texto vacío).' };
    res.redirect('/admin/sobre-mi');
  })
);

module.exports = router;
