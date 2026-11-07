import { createDatabase, STORE_NAMES } from '../js/db.js';
import { createId, parseBRL, formatBRL, addCentavos, subtractCentavos, addCivilDays, daysBetween, formatCivilDate } from '../js/utils.js';
import { createPropertyService, filterProperties } from '../js/imoveis.js';
import { createFinancialService } from '../js/financeiro-service.js';
import { calculateFinancialSummary } from '../js/financeiro-calculos.js';
import { createLeaseService } from '../js/alugueis-service.js';
import { createBookingService, bookingMonth } from '../js/reservas-service.js';
import { createPhotoService } from '../js/galeria-service.js';
import { preparePhoto } from '../js/galeria-imagens.js';
import { buildDashboard } from '../js/dashboard-calculos.js';
import { buildReport } from '../js/relatorios-calculos.js';
import { exportBackup, prepareBackup, restoreBackup, readBackupSnapshot, snapshotStamp } from '../js/backup.js';
import { el, confirmAction } from '../js/ui.js';

const assert = (value, message = 'Resultado inesperado') => { if (!value) throw new Error(message); };
const equal = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `Esperado ${JSON.stringify(b)}; obtido ${JSON.stringify(a)}`);
async function rejects(work, code) { let error; try { await work(); } catch (e) { error = e; } assert(error, 'A operação deveria ser recusada'); if (code) equal(error.code, code); }
const propertyInput = (nome = 'Casa A', tipo = 'casa') => ({ nome, tipo, finalidade: 'temporada', endereco: 'Rua de teste, 1', cidade: 'Fortaleza', uf: 'CE', situacaoManual: 'disponivel' });
const financialInput = patch => ({ tipo: 'receita', categoria: 'Teste', descricao: 'Lançamento de regressão', valor: '2.500,00', vencimento: '2026-10-10', liquidadoEm: '', situacaoPersistida: 'pendente', ...patch });
const bookingInput = (id, entrada = '2026-11-10', saida = '2026-11-13') => ({ propriedadeId: id, hospede: 'Hóspede de teste', plataforma: 'direta', entrada, saida, valorBruto: '900,00', taxaPlataforma: '90,00', outrasDespesas: '30,00', situacao: 'confirmada' });

// Nenhum serviço usa a instância global. As duas bases são descartáveis e
// removidas em finally, mesmo quando uma asserção falha.
export async function runStage11Tests(onResult = () => {}) {
  const results = []; const names = [0, 1].map(() => `imobigest-test-review-${createId()}`);
  const [db, target] = names.map(name => createDatabase({ name }));
  const properties = createPropertyService(db), finance = createFinancialService(db), leases = createLeaseService(db), bookings = createBookingService(db), photos = createPhotoService(db);
  const test = async (name, work) => { let result; try { await work(); result = { name, passed: true }; } catch (e) { result = { name, passed: false, error: e.message }; } results.push(result); onResult(result); };
  const snapshot = () => readBackupSnapshot(db);
  let a, b, c, lease, booking, paid, file, photoRows;
  try {
    await test('Textos secundários têm contraste mínimo 4,5 sobre seus fundos claros', () => {
      const host = el('div'); document.body.append(host);
      const luminance = rgb => { const values = rgb.match(/[\d.]+/g).slice(0, 3).map(v => Number(v) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return values.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0); };
      try {
        for (const [className, background] of [['metric-caption', '#ffffff'], ['app-footer', '#f5f7f9'], ['eyebrow', '#f5f7f9'], ['workspace-label', '#ffffff'], ['field-hint', '#f5f7f9'], ['property-cover', '#eaf1ed']]) {
          const node = el('p', className, 'Texto de conferência'); node.style.backgroundColor = background; host.append(node); const style = getComputedStyle(node); const a = luminance(style.color), b = luminance(style.backgroundColor); assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `Contraste insuficiente: ${className}`);
        }
      } finally { host.remove(); }
    });
    await test('Centavos: 2.001 valores com sinal fazem ida/volta BRL exata e soma sem frações', () => {
      for (let n = -1000; n <= 1000; n++) { equal(parseBRL(formatBRL(n), { allowNegative: true }), n); equal(subtractCentavos(addCentavos(n, 123456), 123456), n); }
    });
    await test('Datas: cada virada mensal entre 1900 e 2100 conserva ordinal e formatação civil', () => {
      for (let year = 1900; year <= 2100; year++) for (let month = 1; month <= 12; month++) { const first = `${year}-${String(month).padStart(2, '0')}-01`; const previous = addCivilDays(first, -1); equal(addCivilDays(previous, 1), first); equal(daysBetween(previous, first), 1); equal(formatCivilDate(first), `01/${String(month).padStart(2, '0')}/${year}`); }
    });
    await test('Datas absurdas e entradas monetárias ambíguas são recusadas', async () => {
      for (const value of ['0000-01-01', '10000-01-01', '2026-02-29', '2026-11-31', '2026-13-01', '2026-11-05T00:00:00Z']) await rejects(() => formatCivilDate(value));
      for (const value of ['', 'NaN', 'Infinity', '1e3', '1.23', '1,234', 'R$ <script>', '9'.repeat(50)]) await rejects(() => parseBRL(value));
    });
    await test('ID de edição vazio/null/false/zero nunca cria um imóvel', async () => {
      const before = await properties.list();
      for (const id of ['', null, false, 0]) await rejects(() => properties.save(propertyInput(), { id, expectedRevision: 0 }));
      equal(await properties.list(), before);
    });
    await test('Três imóveis distintos, busca/filtro e edição sem misturar registros', async () => {
      a = await properties.save(propertyInput()); b = await properties.save(propertyInput('Apartamento B', 'apartamento')); c = await properties.save(propertyInput('Sala C', 'sala_comercial'));
      const beforeB = await properties.get(b.id); a = await properties.save({ ...propertyInput(), endereco: 'Rua editada, 50' }, { id: a.id, expectedRevision: a.revisao });
      equal(await properties.get(b.id), beforeB); equal(filterProperties(await properties.list(), { nome: 'casa a' }).map(p => p.id), [a.id]); equal(filterProperties(await properties.list(), { tipo: 'apartamento' }).map(p => p.id), [b.id]);
    });
    await test('Contrato gera novembro/dezembro uma vez, inclusive com duas solicitações concorrentes', async () => {
      lease = await leases.save({ propriedadeId: a.id, locatario: 'Locatário A', inicio: '2026-11-01', fim: '2026-12-31', valorMensal: '2.500,00', diaVencimento: '10', situacao: 'ativo' });
      await Promise.all([leases.generate(lease.id, '2026-11', '2026-12', lease.revisao), leases.generate(lease.id, '2026-11', '2026-12', lease.revisao)]);
      const rows = await leases.installments(lease.id); equal(rows.length, 2); equal(calculateFinancialSummary(rows).receitaRealizada, 0);
    });
    await test('Receber parcela atualiza o mesmo ID; despesa paga e pendente resultam em 1870 realizado', async () => {
      const row = (await leases.installments(lease.id)).find(r => r.periodoReferencia === '2026-11');
      paid = await finance.save({ ...row, valor: '2.500,00', situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-05' }, { id: row.id, expectedRevision: row.revisao }); equal(paid.id, row.id);
      await finance.save(financialInput({ propriedadeId: a.id, tipo: 'despesa', valor: '630,00', situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-05' }));
      await finance.save(financialInput({ propriedadeId: a.id, tipo: 'despesa', valor: '100,00', vencimento: '2026-11-20' }));
      equal((await leases.installments(lease.id)).length, 2); equal(calculateFinancialSummary(await finance.list(), { propriedadeId: a.id, mes: '2026-11' }).resultadoRealizado, 187000);
    });
    await test('Financeiro, Dashboard e Relatórios concordam; geral e outro imóvel ficam isolados', async () => {
      await finance.save(financialInput({ tipo: 'despesa', valor: '20,00', situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-06' }));
      const data = await snapshot(); const period = { inicio: '2026-11-01', fim: '2026-11-30' };
      equal(buildDashboard(data, { ...period, preset: 'personalizado', propertyId: a.id }).totals.resultadoRealizado, 187000);
      equal(buildReport(data, { ...period, propertyId: a.id }).totals.resultadoRealizado, 187000);
      equal(buildReport(data, period).totals.resultadoRealizado, 185000);
      equal(buildReport(data, { ...period, propertyId: b.id }).totals.resultadoRealizado, 0);
      equal(buildReport(data, { inicio: '2026-10-01', fim: '2026-10-31' }).totals.resultadoRealizado, 0);
    });
    await test('Reservas: três noites, sobreposição bloqueada, adjacência e outro imóvel permitidos', async () => {
      booking = await bookings.save(bookingInput(b.id));
      await rejects(() => bookings.save(bookingInput(b.id, '2026-11-12', '2026-11-15')), 'OVERLAP');
      await bookings.save(bookingInput(b.id, '2026-11-13', '2026-11-15')); await bookings.save(bookingInput(c.id));
      const calendar = bookingMonth('2026-11', [booking]); equal(calendar.days.filter(d => d.bookings.length).length, 3);
      await rejects(() => bookings.save(bookingInput(a.id)), 'LEASE_CONFLICT');
    });
    await test('Gerar reserva repetidamente só produz três pendências e nunca receita realizada', async () => {
      await Promise.all([bookings.generate(booking.id, {}, booking.revisao), bookings.generate(booking.id, {}, booking.revisao)]);
      const rows = await bookings.transactions(booking.id); equal(rows.length, 3); equal(calculateFinancialSummary(rows).resultadoRealizado, 0);
    });
    await test('Cancelar reserva exige consentimento das pendências e libera calendário preservando IDs', async () => {
      const preview = await bookings.cancellationPreview(booking.id); const ids = (await bookings.transactions(booking.id)).map(r => r.id);
      await rejects(() => bookings.cancel(booking.id, booking.revisao, { financialStamp: preview.financialStamp }), 'CONFIRM_REQUIRED');
      await bookings.cancel(booking.id, booking.revisao, { financialStamp: preview.financialStamp, cancelPending: true });
      const rows = await bookings.transactions(booking.id); equal(rows.map(r => r.id), ids); assert(rows.every(r => r.situacaoPersistida === 'cancelado'));
      equal(bookingMonth('2026-11', [await bookings.get(booking.id)]).days.filter(d => d.bookings.length).length, 0);
    });
    await test('Imóvel com relações não é apagado; liquidado não é excluído nem cancelado', async () => {
      await rejects(() => properties.remove(a.id), 'LINKED'); await rejects(() => finance.remove(paid.id, paid.revisao), 'LOCKED'); await rejects(() => finance.cancel(paid.id, paid.revisao), 'LOCKED'); assert(await properties.get(a.id));
    });
    await test('JPEG/PNG/WebP: três fotos na Casa A e duas no Apartamento B, isoladas por ID', async () => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16; canvas.getContext('2d').fillRect(0, 0, 24, 16);
      const prepared = [];
      for (const type of ['image/jpeg', 'image/png', 'image/webp']) { const blob = await new Promise(resolve => canvas.toBlob(resolve, type)); equal(blob.type, type); prepared.push(await preparePhoto(new File([blob], 'mesmo-nome', { type }))); }
      photoRows = await photos.addBatch(a.id, prepared); await photos.addBatch(b.id, prepared.slice(0, 2).map(p => ({ ...p, id: createId() })));
      equal((await photos.page({ propertyId: a.id })).total, 3); equal((await photos.page({ propertyId: b.id })).total, 2); assert(new Set((await db.list('photos')).map(p => p.id)).size === 5);
    });
    await test('Capa persiste ao reabrir; excluir limpa referência sem apagar imóvel ou outra foto', async () => {
      const photo = photoRows[0]; await photos.setCover(photo.id, a.id, photo.revisao); db.close(); equal((await properties.get(a.id)).coverPhotoId, photo.id);
      await rejects(() => photos.setCover(photo.id, b.id, photo.revisao), 'PROPERTY');
      await photos.remove(photo.id, a.id, photo.revisao); assert(!(await properties.get(a.id)).coverPhotoId); equal((await photos.page({ propertyId: b.id })).total, 2);
      await photos.setCover(photoRows[1].id, a.id, photoRows[1].revisao);
    });
    await test('MIME falso e SVG com script são recusados sem gravar foto', async () => {
      const before = snapshotStamp(await snapshot());
      for (const type of ['image/png', 'image/svg+xml', 'text/html']) await rejects(() => preparePhoto(new File(['<svg onload="window.__reviewXss=1"/>'], 'foto.png', { type })));
      equal(snapshotStamp(await snapshot()), before);
    });
    await test('Texto malicioso mantém conteúdo literal, inclusive após persistir e exportar', async () => {
      const payload = '<img src=x onerror="window.__reviewXss=1">'; const p = await properties.save({ ...propertyInput(payload), descricao: '<script>window.__reviewXss=1</script>' });
      const node = el('div', '', p.nome); document.body.append(node); try { equal(node.textContent, payload); equal(node.childElementCount, 0); assert(!window.__reviewXss); } finally { node.remove(); }
      file = await exportBackup(db); const data = JSON.parse(await file.blob.text()).data; equal(data.properties.find(r => r.id === p.id).nome, payload);
    });
    await test('Backup com referência quebrada é recusado e conserva toda a fonte', async () => {
      const before = snapshotStamp(await snapshot()); const broken = JSON.parse(await file.blob.text()); broken.data.properties[0].coverPhotoId = 'foto-inexistente';
      await rejects(() => prepareBackup(JSON.stringify(broken))); equal(snapshotStamp(await snapshot()), before);
    });
    await test('Backup completo restaura e compara registros, IDs e bytes dos dois Blobs em base limpa', async () => {
      const prepared = await prepareBackup(await file.blob.text()); await restoreBackup(prepared, target, { confirmed: true, expectedStamp: snapshotStamp(await readBackupSnapshot(target)) });
      const original = await snapshot(), restored = await readBackupSnapshot(target);
      for (const s of STORE_NAMES.filter(s => s !== 'appMeta')) {
        equal(restored[s], original[s]);
        if (s === 'photos') for (let i = 0; i < original.photos.length; i++) for (const key of ['blob', 'thumbnailBlob']) equal([...new Uint8Array(await restored.photos[i][key].arrayBuffer())], [...new Uint8Array(await original.photos[i][key].arrayBuffer())]);
      }
    });
    await test('Confirmações simultâneas têm rótulos próprios, cancelamento seguro e foco inicial em Cancelar', async () => {
      const first = confirmAction({ title: 'Primeira confirmação', description: 'Primeira ação' }); const second = confirmAction({ title: 'Segunda confirmação', description: 'Segunda ação' });
      const dialogs = [...document.querySelectorAll('dialog.confirmation-dialog')];
      let labels, focused;
      try { labels = dialogs.map(d => document.getElementById(d.getAttribute('aria-labelledby')).textContent); focused = document.activeElement === dialogs[1].querySelector('.button-secondary'); }
      finally { for (const d of dialogs.reverse()) d.close('cancel'); }
      equal(await first, false); equal(await second, false); equal(labels, ['Primeira confirmação', 'Segunda confirmação']); assert(focused);
    });
  } finally {
    db.close(); target.close();
    await test('Limpeza somente das duas bases descartáveis da revisão', async () => {
      for (const name of names) await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Banco de teste bloqueado')); });
    });
  }
  return results;
}
