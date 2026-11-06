// Portada de la tienda: que obra se destaca y, opcionalmente, una foto propia para ese espacio.
const express = require('express');
const db = require('../../db');
const { requireAdmin } = require('../../middleware/auth');
const { wrap } = require('../../lib/security');
const { deleteImage, UserError } = require('../../lib/imageStorage');
const { prepareFiles, saveMany } = require('../../lib/productImages');
const siteSettings = require('../../lib/siteSettings');
const { uploadImages, pickFiles } = require('./shared');

const router = express.Router();

async function renderCover(res, { error = null, status = 200 } = {}) {
  const products = await db.all('SELECT id, title, type, active, image_path FROM products ORDER BY title COLLATE NOCASE');
  const featuredId = siteSettings.getFeaturedId();
  res.status(status).render('admin/cover', {
    products,
    featuredId,
    featured: products.find((p) => Number(p.id) === featuredId) || null,
    photo: siteSettings.getCoverPhoto(),
    error,
    meta: { title: 'Portada', noindex: true },
  });
}

router.get('/admin/portada', requireAdmin, wrap((req, res) => renderCover(res)));

router.post(
  '/admin/portada',
  requireAdmin,
  uploadImages,
  wrap(async (req, res) => {
    if (req.uploadError) return renderCover(res, { error: req.uploadError, status: 400 });
    const { cover } = pickFiles(req);

    // Obra: "" = automatica (la ultima añadida); si no, debe existir
    const wanted = typeof req.body.product === 'string' ? req.body.product.trim() : '';
    let productId = 0;
    if (wanted) {
      const found = /^\d{1,9}$/.test(wanted) ? await db.get('SELECT id FROM products WHERE id = ?', [Number(wanted)]) : null;
      if (!found) return renderCover(res, { error: 'Esa obra no existe.', status: 400 });
      productId = Number(found.id);
    }

    // Foto propia: se valida y guarda antes de cambiar nada
    let newPhoto = null;
    if (cover) {
      try {
        await prepareFiles([cover]);
        [newPhoto] = await saveMany([cover]);
      } catch (err) {
        const msg = err instanceof UserError ? err.message : 'No se ha podido guardar la foto. Inténtalo de nuevo en unos minutos.';
        if (!(err instanceof UserError)) console.error('[portada] no se pudo guardar la foto:', err && err.message ? err.message : err);
        return renderCover(res, { error: msg, status: 400 });
      }
    }

    await siteSettings.setFeaturedId(productId);
    const oldPhoto = siteSettings.getCoverPhoto();
    if (newPhoto) {
      await siteSettings.setCoverPhoto(newPhoto);
      if (oldPhoto) await deleteImage(oldPhoto);
    } else if (req.body.remove_photo === '1' && oldPhoto) {
      await siteSettings.setCoverPhoto('');
      await deleteImage(oldPhoto);
    }
    req.session.flash = { type: 'success', msg: 'Portada actualizada.' };
    res.redirect('/admin/portada');
  })
);

module.exports = router;
