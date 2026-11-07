import { createDatabase } from '../js/db.js';
import { createId, formatBRL } from '../js/utils.js';
import { createLeaseService, validateLeaseInput, monthsInRange, buildChargePreview, assertLeaseAvailability } from '../js/alugueis-service.js';
import { createFinancialService } from '../js/financeiro-service.js';
import { calculateFinancialSummary } from '../js/financeiro-calculos.js';
import { createPropertyService } from '../js/imoveis.js';
import { matchLeaseRoute } from '../js/alugueis.js';

const assert = (value, message = 'Resultado inesperado.') => { if (!value) throw new Error(message); };
const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), `Esperado ${JSON.stringify(expected)}; obtido ${JSON.stringify(actual)}`);
async function rejects(work, code) { let error; try { await work(); } catch (caught) { error = caught; } assert(error, 'A operação deveria falhar.'); if (code) equal(error.code, code); return error; }
const input = (patch = {}) => ({ propriedadeId: 'casa-a', locatario: 'Ana', inicio: '2026-11-01', fim: '2027-04-30', valorMensal: '2.500,00', diaVencimento: '31', situacao: 'ativo', observacoes: '', ...patch });
const editable = (lease, patch = {}) => ({ ...lease, valorMensal: formatBRL(lease.valorMensalCentavos), ...patch });
const sum = (rows) => calculateFinancialSummary(rows, {}, '2026-12-01');

export async function runStage05Tests(onResult = () => {}) {
  const name = `imobigest-test-leases-${createId()}`; const db = createDatabase({ name }); const second = createDatabase({ name });
  const service = createLeaseService(db); const other = createLeaseService(second); const finance = createFinancialService(db);
  const results = [];
  async function test(name, work) { let result; try { await work(); result = { name, passed: true }; } catch (error) { result = { name, passed: false, error: error.message }; } results.push(result); onResult(result); }
  let a; let b;
  try {
    for (const id of ['casa-a', 'casa-b', 'casa-c', 'casa-d', 'casa-e']) await db.add('properties', { id, nome: id });
    await test('Obrigatórios, valor positivo, datas, dia 1–31 e situação são validados', async () => {
      const error = await rejects(() => service.save(input({ propriedadeId: '', locatario: '', inicio: '2026-02-29', fim: '', valorMensal: '0', diaVencimento: '32', situacao: 'encerrado' })));
      for (const key of ['propriedadeId', 'locatario', 'inicio', 'fim', 'valorMensal', 'diaVencimento']) assert(error.fields[key]);
      for (const patch of [{ fim: '2026-10-31' }, { diaVencimento: '1.5' }, { diaVencimento: '1e1' }, { valorMensal: '-1,00' }, { situacao: 'outra' }]) await rejects(() => validateLeaseInput(input(patch)));
      equal((await service.list()).length, 0);
    });
    await test('Cadastro exige imóvel existente e mantém centavos, ID e revisão', async () => {
      await rejects(() => service.save(input({ propriedadeId: 'ausente' })), 'PROPERTY_NOT_FOUND');
      a = await service.save(input()); equal(a.valorMensalCentavos, 250000); equal(a.revisao, 1); assert(a.id);
      db.close(); equal(await service.get(a.id), a);
    });
    await test('Prévia novembro/dezembro não grava; mostra duas parcelas pendentes', async () => {
      const preview = await service.preview(a.id, '2026-11', '2026-12');
      equal(preview.createCount, 2); equal(preview.totalCentavos, 500000); equal(preview.rows.map((r) => r.vencimento), ['2026-11-30', '2026-12-31']);
      equal((await service.installments(a.id)).length, 0);
    });
    await test('Geração cria duas receitas pendentes únicas; realizado continua zero', async () => {
      const result = await service.generate(a.id, '2026-11', '2026-12', a.revisao); equal(result.createCount, 2);
      const rows = await service.installments(a.id); equal(rows.length, 2);
      for (const row of rows) { equal(row.situacaoPersistida, 'pendente'); equal(row.liquidadoEm, null); equal(row.origemId, a.id); equal(row.chaveOrigem, `contrato:${a.id}:${row.periodoReferencia}`); }
      equal(sum(rows).receitaRealizada, 0); equal(sum(rows).aReceber, 500000);
    });
    await test('Repetição ignora existentes, mantém IDs e informa quantidade', async () => {
      const before = await service.installments(a.id); const result = await service.generate(a.id, '2026-11', '2026-12', a.revisao);
      equal(result.createCount, 0); equal(result.existingCount, 2); equal(await service.installments(a.id), before);
    });
    await test('Receber novembro atualiza a mesma transação e preserva dezembro previsto', async () => {
      const rows = await service.installments(a.id); const november = rows.find((r) => r.periodoReferencia === '2026-11');
      const paid = await finance.save({ ...november, valor: formatBRL(november.valorCentavos), situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-05' }, { id: november.id, expectedRevision: november.revisao });
      equal(paid.id, november.id); const after = await service.installments(a.id); equal(after.length, 2); equal(sum(after).receitaRealizada, 250000); equal(sum(after).aReceber, 250000);
      equal(after.find((r) => r.periodoReferencia === '2026-12').situacaoPersistida, 'pendente');
    });
    await test('Dia 31 ajusta fevereiro comum/bissexto e abril; intervalo cruza anos', () => {
      const lease = { ...a, inicio: '2027-01-01', fim: '2028-04-30' };
      const rows = buildChargePreview(lease, [], '2027-02', '2028-04').rows;
      equal(rows.find((r) => r.periodoReferencia === '2027-02').vencimento, '2027-02-28');
      equal(rows.find((r) => r.periodoReferencia === '2028-02').vencimento, '2028-02-29');
      equal(rows.find((r) => r.periodoReferencia === '2028-04').vencimento, '2028-04-30');
      equal(monthsInRange('2026-12', '2027-01'), ['2026-12', '2027-01']);
    });
    await test('Meses fora da vigência são ignorados; pontas têm valor integral e data limitada', () => {
      const lease = { ...a, inicio: '2026-11-20', fim: '2026-12-10', diaVencimento: 5 };
      const preview = buildChargePreview(lease, [], '2026-10', '2027-01'); equal(preview.outsideCount, 2); equal(preview.createCount, 2);
      equal(preview.rows[1].vencimento, '2026-11-20'); equal(preview.rows[1].valorCentavos, 250000);
      equal(buildChargePreview({ ...lease, diaVencimento: 31 }, [], '2026-12', '2026-12').rows[0].vencimento, '2026-12-10');
    });
    await test('Intervalo invertido, inválido, muito longo e overflow são recusados', async () => {
      for (const range of [['2026-12', '2026-11'], ['2026-13', '2026-13'], ['2020-01', '2030-01']]) await rejects(() => monthsInRange(...range));
      equal(monthsInRange('0001-01', '0001-01'), ['0001-01']); equal(monthsInRange('9999-12', '9999-12'), ['9999-12']);
      await rejects(() => buildChargePreview({ ...a, valorMensalCentavos: Number.MAX_SAFE_INTEGER }, [], '2026-11', '2026-12'));
    });
    await test('Imóvel e início ficam protegidos após emissão; cancelar contrato com parcelas é bloqueado', async () => {
      for (const patch of [{ propriedadeId: 'casa-b' }, { inicio: '2026-11-02' }, { situacao: 'cancelado' }]) await rejects(() => service.save(editable(a, patch), { id: a.id, expectedRevision: a.revisao }), 'LINKED');
      await rejects(() => createPropertyService(db).remove('casa-a'), 'LINKED'); equal(await service.get(a.id), a);
    });
    await test('Alterar valor/dia não reescreve emitidas e invalida prévia antiga', async () => {
      const before = await service.installments(a.id); const preview = await service.preview(a.id, '2027-01', '2027-01');
      a = await service.save(editable(a, { valorMensal: '2.600,01', diaVencimento: '10' }), { id: a.id, expectedRevision: a.revisao });
      equal(await service.installments(a.id), before);
      await rejects(() => service.generate(a.id, preview.start, preview.end, preview.lease.revisao), 'CONFLICT');
      const next = await service.preview(a.id, '2027-01', '2027-01'); equal(next.rows[0].valorCentavos, 260001); equal(next.rows[0].vencimento, '2027-01-10');
    });
    await test('Encerramento preserva recebido e pendente posterior ao fim; não gera fora', async () => {
      const before = await service.installments(a.id);
      a = await service.save(editable(a, { situacao: 'encerrado', fim: '2026-11-30' }), { id: a.id, expectedRevision: a.revisao });
      equal(await service.installments(a.id), before);
      const preview = await service.generate(a.id, '2026-11', '2027-01', a.revisao); equal(preview.createCount, 0); equal(preview.existingCount, 2); equal(preview.outsideCount, 1);
      equal(sum(await service.installments(a.id)).receitaRealizada, 250000);
      await rejects(() => service.save(editable(a, { situacao: 'ativo' }), { id: a.id, expectedRevision: a.revisao }), 'LOCKED');
    });
    await test('Contrato encerrado pode emitir competências históricas ausentes dentro da vigência', async () => {
      const lease = await service.save(input({ propriedadeId: 'casa-c', situacao: 'encerrado', fim: '2026-12-31' }));
      equal((await service.generate(lease.id, '2026-11', '2026-12', lease.revisao)).createCount, 2);
    });
    await test('Geração concorrente por duas conexões continua única e atômica', async () => {
      b = await service.save(input({ propriedadeId: 'casa-b', fim: '' }));
      const results = await Promise.all([service.generate(b.id, '2026-11', '2026-12', b.revisao), other.generate(b.id, '2026-11', '2026-12', b.revisao)]);
      equal(results.map((r) => r.createCount).sort(), [0, 2]); equal((await service.installments(b.id)).length, 2);
    });
    await test('Duas edições da mesma revisão: uma salva e a outra recebe CONFLICT', async () => {
      const attempts = await Promise.allSettled([service.save(editable(b, { observacoes: 'A' }), { id: b.id, expectedRevision: b.revisao }), other.save(editable(b, { observacoes: 'B' }), { id: b.id, expectedRevision: b.revisao })]);
      equal(attempts.filter((r) => r.status === 'fulfilled').length, 1); equal(attempts.find((r) => r.status === 'rejected').reason.code, 'CONFLICT'); b = await service.get(b.id);
    });
    await test('Parcela cancelada conserva chave e não reaparece na geração', async () => {
      const row = (await service.installments(b.id))[0]; await finance.cancel(row.id, row.revisao);
      const result = await service.generate(b.id, '2026-11', '2026-12', b.revisao); equal(result.createCount, 0); equal(result.existingCount, 2); equal((await service.installments(b.id)).length, 2);
    });
    await test('Falha após inserções aborta o lote inteiro sem parcelas parciais', async () => {
      const lease = await service.save(input({ propriedadeId: 'casa-d' })); let inserts = 0;
      const failingDB = { ...db, runTransaction(stores, mode, work) { return db.runTransaction(stores, mode, (tx) => work({ ...tx, request(request, callback) { return tx.request(request, (result) => { if (request.source?.name === 'transactions' && ++inserts === 2) throw new DOMException('Teste de quota', 'QuotaExceededError'); callback?.(result); }); } })); } };
      await rejects(() => createLeaseService(failingDB).generate(lease.id, '2026-11', '2026-12', lease.revisao), 'QUOTA'); equal((await service.installments(lease.id)).length, 0);
    });
    await test('Cancelar sem parcelas impede geração e não altera outros contratos', async () => {
      const canceled = await service.save(input({ propriedadeId: 'casa-e', situacao: 'cancelado' }));
      await rejects(() => service.preview(canceled.id, '2026-11', '2026-12'), 'CANCELED');
      await rejects(() => service.generate(canceled.id, '2026-11', '2026-12', canceled.revisao), 'CANCELED');
      equal((await service.installments(a.id)).length, 2);
    });
    await test('Contratos sobrepostos são bloqueados; vigências consecutivas são permitidas', async () => {
      await rejects(() => service.save(input({ fim: '2026-11-20' })), 'OCCUPIED');
      const next = await service.save(input({ inicio: '2026-12-01', fim: '2026-12-31', locatario: 'Outro locatário' })); assert(next.id !== a.id);
      await rejects(() => service.save(input({ inicio: '2026-11-30', fim: '2026-11-30' })), 'OCCUPIED');
    });
    await test('Reservas confirmadas/concluídas bloqueiam; checkout no início e canceladas não', async () => {
      const candidate = validateLeaseInput(input({ propriedadeId: 'casa-e', inicio: '2026-11-10', fim: '2026-11-20' }));
      const booking = { id: 'booking-test', propriedadeId: 'casa-e', entrada: '2026-11-09', saida: '2026-11-11', situacao: 'confirmada' };
      for (const situacao of ['confirmada', 'concluida']) await rejects(() => assertLeaseAvailability(candidate, [], [{ ...booking, situacao }]), 'OCCUPIED');
      assertLeaseAvailability(candidate, [], [{ ...booking, saida: '2026-11-10' }]);
      assertLeaseAvailability(candidate, [], [{ ...booking, situacao: 'cancelada' }]);
      await db.add('bookings', booking);
      await rejects(() => service.save(input({ propriedadeId: 'casa-e', inicio: candidate.inicio, fim: candidate.fim })), 'OCCUPIED');
      assert(await db.get('bookings', booking.id));
    });
    await test('Referência corrompida impede duplicação; origem imóvel divergente é recusada', async () => {
      const row = (await service.installments(a.id))[0];
      await rejects(() => buildChargePreview(a, [{ ...row, chaveOrigem: undefined }], '2026-11', '2026-12'), 'ORIGIN');
      await rejects(() => buildChargePreview(a, [{ ...row, propriedadeId: 'casa-b' }], '2026-11', '2026-12'), 'ORIGIN');
    });
    await test('Contrato ausente/ID inválido não cria cobranças; reabrir preserva histórico', async () => {
      await rejects(() => service.generate('ausente', '2026-11', '2026-12', 0), 'NOT_FOUND');
      await rejects(() => service.get('ID inválido')); const before = await service.installments(a.id);
      db.close(); equal(await service.installments(a.id), before); equal(await service.get(a.id), a);
    });
    await test('Rotas selecionam criação por imóvel, ficha e edição corretas', () => {
      equal(matchLeaseRoute('/alugueis'), { mode: 'list' });
      equal(matchLeaseRoute('/alugueis/novo?imovel=casa-a'), { mode: 'new', propertyId: 'casa-a' });
      equal(matchLeaseRoute('/alugueis/id-a'), { mode: 'detail', id: 'id-a' });
      equal(matchLeaseRoute('/alugueis/id-a/editar'), { mode: 'edit', id: 'id-a' });
      equal(matchLeaseRoute('/alugueis/id-a/extra'), null);
    });
  } finally {
    db.close(); second.close();
    await test('Limpeza apenas do banco isolado de contratos desta execução', () => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Banco de teste bloqueado.')); }));
  }
  return results;
}
