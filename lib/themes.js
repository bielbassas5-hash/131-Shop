// Temas (montañas, retratos, animales...) asignables a cada producto.
const db = require('../db');

const MAX_THEMES = 80; // tope de temas distintos (evita que una clasificacion automatica crezca sin control)
const MAX_PER_PRODUCT = 5;

// ---------- Nombres ----------
// Solo letras, numeros, espacios, guion y apostrofo (2-30 caracteres): nada de HTML ni simbolos.
function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’-]{1,29}$/u.test(s)) return '';
  return s.charAt(0).toLocaleUpperCase('es') + s.slice(1);
}

// "Cuadros, Acuarela ,Retratos" -> ['Cuadros', 'Acuarela', 'Retratos'] (sin repetidos ni invalidos)
function parseNames(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const part of text.split(',')) {
    const name = cleanName(part);
    const slug = db.slugOf(name);
    if (name && slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out.slice(0, MAX_PER_PRODUCT);
}

// ---------- Deteccion por palabras (titulo y descripcion) ----------
// Gratis y sin conexion. Se compara sin tildes y en minusculas.
const RULES = [
  ['Montañas', /\b(montan\w*|monte|montes|cumbre\w*|pico|picos|alpin\w*|nevad\w*|sierra|pirineo\w*|volcan\w*|cordillera|glaciar)\b/],
  ['Retratos', /\b(retrat\w*|rostro\w*|cara|caras|mujer|mujeres|hombre|hombres|nin[oa]s?|chic[oa]s?|persona|personas|autorretrat\w*|perfil|musa|abuel[oa]s?|reina|rey)\b/],
  ['Animales', /\b(animal\w*|gat[oa]s?|perr[oa]s?|pajaro\w*|ave|aves|buho\w*|lobo\w*|zorro\w*|oso\w*|conejo\w*|pez|peces|ballena\w*|caballo\w*|mariposa\w*|tigre\w*|leon|leones|elefante\w*|serpiente\w*|rana\w*|tortuga\w*|abeja\w*|ciervo\w*|panda|koala|mono|monos|pulpo|medusa|cuervo|lechuza|colibri|fauna)\b/],
  ['Paisajes', /\b(paisaje\w*|bosque\w*|campo|campos|rio|rios|lago\w*|atardecer\w*|amanecer\w*|valle\w*|selva|desierto|cascada|naturaleza|horizonte|pradera\w*)\b/],
  ['Flores y plantas', /\b(flor|flores|floral\w*|rosa|rosas|planta\w*|hoja|hojas|jardin\w*|cactus|arbol\w*|tulipan\w*|girasol\w*|botanic\w*|helecho\w*)\b/],
  ['Ciudad', /\b(ciudad\w*|calle\w*|edificio\w*|puente\w*|urban\w*|rascacielos|metro|skyline|barrio\w*)\b/],
  ['Mar', /\b(mar|marea|oceano\w*|ola|olas|barco\w*|playa\w*|faro|velero\w*|marin\w*|sirena)\b/],
  ['Espacio', /\b(espacio|luna|lunas|estrella\w*|astronaut\w*|planeta\w*|galaxia\w*|cosmos|cosmic\w*|nebulosa|cohete|universo)\b/],
  ['Fantasía', /\b(fantasia|dragon\w*|hada\w*|unicornio\w*|magi[ac]\w*|brujo\w*|bruja\w*|duende\w*|elfo\w*|mitolog\w*|monstruo\w*|fantasma\w*)\b/],
  ['Personajes', /\b(personaje\w*|caricatura\w*|chibi|robot\w*|heroe\w*|villano\w*)\b/],
  ['Comida', /\b(comida|pizza|cafe|taza|fruta\w*|pan|tarta\w*|helado\w*|sushi|taco\w*|galleta\w*|cerveza|vino)\b/],
  ['Letras', /\b(letra\w*|frase\w*|tipograf\w*|texto|palabra\w*|lettering|cita)\b/],
];

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function keywordThemes(text) {
  const t = fold(text);
  return RULES.filter(([, re]) => re.test(t)).map(([name]) => name).slice(0, 3);
}

// ---------- Acceso a datos ----------
const ACTIVE_COUNT = `(SELECT COUNT(*) FROM product_themes pt JOIN products p ON p.id = pt.product_id WHERE pt.theme_id = t.id AND p.active = 1)`;

const allThemes = () =>
  db.all(
    `SELECT t.id, t.name, t.slug, ${ACTIVE_COUNT} AS active_count,
            (SELECT COUNT(*) FROM product_themes WHERE theme_id = t.id) AS total_count
     FROM themes t ORDER BY t.name COLLATE NOCASE`
  );

// Solo los temas que tienen productos visibles (los vacios no se muestran a los clientes)
const publicThemes = () =>
  db.all(
    `SELECT t.id, t.name, t.slug, ${ACTIVE_COUNT} AS active_count
     FROM themes t WHERE ${ACTIVE_COUNT} > 0 ORDER BY active_count DESC, t.name COLLATE NOCASE`
  );

const themeBySlug = (slug) => db.get('SELECT id, name, slug FROM themes WHERE slug = ?', [slug]);

// Devuelve los ids de esos nombres, creando los que no existan (respeta el tope global).
async function ensureThemes(names) {
  const ids = [];
  for (const raw of names) {
    const name = cleanName(raw);
    const slug = db.slugOf(name);
    if (!name || !slug) continue;
    let row = await db.get('SELECT id FROM themes WHERE slug = ?', [slug]);
    if (!row) {
      const count = await db.get('SELECT COUNT(*) AS n FROM themes');
      if (Number(count.n) >= MAX_THEMES) continue;
      await db.run('INSERT OR IGNORE INTO themes (name, slug) VALUES (?, ?)', [name, slug]);
      row = await db.get('SELECT id FROM themes WHERE slug = ?', [slug]);
    }
    if (row) ids.push(Number(row.id));
  }
  return [...new Set(ids)];
}

async function setProductThemes(productId, themeIds) {
  const ids = [...new Set(themeIds.map(Number).filter(Number.isInteger))].slice(0, MAX_PER_PRODUCT);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM product_themes WHERE product_id = ?', [productId]);
    for (const id of ids) {
      await tx.run(
        'INSERT OR IGNORE INTO product_themes (product_id, theme_id) SELECT ?, id FROM themes WHERE id = ?',
        [productId, id]
      );
    }
  });
}

async function addProductThemes(productId, themeIds) {
  const current = await db.get('SELECT COUNT(*) AS n FROM product_themes WHERE product_id = ?', [productId]);
  let room = MAX_PER_PRODUCT - Number(current.n);
  for (const id of themeIds) {
    if (room <= 0) break;
    const res = await db.run(
      'INSERT OR IGNORE INTO product_themes (product_id, theme_id) SELECT ?, id FROM themes WHERE id = ?',
      [productId, Number(id)]
    );
    if (res.changes) room -= 1;
  }
}

const themesOf = (productId) =>
  db.all(
    `SELECT t.id, t.name, t.slug FROM themes t JOIN product_themes pt ON pt.theme_id = t.id
     WHERE pt.product_id = ? ORDER BY t.name COLLATE NOCASE`,
    [productId]
  );

const productsWithoutThemes = (limit) =>
  db.all(
    `SELECT p.id, p.title, p.description, p.image_path FROM products p
     WHERE NOT EXISTS (SELECT 1 FROM product_themes pt WHERE pt.product_id = p.id)
     ORDER BY p.id LIMIT ?`,
    [limit]
  );

module.exports = {
  MAX_THEMES,
  MAX_PER_PRODUCT,
  cleanName,
  parseNames,
  keywordThemes,
  allThemes,
  publicThemes,
  themeBySlug,
  ensureThemes,
  setProductThemes,
  addProductThemes,
  themesOf,
  productsWithoutThemes,
};
