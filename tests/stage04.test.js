import { createDatabase } from '../js/db.js';
import { createId, formatBRL } from '../js/utils.js';
import { createFinancialService, validateFinancialInput, createOriginKey } from '../js/financeiro-service.js';
import { calculateFinancialSummary, filterTransactions, financialStatus } from '../js/financeiro-calculos.js';
import { createPropertyService } from '../js/imoveis.js';

function assert(value, message = 'Resultado inesperado.') { if (!value) throw new Error(message); }
function equal(actual, expected) { assert(JSON.stringify(actual) === JSON.stringify(expected), `Esperado ${JSON.stringify(expected)}; obtido ${JSON.stringify(actual)}`); }
async function rejects(work, code) { let error; try { await work(); } catch (caught) { error = caught; } assert(error, 'A operação deveria falhar.'); if (code) equal(error.code, code); return error; }
const input = (patch = {}) => ({ tipo: 'receita', propriedadeId: 'casa-a', categoria: 'Aluguel', descricao: 'Receita de teste', valor: '2.500,00', vencimento: '2026-10-10', liquidadoEm: '', situacaoPersistida: 'pendente', formaPagamento: 'Pix', observacoes: '', ...patch });
const asInput = (record, patch = {}) => ({ ...record, valor: formatBRL(record.valorCentavos), ...patch });
const today = '2026-11-06';
const sum = (rows, filters = {}) => calculateFinancialSummary(rows, filters, today);

export async function runStage04Tests(onResult = () => {}) {
  const results = []; const name = `imobigest-test-financial-${createId()}`;
  const db = createDatabase({ name }); const second = createDatabase({ name });
  const service = createFinancialService(db); const other = createFinancialService(second);
  async function test(name, work) { let result; try { await work(); result = { name, passed: true }; } catch (error) { result = { name, passed: false, error: error.message }; } results.push(result); onResult(result); }
  let revenue; let expense; let pending;
  try {
    await db.add('properties', { id: 'casa-a', nome: 'Casa A' }); await db.add('properties', { id: 'casa-b', nome: 'Casa B' });
    await test('Valor positivo, campos obrigatórios e datas civis válidas são exigidos', async () => {
      const error = await rejects(() => service.save(input({ valor: '0', descricao: '', categoria: '', vencimento: '2026-02-29', tipo: 'outro' })));
      for (const key of ['valor', 'descricao', 'categoria', 'vencimento', 'tipo']) assert(error.fields[key]);
      for (const valor of ['-1,00', '1,001', '1.23', '90071992547409,92']) await rejects(() => service.save(input({ valor })));
      equal((await service.list()).length, 0);
    });
    await test('Receita pendente de 250000 centavos não compõe realizado', async () => {
      revenue = await service.save(input()); equal(revenue.valorCentavos, 250000);
      equal(sum([revenue]).receitaRealizada, 0); equal(sum([revenue]).aReceber, 250000);
      equal(revenue.origem, 'manual'); equal(revenue.origemId, null); equal(revenue.periodoReferencia, null); assert(!Object.hasOwn(revenue, 'chaveOrigem'));
    });
    await test('Liquidação sem data é rejeitada sem alterar o pendente', async () => {
      await rejects(() => service.save(asInput(revenue, { situacaoPersistida: 'liquidado' }), { id: revenue.id, expectedRevision: revenue.revisao }));
      equal(await service.get(revenue.id), revenue);
    });
    await test('Liquidação em 05/11/2026 atualiza o mesmo ID e mês correto', async () => {
      const id = revenue.id;
      revenue = await service.save(asInput(revenue, { situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-05' }), { id, expectedRevision: revenue.revisao });
      equal(revenue.id, id); equal((await service.list()).length, 1);
      equal(sum([revenue], { mes: '2026-11' }).receitaRealizada, 250000);
      equal(sum([revenue], { mes: '2026-10' }).receitaRealizada, 0); equal(sum([revenue]).aReceber, 0);
    });
    await test('Despesa paga de 63000 resulta em 187000; pendente de 10000 não altera', async () => {
      expense = await service.save(input({ tipo: 'despesa', categoria: 'Manutenção', valor: '630,00', situacaoPersistida: 'liquidado', liquidadoEm: '2026-11-05' }));
      pending = await service.save(input({ tipo: 'despesa', categoria: 'Taxa', valor: '100,00', vencimento: '2026-11-20' }));
      const totals = sum(await service.list(), { mes: '2026-11' });
      equal(totals.receitaRealizada, 250000); equal(totals.despesaRealizada, 63000); equal(totals.resultadoRealizado, 187000); equal(totals.aPagar, 10000);
    });
    await test('Atrasado é derivado; vencimento hoje continua pendente', () => {
      equal(financialStatus({ ...pending, vencimento: '2026-11-05' }, today), 'atrasado');
      equal(financialStatus({ ...pending, vencimento: today }, today), 'pendente');
      equal(financialStatus(revenue, today), 'liquidado');
      assert(!Object.hasOwn(pending, 'atrasado'));
    });
    await test('Situação atrasado não pode ser persistida e pendente não aceita liquidação residual', async () => {
      await rejects(() => service.save(input({ situacaoPersistida: 'atrasado' })));
      await rejects(() => service.save(input({ liquidadoEm: today })));
    });
    await test('Receitas/despesas gerais não são atribuídas a Casa A ou Casa B', async () => {
      const general = await service.save(input({ propriedadeId: '', valor: '10,01', situacaoPersistida: 'liquidado', liquidadoEm: today }));
      const rows = await service.list(); equal(general.propriedadeId, null);
      equal(sum(rows, { propriedadeId: 'casa-a' }).resultadoRealizado, 187000);
      equal(sum(rows, { propriedadeId: 'casa-b' }).receitaRealizada, 0);
      equal(sum(rows, { propriedadeId: null }).receitaRealizada, 1001);
      equal(sum(rows).resultadoRealizado, 188001);
    });
    await test('Todos os filtros combinam sem escrita; período inclusivo e ordenação civil', async () => {
      const rows = await service.list(); const snapshot = JSON.stringify(rows);
      equal(filterTransactions(rows, { propriedadeId: 'casa-a', mes: '2026-11', tipo: 'despesa', categoria: 'Taxa', situacao: 'pendente' }, today).map((r) => r.id), [pending.id]);
      equal(filterTransactions(rows, { inicio: '2026-11-05', fim: '2026-11-05' }, today).length, 2);
      equal(filterTransactions(rows, { mes: '2026-10', situacao: 'liquidado' }, today).length, 0);
      const sorted = filterTransactions(rows, { ordenacao: 'vencimento' }, today).map((r) => r.vencimento);
      equal(sorted, [...sorted].sort()); equal(JSON.stringify(await service.list()), snapshot);
      await rejects(() => filterTransactions(rows, { inicio: '2026-12-01', fim: '2026-11-01' }, today));
    });
    await test('Edição e cancelamento persistem; cancelado não entra em nenhuma soma', async () => {
      pending = await service.save(asInput(pending, { valor: '100,01' }), { id: pending.id, expectedRevision: pending.revisao });
      equal(sum([pending]).aPagar, 10001);
      await rejects(() => service.save(asInput(pending, { situacaoPersistida: 'cancelado' }), { id: pending.id, expectedRevision: pending.revisao }));
      pending = await service.cancel(pending.id, pending.revisao); db.close(); equal(await service.get(pending.id), pending);
      equal(sum([pending]), { receitaRealizada: 0, despesaRealizada: 0, resultadoRealizado: 0, aReceber: 0, aPagar: 0, receitaAtrasada: 0, despesaAtrasada: 0 });
      await rejects(() => service.save(asInput(pending, { situacaoPersistida: 'pendente' }), { id: pending.id, expectedRevision: pending.revisao }), 'LOCKED');
    });
    await test('Liquidados protegem valor, datas, imóvel, tipo, situação e exclusão/cancelamento', async () => {
      for (const patch of [{ valor: '1,00' }, { vencimento: today }, { liquidadoEm: today }, { propriedadeId: 'casa-b' }, { tipo: 'despesa' }, { situacaoPersistida: 'pendente', liquidadoEm: '' }]) {
        await rejects(() => service.save(asInput(revenue, patch), { id: revenue.id, expectedRevision: revenue.revisao }), 'LOCKED');
      }
      await rejects(() => service.cancel(revenue.id, revenue.revisao), 'LOCKED');
      await rejects(() => service.remove(revenue.id, revenue.revisao), 'LOCKED'); equal(await service.get(revenue.id), revenue);
      revenue = await service.save(asInput(revenue, { observacoes: '<script>texto</script>' }), { id: revenue.id, expectedRevision: revenue.revisao }); equal(revenue.observacoes, '<script>texto</script>');
    });
    await test('Excluir pendente manual é permitido; ausente não recria registros', async () => {
      const row = await service.save(input({ propriedadeId: null, valor: '0,01' }));
      equal(await service.remove(row.id, row.revisao), true); equal(await service.remove(row.id, row.revisao), false);
      await rejects(() => service.save(input(), { id: row.id, expectedRevision: row.revisao }), 'NOT_FOUND');
    });
    await test('Imóvel inexistente é recusado; vínculo financeiro bloqueia exclusão do imóvel', async () => {
      await rejects(() => service.save(input({ propriedadeId: 'inexistente' })), 'PROPERTY_NOT_FOUND');
      await rejects(() => createPropertyService(db).remove('casa-a'), 'LINKED'); assert(await db.get('properties', 'casa-a'));
    });
    await test('Duas conexões com a mesma revisão não sobrescrevem silenciosamente', async () => {
      const row = await service.save(input());
      const attempts = await Promise.allSettled([service.save(asInput(row, { valor: '1,00' }), { id: row.id, expectedRevision: row.revisao }), other.save(asInput(row, { valor: '2,00' }), { id: row.id, expectedRevision: row.revisao })]);
      equal(attempts.filter((r) => r.status === 'fulfilled').length, 1); equal(attempts.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
    });
    await test('Chaves contrato/mês e reserva/subtipo são estáveis e validadas', async () => {
      equal(createOriginKey({ origem: 'contrato', origemId: 'lease-a', periodoReferencia: '2026-11', subtipoOrigem: 'aluguel' }), 'contrato:lease-a:2026-11');
      equal(createOriginKey({ origem: 'reserva', origemId: 'booking-a', subtipoOrigem: 'taxa' }), 'reserva:booking-a:taxa');
      await rejects(() => createOriginKey({ origem: 'contrato', origemId: 'lease-a', periodoReferencia: '2026-13', subtipoOrigem: 'aluguel' }));
      await rejects(() => createOriginKey({ origem: 'reserva', origemId: 'booking-a', subtipoOrigem: 'outro' }));
    });
    await test('CRUD manual não permite criar referência gerada nem trocar origem', async () => {
      await rejects(() => service.save(input({ origem: 'contrato', origemId: 'fake' })), 'ORIGIN');
      await rejects(() => service.save(asInput(revenue, { origemId: 'fake' }), { id: revenue.id, expectedRevision: revenue.revisao }), 'ORIGIN');
    });
    await test('Gerados preservam referências e chave única mesmo cancelados', async () => {
      await db.add('leases', { id: 'lease-a', propriedadeId: 'casa-a' });
      const source = { origem: 'contrato', origemId: 'lease-a', periodoReferencia: '2026-11', subtipoOrigem: 'aluguel' };
      let row = { ...validateFinancialInput(input()), ...source, chaveOrigem: createOriginKey(source), id: 'generated-a', revisao: 1 };
      await db.add('transactions', row);
      await rejects(() => db.add('transactions', { ...row, id: 'duplicate-a' }), 'DUPLICATE');
      for (const patch of [{ origemId: 'fake' }, { periodoReferencia: '2026-12' }, { chaveOrigem: 'fake' }, { subtipoOrigem: 'fake' }, { propriedadeId: 'casa-b' }, { tipo: 'despesa' }]) await rejects(() => service.save(asInput(row, patch), { id: row.id, expectedRevision: row.revisao }), 'ORIGIN');
      row = await service.save(asInput(row, { valor: '2.600,00' }), { id: row.id, expectedRevision: row.revisao });
      await rejects(() => service.remove(row.id, row.revisao), 'LOCKED');
      row = await service.cancel(row.id, row.revisao); equal(row.chaveOrigem, createOriginKey(source));
      await rejects(() => db.add('transactions', { ...row, id: 'duplicate-b' }), 'DUPLICATE');
      await rejects(() => service.remove(row.id, row.revisao), 'LOCKED');
    });
    await test('Origem ausente ou imóvel divergente impede edição do gerado', async () => {
      const source = { origem: 'reserva', origemId: 'booking-missing', subtipoOrigem: 'bruto' };
      const row = { ...validateFinancialInput(input()), ...source, chaveOrigem: createOriginKey(source), id: 'orphan', revisao: 1 };
      await db.add('transactions', row);
      await rejects(() => service.save(asInput(row), { id: row.id, expectedRevision: 1 }), 'ORIGIN');
      await db.add('bookings', { id: 'booking-missing', propriedadeId: 'casa-b' });
      await rejects(() => service.save(asInput(row), { id: row.id, expectedRevision: 1 }), 'ORIGIN');
    });
    await test('Centavos permanecem exatos; totais acima do limite são recusados', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({ ...revenue, id: `cent-${i}`, valorCentavos: 1 }));
      equal(sum(rows).receitaRealizada, 100);
      await rejects(() => sum([{ ...revenue, valorCentavos: Number.MAX_SAFE_INTEGER }, { ...revenue, id: 'extra', valorCentavos: 1 }]));
      await rejects(() => sum([{ ...revenue, valorCentavos: 1.5 }]));
    });
    await test('Virada de ano, fevereiro e ausência de liquidação não deslocam períodos', () => {
      const row = { ...revenue, vencimento: '2026-12-31', liquidadoEm: '2027-01-01' };
      equal(sum([row], { mes: '2026-12' }).receitaRealizada, 0); equal(sum([row], { mes: '2027-01' }).receitaRealizada, 250000);
      const leap = { ...row, vencimento: '2028-02-29', liquidadoEm: null, situacaoPersistida: 'pendente' };
      equal(sum([leap], { mes: '2028-02' }).aReceber, 250000);
    });
  } finally {
    db.close(); second.close();
    await test('Limpeza somente do banco financeiro isolado desta execução', () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Banco de teste bloqueado.'));
    }));
  }
  return results;
}
