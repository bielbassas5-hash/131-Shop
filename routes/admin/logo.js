// Logo de la web: dos versiones (fondo claro y, opcional, fondo oscuro) subidas desde el panel.
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { saveImage, deleteImage, detectImageType, UserError } = require('../../lib/imageStorage');
const siteSettings = require('../../lib/siteSettings');
const { uploadLogo } = require('./shared');

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/webp', 'image/jpeg'];

const router = express.Router();

router.get('/admin/logo', requireAdmin, (req, res) => {
  res.render('admin/logo', { current: siteSettings.getLogo(), error: null, meta: { title: 'Logo', noindex: true } });
});

// Valida el archivo (por su contenido real, no por el nombre) y lo guarda; devuelve la URL
async function storeLogo(file) {
  const type = detectImageType(file.buffer);
  if (!type || !LOGO_TYPES.includes(type.mime)) throw new UserError('El logo debe ser un PNG (mejor con fondo transparente), WEBP o JPG.');
  if (file.buffer.length > MAX_LOGO_BYTES) throw new UserError('El logo supera los 2 MB.');
  return saveImage(file);
}

router.post(
  '/admin/logo',
  requireAdmin,
  uploadLogo,
  wrap(async (req, res) => {
    const files = req.files || {};
    const light = (files.light || [])[0];
    const dark = (files.dark || [])[0];
    const current = siteSettings.getLogo();
    const fail = (msg) => res.status(400).render('admin/logo', { current, error: msg, meta: { title: 'Logo', noindex: true } });
    if (req.uploadError) return fail(req.uploadError);
    if (!light && !dark) return fail('Elige al menos un archivo.');
    if (dark && !light && !current.light) return fail('Sube primero la versión para fondo claro.');

    const next = { ...current };
    const created = [];
    try {
      if (light) created.push((next.light = await storeLogo(light)));
      if (dark) created.push((next.dark = await storeLogo(dark)));
    } catch (err) {
      for (const url of created) await deleteImage(url);
      return fail(err instanceof UserError ? err.message : 'No se ha podido guardar el logo. Inténtalo de nuevo en unos minutos.');
    }
    await siteSettings.setLogo(next);
    if (light && current.light) await deleteImage(current.light);
    if (dark && current.dark) await deleteImage(current.dark);
    req.session.flash = { type: 'success', msg: 'Logo actualizado.' };
    res.redirect('/admin/logo');
  })
);

router.post(
  '/admin/logo/quitar',
  requireAdmin,
  wrap(async (req, res) => {
    const current = siteSettings.getLogo();
    await siteSettings.setLogo({ light: '', dark: '' });
    for (const url of [current.light, current.dark]) if (url) await deleteImage(url);
    req.session.flash = { type: 'success', msg: 'Logo quitado: se vuelve a mostrar el texto "131.".' };
    res.redirect('/admin/logo');
  })
);

module.exports = router;
