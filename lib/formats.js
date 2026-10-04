// Formatos estandar de impresion y calidad segun la resolucion de la imagen original.
// Sin dependencias: solo lee las cabeceras del archivo para saber su tamaño en pixeles.

const PRESETS = [
  { id: 'A5', label: 'A5 (14,8 × 21 cm)', mm: [148, 210] },
  { id: 'A4', label: 'A4 (21 × 29,7 cm)', mm: [210, 297] },
  { id: 'A3', label: 'A3 (29,7 × 42 cm)', mm: [297, 420] },
  { id: 'A2', label: 'A2 (42 × 59,4 cm)', mm: [420, 594] },
  { id: 'A1', label: 'A1 (59,4 × 84,1 cm)', mm: [594, 841] },
];

const presetOfLabel = (label) => PRESETS.find((p) => p.label === label) || null;

const MAX_PX = 30000;
const valid = (w, h) => Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= MAX_PX && h <= MAX_PX;

// Tamaño en pixeles leyendo solo la cabecera (PNG, JPEG, GIF y WEBP). null si no se puede leer.
function imageSize(buf) {
  try {
    if (!buf || buf.length < 30) return null;
    let w;
    let h;
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      w = buf.readUInt32BE(16);
      h = buf.readUInt32BE(20);
    } else if (buf.toString('ascii', 0, 4) === 'GIF8') {
      w = buf.readUInt16LE(6);
      h = buf.readUInt16LE(8);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i += 1;
        } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          h = buf.readUInt16BE(i + 5);
          w = buf.readUInt16BE(i + 7);
          break;
        } else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
        } else {
          i += 2 + buf.readUInt16BE(i + 2);
        }
      }
    } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8 ') {
        w = buf.readUInt16LE(26) & 0x3fff;
        h = buf.readUInt16LE(28) & 0x3fff;
      } else if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        w = (bits & 0x3fff) + 1;
        h = ((bits >> 14) & 0x3fff) + 1;
      } else if (kind === 'VP8X') {
        w = 1 + buf.readUIntLE(24, 3);
        h = 1 + buf.readUIntLE(27, 3);
      }
    }
    return valid(w, h) ? { width: w, height: h } : null;
  } catch (_) {
    return null;
  }
}

// Pixeles por pulgada que daria la imagen en ese formato (sin importar la orientacion)
function pppFor(width, height, mm) {
  const [shortMm, longMm] = [Math.min(...mm), Math.max(...mm)];
  const [shortPx, longPx] = [Math.min(width, height), Math.max(width, height)];
  return Math.floor(Math.min(shortPx / (shortMm / 25.4), longPx / (longMm / 25.4)));
}

// 300 ppp o mas: optima · 200-299: aceptable · menos: baja
const qualityOf = (ppp) => (ppp >= 300 ? 'optima' : ppp >= 200 ? 'aceptable' : 'baja');
const QUALITY_LABELS = { optima: 'Calidad óptima', aceptable: 'Calidad aceptable', baja: 'Resolución baja' };

function assess(dims, preset) {
  if (!dims || !valid(Number(dims.width), Number(dims.height))) return null;
  const ppp = pppFor(Number(dims.width), Number(dims.height), preset.mm);
  return { ppp, level: qualityOf(ppp) };
}

module.exports = { PRESETS, presetOfLabel, imageSize, pppFor, qualityOf, assess, QUALITY_LABELS, MAX_PX, valid };
