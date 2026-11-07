import { ValidationError, validateId, todayCivil, civilToOrdinal, assertCentavos, addCentavos } from './utils.js';
import { dashboardMonths } from './dashboard-calculos.js';
import { calculateFinancialSummary, groupFinancialSummary, filterTransactions, financialDate, financialStatus } from './financeiro-calculos.js';

export const REPORTS = Object.freeze({ resumo: 'Resumo financeiro', imovel: 'Resultado por imóvel', mensal: 'Evolução mensal', categoria: 'Despesas por categoria', pendencias: 'Recebíveis, pagáveis e atrasos', temporada: 'Temporada' });
export const BASES = Object.freeze({ caixa: 'Caixa realizado · liquidação', pendencias: 'Pendências · vencimento' });
export const TYPES = Object.freeze({ '': 'Receitas e despesas', receita: 'Receita', despesa: 'Despesa' });
export const STATUSES = Object.freeze({ em_aberto: 'Todas em aberto', pendente: 'A vencer (inclui hoje)', atrasado: 'Em atraso' });
const column = (key, label, type = 'text') => ({ key, label, type });
const money = (key, label) => column(key, label, 'money');
const table = (title, note, columns, rows) => ({ title, note, columns, rows });
const sumColumns = (basis) => basis === 'caixa'
  ? [money('receitaRealizada', 'Recebido (R$)'), money('despesaRealizada', 'Pago (R$)'), money('resultadoRealizado', 'Resultado realizado (R$)')]
  : [money('aReceber', 'A receber (R$)'), money('aPagar', 'A pagar (R$)'), money('receitaAtrasada', 'Recebível atrasado (R$)'), money('despesaAtrasada', 'Pagável atrasado (R$)')];

// Rateio apenas analítico. O resto de centavos é atribuído às primeiras noites,
// de modo que recortes adjacentes recompõem exatamente o bruto, sem gravar nada.
export function bookingNightValue(booking, startOrdinal, endExclusiveOrdinal) {
  const start = civilToOrdinal(booking.entrada); const end = civilToOrdinal(booking.saida);
  if (end <= start) throw new ValidationError('Reserva com saída anterior ou igual à entrada.');
  const gross = BigInt(assertCentavos(booking.valorBrutoCentavos));
  if (gross < 0n) throw new ValidationError('Reserva com valor bruto negativo.');
  const from = Math.max(start, startOrdinal); const to = Math.min(end, endExclusiveOrdinal);
  if (to <= from) return { nights: 0, value: 0, from, to };
  const count = end - start; const rest = Number(gross % BigInt(count));
  const extras = Math.max(0, Math.min(to - start, rest) - Math.min(from - start, rest));
  return { nights: to - from, value: assertCentavos(Number(gross / BigInt(count) * BigInt(to - from) + BigInt(extras))), from, to };
}
const average = (value, count) => count ? assertCentavos(Number((BigInt(value) + BigInt(Math.floor(count / 2))) / BigInt(count))) : null;

function seasonTables(data, properties, period, names, today) {
  const start = civilToOrdinal(period.inicio); const end = civilToOrdinal(period.fim) + 1; const days = end - start;
  const ids = new Set(properties.map(p => p.id));
  const active = data.bookings.filter(b => ids.has(b.propriedadeId) && b.situacao !== 'cancelada');
  const activeIds = new Set(); const detail = []; const intervals = new Map();
  for (const b of active) {
    if (!['confirmada', 'concluida'].includes(b.situacao)) throw new ValidationError('Situação de reserva inválida.');
    activeIds.add(b.id);
    const part = bookingNightValue(b, start, end);
    if (!part.nights) continue;
    if (!intervals.has(b.propriedadeId)) intervals.set(b.propriedadeId, []);
    intervals.get(b.propriedadeId).push(part);
    detail.push({ id: b.id, property: names.get(b.propriedadeId), guest: b.hospede, entry: b.entrada, exit: b.saida, status: b.situacao === 'confirmada' ? 'Confirmada' : 'Concluída', nights: part.nights, negotiated: part.value });
  }
  for (const list of intervals.values()) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 1; i < list.length; i++) if (list[i].from < list[i - 1].to) throw new ValidationError('Reservas sobrepostas: regularize o calendário antes de calcular ocupação.');
  }
  const bookingById = new Map(active.map(b => [b.id, b]));
  const cash = filterTransactions(data.transactions.filter(t => t.origem === 'reserva' && activeIds.has(t.origemId) && bookingById.get(t.origemId).propriedadeId === t.propriedadeId), { ...period, tipo: 'receita', situacao: 'liquidado' }, today);
  const received = new Map(groupFinancialSummary(cash, t => t.propriedadeId, {}, today).map(g => [g.key, g.totals.receitaRealizada]));
  const rows = properties.map(p => {
    const bookings = detail.filter(b => bookingById.get(b.id).propriedadeId === p.id);
    const nights = bookings.reduce((n, b) => n + b.nights, 0); let negotiated = 0;
    for (const b of bookings) negotiated = addCentavos(negotiated, b.negotiated);
    return { property: p.nome, bookings: bookings.length, nights, eligible: p.finalidade === 'temporada' ? days : null, occupancy: p.finalidade === 'temporada' ? nights / days * 100 : null, negotiated, average: average(negotiated, nights), received: received.get(p.id) || 0 };
  });
  let negotiated = 0; for (const row of rows) negotiated = addCentavos(negotiated, row.negotiated);
  const eligible = rows.reduce((n, r) => n + (r.eligible || 0), 0);
  const occupied = rows.reduce((n, r) => n + (r.eligible ? r.nights : 0), 0);
  const nights = detail.reduce((n, r) => n + r.nights, 0);
  const total = { property: 'Total do recorte', bookings: detail.length, nights, eligible: eligible || null, occupancy: eligible ? occupied / eligible * 100 : null, negotiated, average: average(negotiated, nights), received: calculateFinancialSummary(cash, {}, today).receitaRealizada };
  const note = 'Noites: interseção de [entrada, saída) com o período inclusivo. Ocupação: noites reservadas ÷ noites-calendário, somente nos imóveis atualmente classificados como Temporada; consolidado usa a soma desses denominadores. Sem imóvel elegível: não aplicável. Não desconta manutenção, contratos ou bloqueios, nem reconstrói disponibilidade/cadastro histórico. Confirmadas incluem estadias futuras; canceladas não participam.';
  const amounts = 'Bruto negociado é estimativa proporcional às noites do recorte, com centavos restantes nas primeiras noites; média = esse bruto ÷ essas noites, arredondada ao centavo. Recebido vem somente das receitas liquidadas vinculadas a reservas não canceladas, pela data da liquidação, mesmo que a estadia esteja fora do período. Não dividir recebido pelas noites, nem somar negociado ao caixa. Tipo, categoria e situação financeiros não se aplicam a este relatório.';
  return [table('Temporada por imóvel', `${note} ${amounts}`, [column('property', 'Imóvel'), column('bookings', 'Reservas com noites', 'number'), column('nights', 'Noites no período', 'number'), column('eligible', 'Noites-calendário elegíveis', 'number'), column('occupancy', 'Ocupação (%)', 'percent'), money('negotiated', 'Bruto negociado proporcional (R$)'), money('average', 'Média negociada por noite (R$)'), money('received', 'Receita de reservas recebida (R$)')], [...rows, total]),
    table('Reservas que ocupam o período', 'Somente confirmadas/concluídas com ao menos uma noite no recorte. Datas originais; noites e bruto proporcionais ao filtro.', [column('id', 'ID da reserva'), column('property', 'Imóvel'), column('guest', 'Hóspede'), column('entry', 'Entrada', 'date'), column('exit', 'Saída exclusiva', 'date'), column('status', 'Situação'), column('nights', 'Noites no período', 'number'), money('negotiated', 'Bruto negociado proporcional (R$)')], detail),
    transactionTable(cash, names, today, 'Receitas de reservas recebidas', 'Conciliação do recebido acima. Não inclui canceladas, receitas sem reserva válida ou valores apenas negociados.')];
}

function transactionTable(rows, names, today, title = 'Lançamentos do recorte', note = 'Registros que compõem as somas acima; não somar novamente. ID permite conferir no Financeiro. Cancelados excluídos.') {
  return table(title, note, [column('id', 'ID do lançamento'), column('property', 'Imóvel'), column('type', 'Tipo'), column('category', 'Categoria'), column('description', 'Descrição'), money('value', 'Valor (R$)'), column('due', 'Vencimento', 'date'), column('settled', 'Liquidação', 'date'), column('status', 'Situação'), column('origin', 'Origem'), column('originId', 'ID da origem')], rows.map(t => ({ id: t.id, property: t.propriedadeId === null ? 'Geral · sem imóvel' : names.get(t.propriedadeId) || 'Imóvel não encontrado', type: TYPES[t.tipo], category: t.categoria, description: t.descricao, value: t.valorCentavos, due: t.vencimento, settled: t.liquidadoEm || null, status: { liquidado: 'Liquidado', pendente: 'A vencer (inclui hoje)', atrasado: 'Em atraso' }[financialStatus(t, today)], origin: t.origem, originId: t.origemId || null })));
}

export function buildReport(data, filters, today = todayCivil()) {
  const { inicio, fim, propertyId = '', report = 'resumo' } = filters;
  if (!Object.hasOwn(REPORTS, report)) throw new ValidationError('Selecione um relatório válido.');
  const months = dashboardMonths(inicio, fim);
  civilToOrdinal(today);
  if (propertyId) { validateId(propertyId); if (!data.properties.some(p => p.id === propertyId)) throw new ValidationError('O imóvel selecionado não existe mais. Escolha outro imóvel.'); }
  const names = new Map(data.properties.map(p => [p.id, p.nome])); const propertyLabel = propertyId ? names.get(propertyId) : 'Todos os imóveis e gerais';
  const period = { inicio, fim };
  if (report === 'temporada') return { report, title: REPORTS[report], period, today, basis: 'Noites pela estadia; recebido pela liquidação', propertyLabel, typeLabel: 'Não aplicável', categoryLabel: 'Não aplicável', statusLabel: 'Reservas confirmadas/concluídas', tables: seasonTables(data, data.properties.filter(p => !propertyId || p.id === propertyId), period, names, today) };
  const basis = report === 'pendencias' ? 'pendencias' : (filters.basis || 'caixa');
  const tipo = filters.tipo || ''; const categoria = filters.categoria || '';
  if (!Object.hasOwn(BASES, basis) || !Object.hasOwn(TYPES, tipo)) throw new ValidationError('Base ou tipo inválido.');
  const situacao = basis === 'caixa' ? 'liquidado' : (filters.situacao || 'em_aberto');
  if (basis === 'pendencias' && !Object.hasOwn(STATUSES, situacao)) throw new ValidationError('Situação de pendência inválida.');
  const financialFilters = { inicio, fim, tipo, categoria, situacao, ...(propertyId ? { propriedadeId: propertyId } : {}) };
  const rows = filterTransactions(data.transactions, financialFilters, today);
  const totals = calculateFinancialSummary(rows, {}, today); const columns = sumColumns(basis);
  const tables = [table('Resumo do recorte', basis === 'caixa' ? 'Receitas recebidas menos despesas pagas, pela liquidação. Fluxo de caixa registrado, não lucro contábil.' : 'Pelo vencimento. Atrasos são parte de a receber/a pagar, não valores adicionais; hoje ainda não está atrasado. Não altera o caixa realizado.', [column('metric', 'Indicador'), money('amount', 'Total (R$)')], columns.map(c => ({ metric: c.label, amount: totals[c.key] })))];
  if (report === 'imovel') tables.push(table('Resultado por imóvel e gerais', 'Gerais formam linha própria e já integram o consolidado. Não são rateadas aos imóveis.', [column('property', 'Imóvel'), ...columns], groupFinancialSummary(rows, t => t.propriedadeId, {}, today).map(g => ({ property: g.key === null ? 'Geral · sem imóvel' : names.get(g.key) || 'Imóvel não encontrado', ...g.totals }))));
  if (report === 'mensal') tables.push(table('Evolução mensal', 'Meses parciais respeitam o filtro. Zero indica ausência de registros; resultado não é acumulado.', [column('month', 'Mês'), ...columns], groupFinancialSummary(rows, t => financialDate(t).slice(0, 7), {}, today, months).map(g => ({ month: `${g.key.slice(5)}/${g.key.slice(0,4)}`, ...g.totals }))));
  if (report === 'categoria') tables.push(table('Despesas por categoria', 'Somente despesas dentro de todos os filtros; selecionar tipo Receita produz tabela vazia. O resumo permanece referente ao recorte completo selecionado.', [column('category', 'Categoria'), ...columns.filter(c => ['despesaRealizada', 'aPagar', 'despesaAtrasada'].includes(c.key))], groupFinancialSummary(rows, t => t.categoria, { tipo: 'despesa' }, today).map(g => ({ category: g.key, ...g.totals }))));
  tables.push(transactionTable(rows, names, today));
  return { report, title: REPORTS[report], period, today, basis: BASES[basis], propertyLabel, typeLabel: TYPES[tipo], categoryLabel: categoria || 'Todas', statusLabel: basis === 'caixa' ? 'Liquidado' : STATUSES[situacao], tables, totals, rows, financialFilters };
}
