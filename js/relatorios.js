import { database, DEMO_DB_NAME } from './db.js';
import { formatCivilDate, todayCivil, dueDateForMonth } from './utils.js';
import { buildReport, REPORTS, BASES, TYPES, STATUSES } from './relatorios-calculos.js';
import { reportCsv, formatReportCell } from './relatorios-csv.js';
import { el, createScreen, emptyState } from './ui.js';

let savedFilters;
export function loadReportData(db = database) {
  const stores = ['properties', 'transactions', 'bookings'];
  return db.runTransaction(stores, 'readonly', tx => {
    const data = {}; let remaining = stores.length;
    for (const name of stores) tx.request(tx.store(name).getAll(), rows => { data[name] = rows; if (!--remaining) tx.result(data); });
  });
}
function field(name, label, options, value = '') {
  const wrapper = el('div', 'field'); const caption = el('label', '', label); const input = el(options ? 'select' : 'input');
  input.id = `report-${name}`; input.name = name; caption.htmlFor = input.id;
  if (options) setOptions(input, Object.entries(options)); else { input.type = 'date'; input.required = true; }
  input.value = value; wrapper.append(caption, input); return { wrapper, input };
}
function setOptions(input, pairs) {
  input.replaceChildren(); for (const [value, label] of pairs) { const option = el('option', '', label); option.value = value; input.append(option); }
}
export function renderReportTable(section) {
  const panel = el('section', 'panel report-section'); panel.append(el('h2', '', section.title), el('p', 'field-hint', section.note));
  if (!section.rows.length) { panel.append(emptyState({ title: 'Sem registros neste recorte', description: 'Altere os filtros ou registre movimentações no módulo correspondente.', iconName: 'report' })); return panel; }
  const table = el('table', 'report-table'); const caption = el('caption', 'sr-only', section.title); const head = el('thead'); const header = el('tr');
  for (const c of section.columns) { const th = el('th', '', c.label); th.scope = 'col'; header.append(th); } head.append(header);
  const body = el('tbody');
  for (const row of section.rows) {
    const tr = el('tr'); for (const c of section.columns) { const td = el('td', '', formatReportCell(row[c.key], c.type)); td.dataset.label = c.label; tr.append(td); } body.append(tr);
  }
  table.append(caption, head, body); panel.append(table); return panel;
}
export function renderReports() {
  let alive = true; let reading = false; let data; let model;
  const today = todayCivil(); const month = today.slice(0, 7);
  const initial = savedFilters || { report: 'resumo', basis: 'caixa', inicio: dueDateForMonth(month, 1), fim: dueDateForMonth(month, 31), propertyId: '', tipo: '', categoria: '', situacao: 'em_aberto' };
  const screen = createScreen({ title: 'Relatórios', description: 'Confira os registros, exporte o recorte ou prepare uma cópia para impressão.', eyebrow: 'IMOBIGEST · CONFERÊNCIA FINANCEIRA' }); screen.classList.add('reports-screen');
  const form = el('form', 'panel report-filters'); const fieldset = el('fieldset'); fieldset.append(el('legend', 'sr-only', 'Filtros dos relatórios'));
  const fields = {
    report: field('report', 'Relatório', REPORTS, initial.report), basis: field('basis', 'Base financeira', BASES, initial.basis),
    inicio: field('inicio', 'De (inclusive)', null, initial.inicio), fim: field('fim', 'Até (inclusive)', null, initial.fim),
    propertyId: field('propertyId', 'Imóvel', { '': 'Todos os imóveis e gerais' }), tipo: field('tipo', 'Tipo', TYPES, initial.tipo),
    categoria: field('categoria', 'Categoria', { '': 'Todas' }), situacao: field('situacao', 'Situação', { ...STATUSES, liquidado: 'Liquidado' }, initial.situacao),
  };
  fieldset.append(...Object.values(fields).map(f => f.wrapper)); form.append(fieldset);
  const help = el('p', 'field-hint'); help.id = 'report-filter-help'; form.append(help);
  for (const { input } of Object.values(fields)) input.setAttribute('aria-describedby', help.id);
  const actions = el('div', 'report-actions');
  const refresh = el('button', 'button button-secondary', 'Atualizar dados'); const download = el('button', 'button button-primary', 'Exportar CSV'); const print = el('button', 'button button-secondary', 'Imprimir / Salvar PDF');
  for (const button of [refresh, download, print]) button.type = 'button'; actions.append(refresh, download, print);
  const error = el('p', 'dashboard-error'); error.setAttribute('role', 'alert');
  const context = el('p', 'report-context'); context.setAttribute('role', 'status');
  const content = el('div', 'report-content');
  const exportNote = el('p', 'field-hint report-export-note', 'CSV: UTF-8, separador ponto e vírgula e valores decimais com vírgula. A coluna Seção identifica cada tabela; resumo e detalhamento não devem ser somados entre si. Impressão: escolha Salvar como PDF no diálogo do navegador.');
  screen.append(form, actions, error, context, content, exportNote);
  function values() { return Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.input.value])); }
  function controls() {
    const season = fields.report.input.value === 'temporada'; const pending = fields.report.input.value === 'pendencias';
    for (const key of ['basis', 'tipo', 'categoria', 'situacao']) fields[key].wrapper.hidden = season;
    if (pending) fields.basis.input.value = 'pendencias';
    fields.basis.input.disabled = season || pending;
    fields.tipo.input.disabled = fields.categoria.input.disabled = season;
    fields.situacao.input.disabled = season || fields.basis.input.value === 'caixa';
    if (fields.basis.input.value === 'caixa') fields.situacao.input.value = 'liquidado';
    else if (fields.situacao.input.value === 'liquidado') fields.situacao.input.value = 'em_aberto';
    fields.situacao.input.querySelector('option[value="liquidado"]').disabled = fields.basis.input.value !== 'caixa';
    help.textContent = season ? 'Temporada usa somente período e imóvel. Tipo, categoria e situação financeiros não se aplicam; reservas canceladas ficam fora. Valores negociados e recebidos são separados.' : fields.basis.input.value === 'caixa' ? 'Caixa realizado: somente liquidados, pela data de recebimento/pagamento. Cancelados e pendentes não entram. Situação fixada em Liquidado.' : 'Pendências: somente em aberto, pelo vencimento; atraso depende de hoje. Valores previstos não são resultado realizado.';
  }
  function clear() { model = undefined; download.disabled = print.disabled = true; content.replaceChildren(); context.textContent = ''; error.textContent = ''; }
  function draw() {
    if (!alive || !data) return; clear(); controls(); savedFilters = values();
    try {
      model = buildReport(data, savedFilters); screen.dataset.reportState = 'ready';
      if (database.name === DEMO_DB_NAME) model.title += ' · Modo demonstração';
      context.textContent = `${model.title} · ${formatCivilDate(model.period.inicio)} a ${formatCivilDate(model.period.fim)} · ${model.propertyLabel} · ${model.basis} · Tipo: ${model.typeLabel} · Categoria: ${model.categoryLabel} · Situação: ${model.statusLabel} · Hoje: ${formatCivilDate(model.today)}.`;
      if (model.rows && !model.rows.length) content.append(emptyState({ title: 'Nenhum lançamento neste recorte', description: 'Os totais são zero. Pendências não são recebimentos; confira a base de datas selecionada.', iconName: 'report' }));
      content.append(...model.tables.map(renderReportTable)); download.disabled = print.disabled = false;
    } catch (caught) { model = undefined; content.replaceChildren(); screen.dataset.reportState = 'invalid'; error.textContent = caught.message; }
  }
  async function load() {
    if (reading || !alive) return; reading = true; fieldset.disabled = refresh.disabled = true; clear(); screen.dataset.reportState = 'loading';
    try {
      data = await loadReportData(); if (!alive) return;
      const keep = savedFilters || initial;
      const properties = [['', 'Todos os imóveis e gerais'], ...data.properties.map(p => [p.id, p.nome])];
      if (keep.propertyId && !data.properties.some(p => p.id === keep.propertyId)) properties.push([keep.propertyId, 'Imóvel não encontrado — escolha outro']);
      setOptions(fields.propertyId.input, properties); fields.propertyId.input.value = keep.propertyId;
      const categories = [...new Set(data.transactions.map(t => t.categoria).filter(Boolean))]; if (keep.categoria && !categories.includes(keep.categoria)) categories.push(keep.categoria);
      setOptions(fields.categoria.input, [['', 'Todas'], ...categories.sort((a,b) => a.localeCompare(b, 'pt-BR')).map(c => [c, c])]); fields.categoria.input.value = keep.categoria;
      draw();
    } catch (caught) { if (alive) { data = undefined; screen.dataset.reportState = 'error'; error.textContent = `Não foi possível consultar os relatórios. ${caught.message}`; } }
    finally { reading = false; if (alive) { fieldset.disabled = refresh.disabled = false; controls(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); draw(); });
  form.addEventListener('change', draw);
  // Datas incompletas retiram imediatamente a versão anterior da exportação.
  for (const key of ['inicio', 'fim']) fields[key].input.addEventListener('input', draw);
  refresh.addEventListener('click', load);
  download.addEventListener('click', () => {
    if (!model) return; let url;
    try {
      url = URL.createObjectURL(new Blob([reportCsv(model)], { type: 'text/csv;charset=utf-8' }));
      const anchor = el('a'); anchor.href = url; anchor.download = `ImobiGest-${database.name === DEMO_DB_NAME ? 'demo-' : ''}${model.report}-${model.period.inicio}-${model.period.fim}.csv`; document.body.append(anchor); anchor.click(); anchor.remove();
      // Dar tempo ao navegador para consumir o Blob antes de revogar a URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { if (url) URL.revokeObjectURL(url); error.textContent = `Não foi possível exportar: ${caught.message}`; }
  });
  print.addEventListener('click', () => { if (model) { try { window.print(); } catch (caught) { error.textContent = `Não foi possível abrir a impressão: ${caught.message}`; } } });
  load(); return { element: screen, dispose() { alive = false; } };
}
