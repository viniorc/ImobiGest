import { database, DatabaseError } from './db.js';
import { ValidationError, validateId, createId, parseBRL, formatBRL, parseCivilDate, dueDateForMonth, addCentavos } from './utils.js';
import { createOriginKey } from './financeiro-service.js';

export const LEASE_STATUSES = Object.freeze({ ativo: 'Ativo', encerrado: 'Encerrado', cancelado: 'Cancelado' });
export class LeaseValidationError extends ValidationError {
  constructor(fields) { super('Revise os campos indicados antes de salvar.'); this.fields = fields; }
}
export function validateLeaseInput(input) {
  const data = {}; const fields = {};
  data.propriedadeId = input?.propriedadeId;
  try { validateId(data.propriedadeId); } catch { fields.propriedadeId = 'Selecione um imóvel.'; }
  data.locatario = typeof input?.locatario === 'string' ? input.locatario.trim() : '';
  if (!data.locatario || data.locatario.length > 120) fields.locatario = 'Informe o locatário, com até 120 caracteres.';
  data.observacoes = typeof input?.observacoes === 'string' ? input.observacoes.trim() : '';
  if (data.observacoes.length > 3000) fields.observacoes = 'Use até 3000 caracteres nas observações.';
  data.inicio = input?.inicio; data.fim = input?.fim || null;
  try { parseCivilDate(data.inicio); } catch { fields.inicio = 'Informe uma data inicial válida.'; }
  if (data.fim) {
    try { parseCivilDate(data.fim); } catch { fields.fim = 'Informe uma data final válida.'; }
    if (!fields.inicio && !fields.fim && data.fim < data.inicio) fields.fim = 'O fim não pode ser anterior ao início.';
  }
  data.situacao = input?.situacao;
  if (!Object.hasOwn(LEASE_STATUSES, data.situacao ?? '')) fields.situacao = 'Selecione uma situação válida.';
  if (data.situacao === 'encerrado' && !data.fim) fields.fim = 'Informe a data final para encerrar o contrato.';
  try { data.valorMensalCentavos = parseBRL(input?.valorMensal); if (data.valorMensalCentavos <= 0) throw new ValidationError('Informe um valor mensal maior que zero.'); }
  catch (error) { fields.valorMensal = error.message; }
  const day = String(input?.diaVencimento ?? '');
  data.diaVencimento = Number(day);
  if (!/^\d{1,2}$/.test(day) || data.diaVencimento < 1 || data.diaVencimento > 31) fields.diaVencimento = 'Informe um dia inteiro de 1 a 31.';
  if (Object.keys(fields).length) throw new LeaseValidationError(fields);
  return data;
}

function checkRevision(lease, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== (lease.revisao ?? 0)) throw new DatabaseError('CONFLICT', 'Este contrato mudou em outra aba. Reabra o cadastro ou refaça a prévia antes de continuar.');
  if (!Number.isSafeInteger(expectedRevision + 1)) throw new ValidationError('Revisão acima do limite seguro.');
}

// Política local do MVP: unidade inteira. Contrato inclui início/fim;
// reserva ocupa [entrada, saída). Não é uma regra universal de locação.
export function assertLeaseAvailability(candidate, leases, bookings, ownId) {
  if (candidate.situacao === 'cancelado') return;
  for (const lease of leases) {
    if (lease.id === ownId || lease.propriedadeId !== candidate.propriedadeId || lease.situacao === 'cancelado') continue;
    parseCivilDate(lease.inicio); if (lease.fim) parseCivilDate(lease.fim);
    if ((!candidate.fim || lease.inicio <= candidate.fim) && (!lease.fim || candidate.inicio <= lease.fim)) throw new DatabaseError('OCCUPIED', `A vigência conflita com outro contrato deste imóvel (${lease.locatario}). Ajuste as datas; a unidade é inteira neste MVP.`);
  }
  for (const booking of bookings) {
    if (booking.propriedadeId !== candidate.propriedadeId || !['confirmada', 'concluida'].includes(booking.situacao)) continue;
    parseCivilDate(booking.entrada); parseCivilDate(booking.saida);
    if ((!candidate.fim || booking.entrada <= candidate.fim) && booking.saida > candidate.inicio) throw new DatabaseError('OCCUPIED', 'A vigência conflita com uma reserva confirmada/concluída deste imóvel. Ajuste as datas; nenhum dado foi alterado.');
  }
}

export function monthsInRange(start, end) {
  dueDateForMonth(start, 1); dueDateForMonth(end, 1);
  const ordinal = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
  const first = ordinal(start); const last = ordinal(end);
  if (last < first) throw new ValidationError('O mês final deve ser igual ou posterior ao inicial.');
  if (last - first >= 120) throw new ValidationError('Gere no máximo 120 meses por vez. Divida intervalos maiores.');
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const value = first + index;
    return `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
  });
}

export function buildChargePreview(lease, transactions, start, end) {
  validateId(lease.id);
  validateLeaseInput({ ...lease, valorMensal: formatBRL(lease.valorMensalCentavos) });
  if (lease.situacao === 'cancelado') throw new DatabaseError('CANCELED', 'Contrato cancelado não gera cobranças.');
  const existing = new Map();
  for (const record of transactions) {
    if (record.origem !== 'contrato' || record.origemId !== lease.id) continue;
    if (record.chaveOrigem !== createOriginKey(record) || record.propriedadeId !== lease.propriedadeId || record.tipo !== 'receita' || existing.has(record.periodoReferencia)) throw new DatabaseError('ORIGIN', 'Há parcelas com referências inconsistentes. A geração foi bloqueada para evitar duplicação.');
    existing.set(record.periodoReferencia, record);
  }
  const rows = monthsInRange(start, end).map((periodoReferencia) => {
    const from = dueDateForMonth(periodoReferencia, 1); const to = dueDateForMonth(periodoReferencia, 31);
    const outside = to < lease.inicio || Boolean(lease.fim && from > lease.fim);
    const record = existing.get(periodoReferencia);
    if (record) return { periodoReferencia, state: 'existing', outside, record, vencimento: record.vencimento, valorCentavos: record.valorCentavos };
    if (outside) return { periodoReferencia, state: 'outside' };
    let vencimento = dueDateForMonth(periodoReferencia, lease.diaVencimento);
    if (vencimento < lease.inicio) vencimento = lease.inicio;
    if (lease.fim && vencimento > lease.fim) vencimento = lease.fim;
    return { periodoReferencia, state: 'new', vencimento, valorCentavos: lease.valorMensalCentavos };
  });
  const newRows = rows.filter((row) => row.state === 'new');
  return { lease, start, end, rows, createCount: newRows.length, existingCount: rows.filter((row) => row.state === 'existing').length, outsideCount: rows.filter((row) => row.state === 'outside').length, totalCentavos: newRows.reduce((total, row) => addCentavos(total, row.valorCentavos), 0) };
}

export function createLeaseService(db = database) {
  function generation(id, start, end, expectedRevision, write) {
    validateId(id); monthsInRange(start, end);
    return db.runTransaction(['leases', 'transactions', 'properties'], write ? 'readwrite' : 'readonly', (tx) => {
      tx.request(tx.store('leases').get(id), (lease) => {
        if (!lease) throw new DatabaseError('NOT_FOUND', 'Contrato não encontrado.');
        if (write) checkRevision(lease, expectedRevision);
        tx.request(tx.store('properties').get(lease.propriedadeId), (property) => {
          if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel do contrato não existe. Nenhuma cobrança foi gerada.');
          tx.request(tx.store('transactions').index('origem').getAll(['contrato', id]), (records) => {
            const preview = buildChargePreview(lease, records, start, end);
            if (write) {
              const now = new Date().toISOString();
              for (const row of preview.rows.filter((item) => item.state === 'new')) {
                const origin = { origem: 'contrato', origemId: id, periodoReferencia: row.periodoReferencia, subtipoOrigem: 'aluguel' };
                const record = { id: createId(), propriedadeId: lease.propriedadeId, tipo: 'receita', categoria: 'Aluguel', descricao: `Aluguel ${row.periodoReferencia} · ${lease.locatario}`, valorCentavos: row.valorCentavos, vencimento: row.vencimento, liquidadoEm: null, situacaoPersistida: 'pendente', ...origin, chaveOrigem: createOriginKey(origin), formaPagamento: '', observacoes: '', criadoEm: now, atualizadoEm: now, revisao: 1 };
                tx.request(tx.store('transactions').add(record), () => {});
              }
            }
            tx.result(preview);
          });
        });
      });
    });
  }
  return {
    list: () => db.list('leases'),
    get(id) { validateId(id); return db.get('leases', id); },
    installments(id) { validateId(id); return db.queryIndex('transactions', 'origem', ['contrato', id]); },
    preview: (id, start, end) => generation(id, start, end, undefined, false),
    generate: (id, start, end, expectedRevision) => generation(id, start, end, expectedRevision, true),
    async save(input, { id, expectedRevision } = {}) {
      const data = validateLeaseInput(input);
      if (id !== undefined) validateId(id);
      return db.runTransaction(['leases', 'properties', 'transactions', 'bookings'], 'readwrite', (tx) => {
        tx.request(tx.store('properties').get(data.propriedadeId), (property) => {
          if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel selecionado não existe mais.');
          tx.request(tx.store('leases').getAll(), (leases) => {
            const existing = id === undefined ? undefined : leases.find((lease) => lease.id === id);
            if (id !== undefined && !existing) throw new DatabaseError('NOT_FOUND', 'Contrato não encontrado.');
            if (existing) checkRevision(existing, expectedRevision);
            if (existing && existing.situacao !== 'ativo' && data.situacao !== existing.situacao) throw new DatabaseError('LOCKED', 'Contratos encerrados ou cancelados não podem ser reativados nesta etapa.');
            tx.request(tx.store('bookings').index('propriedadeId').getAll(data.propriedadeId), (bookings) => {
              assertLeaseAvailability(data, leases, bookings, id);
              function persist(records) {
                if (records.length && existing && (data.propriedadeId !== existing.propriedadeId || data.inicio !== existing.inicio)) throw new DatabaseError('LINKED', 'Imóvel e início não podem mudar após emitir parcelas. O histórico foi preservado.');
                if (records.length && data.situacao === 'cancelado') throw new DatabaseError('LINKED', 'Contrato com parcelas não pode ser cancelado. Use Encerrado com data final; parcelas existentes serão preservadas.');
                const now = new Date().toISOString();
                const lease = { ...(existing || { id: createId(), criadoEm: now }), ...data, atualizadoEm: now, revisao: existing ? expectedRevision + 1 : 1 };
                tx.request(tx.store('leases')[existing ? 'put' : 'add'](lease), () => tx.result(lease));
              }
              if (!existing) persist([]);
              else tx.request(tx.store('transactions').index('origem').getAll(['contrato', id]), persist);
            });
          });
        });
      });
    },
  };
}
