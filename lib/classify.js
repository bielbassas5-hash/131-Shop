// Orquesta la identificacion de temas de un producto:
//  1) IA de vision (si hay ANTHROPIC_API_KEY)  2) palabras del titulo y la descripcion.
const vision = require('./vision');
const themes = require('./themes');

async function detect({ title, description, image }) {
  if (vision.configured()) {
    const known = (await themes.allThemes()).map((t) => t.name);
    const names = await vision.suggestThemes({ title, description, image, known });
    if (names.length) return { names, source: 'ai' };
  }
  const names = themes.keywordThemes(`${title || ''} ${description || ''}`);
  return { names, source: names.length ? 'keywords' : 'none' };
}

// Detecta y AÑADE los temas al producto (sin quitar los que ya tenga).
async function classifyProduct(product, { buffer } = {}) {
  const detection = await detect({
    title: product.title,
    description: product.description,
    image: { path: product.image_path, buffer },
  });
  if (detection.names.length) {
    const ids = await themes.ensureThemes(detection.names);
    await themes.addProductThemes(product.id, ids);
  }
  return detection;
}

const aiEnabled = () => vision.configured();

module.exports = { detect, classifyProduct, aiEnabled };
