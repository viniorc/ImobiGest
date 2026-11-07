import { ValidationError, createId } from './utils.js';

export const PHOTO_LIMITS = Object.freeze({ fileBytes: 20 * 1024 * 1024, batchBytes: 60 * 1024 * 1024, batchCount: 10, pixels: 40000000, sourceSide: 12000, imageSide: 1920, imageBytes: 3 * 1024 * 1024, thumbnailSide: 480, thumbnailBytes: 160 * 1024 });
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const PHOTO_HELP = 'JPEG, PNG ou WebP: até 20 MiB por arquivo, 40 megapixels e 12.000 px por lado. Até 10 arquivos e 60 MiB por seleção. Versão salva até 1.920 px / 3 MiB; miniatura até 480 px / 160 KiB. Redução local pode perder detalhes; originais não são preservados. Animações viram imagem estática e metadados são removidos.';

export function createObjectURLPool(provider = URL) {
  const urls = new Set();
  return {
    create(blob) { const url = provider.createObjectURL(blob); urls.add(url); return url; },
    revoke(url) { if (urls.delete(url)) provider.revokeObjectURL(url); },
    dispose() { for (const url of urls) provider.revokeObjectURL(url); urls.clear(); },
  };
}

export function validatePhotoFiles(files) {
  const list = Array.from(files || []);
  if (!list.length || list.length > PHOTO_LIMITS.batchCount) throw new ValidationError('Selecione de 1 a 10 fotos por vez.');
  let bytes = 0;
  for (const file of list) {
    if (!(file instanceof Blob) || !PHOTO_TYPES.includes(file.type)) throw new ValidationError('Arquivo incompatível. Selecione somente JPEG, PNG ou WebP.');
    if (!file.size || file.size > PHOTO_LIMITS.fileBytes) throw new ValidationError('Cada foto deve ter conteúdo e no máximo 20 MiB.');
    bytes += file.size;
  }
  if (bytes > PHOTO_LIMITS.batchBytes) throw new ValidationError('A seleção ultrapassa 60 MiB. Selecione menos fotos.');
  return list;
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > PHOTO_LIMITS.sourceSide || height > PHOTO_LIMITS.sourceSide || width * height > PHOTO_LIMITS.pixels) throw new ValidationError('Imagem acima de 40 megapixels ou 12.000 px por lado, ou com dimensões inválidas.');
  return { width, height };
}
// Cabeçalhos antes da decodificação evitam aceitar imagens de dimensões excessivas.
export async function inspectPhotoBlob(blob) {
  if (!(blob instanceof Blob) || !PHOTO_TYPES.includes(blob.type) || !blob.size || blob.size > PHOTO_LIMITS.fileBytes) throw new ValidationError('Blob de imagem inválido ou acima de 20 MiB.');
  const bytes = new Uint8Array(await blob.arrayBuffer()); const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (blob.type === 'image/png' && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) && view.getUint32(8) === 13 && ascii(12, 'IHDR')) return dimensions(view.getUint32(16), view.getUint32(20));
  if (blob.type === 'image/webp' && bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP') && view.getUint32(4, true) + 8 === bytes.length) {
    const chunk = view.getUint32(16, true); if (chunk + 20 > bytes.length) throw new ValidationError('Cabeçalho WebP incompleto.');
    if (ascii(12, 'VP8X') && chunk >= 10) return dimensions(1 + bytes[24] + bytes[25]*256 + bytes[26]*65536, 1 + bytes[27] + bytes[28]*256 + bytes[29]*65536);
    if (ascii(12, 'VP8 ') && chunk >= 10 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return dimensions(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
    if (ascii(12, 'VP8L') && chunk >= 5 && bytes[20] === 47) { const bits = view.getUint32(21, true); return dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1); }
  }
  if (blob.type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      offset += length;
    }
  }
  throw new ValidationError('O conteúdo do arquivo não corresponde a um JPEG, PNG ou WebP válido.');
}

async function decode(blob) {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const url = URL.createObjectURL(blob); const image = new Image();
    try { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('decode')); image.src = url; }); return image; }
    finally { URL.revokeObjectURL(url); }
  } catch { throw new ValidationError('Não foi possível decodificar a foto. O arquivo pode estar corrompido.'); }
}
const encode = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new ValidationError('O navegador não conseguiu preparar a imagem.')), type, quality));
async function compact(image, maxSide, maxBytes, type, initialQuality) {
  const width = image.width || image.naturalWidth; const height = image.height || image.naturalHeight;
  const canvas = document.createElement('canvas'); let side = maxSide;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, side / Math.max(width, height)); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d'); if (!context) throw new ValidationError('Canvas não está disponível neste navegador.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await encode(canvas, type, Math.max(.5, initialQuality - attempt * .07));
      if (PHOTO_TYPES.includes(blob.type) && blob.size <= maxBytes) return { blob, width: canvas.width, height: canvas.height };
      side = Math.floor(side * .72);
    }
    throw new ValidationError('Não foi possível reduzir a foto ao limite de armazenamento. Escolha uma imagem menor.');
  } finally { canvas.width = canvas.height = 0; }
}

export async function preparePhoto(file) {
  validatePhotoFiles([file]); await inspectPhotoBlob(file);
  const image = await decode(file);
  try {
    dimensions(image.width || image.naturalWidth, image.height || image.naturalHeight);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const full = await compact(image, PHOTO_LIMITS.imageSide, PHOTO_LIMITS.imageBytes, type, .85);
    const thumb = await compact(image, PHOTO_LIMITS.thumbnailSide, PHOTO_LIMITS.thumbnailBytes, 'image/webp', .75);
    return { id: createId(), blob: full.blob, thumbnailBlob: thumb.blob, width: full.width, height: full.height, thumbnailWidth: thumb.width, thumbnailHeight: thumb.height, originalSize: file.size, nomeArquivo: String(file.name || 'Foto').slice(0, 240), categoriaComodo: 'outro', legenda: '' };
  } finally { image.close?.(); }
}
