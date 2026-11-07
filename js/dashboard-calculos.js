import { ValidationError, validateId, parseCivilDate, dueDateForMonth, todayCivil } from './utils.js';
import { calculateFinancialSummary, filterTransactions, financialDate, financialStatus, groupFinancialSummary } from './financeiro-calculos.js';

export const DASHBOARD_PRESETS = Object.freeze({ atual: 'Este mês', anterior: 'Mês anterior', ultimos12: 'Últimos 12 meses', personalizado: 'Período personalizado' });
const monthNumber = (period) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
const monthFromNumber = (number) => `${String(Math.floor(number / 12)).padStart(4, '0')}-${String(number % 12 + 1).padStart(2, '0')}`;
export function dashboardMonths(inicio, fim) {
  parseCivilDate(inicio); parseCivilDate(fim);
  const first = monthNumber(inicio); const last = monthNumber(fim);
  if (inicio > fim) throw new ValidationError('O início deve ser anterior ou igual ao fim do período.');
  if (last - first >= 120) throw new ValidationError('Selecione até 120 meses por visualização.');
  return Array.from({ length: last - first + 1 }, (_, index) => monthFromNumber(first + index));
}
export function resolveDashboardPeriod(filters = {}, today = todayCivil()) {
  parseCivilDate(today); const preset = filters.preset || 'atual';
  if (!Object.hasOwn(DASHBOARD_PRESETS, preset)) throw new ValidationError('Selecione um período válido.');
  let inicio; let fim;
  if (preset === 'personalizado') { inicio = filters.inicio; fim = filters.fim; }
  else {
    const current = monthNumber(today); const first = preset === 'ultimos12' ? current - 11 : preset === 'anterior' ? current - 1 : current; const last = preset === 'anterior' ? current - 1 : current;
    inicio = dueDateForMonth(monthFromNumber(first), 1); fim = dueDateForMonth(monthFromNumber(last), 31);
  }
  const months = dashboardMonths(inicio, fim); return { inicio, fim, months, preset };
}

export function calculateDashboardOccupation(properties, leases, bookings, { inicio, fim }) {
  parseCivilDate(inicio); parseCivilDate(fim); if (inicio > fim) throw new ValidationError('Período de ocupação invertido.');
  const selected = new Set(properties.map((row) => row.id)); const occupiedIds = new Set();
  for (const row of leases) {
    if (!selected.has(row.propriedadeId) || row.situacao === 'cancelado') continue;
    if (!['ativo', 'encerrado'].includes(row.situacao)) throw new ValidationError('Contrato com situação inválida.');
    parseCivilDate(row.inicio); if (row.fim) { parseCivilDate(row.fim); if (row.fim < row.inicio) throw new ValidationError('Vigência de contrato inválida.'); }
    if (row.inicio <= fim && (!row.fim || row.fim >= inicio)) occupiedIds.add(row.propriedadeId);
  }
  for (const row of bookings) {
    if (!selected.has(row.propriedadeId) || row.situacao === 'cancelada') continue;
    if (!['confirmada', 'concluida'].includes(row.situacao)) throw new ValidationError('Reserva com situação inválida.');
    parseCivilDate(row.entrada); parseCivilDate(row.saida); if (row.saida <= row.entrada) throw new ValidationError('Período de reserva inválido.');
    if (row.entrada <= fim && row.saida > inicio) occupiedIds.add(row.propriedadeId);
  }
  const maintenance = properties.filter((row) => !occupiedIds.has(row.id) && row.situacaoManual === 'manutencao').length;
  return { registered: properties.length, occupied: occupiedIds.size, available: properties.length - occupiedIds.size - maintenance, maintenance, occupiedIds: [...occupiedIds] };
}

export function buildDashboard(data, filters = {}, today = todayCivil()) {
  const period = resolveDashboardPeriod(filters, today); const propertyId = filters.propertyId || '';
  if (propertyId) { validateId(propertyId); if (!data.properties.some((row) => row.id === propertyId)) throw new ValidationError('O imóvel selecionado não existe mais. Escolha outro imóvel ou Todos os imóveis.'); }
  const selectedProperties = data.properties.filter((row) => !propertyId || row.id === propertyId);
  const financialFilters = { inicio: period.inicio, fim: period.fim, ...(propertyId ? { propriedadeId: propertyId } : {}) };
  const rows = filterTransactions(data.transactions, financialFilters, today).filter((row) => row.situacaoPersistida !== 'cancelado');
  const totals = calculateFinancialSummary(rows, {}, today);
  const monthly = groupFinancialSummary(rows, (row) => financialDate(row).slice(0, 7), {}, today, period.months);
  const names = new Map(data.properties.map((row) => [row.id, row.nome]));
  const revenues = groupFinancialSummary(rows, (row) => row.propriedadeId, { tipo: 'receita', situacao: 'liquidado' }, today).map((group) => ({ key: group.key, label: group.key === null ? 'Receitas gerais (sem imóvel)' : names.get(group.key) || `Imóvel não encontrado (${group.key})`, value: group.totals.receitaRealizada }));
  const expenses = groupFinancialSummary(rows, (row) => row.categoria || 'Sem categoria', { tipo: 'despesa', situacao: 'liquidado' }, today).map((group) => ({ key: group.key, label: group.key, value: group.totals.despesaRealizada }));
  const sortValues = (a, b) => b.value - a.value || a.label.localeCompare(b.label, 'pt-BR'); revenues.sort(sortValues); expenses.sort(sortValues);
  const pending = rows.filter((row) => row.situacaoPersistida === 'pendente');
  const overdue = pending.filter((row) => financialStatus(row, today) === 'atrasado');
  const generalRows = propertyId ? [] : rows.filter((row) => row.propriedadeId === null);
  return {
    period, propertyId, today, propertyLabel: propertyId ? names.get(propertyId) : 'Todos os imóveis', financialFilters, totals, monthly, revenues, expenses,
    occupation: calculateDashboardOccupation(selectedProperties, data.leases, data.bookings, period),
    recent: rows.filter((row) => row.situacaoPersistida === 'liquidado').reverse().slice(0, 6),
    upcoming: pending.filter((row) => row.vencimento >= today).slice(0, 6),
    overdue: overdue.slice(0, 6), overdueCount: overdue.length,
    general: propertyId ? null : { totals: calculateFinancialSummary(generalRows, {}, today), expenseCount: generalRows.filter((row) => row.tipo === 'despesa').length },
    rows, names,
  };
}
