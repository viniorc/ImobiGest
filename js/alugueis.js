import { database } from './db.js';
import { createLeaseService, LEASE_STATUSES, validateLeaseInput } from './alugueis-service.js';
import { formatBRL, formatCivilDate, todayCivil } from './utils.js';
import { calculateFinancialSummary, filterTransactions, financialStatus } from './financeiro-calculos.js';
import { el, link, createScreen, emptyState, confirmAction, showToast } from './ui.js';

const service = createLeaseService();
const path = (id) => `#/alugueis/${encodeURIComponent(id)}`;
const newPath = (id) => `#/alugueis/novo${id ? `?imovel=${encodeURIComponent(id)}` : ''}`;
const button = (text, style = 'button button-secondary') => { const node = el('button', style, text); node.type = 'button'; return node; };
const periodLabel = (period) => `${period.slice(5)}/${period.slice(0, 4)}`;
const statusLabels = { pendente: 'A receber', atrasado: 'Vencida', liquidado: 'Recebida', cancelado: 'Cancelada' };

function field(name, label, { value = '', type = 'text', options, required = false, maxLength } = {}) {
  const wrapper = el('div', 'field'); const control = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  control.id = `lease-${name}`; control.name = name; control.required = required;
  const caption = el('label', '', `${label}${required ? ' *' : ''}`); caption.htmlFor = control.id;
  if (options) for (const [key, text] of Object.entries(options)) { const option = el('option', '', text); option.value = key; control.append(option); }
  else if (type !== 'textarea') control.type = type;
  if (maxLength) control.maxLength = maxLength;
  if (type === 'textarea') control.rows = 4;
  if (name === 'valorMensal') control.inputMode = 'decimal';
  if (name === 'diaVencimento') { control.min = '1'; control.max = '31'; control.step = '1'; }
  control.value = value;
  const error = el('span', 'field-error'); error.id = `${control.id}-error`; control.setAttribute('aria-describedby', error.id);
  wrapper.append(caption, control, error); return { wrapper, control, error };
}
function failure(host, error, retry) {
  const state = emptyState({ title: 'Não foi possível carregar os contratos', description: error.message, iconName: 'info' });
  const action = button('Tentar novamente'); action.addEventListener('click', retry); state.append(action); host.replaceChildren(state);
}
function missing() { return emptyState({ title: 'Contrato não encontrado', description: 'Volte à lista para conferir os registros disponíveis.', action: link('Voltar aos aluguéis', '#/alugueis', 'button button-primary') }); }

export function matchLeaseRoute(route) {
  if (route === '/alugueis') return { mode: 'list' };
  const [pathname, query = ''] = route.split('?');
  if (pathname === '/alugueis/novo') return { mode: 'new', propertyId: new URLSearchParams(query).get('imovel') || '' };
  const match = /^\/alugueis\/([^/]+)(\/editar)?$/.exec(route);
  if (!match) return null;
  let id; try { id = decodeURIComponent(match[1]); } catch { id = ''; }
  return { mode: match[2] ? 'edit' : 'detail', id };
}

function installmentView(records, leases, names) {
  const host = el('section', 'lease-installments'); host.append(el('h2', '', 'Parcelas do recorte'));
  const status = field('parcel-status', 'Situação da parcela', { options: { '': 'Todas', em_aberto: 'A receber (inclui vencidas)', liquidado: 'Recebidas', atrasado: 'Vencidas', cancelado: 'Canceladas' } });
  const results = el('div'); host.append(status.wrapper, results);
  function draw() {
    try {
      const today = todayCivil(); const filters = { situacao: status.control.value, ordenacao: 'vencimento' };
      const rows = filterTransactions(records, filters, today); const totals = calculateFinancialSummary(records, filters, today);
      const summary = el('div', 'lease-summary');
      for (const [label, value] of [['A receber', totals.aReceber], ['Recebidas', totals.receitaRealizada], ['Vencidas (incluídas a receber)', totals.receitaAtrasada]]) {
        const card = el('div', 'metric-card'); card.append(el('h3', '', label), el('p', 'metric-value', formatBRL(value))); summary.append(card);
      }
      results.replaceChildren(summary);
      if (!rows.length) { results.append(emptyState({ title: 'Nenhuma parcela neste recorte', description: 'A geração é explícita na ficha do contrato. Ajuste os filtros para consultar outras parcelas.', iconName: 'wallet' })); return; }
      const list = el('div', 'financial-list');
      const tenants = new Map(leases.map((lease) => [lease.id, lease.locatario]));
      for (const row of rows) {
        const state = financialStatus(row, today); const card = el('article', 'financial-row financial-receita'); card.dataset.installmentId = row.id;
        const copy = el('div', 'financial-row-copy');
        copy.append(el('span', `financial-status finance-status-${state}`, statusLabels[state]), el('h3', '', `Competência ${periodLabel(row.periodoReferencia)}`), el('p', '', `${tenants.get(row.origemId) || 'Contrato não encontrado'} · ${names.get(row.propriedadeId) || 'Imóvel não encontrado'}`), el('p', '', `Vencimento: ${formatCivilDate(row.vencimento)}${row.liquidadoEm ? ` · Recebimento: ${formatCivilDate(row.liquidadoEm)}` : ''}`));
        const actions = el('div', 'financial-row-side'); actions.append(el('strong', 'financial-amount', formatBRL(row.valorCentavos)), link(row.situacaoPersistida === 'pendente' ? 'Receber no Financeiro' : 'Consultar no Financeiro', `#/financeiro/${encodeURIComponent(row.id)}/editar`, 'text-link'), link('Abrir contrato', path(row.origemId), 'text-link'));
        card.append(copy, actions); list.append(card);
      }
      results.append(list);
    } catch (error) { results.replaceChildren(el('p', 'form-summary', error.message)); }
  }
  status.control.addEventListener('input', draw); draw(); return host;
}

export function createLeasePanel({ propertyId } = {}) {
  let alive = true; let loading = false; let leases = []; let properties = []; let transactions = [];
  const root = el('div', 'lease-panel'); const toolbar = el('div', 'financial-toolbar'); const refresh = button('Atualizar');
  toolbar.append(link('Novo contrato', newPath(propertyId), 'button button-primary'), refresh);
  const filterHost = el('div'); const results = el('div');
  const filters = { propriedadeId: propertyId || '', id: '', situacao: '' };
  root.append(toolbar, el('p', 'financial-note', 'Locação de unidade inteira neste MVP. Contratos não cancelados bloqueiam períodos de outros contratos e reservas confirmadas/concluídas. Situação cadastral do imóvel não é alterada automaticamente.'), filterHost, results);
  function buildFilters() {
    const section = el('section', 'lease-filters'); section.setAttribute('aria-label', 'Filtros de contratos');
    for (const [key, label, options] of [
      ...(!propertyId ? [['propriedadeId', 'Imóvel', { '': 'Todos os imóveis', ...Object.fromEntries(properties.map((p) => [p.id, p.nome])) }]] : []),
      ['id', 'Contrato / locatário', { '': 'Todos os contratos', ...Object.fromEntries(leases.filter((l) => !filters.propriedadeId || l.propriedadeId === filters.propriedadeId).map((l) => [l.id, `${l.locatario} · ${formatCivilDate(l.inicio)}`])) }],
      ['situacao', 'Situação do contrato', { '': 'Todas as situações', ...LEASE_STATUSES }],
    ]) {
      const item = field(`filter-${key}`, label, { options, value: filters[key] }); filters[key] = item.control.value;
      item.control.addEventListener('input', () => { filters[key] = item.control.value; if (key === 'propriedadeId') { filters.id = ''; buildFilters(); } draw(); }); section.append(item.wrapper);
    }
    filterHost.replaceChildren(section);
  }
  function draw() {
    const selected = leases.filter((lease) => (!filters.propriedadeId || lease.propriedadeId === filters.propriedadeId) && (!filters.id || lease.id === filters.id) && (!filters.situacao || lease.situacao === filters.situacao)).sort((a, b) => b.inicio.localeCompare(a.inicio) || a.id.localeCompare(b.id));
    const ids = new Set(selected.map((lease) => lease.id)); const names = new Map(properties.map((p) => [p.id, p.nome]));
    results.replaceChildren();
    if (!selected.length) { results.append(emptyState({ title: 'Nenhum contrato neste recorte', description: 'Cadastre um contrato ou ajuste os filtros.', iconName: 'contract' })); return; }
    const list = el('div', 'lease-list');
    for (const lease of selected) {
      const card = el('article', 'lease-card'); card.dataset.leaseId = lease.id;
      card.append(el('span', `lease-status lease-status-${lease.situacao}`, LEASE_STATUSES[lease.situacao]), el('h2', '', lease.locatario), el('p', '', names.get(lease.propriedadeId) || 'Imóvel não encontrado'), el('p', '', `${formatCivilDate(lease.inicio)} a ${lease.fim ? formatCivilDate(lease.fim) : 'sem data final'}`), el('strong', '', `${formatBRL(lease.valorMensalCentavos)} / mês · dia ${lease.diaVencimento}`), link('Ver contrato e cobranças', path(lease.id), 'text-link'), link('Editar contrato', `${path(lease.id)}/editar`, 'text-link')); list.append(card);
    }
    results.append(list, installmentView(transactions.filter((row) => row.origem === 'contrato' && ids.has(row.origemId)), selected, names));
  }
  async function load() {
    if (loading || !alive) return; loading = true; refresh.disabled = true;
    try { [leases, properties, transactions] = await Promise.all([service.list(), database.list('properties'), database.list('transactions')]); if (alive) { buildFilters(); draw(); } }
    catch (error) { if (alive) failure(results, error, load); }
    finally { loading = false; if (alive) refresh.disabled = false; }
  }
  refresh.addEventListener('click', load); load(); return { element: root, dispose() { alive = false; } };
}

export function renderLeaseForm({ id, propertyId = '' } = {}) {
  let alive = true; let dirty = false; let saving = false; let lease; let installments = [];
  const screen = createScreen({ title: id === undefined ? 'Novo contrato' : 'Editar / encerrar contrato', description: 'Vigência, valor mensal e locatário da unidade.' }); const host = el('div', '', 'Carregando…'); screen.append(host);
  const beforeUnload = (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload);
  async function load() {
    try {
      const properties = await database.list('properties');
      if (id !== undefined) { lease = await service.get(id); installments = await service.installments(id); }
      if (!alive) return;
      if (id !== undefined && !lease) { host.replaceChildren(missing()); return; }
      if (!properties.length) { host.replaceChildren(emptyState({ title: 'Cadastre um imóvel primeiro', description: 'Todo contrato precisa de um imóvel existente.', action: link('Cadastrar imóvel', '#/imoveis/novo', 'button button-primary') })); return; }
      const form = el('form', 'property-form panel'); form.noValidate = true;
      const summary = el('p', 'form-summary'); summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
      form.append(el('p', 'form-intro', 'Campos com * são obrigatórios. Meses parciais têm valor mensal integral, sem rateio automático. Encerrar exige data final e preserva todas as parcelas, inclusive pendências posteriores ao fim. Alterar valor ou dia só afeta novas parcelas. Para receber, use o Financeiro.'), summary);
      const fieldset = el('fieldset'); const grid = el('div', 'property-form-grid'); const fields = {};
      const propertyOptions = { '': 'Selecione o imóvel', ...Object.fromEntries(properties.map((p) => [p.id, p.nome])) };
      if (lease?.propriedadeId && !Object.hasOwn(propertyOptions, lease.propriedadeId)) propertyOptions[lease.propriedadeId] = 'Imóvel não encontrado';
      const statusOptions = lease && lease.situacao !== 'ativo' ? { [lease.situacao]: LEASE_STATUSES[lease.situacao] } : LEASE_STATUSES;
      for (const [key, label, options] of [
        ['propriedadeId', 'Imóvel', { options: propertyOptions, required: true }], ['locatario', 'Locatário', { required: true, maxLength: 120 }],
        ['inicio', 'Início', { type: 'date', required: true }], ['fim', 'Fim (opcional para ativo)', { type: 'date' }],
        ['valorMensal', 'Valor mensal (R$)', { required: true }], ['diaVencimento', 'Dia de vencimento (1–31)', { type: 'number', required: true }],
        ['situacao', 'Situação', { options: statusOptions, required: true }], ['observacoes', 'Observações', { type: 'textarea', maxLength: 3000 }],
      ]) {
        let value = lease?.[key] ?? ({ propriedadeId: propertyId, situacao: 'ativo' }[key] || '');
        if (key === 'valorMensal') value = lease ? formatBRL(lease.valorMensalCentavos).replace(/^R\$\s*/, '') : '';
        fields[key] = field(key, label, { ...options, value });
        if (installments.length && ['propriedadeId', 'inicio'].includes(key)) fields[key].control.disabled = true;
        grid.append(fields[key].wrapper);
      }
      if (installments.length) form.append(el('p', 'financial-note', `${installments.length} parcela(s) já emitida(s). Imóvel e início protegidos; editar ou encerrar não recalcula nem cancela essas parcelas.`));
      const values = () => Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.control.value])); const initial = JSON.stringify(values());
      for (const event of ['input', 'change']) form.addEventListener(event, () => { dirty = JSON.stringify(values()) !== initial; });
      const save = button('Salvar contrato', 'button button-primary'); save.type = 'submit'; const actions = el('div', 'form-actions'); actions.append(link('Voltar', lease ? path(id) : '#/alugueis', 'button button-secondary'), save);
      fieldset.append(grid); form.append(fieldset, actions); host.replaceChildren(form);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); if (saving) return;
        summary.textContent = ''; Object.values(fields).forEach((item) => { item.error.textContent = ''; item.control.removeAttribute('aria-invalid'); });
        saving = true; fieldset.disabled = true; save.disabled = true;
        try {
          const input = values(); validateLeaseInput(input);
          if (lease || input.situacao !== 'ativo') {
            const accepted = await confirmAction({ title: 'Salvar situação e condições?', description: 'As parcelas já emitidas serão preservadas integralmente, inclusive recebimentos e pendências fora de uma nova data final. Novos valores e vencimentos valem apenas para competências ainda não emitidas. Encerrados/cancelados não podem ser reativados nesta etapa.', confirmLabel: 'Salvar contrato', cancelLabel: 'Continuar editando' });
            if (!accepted || !alive) return;
          }
          const saved = await service.save(input, lease ? { id, expectedRevision: lease.revisao ?? 0 } : {});
          if (alive) { dirty = false; saving = false; showToast('Contrato salvo. Nenhuma parcela existente foi alterada.'); window.location.hash = path(saved.id).slice(1); }
        } catch (error) {
          if (!alive) return; summary.textContent = error.message;
          if (error.fields) for (const [key, message] of Object.entries(error.fields)) { fields[key].error.textContent = message; fields[key].control.setAttribute('aria-invalid', 'true'); }
          fieldset.disabled = false; (form.querySelector('[aria-invalid="true"]') || summary).focus();
        } finally { saving = false; if (alive) { fieldset.disabled = false; save.disabled = false; } }
      });
    } catch (error) { if (alive) failure(host, error, load); }
  }
  load();
  return { element: screen, dispose() { alive = false; window.removeEventListener('beforeunload', beforeUnload); }, canLeave: () => saving ? false : !dirty || confirmAction({ title: 'Descartar alterações?', description: 'O contrato tem alterações ainda não salvas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar editando' }) };
}

export function renderLeaseDetail({ id }) {
  let alive = true; let busy = false; let loading = false; let preview;
  const screen = createScreen({ title: 'Contrato de aluguel', description: 'Cobranças previstas, emitidas somente após sua confirmação.' });
  const host = el('div', 'lease-detail', 'Carregando contrato…'); screen.append(link('Voltar aos aluguéis', '#/alugueis', 'text-link'), host);
  async function load() {
    if (loading || !alive) return;
    loading = true; preview = undefined;
    try {
      const lease = await service.get(id); if (!alive) return;
      if (!lease) { host.replaceChildren(missing()); return; }
      const properties = await database.list('properties'); if (!alive) return;
      const names = new Map(properties.map((p) => [p.id, p.nome]));
      screen.querySelector('h1').textContent = `Contrato · ${lease.locatario}`;
      const facts = el('dl', 'property-facts lease-facts');
      for (const [label, value] of [['Imóvel', names.get(lease.propriedadeId) || 'Imóvel não encontrado'], ['Locatário', lease.locatario], ['Situação', LEASE_STATUSES[lease.situacao]], ['Início', formatCivilDate(lease.inicio)], ['Fim', lease.fim ? formatCivilDate(lease.fim) : 'Sem data final'], ['Valor mensal', formatBRL(lease.valorMensalCentavos)], ['Dia de vencimento', String(lease.diaVencimento)], ['Observações', lease.observacoes || 'Não informadas']]) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); facts.append(row); }
      const toolbar = el('div', 'financial-toolbar'); const refresh = button('Atualizar ficha'); refresh.addEventListener('click', () => { if (!busy) load(); }); toolbar.append(link('Editar / encerrar contrato', `${path(id)}/editar`, 'button button-secondary'), refresh);
      const generation = el('section', 'lease-generation panel'); generation.append(el('h2', '', 'Gerar cobranças'), el('p', 'financial-note', 'Uma receita pendente por competência, com valor mensal integral (sem rateio). Dia inexistente usa o último dia do mês; nas pontas da vigência, o vencimento é limitado ao início/fim. Parcelas existentes, inclusive canceladas, nunca são recriadas. Até 120 meses por vez.'));
      const parts = el('div');
      async function loadParts() { const records = await service.installments(id); if (alive) parts.replaceChildren(installmentView(records, [lease], names)); }
      if (lease.situacao === 'cancelado') generation.append(el('p', 'financial-note', 'Contrato cancelado: geração indisponível.'));
      else {
        const form = el('form', 'lease-range'); form.noValidate = true;
        const start = field('mesInicio', 'Mês inicial', { type: 'month', required: true, value: lease.inicio.slice(0, 7) });
        const end = field('mesFim', 'Mês final', { type: 'month', required: true, value: (lease.fim || lease.inicio).slice(0, 7) });
        const review = button('Ver prévia'); review.type = 'submit'; form.append(start.wrapper, end.wrapper, review);
        const feedback = el('p', 'form-summary'); feedback.setAttribute('role', 'status'); const rows = el('div');
        const generate = button('Gerar cobranças', 'button button-primary'); generate.disabled = true;
        const invalidate = () => { preview = undefined; rows.replaceChildren(); generate.disabled = true; feedback.classList.remove('lease-error'); feedback.textContent = 'Confira a prévia para habilitar a geração.'; };
        start.control.addEventListener('input', invalidate); end.control.addEventListener('input', invalidate);
        const toggle = (value) => { busy = value; start.control.disabled = end.control.disabled = review.disabled = refresh.disabled = value; generate.disabled = value || !preview; };
        function renderPreview() {
          const message = `${preview.createCount} nova(s) · ${preview.existingCount} já cadastrada(s) · ${preview.outsideCount} fora da vigência. Novas previsões: ${formatBRL(preview.totalCentavos)}.`;
          rows.replaceChildren(el('p', 'lease-preview-summary', message)); const list = el('ul', 'lease-preview');
          for (const row of preview.rows) {
            const detail = row.state === 'outside' ? 'Fora da vigência · não gerar' : `${formatCivilDate(row.vencimento)} · ${formatBRL(row.valorCentavos)} · ${row.state === 'new' ? 'Nova · pendente' : `Já cadastrada · ${statusLabels[financialStatus(row.record)]}${row.outside ? ' · histórico fora da vigência atual' : ''}`}`;
            list.append(el('li', '', `${periodLabel(row.periodoReferencia)} — ${detail}`));
          }
          rows.append(list);
        }
        form.addEventListener('submit', async (event) => {
          event.preventDefault(); if (busy) return; invalidate(); toggle(true); feedback.textContent = 'Consultando prévia…';
          try { preview = await service.preview(id, start.control.value, end.control.value); if (alive) { renderPreview(); feedback.textContent = 'Confira competências, datas e valores antes de gerar. Nenhum recebimento será lançado.'; } }
          catch (error) { preview = undefined; if (alive) { feedback.classList.add('lease-error'); feedback.textContent = error.message; } }
          finally { if (alive) toggle(false); else busy = false; }
        });
        generate.addEventListener('click', async () => {
          if (busy || !preview) return; toggle(true);
          try {
            const accepted = await confirmAction({ title: 'Gerar cobranças previstas?', description: `${preview.createCount} nova(s) parcela(s), total ${formatBRL(preview.totalCentavos)}. Existentes serão ignoradas. As novas receitas ficarão pendentes; nenhum pagamento será registrado.`, confirmLabel: 'Gerar cobranças', cancelLabel: 'Revisar prévia' });
            if (!accepted || !alive) return;
            const result = await service.generate(id, preview.start, preview.end, preview.lease.revisao ?? 0);
            if (!alive) return;
            feedback.textContent = `${result.createCount} cobrança(s) criada(s); ${result.existingCount} já cadastrada(s); ${result.outsideCount} fora da vigência. Nenhum recebimento automático.`;
            preview = undefined; rows.replaceChildren(); await loadParts();
          } catch (error) { preview = undefined; rows.replaceChildren(); if (alive) { feedback.classList.add('lease-error'); feedback.textContent = error.message; } }
          finally { if (alive) toggle(false); else busy = false; }
        });
        generation.append(form, feedback, rows, generate);
      }
      host.replaceChildren(toolbar, facts, generation, parts); await loadParts();
    } catch (error) { if (alive) failure(host, error, load); }
    finally { loading = false; }
  }
  load(); return { element: screen, dispose() { alive = false; }, canLeave: () => !busy };
}

export function renderLeases(params) {
  if (params.mode === 'new' || params.mode === 'edit') return renderLeaseForm(params);
  if (params.mode === 'detail') return renderLeaseDetail(params);
  const screen = createScreen({ title: 'Aluguéis tradicionais', description: 'Contratos e parcelas, com histórico preservado.' }); const panel = createLeasePanel(); screen.append(panel.element); return { element: screen, dispose: panel.dispose };
}
