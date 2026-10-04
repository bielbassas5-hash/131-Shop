const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

const cloudinaryConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// Error cuyo mensaje se puede mostrar tal cual al usuario.
class UserError extends Error {}

// Detecta el tipo real mirando los primeros bytes; el mimetype que envia el
// navegador y el nombre del archivo no son fiables.
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { ext: '.png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { ext: '.gif', mime: 'image/gif' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'tienda-131',
        resource_type: 'image',
        // Limita el tamaño guardado para ahorrar almacenamiento del plan gratuito
        transformation: [{ width: 2000, height: 2000, crop: 'limit' }],
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

// Guarda la imagen y devuelve la URL/ruta publica para image_path.
// Con Cloudinary configurado sube a la nube; si no, guarda en public/uploads
// (solo válido para desarrollo local, el disco de Render gratis no es persistente).
async function saveImage(file) {
  if (!file) return null;

  const type = detectImageType(file.buffer);
  if (!type) throw new UserError('El archivo no es una imagen válida (usa PNG, JPG, WEBP o GIF).');

  if (cloudinaryConfigured) return uploadToCloudinary(file.buffer);

  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = crypto.randomUUID() + type.ext;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

// Borra la imagen anterior de un producto (Cloudinary o disco local). Nunca lanza:
// una imagen huerfana es preferible a un error al editar o borrar.
async function deleteImage(url) {
  try {
    if (!url) return;
    if (url.startsWith('/uploads/')) {
      const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
      const target = path.join(uploadsDir, path.basename(url));
      if (path.dirname(target) === uploadsDir) fs.rmSync(target, { force: true });
      return;
    }
    if (!cloudinaryConfigured) return;
    // Solo se borran activos de nuestra carpeta
    const m = url.match(/\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(tienda-131\/[\w-]+)\.\w+$/);
    if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'image' });
  } catch (err) {
    console.error('No se pudo borrar la imagen anterior:', err.message);
  }
}

module.exports = { saveImage, deleteImage, cloudinaryConfigured, UserError, detectImageType };
