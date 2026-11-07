import { ValidationError, assertCentavos, addCentavos, subtractCentavos, parseCivilDate, dueDateForMonth, todayCivil } from './utils.js';

export function financialStatus(record, today = todayCivil()) {
  parseCivilDate(today);
  if (!['pendente', 'liquidado', 'cancelado'].includes(record.situacaoPersistida)) throw new ValidationError('Situação financeira inválida.');
  parseCivilDate(record.vencimento);
  return record.situacaoPersistida === 'pendente' && record.vencimento < today ? 'atrasado' : record.situacaoPersistida;
}

// A mesma data governa a seleção da lista e as somas do resumo.
export function financialDate(record) {
  const date = record.situacaoPersistida === 'liquidado' ? record.liquidadoEm : record.vencimento;
  parseCivilDate(date);
  return date;
}

export function filterTransactions(records, filters = {}, today = todayCivil()) {
  let { inicio = '', fim = '', mes = '' } = filters;
  parseCivilDate(today);
  if (mes) { inicio = dueDateForMonth(mes, 1); fim = dueDateForMonth(mes, 31); }
  if (inicio) parseCivilDate(inicio);
  if (fim) parseCivilDate(fim);
  if (inicio && fim && inicio > fim) throw new ValidationError('O início do período deve ser anterior ou igual ao fim.');
  const selected = records.filter((record) => {
    if (filters.propriedadeId !== undefined && record.propriedadeId !== filters.propriedadeId) return false;
    if (filters.tipo && record.tipo !== filters.tipo) return false;
    if (filters.categoria && record.categoria !== filters.categoria) return false;
    const status = financialStatus(record, today);
    if (filters.situacao && (filters.situacao === 'em_aberto' ? !['pendente', 'atrasado'].includes(status) : status !== filters.situacao)) return false;
    const date = financialDate(record);
    return (!inicio || date >= inicio) && (!fim || date <= fim);
  });
  const key = filters.ordenacao === 'vencimento' ? (row) => row.vencimento : financialDate;
  return selected.sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
}

export function calculateFinancialSummary(records, filters = {}, today = todayCivil()) {
  const rows = filterTransactions(records, filters, today);
  const totals = { receitaRealizada: 0, despesaRealizada: 0, resultadoRealizado: 0, aReceber: 0, aPagar: 0, receitaAtrasada: 0, despesaAtrasada: 0 };
  for (const row of rows) {
    if (row.situacaoPersistida === 'cancelado') continue;
    if (!['receita', 'despesa'].includes(row.tipo) || assertCentavos(row.valorCentavos) <= 0) throw new ValidationError('Lançamento com tipo ou valor inválido.');
    const revenue = row.tipo === 'receita';
    const key = row.situacaoPersistida === 'liquidado' ? (revenue ? 'receitaRealizada' : 'despesaRealizada') : (revenue ? 'aReceber' : 'aPagar');
    totals[key] = addCentavos(totals[key], row.valorCentavos);
    if (financialStatus(row, today) === 'atrasado') {
      const overdue = revenue ? 'receitaAtrasada' : 'despesaAtrasada';
      totals[overdue] = addCentavos(totals[overdue], row.valorCentavos);
    }
  }
  totals.resultadoRealizado = subtractCentavos(totals.receitaRealizada, totals.despesaRealizada);
  return totals;
}

// Agregações reutilizam o mesmo recorte e a mesma soma do Financeiro.
// Map evita colisões entre IDs/categorias e nomes como "__proto__".
export function groupFinancialSummary(records, groupKey, filters = {}, today = todayCivil(), seedKeys = []) {
  if (typeof groupKey !== 'function' || !Array.isArray(seedKeys)) throw new ValidationError('Agrupamento financeiro inválido.');
  const groups = new Map(seedKeys.map((key) => [key, []]));
  for (const row of filterTransactions(records, filters, today)) {
    if (row.situacaoPersistida === 'cancelado') continue;
    const key = groupKey(row);
    if (key !== null && typeof key !== 'string') throw new ValidationError('A chave do agrupamento deve ser texto ou null.');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, rows]) => ({ key, count: rows.length, totals: calculateFinancialSummary(rows, {}, today) }));
}
