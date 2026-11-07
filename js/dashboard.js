import { database } from './db.js';
import { formatBRL, formatCivilDate, todayCivil } from './utils.js';
import { buildDashboard, resolveDashboardPeriod, DASHBOARD_PRESETS } from './dashboard-calculos.js';
import { createMonthlyChart, createCategoryChart } from './graficos.js';
import { el, icon, link, createScreen, emptyState } from './ui.js';

let savedFilters = { preset: 'atual', propertyId: '', inicio: '', fim: '' };
export function loadDashboardData(db = database) {
  const stores = ['properties', 'transactions', 'leases', 'bookings'];
  return db.runTransaction(stores, 'readonly', (tx) => {
    const data = {}; let remaining = stores.length;
    for (const name of stores) tx.request(tx.store(name).getAll(), (rows) => { data[name] = rows; if (!--remaining) tx.result(data); });
  });
}
function field(name, label, { options, type = 'text', value = '' } = {}) {
  const wrapper = el('div', 'field'); const caption = el('label', '', label); const control = el(options ? 'select' : 'input'); control.name = name; control.id = `dashboard-${name}`; caption.htmlFor = control.id;
  if (options) for (const [key, text] of Object.entries(options)) { const option = el('option', '', text); option.value = key; control.append(option); } else control.type = type;
  control.value = value; wrapper.append(caption, control); return { wrapper, control };
}
function metric(key, title, value, caption, tone = 'navy', iconName = 'wallet') {
  const card = el('article', `metric-card metric-${tone}`); card.dataset.dashboardMetric = key;
  const top = el('div', 'metric-top'); const mark = el('span', 'metric-icon'); mark.append(icon(iconName)); top.append(el('h2', '', title), mark);
  card.append(top, el('p', 'metric-value', value), el('p', 'metric-caption', caption)); return card;
}
function activityList(title, description, rows, model, state, emptyText) {
  const section = el('section', 'panel dashboard-activity'); section.dataset.dashboardList = state;
  section.append(el('div', 'dashboard-chart-heading')); section.firstElementChild.append(el('h2', '', title), el('p', 'field-hint', description));
  if (!rows.length) section.append(emptyState({ title: emptyText, description: 'Este resultado considera somente o imóvel e o período selecionados.', iconName: 'clock' }));
  else {
    const list = el('ul', 'dashboard-records');
    for (const record of rows) {
      const item = el('li', `dashboard-record record-${record.tipo}`); item.dataset.transactionId = record.id;
      const details = el('div'); const date = state === 'recent' ? record.liquidadoEm : record.vencimento;
      details.append(link(record.descricao, `#/financeiro/${encodeURIComponent(record.id)}/editar`, 'dashboard-record-link'), el('p', 'field-hint', `${record.propriedadeId === null ? 'Geral · sem imóvel' : model.names.get(record.propriedadeId) || 'Imóvel não encontrado'} · ${formatCivilDate(date)}`));
      item.append(details, el('strong', '', `${record.tipo === 'receita' ? 'Receita' : 'Despesa'} · ${formatBRL(record.valorCentavos)}`)); list.append(item);
    }
    section.append(list);
  }
  return section;
}

export function renderDashboard() {
  let alive = true; let reading = false; let data; let charts = [];
  const screen = createScreen({ title: 'Visão geral', description: 'Seu patrimônio e seu fluxo de caixa, a partir dos registros locais.', eyebrow: 'SEU PATRIMÔNIO, EM PERSPECTIVA' }); screen.classList.add('real-dashboard');
  const form = el('form', 'dashboard-filters panel'); const fieldset = el('fieldset'); fieldset.append(el('legend', 'sr-only', 'Filtros do Dashboard'));
  const preset = field('preset', 'Período', { options: DASHBOARD_PRESETS, value: savedFilters.preset }); const property = field('propertyId', 'Imóvel', { options: { '': 'Todos os imóveis' } });
  const start = field('inicio', 'De (inclusive)', { type: 'date', value: savedFilters.inicio }); const end = field('fim', 'Até (inclusive)', { type: 'date', value: savedFilters.fim });
  const refresh = el('button', 'button button-secondary', 'Atualizar dados'); refresh.type = 'button'; fieldset.append(preset.wrapper, property.wrapper, start.wrapper, end.wrapper, refresh); form.append(fieldset);
  const error = el('p', 'dashboard-error'); error.setAttribute('role', 'alert'); error.tabIndex = -1;
  const context = el('p', 'dashboard-context'); context.setAttribute('role', 'status'); const content = el('div', 'dashboard-content'); screen.append(form, error, context, content);
  function clearCharts() { charts.forEach((chart) => chart.dispose()); charts = []; }
  function setDateFields() {
    const custom = preset.control.value === 'personalizado'; start.wrapper.hidden = end.wrapper.hidden = !custom; start.control.disabled = end.control.disabled = !custom;
    if (!custom || !start.control.value || !end.control.value) {
      const period = resolveDashboardPeriod({ preset: custom ? 'atual' : preset.control.value });
      if (!custom || !start.control.value) start.control.value = period.inicio; if (!custom || !end.control.value) end.control.value = period.fim;
    }
  }
  function draw() {
    if (!alive || !data) return; clearCharts(); content.replaceChildren(); error.textContent = ''; context.textContent = ''; start.control.removeAttribute('aria-invalid'); end.control.removeAttribute('aria-invalid');
    savedFilters = { preset: preset.control.value, propertyId: property.control.value, inicio: start.control.value, fim: end.control.value };
    try {
      const model = buildDashboard(data, savedFilters, todayCivil()); screen.dataset.dashboardState = 'ready';
      context.textContent = `${formatCivilDate(model.period.inicio)} a ${formatCivilDate(model.period.fim)} · ${model.propertyLabel}. Realizado pela liquidação; previsão e atrasos pelo vencimento. Hoje: ${formatCivilDate(model.today)}.`;
      const note = el('p', 'dashboard-definition', 'Ocupados: ao menos um dia de contrato ou uma noite de reserva não cancelados no intervalo. Disponíveis: sem ocupação registrada em todo o intervalo, excluindo manutenção cadastral. A contagem usa o cadastro atual; situação manual “ocupado” não substitui datas. Um imóvel ocupado parcialmente pode ter vagas em outros dias.');
      if (!data.properties.length) content.append(emptyState({ title: 'Cadastre um imóvel para começar', description: 'Lançamentos gerais já registrados continuam incluídos no consolidado abaixo.', action: link('Cadastrar imóvel', '#/imoveis/novo', 'button button-primary') }));
      const cards = el('section', 'metrics-grid dashboard-metrics'); cards.setAttribute('aria-label', 'Indicadores do recorte');
      cards.append(metric('registered', 'Imóveis cadastrados', String(model.occupation.registered), 'Cadastro atual · filtro por imóvel', 'navy', 'building'), metric('occupied', 'Ocupados no período', String(model.occupation.occupied), 'Com contrato ou reserva no intervalo', 'navy', 'contract'), metric('available', 'Disponíveis no período', String(model.occupation.available), `${model.occupation.maintenance} em manutenção sem ocupação, fora deste número`, 'navy', 'building'));
      for (const [key, title, caption, tone, iconName] of [
        ['receitaRealizada', 'Receitas recebidas', 'Pela data do recebimento', 'green', 'up'], ['despesaRealizada', 'Despesas pagas', 'Pela data do pagamento', 'red', 'down'], ['resultadoRealizado', 'Resultado realizado', 'Recebido menos pago · fluxo de caixa', 'navy', 'wallet'], ['aReceber', 'A receber', `Atrasado no recorte: ${formatBRL(model.totals.receitaAtrasada)}`, 'green', 'clock'], ['aPagar', 'A pagar', `Atrasado no recorte: ${formatBRL(model.totals.despesaAtrasada)}`, 'red', 'clock'],
      ]) cards.append(metric(key, title, formatBRL(model.totals[key]), caption, tone, iconName));
      content.append(cards, note);
      const plots = el('div', 'dashboard-chart-grid');
      for (const [title, kind] of [['Receitas × despesas por mês', 'comparison'], ['Evolução do resultado', 'result']]) {
        const chart = createMonthlyChart({ title, kind, rows: model.monthly, description: kind === 'result' ? 'Resultado realizado de cada mês, sem acumular saldo anterior.' : 'Recebido e pago pela data da liquidação; meses parciais respeitam o filtro.' }); charts.push(chart); plots.append(chart.element);
      }
      plots.append(createCategoryChart({ title: 'Receitas por imóvel', description: 'Somente receitas liquidadas; gerais identificadas como sem imóvel.', rows: model.revenues, key: 'properties' }), createCategoryChart({ title: 'Despesas por categoria', description: 'Somente despesas pagas; gerais incluídas no consolidado, sem rateio.', rows: model.expenses, tone: 'expense', key: 'categories' })); content.append(plots);
      const general = el('section', 'panel dashboard-general'); general.dataset.dashboardGeneral = model.general ? 'included' : 'excluded';
      general.append(el('h2', '', 'Despesas gerais · sem imóvel'));
      if (model.general) {
        general.append(el('p', 'field-hint', 'Já incluídas nos cartões e gráficos consolidados, no mesmo período. Estes valores não devem ser somados novamente nem distribuídos aos imóveis.'));
        const facts = el('dl', 'dashboard-general-values');
        for (const [key, label] of [['despesaRealizada', 'Pagas'], ['aPagar', 'A pagar'], ['despesaAtrasada', 'Em atraso (parte de a pagar)']]) { const row = el('div'); row.dataset.generalMetric = key; row.append(el('dt', '', label), el('dd', '', formatBRL(model.general.totals[key]))); facts.append(row); } general.append(facts);
      } else general.append(el('p', 'field-hint', 'Gerais não pertencem ao imóvel selecionado e estão fora deste recorte. Selecione Todos os imóveis para consultá-las no mesmo período.'));
      content.append(general);
      const alerts = activityList(`Atrasos no recorte · ${model.overdueCount}`, `Vencimentos anteriores a hoje dentro do período selecionado. A receber: ${formatBRL(model.totals.receitaAtrasada)} · A pagar: ${formatBRL(model.totals.despesaAtrasada)}. Até 6 registros; não inclui atrasos fora do período.`, model.overdue, model, 'overdue', 'Nenhum atraso neste recorte'); content.append(alerts);
      const lists = el('div', 'dashboard-chart-grid'); lists.append(activityList('Últimas movimentações', 'Até 6 recebimentos/pagamentos, em ordem decrescente de liquidação no recorte.', model.recent, model, 'recent', 'Nenhuma liquidação neste recorte'), activityList('Próximos vencimentos', 'Até 6 pendências de hoje em diante, em ordem de vencimento e dentro do recorte.', model.upcoming, model, 'upcoming', 'Nenhum vencimento futuro neste recorte')); content.append(lists);
      const footer = el('div', 'dashboard-links'); footer.append(link('Abrir Financeiro', '#/financeiro', 'button button-secondary'), link('Consultar imóveis', '#/imoveis', 'text-link'), el('span', 'field-hint', 'Consulta local. Atualize os dados para refletir mudanças de outra aba.')); content.append(footer);
    } catch (caught) {
      clearCharts(); content.replaceChildren(); screen.dataset.dashboardState = 'invalid'; error.textContent = caught.message;
      if (preset.control.value === 'personalizado') { start.control.setAttribute('aria-invalid', 'true'); end.control.setAttribute('aria-invalid', 'true'); }
    }
  }
  async function load() {
    if (reading || !alive) return; reading = true; fieldset.disabled = true; screen.dataset.dashboardState = 'loading'; error.textContent = ''; context.textContent = 'Consultando os registros locais…'; clearCharts(); content.replaceChildren();
    try {
      data = await loadDashboardData(); if (!alive) return;
      const selected = savedFilters.propertyId; property.control.replaceChildren();
      for (const [id, label] of [['', 'Todos os imóveis'], ...data.properties.map((row) => [row.id, row.nome])]) { const option = el('option', '', label); option.value = id; property.control.append(option); }
      if (selected && !data.properties.some((row) => row.id === selected)) { const option = el('option', '', 'Imóvel não encontrado — escolha outro'); option.value = selected; property.control.append(option); } property.control.value = selected;
      setDateFields(); draw();
    } catch (caught) { if (alive) { data = undefined; screen.dataset.dashboardState = 'error'; context.textContent = ''; error.textContent = caught.message; content.append(emptyState({ title: 'Não foi possível consultar o Dashboard', description: 'Confira as permissões de armazenamento e clique em Atualizar dados para tentar novamente.', iconName: 'info' })); } }
    finally { reading = false; if (alive) fieldset.disabled = false; }
  }
  preset.control.addEventListener('change', () => { try { setDateFields(); draw(); } catch (caught) { clearCharts(); content.replaceChildren(); context.textContent = ''; error.textContent = caught.message; screen.dataset.dashboardState = 'invalid'; } });
  for (const input of [property.control, start.control, end.control]) input.addEventListener('change', draw);
  form.addEventListener('submit', (event) => { event.preventDefault(); draw(); }); refresh.addEventListener('click', load); load();
  return { element: screen, dispose() { alive = false; clearCharts(); } };
}
