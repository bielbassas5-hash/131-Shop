// Temas: gestion y clasificacion en bloque.
const express = require('express');
const db = require('../../db');
const { slugOf } = db;
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const themesLib = require('../../lib/themes');
const classify = require('../../lib/classify');

const router = express.Router();

router.get(
  '/admin/temas',
  requireAdmin,
  wrap(async (req, res) => {
    const withoutThemes = await themesLib.productsWithoutThemes(1000);
    res.render('admin/themes', {
      themes: await themesLib.allThemes(),
      unclassified: withoutThemes.length,
      aiEnabled: classify.aiEnabled(),
      meta: { title: 'Temas', noindex: true },
    });
  })
);

router.post(
  '/admin/temas',
  requireAdmin,
  wrap(async (req, res) => {
    const names = themesLib.parseNames(req.body.name);
    if (!names.length) {
      req.session.flash = { type: 'error', msg: 'Nombre no válido (2-30 letras, números, espacios o guiones).' };
    } else {
      await themesLib.ensureThemes(names);
      req.session.flash = { type: 'success', msg: `Tema "${names[0]}" creado.` };
    }
    res.redirect('/admin/temas');
  })
);

// Clasifica (como máximo 15 por vez) los productos que aún no tienen ningún tema
router.post(
  '/admin/temas/clasificar',
  requireAdmin,
  wrap(async (req, res) => {
    const batch = classify.aiEnabled() ? 5 : 30; // la IA tarda unos segundos por imagen
    const pending = await themesLib.productsWithoutThemes(batch);
    let done = 0;
    for (const p of pending) {
      const d = await classify.classifyProduct(p);
      if (d.names.length) done += 1;
    }
    const left = (await themesLib.productsWithoutThemes(1000)).length;
    req.session.flash = {
      type: pending.length ? 'success' : 'info',
      msg: pending.length
        ? `Clasificados ${done} de ${pending.length} productos.${left ? ` Quedan ${left} sin tema; vuelve a pulsar el botón.` : ''}`
        : 'Todos los productos ya tienen algún tema.',
    };
    res.redirect('/admin/temas');
  })
);

router.post(
  '/admin/temas/:id/renombrar',
  requireAdmin,
  wrap(async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const name = themesLib.cleanName(req.body.name);
    const slug = name ? slugOf(name) : '';
    const clash = slug ? await db.get('SELECT id FROM themes WHERE slug = ? AND id != ?', [slug, id]) : null;
    if (!id || !name || !slug) req.session.flash = { type: 'error', msg: 'Nombre no válido.' };
    else if (clash) req.session.flash = { type: 'error', msg: 'Ya existe un tema con ese nombre.' };
    else {
      await db.run('UPDATE themes SET name = ?, slug = ? WHERE id = ?', [name, slug, id]);
      req.session.flash = { type: 'success', msg: 'Tema renombrado.' };
    }
    res.redirect('/admin/temas');
  })
);

router.post(
  '/admin/temas/:id/eliminar',
  requireAdmin,
  wrap(async (req, res) => {
    if (/^\d+$/.test(req.params.id)) {
      await db.run('DELETE FROM product_themes WHERE theme_id = ?', [req.params.id]);
      await db.run('DELETE FROM themes WHERE id = ?', [req.params.id]);
      req.session.flash = { type: 'success', msg: 'Tema eliminado (los productos se conservan).' };
    }
    res.redirect('/admin/temas');
  })
);

module.exports = router;
