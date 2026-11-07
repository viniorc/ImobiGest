import { database, DatabaseError } from './db.js';
import { ValidationError, validateId, createId, parseBRL, parseCivilDate, dueDateForMonth } from './utils.js';

export class FinancialValidationError extends ValidationError {
  constructor(fields) { super('Revise os campos indicados antes de salvar.'); this.fields = fields; }
}

export function validateFinancialInput(input) {
  const data = {}; const errors = {};
  for (const [key, label, limit, required] of [['categoria', 'Categoria', 80, true], ['descricao', 'Descrição', 240, true], ['formaPagamento', 'Forma de pagamento', 80, false], ['observacoes', 'Notas', 3000, false]]) {
    data[key] = typeof input?.[key] === 'string' ? input[key].trim() : '';
    if (required && !data[key]) errors[key] = `${label} é obrigatória.`;
    if (data[key].length > limit) errors[key] = `${label}: use até ${limit} caracteres.`;
  }
  data.tipo = input?.tipo;
  if (!['receita', 'despesa'].includes(data.tipo)) errors.tipo = 'Selecione receita ou despesa.';
  data.propriedadeId = input?.propriedadeId === '' || input?.propriedadeId == null ? null : input.propriedadeId;
  try { if (data.propriedadeId !== null) validateId(data.propriedadeId); } catch (error) { errors.propriedadeId = error.message; }
  try {
    data.valorCentavos = parseBRL(input?.valor);
    if (data.valorCentavos <= 0) throw new ValidationError('O valor deve ser maior que zero.');
  } catch (error) { errors.valor = error.message; }
  data.vencimento = input?.vencimento;
  try { parseCivilDate(data.vencimento); } catch { errors.vencimento = 'Informe uma data de vencimento válida.'; }
  data.situacaoPersistida = input?.situacaoPersistida;
  if (!['pendente', 'liquidado', 'cancelado'].includes(data.situacaoPersistida)) errors.situacaoPersistida = 'Selecione uma situação válida; atraso é calculado automaticamente.';
  data.liquidadoEm = input?.liquidadoEm || null;
  if (data.situacaoPersistida === 'liquidado') {
    try { parseCivilDate(data.liquidadoEm); } catch { errors.liquidadoEm = 'Informe a data do recebimento ou pagamento para liquidar.'; }
  } else if (data.liquidadoEm !== null) errors.liquidadoEm = 'Somente um lançamento liquidado pode ter data de recebimento ou pagamento.';
  if (Object.keys(errors).length) throw new FinancialValidationError(errors);
  return data;
}

// Preparação para os módulos de origem. Não gera cobranças ou reservas.
export function createOriginKey({ origem, origemId, periodoReferencia, subtipoOrigem }) {
  validateId(origemId);
  if (origem === 'contrato') {
    dueDateForMonth(periodoReferencia, 1);
    if (subtipoOrigem !== 'aluguel') throw new ValidationError('Subtipo de contrato inválido.');
    return `contrato:${origemId}:${periodoReferencia}`;
  }
  if (origem === 'reserva' && ['bruto', 'taxa', 'outras'].includes(subtipoOrigem) && !periodoReferencia) return `reserva:${origemId}:${subtipoOrigem}`;
  throw new ValidationError('Referência de origem inválida.');
}

const referenceFields = ['origem', 'origemId', 'periodoReferencia', 'subtipoOrigem', 'chaveOrigem'];
const lockedFields = ['tipo', 'propriedadeId', 'valorCentavos', 'vencimento', 'liquidadoEm', 'situacaoPersistida'];
function revisionCheck(record, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (record.revisao ?? 0)) throw new DatabaseError('CONFLICT', 'O lançamento mudou em outra aba. Seus campos foram mantidos; anote as alterações e reabra o registro.');
  if (!Number.isSafeInteger(expected + 1)) throw new ValidationError('Revisão acima do limite seguro.');
}
function verifyOrigin(tx, record, done) {
  if (record.origem === 'manual') {
    if (referenceFields.slice(1).some((key) => record[key] != null)) throw new DatabaseError('ORIGIN', 'Lançamento manual contém referência incompatível.');
    done(); return;
  }
  if (record.chaveOrigem !== createOriginKey(record)) throw new DatabaseError('ORIGIN', 'A referência do lançamento está inconsistente. Nenhuma alteração foi salva.');
  const store = record.origem === 'contrato' ? 'leases' : 'bookings';
  tx.request(tx.store(store).get(record.origemId), (origin) => {
    if (!origin || !record.propriedadeId || origin.propriedadeId !== record.propriedadeId) throw new DatabaseError('ORIGIN', 'A origem não existe ou pertence a outro imóvel.');
    const expectedType = record.origem === 'contrato' || record.subtipoOrigem === 'bruto' ? 'receita' : 'despesa';
    if (record.tipo !== expectedType) throw new DatabaseError('ORIGIN', 'O tipo não corresponde à origem do lançamento.');
    if (record.origem === 'reserva' && origin.situacao === 'cancelada' && record.situacaoPersistida === 'liquidado') throw new DatabaseError('ORIGIN', 'Reserva cancelada não pode receber novos pagamentos. Regularize a origem antes de liquidar.');
    done();
  });
}

export function createFinancialService(db = database) {
  return {
    list: () => db.list('transactions'),
    get(id) { validateId(id); return db.get('transactions', id); },
    async save(input, { id, expectedRevision } = {}) {
      const data = validateFinancialInput(input);
      if (id !== undefined) validateId(id);
      return db.runTransaction(['transactions', 'properties', 'leases', 'bookings'], 'readwrite', (tx) => {
        function write(existing) {
          if (id !== undefined && !existing) throw new DatabaseError('NOT_FOUND', 'Lançamento não encontrado. Volte à lista.');
          if (existing) revisionCheck(existing, expectedRevision);
          for (const key of referenceFields) {
            const expected = existing ? existing[key] : key === 'origem' ? 'manual' : undefined;
            if (Object.hasOwn(input, key) && input[key] !== expected) throw new DatabaseError('ORIGIN', 'Referências de contrato ou reserva não podem ser alteradas no Financeiro.');
          }
          if (!existing && data.situacaoPersistida === 'cancelado') throw new ValidationError('Crie um lançamento pendente ou liquidado.');
          if (existing?.situacaoPersistida === 'pendente' && data.situacaoPersistida === 'cancelado') throw new ValidationError('Use a ação Cancelar lançamento com confirmação.');
          if (existing && existing.situacaoPersistida !== 'pendente' && lockedFields.some((key) => data[key] !== existing[key])) throw new DatabaseError('LOCKED', 'Valor, datas, tipo, imóvel e situação de registros liquidados ou cancelados são preservados. Estorno não está disponível nesta etapa.');
          if (existing && existing.origem !== 'manual' && ['propriedadeId', 'tipo'].some((key) => existing[key] !== data[key])) throw new DatabaseError('ORIGIN', 'O imóvel e o tipo de um lançamento gerado são definidos pela origem.');
          const now = new Date().toISOString();
          const record = { ...(existing || { id: createId(), origem: 'manual', origemId: null, periodoReferencia: null, criadoEm: now }), ...data, revisao: existing ? expectedRevision + 1 : 1, atualizadoEm: now };
          function persist() {
            verifyOrigin(tx, record, () => tx.request(tx.store('transactions')[existing ? 'put' : 'add'](record), () => tx.result(record)));
          }
          if (record.propriedadeId === null) persist();
          else tx.request(tx.store('properties').get(record.propriedadeId), (property) => {
            if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel selecionado não existe mais. Selecione um imóvel disponível ou Geral.');
            persist();
          });
        }
        if (id === undefined) write(); else tx.request(tx.store('transactions').get(id), write);
      });
    },
    async cancel(id, expectedRevision) {
      validateId(id);
      return db.runTransaction(['transactions', 'leases', 'bookings'], 'readwrite', (tx) => {
        tx.request(tx.store('transactions').get(id), (record) => {
          if (!record) throw new DatabaseError('NOT_FOUND', 'Lançamento não encontrado.');
          revisionCheck(record, expectedRevision);
          if (record.situacaoPersistida !== 'pendente') throw new DatabaseError('LOCKED', 'Somente lançamentos pendentes podem ser cancelados.');
          verifyOrigin(tx, record, () => {
            const updated = { ...record, situacaoPersistida: 'cancelado', liquidadoEm: null, revisao: expectedRevision + 1, atualizadoEm: new Date().toISOString() };
            tx.request(tx.store('transactions').put(updated), () => tx.result(updated));
          });
        });
      });
    },
    async remove(id, expectedRevision) {
      validateId(id);
      return db.runTransaction(['transactions'], 'readwrite', (tx) => {
        tx.request(tx.store('transactions').get(id), (record) => {
          if (!record) { tx.result(false); return; }
          revisionCheck(record, expectedRevision);
          if (record.origem !== 'manual' || record.situacaoPersistida !== 'pendente') throw new DatabaseError('LOCKED', 'Somente pendentes manuais podem ser excluídos. Registros gerados, liquidados e cancelados são preservados.');
          tx.request(tx.store('transactions').delete(id), () => tx.result(true));
        });
      });
    },
  };
}
