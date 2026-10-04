// Utilidades comunes a las rutas de administracion.
const multer = require('multer');
const { MAX_EXTRAS } = require('../../lib/productImages');

const WEAK_PASSWORDS = ['arte131', 'admin', 'password', '123456', '131', 'contraseña'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 + MAX_EXTRAS },
});
const imageFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'extra', maxCount: MAX_EXTRAS + 1 },
]);

// Multer sin romper el flujo: el error se guarda en req.uploadError y la ruta lo muestra.
function uploadImages(req, res, next) {
  imageFields(req, res, (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE' ? 'Alguna imagen supera los 8 MB.' : 'No se han podido leer las imágenes.';
    }
    next();
  });
}

function pickFiles(req) {
  const f = req.files || {};
  return { cover: (f.image || [])[0], extras: f.extra || [] };
}

const isWeak = () => {
  const pw = process.env.ADMIN_PASSWORD || '';
  return pw.length < 10 || WEAK_PASSWORDS.includes(pw.toLowerCase());
};

module.exports = { uploadImages, pickFiles, isWeak };
