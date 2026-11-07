import { database } from './db.js';
import { formatBRL, formatCivilDate, todayCivil } from './utils.js';
import { createFinancialService, validateFinancialInput } from './financeiro-service.js';
import { calculateFinancialSummary, filterTransactions, financialStatus } from './financeiro-calculos.js';
import { el, link, createScreen, emptyState, confirmAction, showToast } from './ui.js';

const service = createFinancialService();
const TYPES = { receita: 'Receita', despesa: 'Despesa' };
const STATUSES = { pendente: 'Pendente', atrasado: 'Atrasado', liquidado: 'Liquidado', cancelado: 'Cancelado' };
const editPath = (id) => `#/financeiro/${encodeURIComponent(id)}/editar`;
const newPath = (id) => `#/financeiro/novo${id ? `?imovel=${encodeURIComponent(id)}` : ''}`;
const button = (text, style = 'button button-secondary') => { const node = el('button', style, text); node.type = 'button'; return node; };

function field(name, label, { options, type = 'text', value = '', required = false, maxLength, multiline = false } = {}) {
  const wrapper = el('div', 'field');
  const control = el(options ? 'select' : multiline ? 'textarea' : 'input');
  control.id = `finance-${name}`; control.name = name; control.required = required;
  const caption = el('label', '', `${label}${required ? ' *' : ''}`); caption.htmlFor = control.id;
  if (options) for (const [key, text] of Object.entries(options)) { const option = el('option', '', text); option.value = key; control.append(option); }
  else if (!multiline) control.type = type;
  if (maxLength) control.maxLength = maxLength;
  if (multiline) control.rows = 4;
  if (name === 'valor') control.inputMode = 'decimal';
  control.value = value;
  const error = el('span', 'field-error'); error.id = `${control.id}-error`; control.setAttribute('aria-describedby', error.id);
  wrapper.append(caption, control, error);
  return { wrapper, control, error };
}
function failure(host, error, retry) {
  const state = emptyState({ title: 'Não foi possível carregar o financeiro', description: error.message, iconName: 'info' });
  const action = button('Tentar novamente'); action.addEventListener('click', retry); state.append(action); host.replaceChildren(state);
}

export function matchFinancialRoute(path) {
  if (path === '/financeiro') return { mode: 'list' };
  const [pathname, search = ''] = path.split('?');
  if (pathname === '/financeiro/novo') return { mode: 'new', propertyId: new URLSearchParams(search).get('imovel') || '' };
  const match = /^\/financeiro\/([^/]+)\/editar$/.exec(path);
  if (!match) return null;
  try { return { mode: 'edit', id: decodeURIComponent(match[1]) }; } catch { return { mode: 'edit', id: '' }; }
}

function summaryCards(totals) {
  const grid = el('div', 'financial-summary'); grid.setAttribute('aria-label', 'Resumo do recorte financeiro');
  for (const [key, title, caption, tone] of [
    ['receitaRealizada', 'Receitas recebidas', 'Pela data do recebimento', 'green'],
    ['despesaRealizada', 'Despesas pagas', 'Pela data do pagamento', 'red'],
    ['resultadoRealizado', 'Resultado realizado', 'Recebido menos pago', 'navy'],
    ['aReceber', 'A receber', `Em atraso: ${formatBRL(totals.receitaAtrasada)}`, 'green'],
    ['aPagar', 'A pagar', `Em atraso: ${formatBRL(totals.despesaAtrasada)}`, 'red'],
  ]) {
    const card = el('article', `metric-card metric-${tone}`); card.dataset.metric = key;
    const top = el('div', 'metric-top'); top.append(el('h3', '', title));
    card.append(top, el('p', 'metric-value', formatBRL(totals[key])), el('p', 'metric-caption', caption)); grid.append(card);
  }
  return grid;
}

// Usado tanto pela tela principal quanto pela aba do imóvel, sem totais paralelos.
export function createFinancialPanel({ propertyId } = {}) {
  let alive = true; let loading = false; let records = []; let properties = []; let operation = false;
  const root = el('div', 'financial-panel');
  const toolbar = el('div', 'financial-toolbar');
  const refresh = button('Atualizar');
  toolbar.append(link('Novo lançamento', newPath(propertyId), 'button button-primary'), refresh);
  const note = el('p', 'financial-note', 'Período inclusivo: liquidados pela data de recebimento/pagamento; pendentes e atrasados pelo vencimento. Cancelados aparecem pelo vencimento, mas não entram nos totais. Resultado operacional de caixa, não lucro contábil.');
  const filtersHost = el('div'); const summary = el('div'); const results = el('div');
  const feedback = el('p', 'form-summary'); feedback.setAttribute('role', 'status');
  const count = el('p', 'property-count'); count.setAttribute('role', 'status');
  const filters = {}; const controls = {};
  root.append(toolbar, note, filtersHost, feedback, summary, count, results);
  function buildFilters() {
    const host = el('section', 'financial-filters'); host.setAttribute('aria-label', 'Filtros financeiros');
    const definitions = [
      ...(!propertyId ? [['propriedadeId', 'Imóvel', { options: { '': 'Todos, incluindo gerais', geral: 'Somente gerais', ...Object.fromEntries(properties.map((p) => [p.id, p.nome])) } }]] : []),
      ['mes', 'Mês', { type: 'month' }], ['inicio', 'De', { type: 'date' }], ['fim', 'Até', { type: 'date' }],
      ['tipo', 'Tipo', { options: { '': 'Todos os tipos', ...TYPES } }],
      ['categoria', 'Categoria', { options: { '': 'Todas as categorias', ...Object.fromEntries([...new Set(records.map((r) => r.categoria))].sort((a, b) => a.localeCompare(b, 'pt-BR')).map((s) => [s, s])) } }],
      ['situacao', 'Situação', { options: { '': 'Todas as situações', em_aberto: 'Em aberto (inclui atrasados)', ...STATUSES } }],
      ['ordenacao', 'Ordenar por', { options: { '': 'Data do recorte · crescente', vencimento: 'Vencimento · crescente' } }],
    ];
    for (const [key, label, options] of definitions) {
      const item = field(`filter-${key}`, label, { ...options, value: filters[key] || '' }); controls[key] = item.control;
      // A categoria pode ter desaparecido após uma edição; não manter filtro invisível.
      filters[key] = item.control.value;
      item.control.addEventListener('input', () => {
        filters[key] = item.control.value;
        if (key === 'mes') for (const date of ['inicio', 'fim']) { filters[date] = ''; controls[date].value = ''; }
        if (['inicio', 'fim'].includes(key)) { filters.mes = ''; controls.mes.value = ''; }
        draw();
      }); host.append(item.wrapper);
    }
    const clear = button('Limpar filtros'); clear.addEventListener('click', () => { Object.keys(filters).forEach((key) => { filters[key] = ''; controls[key].value = ''; }); draw(); });
    host.append(clear); filtersHost.replaceChildren(host);
  }
  function selectedFilters() {
    const selected = { ...filters };
    if (propertyId) selected.propriedadeId = propertyId;
    else if (selected.propriedadeId === 'geral') selected.propriedadeId = null;
    else if (!selected.propriedadeId) delete selected.propriedadeId;
    return selected;
  }
  async function mutate(record, kind) {
    if (operation) return; operation = true;
    try {
      const cancel = kind === 'cancel';
      const accepted = await confirmAction({ title: cancel ? 'Cancelar lançamento?' : 'Excluir lançamento?', description: cancel ? `“${record.descricao}” deixará de compor as previsões. O registro e sua referência serão preservados; reativação não está disponível nesta etapa.` : `Excluir definitivamente “${record.descricao}”? Apenas pendentes manuais podem ser removidos.`, confirmLabel: cancel ? 'Cancelar lançamento' : 'Excluir lançamento', cancelLabel: 'Voltar sem alterar' });
      if (!accepted || !alive) return;
      if (cancel) await service.cancel(record.id, record.revisao ?? 0); else await service.remove(record.id, record.revisao ?? 0);
      if (alive) { showToast(cancel ? 'Lançamento cancelado.' : 'Lançamento excluído.'); await load(); }
    } catch (error) { if (alive) { feedback.textContent = error.message; showToast(error.message, { tone: 'error' }); } }
    finally { operation = false; }
  }
  function draw() {
    if (!alive) return;
    feedback.textContent = ''; results.replaceChildren(); summary.replaceChildren();
    try {
      const selection = selectedFilters(); const today = todayCivil();
      const rows = filterTransactions(records, selection, today);
      summary.append(summaryCards(calculateFinancialSummary(records, selection, today)));
      count.textContent = `${rows.length} ${rows.length === 1 ? 'lançamento no recorte' : 'lançamentos no recorte'}`;
      if (!rows.length) { results.append(emptyState({ title: 'Nenhum lançamento neste recorte', description: 'Cadastre um lançamento ou ajuste os filtros. Receitas e despesas gerais ficam sem vínculo com imóveis.', iconName: 'wallet' })); return; }
      const list = el('div', 'financial-list');
      const names = new Map(properties.map((p) => [p.id, p.nome]));
      for (const record of rows) {
        const status = financialStatus(record, today);
        const row = el('article', `financial-row financial-${record.tipo}`); row.dataset.transactionId = record.id;
        const body = el('div', 'financial-row-copy'); const badges = el('div', 'financial-badges');
        badges.append(el('span', `financial-type type-${record.tipo}`, TYPES[record.tipo]), el('span', `financial-status finance-status-${status}`, STATUSES[status]));
        body.append(badges, el('h3', '', record.descricao), el('p', '', `${record.propriedadeId === null ? 'Geral · sem imóvel' : names.get(record.propriedadeId) || 'Imóvel não encontrado'} · ${record.categoria}`));
        body.append(el('p', 'financial-dates', `Vencimento: ${formatCivilDate(record.vencimento)}${record.liquidadoEm ? ` · ${record.tipo === 'receita' ? 'Recebimento' : 'Pagamento'}: ${formatCivilDate(record.liquidadoEm)}` : ''}`));
        body.append(el('small', 'field-hint', record.origem === 'manual' ? 'Lançamento manual' : `Origem: ${record.origem} · ${record.origemId}${record.periodoReferencia ? ` · ${record.periodoReferencia}` : ''}`));
        const side = el('div', 'financial-row-side'); side.append(el('strong', 'financial-amount', formatBRL(record.valorCentavos)));
        const actions = el('div', 'financial-actions'); actions.append(link(record.situacaoPersistida === 'pendente' ? 'Editar / liquidar' : 'Ver / editar notas', editPath(record.id), 'text-link'));
        if (record.origem === 'contrato') actions.append(link('Abrir contrato', `#/alugueis/${encodeURIComponent(record.origemId)}`, 'text-link'));
        if (record.origem === 'reserva') actions.append(link('Abrir reserva', `#/reservas/${encodeURIComponent(record.origemId)}`, 'text-link'));
        if (record.situacaoPersistida === 'pendente') {
          const cancel = button('Cancelar lançamento', 'button button-text-danger'); cancel.addEventListener('click', () => mutate(record, 'cancel')); actions.append(cancel);
          if (record.origem === 'manual') { const remove = button('Excluir', 'button button-text-danger'); remove.addEventListener('click', () => mutate(record, 'remove')); actions.append(remove); }
        } else side.append(el('small', 'field-hint', 'Histórico financeiro preservado'));
        side.append(actions); row.append(body, side); list.append(row);
      }
      results.append(list);
    } catch (error) { count.textContent = 'Recorte indisponível.'; feedback.textContent = error.message; }
  }
  async function load() {
    if (loading || !alive) return;
    loading = true; refresh.disabled = true; count.textContent = 'Carregando lançamentos…';
    try {
      [records, properties] = await Promise.all([service.list(), database.list('properties')]);
      if (alive) { buildFilters(); draw(); }
    } catch (error) { if (alive) { summary.replaceChildren(); count.textContent = ''; failure(results, error, load); } }
    finally { loading = false; if (alive) refresh.disabled = false; }
  }
  refresh.addEventListener('click', load); load();
  return { element: root, dispose() { alive = false; } };
}

export function renderFinancialForm({ id, propertyId = '' } = {}) {
  let alive = true; let dirty = false; let saving = false; let record; let properties;
  const screen = createScreen({ title: id === undefined ? 'Novo lançamento' : 'Editar lançamento', description: 'Registre entradas e saídas com datas e valores conferidos.' });
  const host = el('div', '', 'Carregando…'); screen.append(host);
  const beforeUnload = (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  function build() {
    const form = el('form', 'property-form panel'); form.noValidate = true;
    const summary = el('p', 'form-summary'); summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
    const locked = record && record.situacaoPersistida !== 'pendente';
    const generated = record && record.origem !== 'manual';
    form.append(el('p', 'form-intro', locked ? 'Histórico preservado: apenas categoria, descrição, forma de pagamento e notas podem ser corrigidas. Valor, datas, situação e imóvel estão bloqueados. Estorno e reativação ainda não estão disponíveis.' : 'Campos com * são obrigatórios. Liquidar exige data de recebimento/pagamento e confirmação. Atraso é calculado pelo vencimento.'), summary);
    if (generated) form.append(el('p', 'financial-note', `Origem: ${record.origem} · ${record.origemId} · ${record.periodoReferencia || record.subtipoOrigem}. Referências, imóvel e tipo são protegidos.`));
    if (record?.origem === 'contrato') form.append(link('Voltar ao contrato', `#/alugueis/${encodeURIComponent(record.origemId)}`, 'text-link'));
    if (record?.origem === 'reserva') form.append(link('Voltar à reserva', `#/reservas/${encodeURIComponent(record.origemId)}`, 'text-link'));
    const fieldset = el('fieldset'); const grid = el('div', 'property-form-grid'); const fields = {};
    const propertyOptions = { '': 'Geral · sem imóvel', ...Object.fromEntries(properties.map((p) => [p.id, p.nome])) };
    const selectedProperty = record?.propriedadeId || propertyId;
    if (selectedProperty && !Object.hasOwn(propertyOptions, selectedProperty)) propertyOptions[selectedProperty] = 'Imóvel não encontrado · selecione outro';
    for (const [key, label, options] of [
      ['tipo', 'Tipo', { options: TYPES, required: true }], ['propriedadeId', 'Imóvel', { options: propertyOptions }],
      ['categoria', 'Categoria', { required: true, maxLength: 80 }], ['descricao', 'Descrição', { required: true, maxLength: 240 }],
      ['valor', 'Valor (R$)', { required: true }], ['vencimento', 'Vencimento', { type: 'date', required: true }],
      ['situacaoPersistida', 'Situação', { required: true, options: locked ? { [record.situacaoPersistida]: STATUSES[record.situacaoPersistida] } : { pendente: 'Pendente', liquidado: 'Liquidado (recebido / pago)' } }],
      ['liquidadoEm', 'Data do recebimento / pagamento', { type: 'date' }],
      ['formaPagamento', 'Forma de pagamento', { maxLength: 80 }], ['observacoes', 'Notas', { multiline: true, maxLength: 3000 }],
    ]) {
      let value = record?.[key] ?? ({ tipo: 'receita', situacaoPersistida: 'pendente', propriedadeId: selectedProperty }[key] || '');
      if (key === 'valor') value = record ? formatBRL(record.valorCentavos).replace(/^R\$\s*/, '') : '';
      fields[key] = field(key, label, { ...options, value }); grid.append(fields[key].wrapper);
      if (locked && ['tipo', 'propriedadeId', 'valor', 'vencimento', 'situacaoPersistida', 'liquidadoEm'].includes(key) || generated && ['tipo', 'propriedadeId'].includes(key)) fields[key].control.disabled = true;
    }
    function settlementState() { const liquidated = fields.situacaoPersistida.control.value === 'liquidado'; fields.liquidadoEm.control.disabled = Boolean(locked) || !liquidated; fields.liquidadoEm.control.required = liquidated; if (!liquidated) fields.liquidadoEm.control.value = ''; }
    fields.situacaoPersistida.control.addEventListener('change', settlementState); settlementState();
    const values = () => Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.control.value]));
    const initial = JSON.stringify(values());
    for (const event of ['input', 'change']) form.addEventListener(event, () => { dirty = JSON.stringify(values()) !== initial; });
    const save = button('Salvar lançamento', 'button button-primary'); save.type = 'submit';
    const actions = el('div', 'form-actions'); actions.append(link('Voltar ao Financeiro', '#/financeiro', 'button button-secondary'), save);
    fieldset.append(grid); form.append(fieldset, actions); host.replaceChildren(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (saving) return;
      Object.values(fields).forEach((item) => { item.error.textContent = ''; item.control.removeAttribute('aria-invalid'); }); summary.textContent = '';
      saving = true; save.disabled = true; fieldset.disabled = true;
      try {
        const input = values(); validateFinancialInput(input);
        if (input.situacaoPersistida === 'liquidado' && record?.situacaoPersistida !== 'liquidado') {
          const accepted = await confirmAction({ title: 'Confirmar liquidação?', description: `${TYPES[input.tipo]} de ${formatBRL(validateFinancialInput(input).valorCentavos)} em ${formatCivilDate(input.liquidadoEm)}. Após confirmar, valor, datas, tipo, imóvel e situação serão preservados. Confira antes de continuar.`, confirmLabel: 'Confirmar liquidação', cancelLabel: 'Revisar lançamento' });
          if (!accepted || !alive) return;
        }
        await service.save(input, record ? { id: record.id, expectedRevision: record.revisao ?? 0 } : {});
        if (!alive) return;
        dirty = false; saving = false; showToast('Lançamento salvo.'); window.location.hash = '/financeiro';
      } catch (error) {
        if (!alive) return;
        summary.textContent = error.message;
        if (error.fields) for (const [key, message] of Object.entries(error.fields)) { fields[key].error.textContent = message; fields[key].control.setAttribute('aria-invalid', 'true'); }
        fieldset.disabled = false; (form.querySelector('[aria-invalid="true"]') || summary).focus();
      } finally { saving = false; if (alive) { fieldset.disabled = false; save.disabled = false; } }
    });
  }
  async function load() {
    try {
      properties = await database.list('properties');
      if (id !== undefined) record = await service.get(id);
      if (!alive) return;
      if (id !== undefined && !record) { host.replaceChildren(emptyState({ title: 'Lançamento não encontrado', description: 'O registro pode ter sido excluído em outra aba.', action: link('Voltar ao Financeiro', '#/financeiro', 'button button-primary') })); return; }
      build();
    } catch (error) { if (alive) failure(host, error, load); }
  }
  load();
  return { element: screen, dispose() { alive = false; window.removeEventListener('beforeunload', beforeUnload); }, canLeave: () => saving ? false : !dirty || confirmAction({ title: 'Descartar alterações?', description: 'Há alterações no lançamento que ainda não foram salvas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar editando' }) };
}

export function renderFinancial(params) {
  if (params.mode !== 'list') return renderFinancialForm(params);
  const screen = createScreen({ title: 'Financeiro', description: 'Entradas, saídas e pendências, com cada valor no período correto.' });
  const content = createFinancialPanel(); screen.append(content.element);
  return { element: screen, dispose: content.dispose };
}
