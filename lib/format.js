const nf = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

const TYPE_LABELS = { dibujo: 'Dibujo original', print: 'Print', sticker: 'Sticker' };
const TYPE_PLURALS = { dibujo: 'Dibujos originales', print: 'Prints', sticker: 'Stickers' };
const TYPES = Object.keys(TYPE_LABELS);

const STATUS_LABELS = {
  pending: 'Pendiente de pago',
  paid: 'Pagado',
  production: 'En producción',
  shipped: 'Enviado',
  cancelled: 'Cancelado',
};

const dtf = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' });

// created_at de SQLite es UTC sin zona (YYYY-MM-DD HH:MM:SS)
function dateTime(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(value) : dtf.format(d);
}

const euro = (cents) => nf.format((Number(cents) || 0) / 100);

// Cloudinary sirve la imagen redimensionada y en el mejor formato (webp/avif).
function thumb(url, width = 600) {
  if (!url || !url.includes('res.cloudinary.com') || !url.includes('/upload/')) return url;
  if (/\/upload\/[^/]*(w_|f_auto)/.test(url)) return url;
  return url.replace('/upload/', `/upload/f_auto,q_auto,c_limit,w_${width}/`);
}

module.exports = { euro, dateTime, thumb, TYPE_LABELS, TYPE_PLURALS, TYPES, STATUS_LABELS };
