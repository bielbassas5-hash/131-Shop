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
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { ext: '.png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg' };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { ext: '.gif' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp' };
  return null;
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'tienda-131', resource_type: 'image' },
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

module.exports = { saveImage, cloudinaryConfigured, UserError, detectImageType };
