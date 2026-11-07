import { database, DatabaseError } from './db.js';
import { ValidationError, validateId, createId, parseBRL, formatBRL, assertCentavos, subtractCentavos, calculateNights, parseCivilDate, dueDateForMonth, daysInMonth, civilToOrdinal } from './utils.js';
import { createOriginKey } from './financeiro-service.js';

export const BOOKING_STATUSES = Object.freeze({ confirmada: 'Confirmada', concluida: 'Concluída', cancelada: 'Cancelada' });
export const PLATFORMS = Object.freeze({ airbnb: 'Airbnb', booking: 'Booking', direta: 'Direta', outras: 'Outros' });
export const BOOKING_AMOUNTS = Object.freeze({ bruto: 'valorBrutoCentavos', taxa: 'taxaPlataformaCentavos', outras: 'outrasDespesasCentavos' });
export const CHARGE_LABELS = Object.freeze({ bruto: 'Hospedagem · bruto', taxa: 'Taxa da plataforma', outras: 'Outras despesas' });
export class BookingValidationError extends ValidationError {
  constructor(fields) { super('Revise os campos indicados antes de salvar.'); this.fields = fields; }
}
export const bookingEstimate = (booking) => subtractCentavos(subtractCentavos(booking.valorBrutoCentavos, booking.taxaPlataformaCentavos), booking.outrasDespesasCentavos);
export function validateBookingInput(input) {
  const data = {}; const errors = {};
  data.propriedadeId = input?.propriedadeId;
  try { validateId(data.propriedadeId); } catch { errors.propriedadeId = 'Selecione um imóvel.'; }
  data.hospede = typeof input?.hospede === 'string' ? input.hospede.trim() : '';
  if (!data.hospede || data.hospede.length > 120) errors.hospede = 'Informe o hóspede, com até 120 caracteres.';
  data.observacoes = typeof input?.observacoes === 'string' ? input.observacoes.trim() : '';
  if (data.observacoes.length > 3000) errors.observacoes = 'Use até 3000 caracteres.';
  for (const [key, options] of [['plataforma', PLATFORMS], ['situacao', BOOKING_STATUSES]]) {
    data[key] = input?.[key]; if (!Object.hasOwn(options, data[key] ?? '')) errors[key] = 'Selecione uma opção válida.';
  }
  for (const key of ['entrada', 'saida']) { data[key] = input?.[key]; try { parseCivilDate(data[key]); } catch { errors[key] = 'Informe uma data válida.'; } }
  if (!errors.entrada && !errors.saida) try { calculateNights(data.entrada, data.saida); } catch (error) { errors.saida = error.message; }
  for (const [raw, stored] of [['valorBruto', 'valorBrutoCentavos'], ['taxaPlataforma', 'taxaPlataformaCentavos'], ['outrasDespesas', 'outrasDespesasCentavos']]) {
    try { data[stored] = parseBRL(input?.[raw] ?? ''); if (raw === 'valorBruto' && data[stored] === 0) throw new ValidationError('O valor bruto deve ser maior que zero.'); }
    catch (error) { errors[raw] = error.message; }
  }
  if (!Object.keys(errors).length) try { bookingEstimate(data); } catch (error) { errors.outrasDespesas = error.message; }
  if (Object.keys(errors).length) throw new BookingValidationError(errors);
  return data;
}
function revision(record, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (record.revisao ?? 0)) throw new DatabaseError('CONFLICT', 'A reserva mudou em outra aba. Reabra o cadastro ou refaça a prévia antes de continuar.');
  if (!Number.isSafeInteger(expected + 1)) throw new ValidationError('Revisão acima do limite seguro.');
}
export function assertBookingAvailability(candidate, bookings, leases, ownId) {
  if (candidate.situacao === 'cancelada') return;
  for (const booking of bookings) {
    if (booking.id === ownId || booking.propriedadeId !== candidate.propriedadeId || booking.situacao === 'cancelada') continue;
    calculateNights(booking.entrada, booking.saida);
    if (candidate.entrada < booking.saida && candidate.saida > booking.entrada) throw new DatabaseError('OVERLAP', `Há outra reserva deste imóvel entre ${booking.entrada} e ${booking.saida}. A saída não ocupa a noite desse dia.`);
  }
  for (const lease of leases) {
    if (lease.propriedadeId !== candidate.propriedadeId || lease.situacao === 'cancelado') continue;
    parseCivilDate(lease.inicio); if (lease.fim) parseCivilDate(lease.fim);
    if (candidate.saida > lease.inicio && (!lease.fim || candidate.entrada <= lease.fim)) throw new DatabaseError('LEASE_CONFLICT', 'Há contrato tradicional vigente neste período. Este MVP reserva a unidade inteira; ajuste as datas ou regularize a vigência do contrato em Aluguéis.');
  }
}
function linkedRecords(booking, records) {
  const map = new Map();
  for (const row of records) {
    if (row.origem !== 'reserva' || row.origemId !== booking.id || row.chaveOrigem !== createOriginKey(row) || row.propriedadeId !== booking.propriedadeId || row.tipo !== (row.subtipoOrigem === 'bruto' ? 'receita' : 'despesa') || map.has(row.subtipoOrigem)) throw new DatabaseError('ORIGIN', 'Referências financeiras inconsistentes. A operação foi bloqueada para preservar o histórico.');
    assertCentavos(row.valorCentavos); if (row.valorCentavos <= 0) throw new ValidationError('Lançamento vinculado com valor inválido.');
    if (!['pendente', 'liquidado', 'cancelado'].includes(row.situacaoPersistida)) throw new ValidationError('Situação financeira vinculada inválida.');
    map.set(row.subtipoOrigem, row);
  }
  return map;
}
export function buildBookingPreview(booking, records, dates = {}) {
  validateBookingInput({ ...booking, valorBruto: formatBRL(booking.valorBrutoCentavos), taxaPlataforma: formatBRL(booking.taxaPlataformaCentavos), outrasDespesas: formatBRL(booking.outrasDespesasCentavos) });
  if (booking.situacao === 'cancelada') throw new DatabaseError('CANCELED', 'Reserva cancelada não gera lançamentos.');
  const existing = linkedRecords(booking, records);
  const rows = Object.entries(BOOKING_AMOUNTS).map(([subtipoOrigem, field]) => {
    const vencimento = dates[subtipoOrigem] ?? booking.entrada; parseCivilDate(vencimento);
    const record = existing.get(subtipoOrigem); const planned = booking[field];
    return { subtipoOrigem, planned, suggestedDate: vencimento, state: record ? 'existing' : planned === 0 ? 'zero' : 'new', valorCentavos: record?.valorCentavos ?? planned, vencimento: record?.vencimento ?? vencimento, record };
  });
  return { booking, rows, dates: Object.fromEntries(rows.map((row) => [row.subtipoOrigem, row.suggestedDate])), createCount: rows.filter((row) => row.state === 'new').length, existingCount: existing.size };
}
const stamp = (records) => JSON.stringify(records.map((row) => [row.id, row.revisao ?? 0, row.situacaoPersistida, row.valorCentavos, row.vencimento, row.liquidadoEm]).sort((a, b) => a[0].localeCompare(b[0])));

// Apenas dados civis para o calendário; não depende de horário/fuso local.
export function bookingMonth(month, bookings, leases = [], propertyId = '') {
  const start = dueDateForMonth(month, 1); const { year, month: number } = parseCivilDate(start);
  return { offset: ((civilToOrdinal(start) + 4) % 7 + 7) % 7, days: Array.from({ length: daysInMonth(year, number) }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date, bookings: bookings.filter((row) => row.situacao !== 'cancelada' && (!propertyId || row.propriedadeId === propertyId) && row.entrada <= date && date < row.saida), leases: leases.filter((row) => row.situacao !== 'cancelado' && (!propertyId || row.propriedadeId === propertyId) && row.inicio <= date && (!row.fim || date <= row.fim)) };
  }) };
}
export function shiftBookingMonth(month, delta) {
  dueDateForMonth(month, 1);
  const ordinal = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + delta;
  const result = `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${String(ordinal % 12 + 1).padStart(2, '0')}`;
  dueDateForMonth(result, 1); return result;
}

export function createBookingService(db = database) {
  function withBooking(id, mode, extraStores, work) {
    validateId(id);
    return db.runTransaction(['bookings', 'transactions', ...extraStores], mode, (tx) => {
      tx.request(tx.store('bookings').get(id), (booking) => {
        if (!booking) throw new DatabaseError('NOT_FOUND', 'Reserva não encontrada.');
        tx.request(tx.store('transactions').index('origem').getAll(['reserva', id]), (records) => { linkedRecords(booking, records); work(tx, booking, records); });
      });
    });
  }
  function generate(id, dates, expectedRevision, write) {
    return withBooking(id, write ? 'readwrite' : 'readonly', ['properties'], (tx, booking, records) => {
      if (write) revision(booking, expectedRevision);
      tx.request(tx.store('properties').get(booking.propriedadeId), (property) => {
        if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel da reserva não existe mais.');
        const preview = buildBookingPreview(booking, records, dates);
        if (write) for (const row of preview.rows.filter((item) => item.state === 'new')) {
          const origin = { origem: 'reserva', origemId: id, subtipoOrigem: row.subtipoOrigem, periodoReferencia: null };
          const now = new Date().toISOString();
          const record = { id: createId(), propriedadeId: booking.propriedadeId, tipo: row.subtipoOrigem === 'bruto' ? 'receita' : 'despesa', categoria: CHARGE_LABELS[row.subtipoOrigem], descricao: `${CHARGE_LABELS[row.subtipoOrigem]} · ${booking.hospede}`, valorCentavos: row.valorCentavos, vencimento: row.vencimento, liquidadoEm: null, situacaoPersistida: 'pendente', ...origin, chaveOrigem: createOriginKey(origin), formaPagamento: '', observacoes: '', revisao: 1, criadoEm: now, atualizadoEm: now };
          tx.request(tx.store('transactions').add(record), () => {});
        }
        tx.result(preview);
      });
    });
  }
  return {
    list: () => db.list('bookings'),
    get(id) { validateId(id); return db.get('bookings', id); },
    transactions(id) { validateId(id); return db.queryIndex('transactions', 'origem', ['reserva', id]); },
    preview: (id, dates = {}) => generate(id, dates, undefined, false),
    generate: (id, dates, expectedRevision) => generate(id, dates, expectedRevision, true),
    async save(input, { id, expectedRevision } = {}) {
      const data = validateBookingInput(input); if (id !== undefined) validateId(id);
      return db.runTransaction(['properties', 'bookings', 'leases', 'transactions'], 'readwrite', (tx) => {
        tx.request(tx.store('properties').get(data.propriedadeId), (property) => {
          if (!property) throw new DatabaseError('PROPERTY_NOT_FOUND', 'O imóvel selecionado não existe mais.');
          tx.request(tx.store('bookings').getAll(), (bookings) => {
            const existing = id === undefined ? undefined : bookings.find((row) => row.id === id);
            if (id !== undefined && !existing) throw new DatabaseError('NOT_FOUND', 'Reserva não encontrada.');
            if (existing) revision(existing, expectedRevision);
            if (existing && existing.situacao !== 'cancelada' && data.situacao === 'cancelada') throw new DatabaseError('CANCEL_ACTION', 'Use Cancelar reserva na ficha para revisar os lançamentos associados.');
            if (existing?.situacao === 'cancelada' && ['propriedadeId', 'entrada', 'saida', 'situacao', ...Object.values(BOOKING_AMOUNTS)].some((key) => data[key] !== existing[key])) throw new DatabaseError('LOCKED', 'Reserva cancelada preserva imóvel, datas, valores e situação. Reativação não está disponível.');
            tx.request(tx.store('leases').index('propriedadeId').getAll(data.propriedadeId), (leases) => {
              assertBookingAvailability(data, bookings, leases, id);
              function persist(records) {
                if (existing) linkedRecords(existing, records);
                if (records.length && data.propriedadeId !== existing.propriedadeId) throw new DatabaseError('LINKED', 'O imóvel não pode mudar após gerar lançamentos.');
                const now = new Date().toISOString(); const saved = { ...(existing || { id: createId(), criadoEm: now }), ...data, atualizadoEm: now, revisao: existing ? expectedRevision + 1 : 1 };
                tx.request(tx.store('bookings')[existing ? 'put' : 'add'](saved), () => tx.result(saved));
              }
              if (existing) tx.request(tx.store('transactions').index('origem').getAll(['reserva', id]), persist); else persist([]);
            });
          });
        });
      });
    },
    cancellationPreview(id) {
      return withBooking(id, 'readonly', [], (tx, booking, records) => tx.result({ booking, paid: records.filter((row) => row.situacaoPersistida === 'liquidado').length, pending: records.filter((row) => row.situacaoPersistida === 'pendente').length, financialStamp: stamp(records) }));
    },
    cancel(id, expectedRevision, { cancelPending = false, financialStamp } = {}) {
      return withBooking(id, 'readwrite', [], (tx, booking, records) => {
        revision(booking, expectedRevision);
        if (records.some((row) => row.situacaoPersistida === 'liquidado')) throw new DatabaseError('PAID', 'Cancelamento bloqueado: há lançamentos liquidados. Eles foram preservados. Consulte-os no Financeiro; estorno/regularização de valores liquidados não está disponível nesta etapa.');
        if (financialStamp !== stamp(records)) throw new DatabaseError('CONFLICT', 'Os lançamentos mudaram desde a confirmação. Revise o cancelamento novamente.');
        const pending = records.filter((row) => row.situacaoPersistida === 'pendente');
        if (pending.length && !cancelPending) throw new DatabaseError('CONFIRM_REQUIRED', 'Confirme explicitamente o cancelamento de todos os lançamentos pendentes junto com a reserva. Nada foi alterado.');
        const now = new Date().toISOString();
        for (const record of pending) {
          const nextRevision = (record.revisao ?? 0) + 1; if (!Number.isSafeInteger(nextRevision)) throw new ValidationError('Revisão financeira acima do limite.');
          tx.request(tx.store('transactions').put({ ...record, situacaoPersistida: 'cancelado', liquidadoEm: null, revisao: nextRevision, atualizadoEm: now }), () => {});
        }
        const updated = { ...booking, situacao: 'cancelada', revisao: expectedRevision + 1, atualizadoEm: now };
        tx.request(tx.store('bookings').put(updated), () => tx.result(updated));
      });
    },
    remove(id, expectedRevision) {
      validateId(id);
      return db.runTransaction(['bookings', 'transactions'], 'readwrite', (tx) => tx.request(tx.store('bookings').get(id), (record) => {
        if (!record) { tx.result(false); return; } revision(record, expectedRevision);
        tx.request(tx.store('transactions').index('origem').count(['reserva', id]), (count) => {
          if (count) throw new DatabaseError('LINKED', 'Reserva com lançamentos não pode ser excluída, inclusive se cancelados. Use o cancelamento com preservação de histórico.');
          tx.request(tx.store('bookings').delete(id), () => tx.result(true));
        });
      }));
    },
  };
}
