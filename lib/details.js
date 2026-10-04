// Ficha tecnica de una obra: lineas "Etiqueta: valor" (tecnica, soporte, medidas, edicion...).
const MAX_DETAILS = 8;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function parseDetails(raw) {
  const details = [];
  const errors = [];
  const lines = String(typeof raw === 'string' ? raw : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > MAX_DETAILS) errors.push(`Máximo ${MAX_DETAILS} detalles.`);
  for (const line of lines.slice(0, MAX_DETAILS)) {
    const idx = line.indexOf(':');
    const label = idx > 0 ? clean(line.slice(0, idx), 30) : '';
    const value = idx > 0 ? clean(line.slice(idx + 1), 120) : '';
    if (!label || !value) {
      errors.push(`Detalle no válido: "${clean(line, 40)}". Usa el formato "Técnica: tinta y acuarela".`);
      continue;
    }
    details.push({ label, value });
  }
  return { details, errors };
}

const toText = (details) => details.map((d) => `${d.label}: ${d.value}`).join('\n');

// Referencia visible de cada producto (por ejemplo 131-0007)
const skuOf = (id) => `131-${String(id).padStart(4, '0')}`;

module.exports = { MAX_DETAILS, parseDetails, toText, skuOf };
