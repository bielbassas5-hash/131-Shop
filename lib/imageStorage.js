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
  });
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'tienda-131' },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

// Guarda la imagen subida y devuelve la URL/ruta publica a usar en image_path.
// Con Cloudinary configurado sube a la nube (necesario en hosting sin disco
// persistente); si no, la guarda en public/uploads (solo vale para desarrollo local).
async function saveImage(file) {
  if (!file) return null;

  if (cloudinaryConfigured) {
    return uploadToCloudinary(file.buffer);
  }

  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
  const filename = crypto.randomUUID() + path.extname(file.originalname);
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

module.exports = { saveImage, cloudinaryConfigured };
