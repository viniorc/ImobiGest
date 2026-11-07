import { createDatabase } from '../js/db.js';
import { createId, formatBRL, calculateNights } from '../js/utils.js';
import { createBookingService, validateBookingInput, bookingEstimate, buildBookingPreview, bookingMonth, shiftBookingMonth } from '../js/reservas-service.js';
import { createFinancialService } from '../js/financeiro-service.js';
import { createLeaseService } from '../js/alugueis-service.js';
import { calculateFinancialSummary } from '../js/financeiro-calculos.js';
import { createPropertyService } from '../js/imoveis.js';
import { matchBookingRoute } from '../js/reservas.js';

const assert = (value, message = 'Resultado inesperado.') => { if (!value) throw new Error(message); };
const equal = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `Esperado ${JSON.stringify(b)}; obtido ${JSON.stringify(a)}`);
async function rejects(work, code) { let error; try { await work(); } catch (e) { error = e; } assert(error, 'Deveria falhar.'); if (code) equal(error.code, code); return error; }
const input = (patch = {}) => ({ propriedadeId: 'casa-a', hospede: 'Ana', plataforma: 'airbnb', entrada: '2026-11-10', saida: '2026-11-13', valorBruto: '1.234,56', taxaPlataforma: '234,55', outrasDespesas: '100,01', situacao: 'confirmada', observacoes: '', ...patch });
const editable = (b, patch = {}) => ({ ...b, valorBruto: formatBRL(b.valorBrutoCentavos), taxaPlataforma: formatBRL(b.taxaPlataformaCentavos), outrasDespesas: formatBRL(b.outrasDespesasCentavos), ...patch });
const leaseInput = (patch = {}) => ({ propriedadeId: 'casa-c', locatario: 'Locatário', inicio: '2026-11-01', fim: '2026-11-10', valorMensal: '2.500,00', diaVencimento: '5', situacao: 'ativo', observacoes: '', ...patch });
const sum = (rows) => calculateFinancialSummary(rows, {}, '2026-11-15');

export async function runStage06Tests(onResult = () => {}) {
  const name = `imobigest-test-bookings-${createId()}`; const db = createDatabase({ name }); const second = createDatabase({ name });
  const service = createBookingService(db); const other = createBookingService(second); const finance = createFinancialService(db); const leases = createLeaseService(second);
  const results = []; let a; let b;
  async function test(name, work) { let result; try { await work(); result = { name, passed: true }; } catch (error) { result = { name, passed: false, error: error.message }; } results.push(result); onResult(result); }
  async function cancel(booking, consent = true) { const preview = await service.cancellationPreview(booking.id); return service.cancel(booking.id, booking.revisao, { cancelPending: consent, financialStamp: preview.financialStamp }); }
  try {
    for (const id of ['casa-a', 'casa-b', 'casa-c', 'casa-d', 'casa-e', 'casa-f']) await db.add('properties', { id, nome: id });
    await test('Obrigatórios, datas, saída posterior, plataforma e BRL são validados', async () => {
      for (const patch of [{ hospede: '' }, { propriedadeId: '' }, { plataforma: 'remota' }, { entrada: '2026-02-29' }, { saida: '2026-11-10' }, { saida: '2026-11-09' }, { valorBruto: '0' }, { taxaPlataforma: '-1,00' }, { outrasDespesas: '' }, { situacao: 'pendente' }]) await rejects(() => validateBookingInput(input(patch)));
      equal((await service.list()).length, 0);
    });
    await test('10–13/11 são 3 noites e estimativa usa centavos; resultado negativo é permitido', () => {
      equal(calculateNights('2026-11-10', '2026-11-13'), 3); equal(bookingEstimate(validateBookingInput(input())), 90000);
      equal(bookingEstimate(validateBookingInput(input({ valorBruto: '1,00', taxaPlataforma: '2,00', outrasDespesas: '0' }))), -100);
      equal(calculateNights('2028-02-28', '2028-03-01'), 2); equal(calculateNights('2026-12-31', '2027-01-01'), 1);
    });
    await test('Cadastro exige imóvel existente; persiste ID, revisão e dados civis', async () => {
      await rejects(() => service.save(input({ propriedadeId: 'ausente' })), 'PROPERTY_NOT_FOUND'); a = await service.save(input()); equal(a.revisao, 1); equal(a.valorBrutoCentavos, 123456);
      db.close(); equal(await service.get(a.id), a);
    });
    await test('12–15 sobrepõe; 13–15 é permitido; outro imóvel aceita mesmas datas', async () => {
      await rejects(() => service.save(input({ entrada: '2026-11-12', saida: '2026-11-15' })), 'OVERLAP');
      const next = await service.save(input({ entrada: '2026-11-13', saida: '2026-11-15', situacao: 'concluida' })); assert(next.id);
      await rejects(() => service.save(input({ entrada: '2026-11-14', saida: '2026-11-16' })), 'OVERLAP'); b = await service.save(input({ propriedadeId: 'casa-b' }));
    });
    await test('Editar ignora a própria reserva e rejeita revisão antiga', async () => {
      const before = a; a = await service.save(editable(a, { observacoes: '<img src=x onerror=alert(1)>' }), { id: a.id, expectedRevision: a.revisao });
      equal(a.observacoes, '<img src=x onerror=alert(1)>'); await rejects(() => service.save(editable(before), { id: a.id, expectedRevision: before.revisao }), 'CONFLICT');
    });
    await test('Prévia não grava: bruto e duas despesas pendentes, datas explícitas', async () => {
      const preview = await service.preview(a.id, { bruto: '2026-12-05' }); equal(preview.createCount, 3); equal(preview.rows[0].vencimento, '2026-12-05'); equal((await service.transactions(a.id)).length, 0);
    });
    await test('Geração cria 3 referências únicas e não altera caixa realizado', async () => {
      await service.generate(a.id, { bruto: '2026-12-05' }, a.revisao); const rows = await service.transactions(a.id); equal(rows.length, 3);
      for (const r of rows) { equal(r.chaveOrigem, `reserva:${a.id}:${r.subtipoOrigem}`); equal(r.situacaoPersistida, 'pendente'); equal(r.liquidadoEm, null); }
      equal(sum(rows).receitaRealizada, 0); equal(sum(rows).despesaRealizada, 0); equal(sum(rows).aReceber, 123456); equal(sum(rows).aPagar, 33456);
    });
    await test('Repetir preserva IDs, valores, datas e informa 3 existentes', async () => {
      const before = await service.transactions(a.id); const result = await service.generate(a.id, {}, a.revisao); equal(result.createCount, 0); equal(result.existingCount, 3); equal(await service.transactions(a.id), before);
    });
    await test('Liquidação atualiza a mesma receita uma vez e usa mês da liquidação', async () => {
      const row = (await service.transactions(a.id)).find((r) => r.subtipoOrigem === 'bruto');
      const paid = await finance.save({ ...row, valor: formatBRL(row.valorCentavos), situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-13' }, { id: row.id, expectedRevision: row.revisao }); equal(paid.id, row.id);
      await service.generate(a.id, {}, a.revisao); const rows = await service.transactions(a.id); equal(rows.length, 3); equal(sum(rows).receitaRealizada, 123456);
      equal(calculateFinancialSummary(rows, { mes: '2026-12' }).receitaRealizada, 0);
    });
    await test('Cancelar com liquidado é bloqueado; nenhuma reserva/transação muda', async () => {
      const before = await service.transactions(a.id); await rejects(() => cancel(a), 'PAID'); equal(await service.get(a.id), a); equal(await service.transactions(a.id), before);
    });
    await test('Referências geradas e exclusão com vínculos são protegidas', async () => {
      await rejects(() => service.remove(a.id, a.revisao), 'LINKED'); await rejects(() => createPropertyService(db).remove('casa-a'), 'LINKED');
      await rejects(() => service.save(editable(a, { propriedadeId: 'casa-d' }), { id: a.id, expectedRevision: a.revisao }), 'LINKED');
      const row = (await service.transactions(a.id)).find((r) => r.subtipoOrigem === 'taxa');
      await rejects(() => finance.save({ ...row, valor: formatBRL(row.valorCentavos), subtipoOrigem: 'outras' }, { id: row.id, expectedRevision: row.revisao }), 'ORIGIN');
      await rejects(() => buildBookingPreview(a, [{ ...row, chaveOrigem: 'incorreta' }]), 'ORIGIN');
    });
    await test('Edição negociada não reescreve emitidos e invalida prévia antiga', async () => {
      const before = await service.transactions(a.id); const previous = a; a = await service.save(editable(a, { valorBruto: '1.500,00' }), { id: a.id, expectedRevision: a.revisao }); equal(await service.transactions(a.id), before);
      await rejects(() => service.generate(a.id, {}, previous.revisao), 'CONFLICT'); const preview = await service.preview(a.id); equal(preview.rows[0].planned, 150000); equal(preview.rows[0].valorCentavos, 123456);
    });
    await test('Duas conexões gerando simultaneamente continuam únicas', async () => {
      const attempts = await Promise.all([service.generate(b.id, {}, b.revisao), other.generate(b.id, {}, b.revisao)]); equal(attempts.map((r) => r.createCount).sort(), [0, 3]); equal((await service.transactions(b.id)).length, 3);
    });
    await test('Sem consentimento explícito, cancelar pendências não altera nada', async () => {
      const before = await service.transactions(b.id); await rejects(() => cancel(b, false), 'CONFIRM_REQUIRED'); equal(await service.get(b.id), b); equal(await service.transactions(b.id), before);
      await rejects(() => service.save(editable(b, { situacao: 'cancelada' }), { id: b.id, expectedRevision: b.revisao }), 'CANCEL_ACTION');
    });
    await test('Cancelamento consentido é atômico, libera noites e preserva chaves/histórico', async () => {
      const before = await service.transactions(b.id); b = await cancel(b); equal(b.situacao, 'cancelada'); const rows = await service.transactions(b.id); equal(rows.map((r) => r.id), before.map((r) => r.id));
      assert(rows.every((r) => r.situacaoPersistida === 'cancelado')); equal(sum(rows).aReceber, 0); equal(sum(rows).aPagar, 0);
      equal(bookingMonth('2026-11', [b]).days[9].bookings.length, 0); await service.save(input({ propriedadeId: 'casa-b' }));
      await rejects(() => service.generate(b.id, {}, b.revisao), 'CANCELED'); await rejects(() => service.remove(b.id, b.revisao), 'LINKED');
    });
    await test('Cancelada preserva datas/valor/status; editar notas não reativa', async () => {
      await rejects(() => service.save(editable(b, { situacao: 'confirmada' }), { id: b.id, expectedRevision: b.revisao }), 'LOCKED');
      b = await service.save(editable(b, { observacoes: 'Histórico preservado' }), { id: b.id, expectedRevision: b.revisao }); equal(b.situacao, 'cancelada');
    });
    await test('Contrato bloqueia unidade inteira inclusive último dia; saída no início é permitida', async () => {
      await leases.save(leaseInput()); await rejects(() => service.save(input({ propriedadeId: 'casa-c' })), 'LEASE_CONFLICT');
      const next = await service.save(input({ propriedadeId: 'casa-c', entrada: '2026-11-11', saida: '2026-11-13' })); assert(next.id);
      const previous = await service.save(input({ propriedadeId: 'casa-c', entrada: '2026-10-30', saida: '2026-11-01' })); assert(previous.id);
      await rejects(() => leases.save(leaseInput({ inicio: '2026-11-12', fim: '2026-11-15' })), 'OCCUPIED');
    });
    await test('Criação concorrente de contrato/reserva conflitantes aceita apenas um', async () => {
      const attempts = await Promise.allSettled([service.save(input({ propriedadeId: 'casa-d' })), leases.save(leaseInput({ propriedadeId: 'casa-d', fim: '2026-12-31' }))]); equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
      assert(['LEASE_CONFLICT', 'OCCUPIED'].includes(attempts.find((r) => r.status === 'rejected').reason.code));
    });
    await test('Duas reservas concorrentes sobrepostas aceitam somente uma', async () => {
      const attempts = await Promise.allSettled([service.save(input({ propriedadeId: 'casa-e' })), other.save(input({ propriedadeId: 'casa-e' }))]); equal(attempts.filter((r) => r.status === 'fulfilled').length, 1); equal(attempts.find((r) => r.status === 'rejected').reason.code, 'OVERLAP');
    });
    await test('Despesas zero não geram registros; cancelado financeiro não reaparece', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', taxaPlataforma: '0', outrasDespesas: '0' })); const result = await service.generate(booking.id, {}, booking.revisao); equal(result.createCount, 1);
      const row = (await service.transactions(booking.id))[0]; await finance.cancel(row.id, row.revisao); equal((await service.generate(booking.id, {}, booking.revisao)).createCount, 0);
    });
    await test('Mudança financeira após confirmação exige nova revisão do cancelamento', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', entrada: '2026-12-01', saida: '2026-12-02' })); const preview = await service.cancellationPreview(booking.id);
      await service.generate(booking.id, {}, booking.revisao); await rejects(() => service.cancel(booking.id, booking.revisao, { cancelPending: true, financialStamp: preview.financialStamp }), 'CONFLICT'); equal((await service.get(booking.id)).situacao, 'confirmada');
    });
    await test('Pagamento entre prévia e cancelamento bloqueia sem perder a liquidação', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', entrada: '2026-12-03', saida: '2026-12-04' })); await service.generate(booking.id, {}, booking.revisao); const preview = await service.cancellationPreview(booking.id);
      const row = (await service.transactions(booking.id))[0]; await finance.save({ ...row, valor: formatBRL(row.valorCentavos), situacaoPersistida: 'liquidado', liquidadoEm: '2026-12-04' }, { id: row.id, expectedRevision: row.revisao });
      await rejects(() => service.cancel(booking.id, booking.revisao, { cancelPending: true, financialStamp: preview.financialStamp }), 'PAID'); equal((await finance.get(row.id)).situacaoPersistida, 'liquidado');
    });
    await test('Quota após inserção reverte todo o lote de geração', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', entrada: '2026-12-05', saida: '2026-12-06' }));
      const failing = { ...db, runTransaction(stores, mode, work) { return db.runTransaction(stores, mode, (tx) => work({ ...tx, request(request, callback) { return tx.request(request, (result) => { if (request.source?.name === 'transactions') throw new DOMException('Quota simulada', 'QuotaExceededError'); callback?.(result); }); } })); } };
      await rejects(() => createBookingService(failing).generate(booking.id, {}, booking.revisao), 'QUOTA'); equal((await service.transactions(booking.id)).length, 0);
    });
    await test('Falha ao cancelar primeira transação reverte também reserva e demais pendências', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', entrada: '2026-12-07', saida: '2026-12-08' })); await service.generate(booking.id, {}, booking.revisao); const rows = await service.transactions(booking.id); const preview = await service.cancellationPreview(booking.id);
      const failing = { ...db, runTransaction(stores, mode, work) { return db.runTransaction(stores, mode, (tx) => work({ ...tx, request(request, callback) { return tx.request(request, (result) => { if (request.source?.name === 'transactions') throw new DOMException('Quota simulada', 'QuotaExceededError'); callback?.(result); }); } })); } };
      await rejects(() => createBookingService(failing).cancel(booking.id, booking.revisao, { cancelPending: true, financialStamp: preview.financialStamp }), 'QUOTA'); equal(await service.transactions(booking.id), rows); equal(await service.get(booking.id), booking);
    });
    await test('Calendário civil respeita checkout, mês bissexto, ano e filtro por imóvel', () => {
      const month = bookingMonth('2026-11', [a, b]); equal(month.offset, 0); equal(month.days.length, 30); equal(month.days[9].bookings.map((r) => r.id), [a.id]); equal(month.days[12].bookings.length, 0);
      equal(bookingMonth('2026-11', [a], [], 'casa-b').days[9].bookings.length, 0); equal(bookingMonth('2028-02', []).days.length, 29); equal(shiftBookingMonth('2026-12', 1), '2027-01'); equal(shiftBookingMonth('2027-01', -1), '2026-12');
    });
    await test('Exclusão sem vínculos é segura; ausente e ID inválido não gravam', async () => {
      const booking = await service.save(input({ propriedadeId: 'casa-f', entrada: '2026-12-09', saida: '2026-12-10' })); equal(await service.remove(booking.id, booking.revisao), true); equal(await service.get(booking.id), undefined); equal(await service.remove(booking.id, 1), false);
      await rejects(() => service.get('inválido')); await rejects(() => service.generate('ausente', {}, 0), 'NOT_FOUND');
    });
    await test('Reabrir conexões preserva reservas, chaves e histórico financeiro', async () => {
      const bookings = await service.list(); const rows = await db.list('transactions'); db.close(); second.close(); equal(await other.list(), bookings); equal(await db.list('transactions'), rows);
    });
    await test('Rotas selecionam lista, criação por imóvel, ficha e edição', () => {
      equal(matchBookingRoute('/reservas'), { mode: 'list' }); equal(matchBookingRoute('/reservas/novo?imovel=casa-a'), { mode: 'new', propertyId: 'casa-a' }); equal(matchBookingRoute('/reservas/id-a'), { mode: 'detail', id: 'id-a' }); equal(matchBookingRoute('/reservas/id-a/editar'), { mode: 'edit', id: 'id-a' }); equal(matchBookingRoute('/reservas/id-a/extra'), null);
    });
  } finally {
    db.close(); second.close(); await test('Limpeza apenas do banco isolado de reservas desta execução', () => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Banco bloqueado.')); }));
  }
  return results;
}
