import { database, DB_VERSION, APP_VERSION, STORE_NAMES, DB_NAME, DEMO_DB_NAME, DatabaseError } from './db.js';
import { ValidationError, validateId, assertCentavos, formatBRL, createId } from './utils.js';
import { validatePropertyInput } from './imoveis.js';
import { validateFinancialInput, createOriginKey } from './financeiro-service.js';
import { validateLeaseInput, assertLeaseAvailability } from './alugueis-service.js';
import { validateBookingInput, assertBookingAvailability } from './reservas-service.js';
import { validatePhotoMetadata } from './galeria-service.js';
import { PHOTO_LIMITS, PHOTO_TYPES, inspectPhotoBlob } from './galeria-imagens.js';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAX_BYTES = 100 * 1024 * 1024;
const preparedBackups = new WeakMap();
const fail = message => { throw new ValidationError(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function jsonValue(value, depth = 0) {
  if (depth > 20) fail('Estrutura do arquivo excessivamente profunda.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(v => jsonValue(v, depth + 1)); return; }
  if (!plain(value)) fail('Tipo de dado não portátil no backup.');
  for (const [key, item] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Chave insegura no arquivo.'); jsonValue(item, depth + 1); }
}
function textFields(row, fields) { for (const key of fields.split(' ')) if (typeof row[key] !== 'string') fail(`${row.id}: ${key} deve ser texto.`); }
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Metadado de data/hora inválido.'); }
function cents(value, optional = false) { if (optional && value === null) return; if (assertCentavos(value) < 0) fail('Valor monetário negativo no cadastro.'); }
const moneyInput = value => value === null ? '' : formatBRL(value);
const common = ['id', 'criadoEm', 'atualizadoEm', 'revisao'];
const allowed = {
  properties: [...common, 'nome','tipo','finalidade','endereco','bairro','cidade','uf','cep','descricao','observacoes','valorEstimadoCentavos','aluguelPrevistoCentavos','situacaoManual','coverPhotoId'],
  transactions: [...common, 'propriedadeId','tipo','categoria','descricao','valorCentavos','vencimento','liquidadoEm','situacaoPersistida','origem','origemId','periodoReferencia','subtipoOrigem','chaveOrigem','formaPagamento','observacoes'],
  leases: [...common, 'propriedadeId','locatario','inicio','fim','valorMensalCentavos','diaVencimento','situacao','observacoes'],
  bookings: [...common, 'propriedadeId','hospede','plataforma','entrada','saida','valorBrutoCentavos','taxaPlataformaCentavos','outrasDespesasCentavos','situacao','observacoes'],
  photos: ['id','propriedadeId','categoriaComodo','legenda','mimeType','nomeArquivo','tamanho','thumbnailSize','originalSize','createdAt','atualizadoEm','revisao','blob','thumbnailBlob','width','height','thumbnailWidth','thumbnailHeight'],
};

export function readBackupSnapshot(db = database) {
  return db.runTransaction([...STORE_NAMES], 'readonly', tx => readAll(tx, data => tx.result(data)));
}
function readAll(tx, done) {
  const data = {}; let remaining = STORE_NAMES.length;
  for (const store of STORE_NAMES) tx.request(tx.store(store).getAll(), rows => { data[store] = rows; if (!--remaining) done(data); });
}
export function snapshotStamp(data) {
  // Campos/revisões + tamanho/tipo dos Blobs detectam alterações feitas pelos
  // serviços enquanto o usuário examina a prévia. Comparação dentro da escrita.
  return JSON.stringify(STORE_NAMES.map(s => [s, [...data[s]].sort((a,b) => a.id.localeCompare(b.id))]), (_key, value) => value instanceof Blob ? { blobSize: value.size, blobType: value.type } : value);
}

async function validateImage(blob, size, width, height, maxBytes, maxSide) {
  if (!(blob instanceof Blob) || !PHOTO_TYPES.includes(blob.type) || blob.size !== size || blob.size > maxBytes) fail('Conteúdo/tamanho da foto incompatível com seus metadados.');
  const dimensions = await inspectPhotoBlob(blob);
  if (dimensions.width !== width || dimensions.height !== height || Math.max(width, height) > maxSide) fail('Dimensões da foto incompatíveis com seus metadados.');
  const url = URL.createObjectURL(blob);
  try { const image = new Image(); image.src = url; await image.decode(); if (!image.naturalWidth || !image.naturalHeight) fail('Imagem vazia.'); }
  catch { fail('Foto corrompida: não foi possível decodificar seu conteúdo.'); }
  finally { URL.revokeObjectURL(url); }
}

export async function validateBackupData(data, datasetKind) {
  if (!['real','demo','test'].includes(datasetKind)) fail('Identificação de base inválida.');
  if (!plain(data) || Object.keys(data).length !== STORE_NAMES.length || STORE_NAMES.some(s => !Array.isArray(data[s]))) fail('O backup deve conter exatamente as seis coleções.');
  const maps = {};
  for (const store of STORE_NAMES) {
    if (data[store].length > 100000) fail('Coleção acima do limite de 100.000 registros.');
    maps[store] = new Map();
    for (const row of data[store]) {
      if (!plain(row)) fail(`Registro inválido em ${store}.`); validateId(row.id);
      if (maps[store].has(row.id)) fail(`ID duplicado em ${store}: ${row.id}`); maps[store].set(row.id, row);
      if (store === 'appMeta') { jsonValue(row); continue; }
      if (Object.keys(row).some(k => !allowed[store].includes(k))) fail(`Campo desconhecido em ${store}: use uma versão compatível do aplicativo.`);
      if (row.revisao !== undefined && (!Number.isSafeInteger(row.revisao) || row.revisao < 0)) fail('Revisão inválida.');
      instant(row[store === 'photos' ? 'createdAt' : 'criadoEm']); instant(row.atualizadoEm);
    }
  }
  const meta = maps.appMeta.get('app');
  if (!meta || meta.schemaVersion !== DB_VERSION || typeof meta.appVersion !== 'string' || meta.datasetKind !== datasetKind || meta.demoMode !== (datasetKind === 'demo')) fail('Metadados da base incompatíveis com o backup.');
  if (meta.restoreEpoch !== undefined) validateId(meta.restoreEpoch);
  for (const p of data.properties) {
    textFields(p, 'nome tipo finalidade endereco bairro cidade uf cep descricao observacoes situacaoManual');
    cents(p.valorEstimadoCentavos, true); cents(p.aluguelPrevistoCentavos, true);
    validatePropertyInput({ ...p, valorEstimado: moneyInput(p.valorEstimadoCentavos), aluguelPrevisto: moneyInput(p.aluguelPrevistoCentavos) });
    if (p.coverPhotoId != null) { validateId(p.coverPhotoId); const photo = maps.photos.get(p.coverPhotoId); if (!photo || photo.propriedadeId !== p.id) fail('Capa ausente ou vinculada a outro imóvel.'); }
  }
  for (const store of ['leases','bookings','photos','transactions']) for (const row of data[store]) {
    if (store === 'transactions' && row.propriedadeId === null) continue;
    validateId(row.propriedadeId); if (!maps.properties.has(row.propriedadeId)) fail(`Vínculo com imóvel inexistente em ${store}.`);
  }
  for (const l of data.leases) {
    textFields(l, 'locatario inicio situacao observacoes'); if (l.fim !== null && typeof l.fim !== 'string') fail('Fim de contrato inválido.');
    cents(l.valorMensalCentavos); if (!Number.isInteger(l.diaVencimento)) fail('Dia de vencimento deve ser inteiro.');
    validateLeaseInput({ ...l, valorMensal: moneyInput(l.valorMensalCentavos) });
    assertLeaseAvailability(l, data.leases, data.bookings, l.id);
  }
  for (const b of data.bookings) {
    textFields(b, 'hospede plataforma entrada saida situacao observacoes');
    for (const key of ['valorBrutoCentavos','taxaPlataformaCentavos','outrasDespesasCentavos']) cents(b[key]);
    validateBookingInput({ ...b, valorBruto: moneyInput(b.valorBrutoCentavos), taxaPlataforma: moneyInput(b.taxaPlataformaCentavos), outrasDespesas: moneyInput(b.outrasDespesasCentavos) });
    assertBookingAvailability(b, data.bookings, data.leases, b.id);
  }
  const origins = new Set();
  for (const t of data.transactions) {
    textFields(t, 'tipo categoria descricao vencimento situacaoPersistida origem formaPagamento observacoes'); cents(t.valorCentavos);
    if (t.liquidadoEm !== null && typeof t.liquidadoEm !== 'string') fail('Liquidação deve ser data civil ou null.');
    validateFinancialInput({ ...t, valor: moneyInput(t.valorCentavos) });
    if (t.origem === 'manual') { if (['origemId','periodoReferencia','subtipoOrigem','chaveOrigem'].some(k => t[k] != null)) fail('Lançamento manual com referências geradas.'); }
    else {
      if (!['contrato','reserva'].includes(t.origem)) fail('Origem financeira inválida.');
      const key = createOriginKey(t); if (t.chaveOrigem !== key || origins.has(key)) fail('Referência de origem incorreta ou duplicada.'); origins.add(key);
      const origin = (t.origem === 'contrato' ? maps.leases : maps.bookings).get(t.origemId);
      if (!origin || origin.propriedadeId !== t.propriedadeId) fail('Origem ausente ou de outro imóvel.');
      if (t.tipo !== (t.origem === 'contrato' || t.subtipoOrigem === 'bruto' ? 'receita' : 'despesa')) fail('Tipo incompatível com a origem.');
      if (t.origem === 'reserva' && origin.situacao === 'cancelada' && t.situacaoPersistida !== 'cancelado') fail('Reserva cancelada com lançamento financeiro ativo.');
    }
  }
  for (const p of data.photos) {
    textFields(p, 'categoriaComodo legenda mimeType nomeArquivo'); validatePhotoMetadata(p);
    if (!p.nomeArquivo || p.nomeArquivo.length > 240 || !Number.isSafeInteger(p.originalSize) || p.originalSize <= 0 || p.mimeType !== p.blob?.type) fail('Metadados de foto inválidos.');
    await validateImage(p.blob, p.tamanho, p.width, p.height, PHOTO_LIMITS.imageBytes, PHOTO_LIMITS.imageSide);
    await validateImage(p.thumbnailBlob, p.thumbnailSize, p.thumbnailWidth, p.thumbnailHeight, PHOTO_LIMITS.thumbnailBytes, PHOTO_LIMITS.thumbnailSide);
  }
  return data;
}

async function encodeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { encoding: 'base64', type: blob.type, size: blob.size, data: btoa(binary) };
}
function decodeBlob(value, max) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'data,encoding,size,type' || value.encoding !== 'base64' || !PHOTO_TYPES.includes(value.type) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > max || typeof value.data !== 'string' || value.data.length !== 4 * Math.ceil(value.size / 3) || /[^A-Za-z0-9+/=]/.test(value.data)) fail('Anexo Base64 inválido ou acima do limite.');
  let binary; try { binary = atob(value.data); } catch { fail('Conteúdo Base64 inválido.'); }
  if (binary.length !== value.size || btoa(binary) !== value.data) fail('Tamanho/conteúdo Base64 inválido.');
  return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type: value.type });
}
export async function exportBackup(db = database) {
  const data = await readBackupSnapshot(db); const datasetKind = data.appMeta.find(r => r.id === 'app')?.datasetKind;
  await validateBackupData(data, datasetKind);
  const output = { ...data, photos: [] };
  for (const photo of data.photos) output.photos.push({ ...photo, blob: await encodeBlob(photo.blob), thumbnailBlob: await encodeBlob(photo.thumbnailBlob) });
  const envelope = { application: 'ImobiGest', backupFormatVersion: BACKUP_FORMAT_VERSION, schemaVersion: DB_VERSION, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), datasetKind, counts: Object.fromEntries(STORE_NAMES.map(s => [s, data[s].length])), data: output };
  jsonValue(envelope);
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json;charset=utf-8' });
  if (blob.size > BACKUP_MAX_BYTES) fail('Backup acima do limite suportado de 100 MiB. Nenhum dado foi alterado.');
  return { blob, counts: envelope.counts, datasetKind, stamp: snapshotStamp(data), exportedAt: envelope.exportedAt };
}
export async function prepareBackup(text) {
  if (typeof text !== 'string' || new Blob([text]).size > BACKUP_MAX_BYTES) fail('Selecione um JSON de até 100 MiB.');
  let envelope; try { envelope = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('JSON inválido. Nenhum dado foi alterado.'); }
  jsonValue(envelope);
  if (!plain(envelope) || envelope.application !== 'ImobiGest' || envelope.backupFormatVersion !== BACKUP_FORMAT_VERSION || envelope.schemaVersion !== DB_VERSION || typeof envelope.appVersion !== 'string' || !['real','demo','test'].includes(envelope.datasetKind)) fail('Formato, versão ou identificação de backup incompatível.');
  instant(envelope.exportedAt);
  if (!plain(envelope.data) || !Array.isArray(envelope.data.photos)) fail('Coleções ausentes no backup.');
  if (!plain(envelope.counts) || Object.keys(envelope.counts).length !== STORE_NAMES.length || STORE_NAMES.some(s => !Array.isArray(envelope.data[s]) || envelope.counts[s] !== envelope.data[s].length)) fail('Contagens incompatíveis com as coleções.');
  for (const photo of envelope.data.photos) { if (!plain(photo)) fail('Foto inválida.'); photo.blob = decodeBlob(photo.blob, PHOTO_LIMITS.imageBytes); photo.thumbnailBlob = decodeBlob(photo.thumbnailBlob, PHOTO_LIMITS.thumbnailBytes); }
  await validateBackupData(envelope.data, envelope.datasetKind);
  const info = Object.freeze({ counts: Object.freeze({ ...envelope.counts }), datasetKind: envelope.datasetKind, exportedAt: envelope.exportedAt, bytes: new Blob([text]).size });
  preparedBackups.set(info, envelope.data); return info;
}
export function restoreBackup(prepared, db = database, { confirmed = false, expectedStamp } = {}) {
  const data = preparedBackups.get(prepared);
  if (!data || !confirmed || typeof expectedStamp !== 'string') throw new ValidationError('Valide o arquivo e confirme explicitamente a substituição da base.');
  const targetKind = db.name === DB_NAME ? 'real' : db.name === DEMO_DB_NAME ? 'demo' : 'test';
  if (targetKind !== 'test' && prepared.datasetKind !== targetKind) throw new ValidationError('Backup real e demonstração não podem ser misturados. Ative a base correspondente antes de restaurar.');
  const replacement = { ...data, appMeta: data.appMeta.map(r => r.id === 'app' ? { ...r, datasetKind: targetKind, demoMode: targetKind === 'demo', restoreEpoch: createId() } : r) };
  return db.runTransaction([...STORE_NAMES], 'readwrite', tx => readAll(tx, current => {
    if (snapshotStamp(current) !== expectedStamp) throw new DatabaseError('CONFLICT', 'A base mudou após a prévia/backup anterior. Exporte uma nova cópia e confirme novamente. Nada foi substituído.');
    for (const store of STORE_NAMES) { tx.request(tx.store(store).clear(), () => {}); for (const row of replacement[store]) tx.request(tx.store(store).add(row), () => {}); }
    tx.result(prepared.counts);
  }));
}
