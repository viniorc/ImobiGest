import { database, DatabaseError } from './db.js';
import { ValidationError, validateId } from './utils.js';
import { PHOTO_LIMITS, inspectPhotoBlob } from './galeria-imagens.js';

export const PHOTO_CATEGORIES = Object.freeze({ fachada: 'Fachada', sala: 'Sala', quarto: 'Quarto', cozinha: 'Cozinha', banheiro: 'Banheiro', area_externa: 'Área externa', garagem: 'Garagem', lazer: 'Lazer', documentos_visuais: 'Documentos visuais', outro: 'Outro' });
export const PHOTO_PAGE_SIZE = 12;
export function validatePhotoMetadata(input) {
  const legenda = typeof input?.legenda === 'string' ? input.legenda.trim() : '';
  if (legenda.length > 500) throw new ValidationError('A legenda deve ter até 500 caracteres.');
  if (!Object.hasOwn(PHOTO_CATEGORIES, input?.categoriaComodo ?? '')) throw new ValidationError('Selecione uma categoria válida.');
  return { legenda, categoriaComodo: input.categoriaComodo };
}
function revision(record, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (record.revisao ?? 0) || !Number.isSafeInteger(expected + 1)) throw new DatabaseError('CONFLICT', 'A foto mudou em outra aba. Atualize a galeria antes de continuar.');
}
function propertyRevision(property) {
  const next = (property.revisao ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next < 1) throw new ValidationError('Revisão do imóvel inválida.');
  return next;
}
function belongs(photo, propertyId) {
  if (!photo) throw new DatabaseError('NOT_FOUND', 'Foto não encontrada. Atualize a galeria.');
  if (photo.propriedadeId !== propertyId) throw new DatabaseError('PROPERTY', 'A foto não pertence ao imóvel selecionado.');
}
function summary(photo) {
  const { blob, ...row } = photo; return row;
}
async function preparedRecord(photo, propertyId) {
  validateId(photo?.id); const metadata = validatePhotoMetadata(photo);
  const full = await inspectPhotoBlob(photo.blob); const thumb = await inspectPhotoBlob(photo.thumbnailBlob);
  if (photo.blob.size > PHOTO_LIMITS.imageBytes || Math.max(full.width, full.height) > PHOTO_LIMITS.imageSide || photo.thumbnailBlob.size > PHOTO_LIMITS.thumbnailBytes || Math.max(thumb.width, thumb.height) > PHOTO_LIMITS.thumbnailSide) throw new ValidationError('Imagem ou miniatura acima dos limites. Prepare a foto novamente.');
  return { id: photo.id, propriedadeId: propertyId, ...metadata, blob: photo.blob, thumbnailBlob: photo.thumbnailBlob, width: full.width, height: full.height, thumbnailWidth: thumb.width, thumbnailHeight: thumb.height, mimeType: photo.blob.type, nomeArquivo: String(photo.nomeArquivo || 'Foto').slice(0, 240), tamanho: photo.blob.size, thumbnailSize: photo.thumbnailBlob.size, originalSize: Number.isSafeInteger(photo.originalSize) && photo.originalSize > 0 ? photo.originalSize : photo.blob.size, createdAt: new Date().toISOString(), atualizadoEm: new Date().toISOString(), revisao: 1 };
}

export function createPhotoService(db = database) {
  function withPhoto(id, propertyId, work) {
    validateId(id); validateId(propertyId);
    return db.runTransaction(['photos', 'properties'], 'readwrite', (tx) => tx.request(tx.store('photos').get(id), (photo) => {
      belongs(photo, propertyId); tx.request(tx.store('properties').get(propertyId), (property) => {
        if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel não existe mais. Nenhuma foto foi alterada.');
        work(tx, photo, property);
      });
    }));
  }
  return {
    async addBatch(propertyId, photos) {
      validateId(propertyId);
      if (!Array.isArray(photos) || !photos.length || photos.length > PHOTO_LIMITS.batchCount) throw new ValidationError('Salve de 1 a 10 fotos por vez.');
      const records = []; for (const photo of photos) records.push(await preparedRecord(photo, propertyId));
      return db.runTransaction(['properties', 'photos'], 'readwrite', (tx) => tx.request(tx.store('properties').get(propertyId), (property) => {
        if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel selecionado não existe mais. A prévia foi preservada.');
        for (const record of records) tx.request(tx.store('photos').add(record), () => {});
        tx.result(records.map(summary));
      }));
    },
    page({ propertyId = '', page = 0 } = {}) {
      if (propertyId) validateId(propertyId);
      if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * PHOTO_PAGE_SIZE)) throw new ValidationError('Página inválida.');
      return db.runTransaction(['photos'], 'readonly', (tx) => {
        const store = tx.store('photos'); const source = propertyId ? store.index('propriedadeId') : store; const query = propertyId ? IDBKeyRange.only(propertyId) : undefined;
        tx.request(source.count(query), (total) => {
          const effective = Math.min(page, Math.max(0, Math.ceil(total / PHOTO_PAGE_SIZE) - 1)); const rows = []; let skipped = false; const offset = effective * PHOTO_PAGE_SIZE;
          tx.result({ rows, total, page: effective, pageSize: PHOTO_PAGE_SIZE });
          function readCursor(cursor) {
            if (!cursor || rows.length >= PHOTO_PAGE_SIZE) return;
            if (!skipped && offset) { skipped = true; tx.request(cursor.request, readCursor); cursor.advance(offset); return; }
            tx.request(store.get(cursor.primaryKey), (photo) => { rows.push(summary(photo)); if (rows.length < PHOTO_PAGE_SIZE) { tx.request(cursor.request, readCursor); cursor.continue(); } });
          }
          tx.request(source.openKeyCursor(query), readCursor);
        });
      });
    },
    async get(id, propertyId) { validateId(id); validateId(propertyId); const photo = await db.get('photos', id); belongs(photo, propertyId); return photo; },
    async thumbnail(id, propertyId) { validateId(id); validateId(propertyId); const photo = await db.get('photos', id); belongs(photo, propertyId); return photo.thumbnailBlob instanceof Blob ? photo.thumbnailBlob : null; },
    update(id, propertyId, input, expectedRevision) {
      const metadata = validatePhotoMetadata(input);
      return withPhoto(id, propertyId, (tx, photo) => { revision(photo, expectedRevision); const updated = { ...photo, ...metadata, revisao: expectedRevision + 1, atualizadoEm: new Date().toISOString() }; tx.request(tx.store('photos').put(updated), () => tx.result(summary(updated))); });
    },
    setCover(id, propertyId, expectedRevision) {
      return withPhoto(id, propertyId, (tx, photo, property) => {
        revision(photo, expectedRevision);
        if (!(photo.thumbnailBlob instanceof Blob) || !photo.thumbnailBlob.size) throw new ValidationError('Esta foto não possui miniatura válida.');
        const updated = { ...property, coverPhotoId: id, revisao: propertyRevision(property), atualizadoEm: new Date().toISOString() };
        tx.request(tx.store('properties').put(updated), () => tx.result(updated));
      });
    },
    remove(id, propertyId, expectedRevision) {
      return withPhoto(id, propertyId, (tx, photo, property) => {
        revision(photo, expectedRevision);
        if (property.coverPhotoId === id) { const updated = { ...property, revisao: propertyRevision(property), atualizadoEm: new Date().toISOString() }; delete updated.coverPhotoId; tx.request(tx.store('properties').put(updated), () => {}); }
        tx.request(tx.store('photos').delete(id), () => tx.result(true));
      });
    },
  };
}
