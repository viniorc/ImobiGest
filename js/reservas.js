import { database } from './db.js';
import { createBookingService, validateBookingInput, BOOKING_STATUSES, PLATFORMS, CHARGE_LABELS, bookingEstimate, bookingMonth, shiftBookingMonth } from './reservas-service.js';
import { formatBRL, formatCivilDate, calculateNights, todayCivil, dueDateForMonth } from './utils.js';
import { calculateFinancialSummary, financialStatus } from './financeiro-calculos.js';
import { el, link, createScreen, emptyState, confirmAction, showToast } from './ui.js';

const service = createBookingService();
const detailPath = (id) => `#/reservas/${encodeURIComponent(id)}`;
let selectedMonth = todayCivil().slice(0, 7);
const button = (text, style = 'button button-secondary') => { const node = el('button', style, text); node.type = 'button'; return node; };
const paymentLabels = { pendente: 'Pendente', atrasado: 'Atrasado', liquidado: 'Liquidado', cancelado: 'Cancelado' };
function field(name, label, { value = '', options, type = 'text', required = false, maxLength } = {}) {
  const wrapper = el('div', 'field'); const control = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  control.id = `booking-${name}`; control.name = name; control.required = required;
  const caption = el('label', '', `${label}${required ? ' *' : ''}`); caption.htmlFor = control.id;
  if (options) for (const [key, text] of Object.entries(options)) { const option = el('option', '', text); option.value = key; control.append(option); }
  else if (type !== 'textarea') control.type = type;
  if (maxLength) control.maxLength = maxLength; if (type === 'textarea') control.rows = 4;
  if (['valorBruto', 'taxaPlataforma', 'outrasDespesas'].includes(name)) control.inputMode = 'decimal'; control.value = value;
  const error = el('span', 'field-error'); error.id = `${control.id}-error`; control.setAttribute('aria-describedby', error.id);
  wrapper.append(caption, control, error); return { wrapper, control, error };
}
function failure(host, error, retry) {
  const state = emptyState({ title: 'Não foi possível carregar as reservas', description: error.message, iconName: 'info' }); const action = button('Tentar novamente'); action.addEventListener('click', retry); state.append(action); host.replaceChildren(state);
}
function missing() { return emptyState({ title: 'Reserva não encontrada', description: 'Volte à lista para conferir os registros.', action: link('Voltar às reservas', '#/reservas', 'button button-primary') }); }
export function matchBookingRoute(route) {
  if (route === '/reservas') return { mode: 'list' };
  const [pathname, query = ''] = route.split('?');
  if (pathname === '/reservas/novo') return { mode: 'new', propertyId: new URLSearchParams(query).get('imovel') || '' };
  const match = /^\/reservas\/([^/]+)(\/editar)?$/.exec(route); if (!match) return null;
  let id; try { id = decodeURIComponent(match[1]); } catch { id = ''; }
  return { mode: match[2] ? 'edit' : 'detail', id };
}

export function createBookingPanel({ propertyId } = {}) {
  let alive = true; let loading = false; let bookings = []; let properties = []; let leases = [];
  const root = el('div', 'booking-panel'); const toolbar = el('div', 'financial-toolbar'); const refresh = button('Atualizar');
  toolbar.append(link('Nova reserva', `#/reservas/novo${propertyId ? `?imovel=${encodeURIComponent(propertyId)}` : ''}`, 'button button-primary'), refresh);
  const filters = el('section', 'lease-filters'); filters.setAttribute('aria-label', 'Filtros de reservas');
  const month = field('month', 'Mês', { type: 'month', value: selectedMonth });
  const property = field('filter-property', 'Imóvel', { options: { '': 'Todos os imóveis' } });
  const status = field('filter-status', 'Situação (lista)', { options: { '': 'Todas', ...BOOKING_STATUSES } });
  filters.append(month.wrapper); if (!propertyId) filters.append(property.wrapper); filters.append(status.wrapper);
  const feedback = el('p', 'form-summary'); feedback.setAttribute('role', 'status'); const content = el('div', 'booking-panel');
  root.append(toolbar, el('p', 'financial-note', 'Cadastro manual, sem conexão com Airbnb ou Booking. Saída não ocupa a noite desse dia. O calendário inclui reservas não canceladas e contratos de unidades inteiras; a situação filtra somente a lista.'), filters, feedback, content);
  function draw() {
    if (!alive) return; feedback.textContent = ''; content.replaceChildren();
    try {
      const selected = propertyId || property.control.value;
      const start = dueDateForMonth(month.control.value, 1); const end = dueDateForMonth(month.control.value, 31); selectedMonth = month.control.value;
      const names = new Map(properties.map((row) => [row.id, row.nome]));
      const calendar = el('details', 'booking-calendar-panel panel'); calendar.open = true; calendar.append(el('summary', '', `Calendário · ${month.control.value.slice(5)}/${month.control.value.slice(0, 4)}`));
      const nav = el('div', 'financial-toolbar');
      for (const [label, delta] of [['Mês anterior', -1], ['Próximo mês', 1]]) {
        const action = button(label); let target;
        try { target = shiftBookingMonth(month.control.value, delta); } catch { action.disabled = true; action.title = 'Limite do calendário (anos 0001–9999).'; }
        action.addEventListener('click', () => { month.control.value = target; draw(); }); nav.append(action);
      }
      calendar.append(nav);
      const grid = el('div', 'booking-calendar'); const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
      for (const day of weekdays) { const label = el('span', 'booking-weekday', day); label.setAttribute('aria-hidden', 'true'); grid.append(label); }
      const model = bookingMonth(month.control.value, bookings, leases, selected);
      for (let n = 0; n < model.offset; n++) { const blank = el('div', 'booking-day-blank'); blank.setAttribute('aria-hidden', 'true'); grid.append(blank); }
      for (const [index, day] of model.days.entries()) {
        const cell = el('section', 'booking-day'); cell.dataset.date = day.date; cell.setAttribute('aria-label', formatCivilDate(day.date));
        cell.append(el('h3', '', `${day.date.slice(8)} · ${weekdays[(model.offset + index) % 7]}`));
        for (const booking of day.bookings) cell.append(link(`${booking.hospede} · ${names.get(booking.propriedadeId) || 'Imóvel'} · ${BOOKING_STATUSES[booking.situacao]}`, detailPath(booking.id), `booking-event booking-${booking.situacao}`));
        for (const lease of day.leases) cell.append(link(`Contrato · ${names.get(lease.propriedadeId) || 'Imóvel'} · ${lease.locatario}`, `#/alugueis/${encodeURIComponent(lease.id)}`, 'booking-event booking-contract'));
        if (!day.bookings.length && !day.leases.length) cell.append(el('span', 'field-hint', 'Sem reserva ou contrato')); grid.append(cell);
      }
      calendar.append(grid); content.append(calendar, el('h2', '', 'Reservas que cruzam o mês'));
      const rows = bookings.filter((row) => (!selected || row.propriedadeId === selected) && (!status.control.value || row.situacao === status.control.value) && row.entrada <= end && row.saida > start).sort((a, b) => a.entrada.localeCompare(b.entrada) || a.id.localeCompare(b.id));
      if (!rows.length) { content.append(emptyState({ title: 'Nenhuma reserva neste recorte', description: 'Ajuste mês, imóvel ou situação, ou cadastre uma reserva manual.', iconName: 'calendar' })); return; }
      const list = el('div', 'lease-list');
      for (const row of rows) {
        const card = el('article', 'lease-card'); card.dataset.bookingId = row.id;
        card.append(el('span', `lease-status booking-${row.situacao}`, BOOKING_STATUSES[row.situacao]), el('h2', '', row.hospede), el('p', '', `${names.get(row.propriedadeId) || 'Imóvel não encontrado'} · ${PLATFORMS[row.plataforma]}`), el('p', '', `${formatCivilDate(row.entrada)} → ${formatCivilDate(row.saida)} · ${calculateNights(row.entrada, row.saida)} noites`), el('strong', '', `Resultado estimado: ${formatBRL(bookingEstimate(row))}`), el('small', 'field-hint', 'Estimativa negociada. Não representa recebimento.'), link('Ver reserva e lançamentos', detailPath(row.id), 'text-link')); list.append(card);
      }
      content.append(list);
    } catch (error) { feedback.textContent = error.message; }
  }
  async function load() {
    if (loading || !alive) return; loading = true; refresh.disabled = true;
    try {
      [bookings, properties, leases] = await Promise.all([service.list(), database.list('properties'), database.list('leases')]);
      if (!alive) return;
      const previous = property.control.value; property.control.replaceChildren();
      for (const [id, label] of [['', 'Todos os imóveis'], ...properties.map((p) => [p.id, p.nome])]) { const option = el('option', '', label); option.value = id; property.control.append(option); }
      property.control.value = properties.some((p) => p.id === previous) ? previous : ''; draw();
    } catch (error) { if (alive) failure(content, error, load); }
    finally { loading = false; if (alive) refresh.disabled = false; }
  }
  for (const item of [month, property, status]) item.control.addEventListener('input', draw);
  refresh.addEventListener('click', load); load(); return { element: root, dispose() { alive = false; } };
}

export function renderBookingForm({ id, propertyId = '' } = {}) {
  let alive = true; let dirty = false; let saving = false; let booking; let records = [];
  const screen = createScreen({ title: id === undefined ? 'Nova reserva' : 'Editar reserva', description: 'Hospedagem cadastrada manualmente, sem integração com plataformas.' }); const host = el('div', '', 'Carregando…'); screen.append(host);
  const beforeUnload = (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload);
  async function load() {
    try {
      const properties = await database.list('properties'); if (id !== undefined) { booking = await service.get(id); records = await service.transactions(id); }
      if (!alive) return; if (id !== undefined && !booking) { host.replaceChildren(missing()); return; }
      if (!properties.length) { host.replaceChildren(emptyState({ title: 'Cadastre um imóvel primeiro', description: 'Toda reserva precisa de um imóvel existente.', action: link('Cadastrar imóvel', '#/imoveis/novo', 'button button-primary') })); return; }
      const form = el('form', 'property-form panel'); form.noValidate = true; const summary = el('p', 'form-summary'); summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
      form.append(el('p', 'form-intro', 'Campos com * são obrigatórios. Informe zero nas despesas inexistentes. Entrada inclusiva e saída exclusiva. Contratos vigentes e reservas não canceladas bloqueiam a mesma unidade. Cancelamento de reserva existente é feito na ficha, com revisão financeira.'), summary);
      if (records.length) form.append(el('p', 'financial-note', 'Esta reserva tem lançamentos: imóvel protegido. Editar datas ou valores negociados não altera lançamentos existentes; diferenças serão mostradas na prévia. Correções financeiras são explícitas no Financeiro.'));
      if (booking?.situacao === 'cancelada') form.append(el('p', 'financial-note', 'Cancelada: imóvel, datas, valores e situação preservados. Sem reativação nesta etapa.'));
      const fieldset = el('fieldset'); const grid = el('div', 'property-form-grid'); const fields = {};
      const propertyOptions = { '': 'Selecione o imóvel', ...Object.fromEntries(properties.map((p) => [p.id, p.nome])) };
      if (booking?.propriedadeId && !Object.hasOwn(propertyOptions, booking.propriedadeId)) propertyOptions[booking.propriedadeId] = 'Imóvel não encontrado';
      const statuses = booking?.situacao === 'cancelada' ? { cancelada: 'Cancelada' } : booking ? { confirmada: 'Confirmada', concluida: 'Concluída' } : BOOKING_STATUSES;
      for (const [key, label, options] of [
        ['propriedadeId', 'Imóvel', { options: propertyOptions, required: true }], ['hospede', 'Hóspede', { required: true, maxLength: 120 }],
        ['plataforma', 'Plataforma', { options: PLATFORMS, required: true }], ['situacao', 'Situação', { options: statuses, required: true }],
        ['entrada', 'Check-in', { type: 'date', required: true }], ['saida', 'Check-out', { type: 'date', required: true }],
        ['valorBruto', 'Valor bruto (R$)', { required: true }], ['taxaPlataforma', 'Taxa da plataforma (R$)', { required: true }], ['outrasDespesas', 'Outras despesas (R$)', { required: true }], ['observacoes', 'Observações', { type: 'textarea', maxLength: 3000 }],
      ]) {
        let value = booking?.[key] ?? ({ propriedadeId: propertyId, plataforma: 'direta', situacao: 'confirmada', taxaPlataforma: '0,00', outrasDespesas: '0,00' }[key] || '');
        if (booking && ['valorBruto', 'taxaPlataforma', 'outrasDespesas'].includes(key)) value = formatBRL(booking[`${key}Centavos`]).replace(/^R\$\s*/, '');
        fields[key] = field(key, label, { ...options, value });
        if (key === 'observacoes') fields[key].wrapper.classList.add('field-wide');
        if (records.length && key === 'propriedadeId' || booking?.situacao === 'cancelada' && ['propriedadeId', 'entrada', 'saida', 'valorBruto', 'taxaPlataforma', 'outrasDespesas', 'situacao'].includes(key)) fields[key].control.disabled = true;
        grid.append(fields[key].wrapper);
      }
      const estimate = el('p', 'financial-note'); estimate.setAttribute('role', 'status');
      const values = () => Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.control.value])); const initial = JSON.stringify(values());
      function compute() {
        const input = values(); let nights = ''; try { nights = `${calculateNights(input.entrada, input.saida)} noites`; } catch {}
        try { estimate.textContent = `${nights} · Resultado estimado: ${formatBRL(bookingEstimate(validateBookingInput(input)))}. Não é caixa recebido.`; }
        catch { estimate.textContent = nights || 'Preencha datas válidas para calcular as noites.'; }
      }
      for (const event of ['input', 'change']) form.addEventListener(event, () => { dirty = JSON.stringify(values()) !== initial; compute(); }); compute();
      const save = button('Salvar reserva', 'button button-primary'); save.type = 'submit'; const actions = el('div', 'form-actions'); actions.append(link('Voltar', booking ? detailPath(id) : '#/reservas', 'button button-secondary'), save);
      fieldset.append(grid); form.append(fieldset, estimate, actions); host.replaceChildren(form);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); if (saving) return; summary.textContent = ''; Object.values(fields).forEach((item) => { item.error.textContent = ''; item.control.removeAttribute('aria-invalid'); });
        saving = true; fieldset.disabled = true; save.disabled = true;
        try {
          const input = values(); validateBookingInput(input);
          if (booking && records.length || input.situacao === 'cancelada') {
            const accepted = await confirmAction({ title: 'Salvar reserva?', description: 'Os lançamentos já existentes serão preservados com seus valores, datas e estados atuais. Alterações na reserva não registram recebimentos nem recalculam o financeiro. Reservas canceladas não ocupam o calendário.', confirmLabel: 'Salvar reserva', cancelLabel: 'Continuar editando' }); if (!accepted || !alive) return;
          }
          const saved = await service.save(input, booking ? { id, expectedRevision: booking.revisao ?? 0 } : {});
          if (alive) { dirty = false; saving = false; selectedMonth = saved.entrada.slice(0, 7); showToast('Reserva salva.'); window.location.hash = detailPath(saved.id).slice(1); }
        } catch (error) {
          if (!alive) return; summary.textContent = error.message;
          if (error.fields) for (const [key, message] of Object.entries(error.fields)) { fields[key].error.textContent = message; fields[key].control.setAttribute('aria-invalid', 'true'); }
          fieldset.disabled = false; (form.querySelector('[aria-invalid="true"]') || summary).focus();
        } finally { saving = false; if (alive) { fieldset.disabled = false; save.disabled = false; } }
      });
    } catch (error) { if (alive) failure(host, error, load); }
  }
  load(); return { element: screen, dispose() { alive = false; window.removeEventListener('beforeunload', beforeUnload); }, canLeave: () => saving ? false : !dirty || confirmAction({ title: 'Descartar alterações?', description: 'Há alterações na reserva ainda não salvas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar editando' }) };
}

export function renderBookingDetail({ id }) {
  let alive = true; let busy = false; let loading = false;
  const screen = createScreen({ title: 'Reserva de temporada', description: 'Valores negociados e lançamentos financeiros separados.' }); const host = el('div', 'booking-panel', 'Carregando…'); screen.append(link('Voltar às reservas', '#/reservas', 'text-link'), host);
  async function load() {
    if (loading || !alive) return; loading = true;
    try {
      const booking = await service.get(id); if (!alive) return; if (!booking) { host.replaceChildren(missing()); return; }
      const [property, records] = await Promise.all([database.get('properties', booking.propriedadeId), service.transactions(id)]); if (!alive) return;
      screen.querySelector('h1').textContent = `Reserva · ${booking.hospede}`;
      const feedback = el('p', 'form-summary'); feedback.setAttribute('role', 'status');
      const toolbar = el('div', 'financial-toolbar'); const cancel = button('Cancelar reserva', 'button button-text-danger'); const remove = button('Excluir reserva', 'button button-text-danger'); const refresh = button('Atualizar ficha');
      toolbar.append(link('Editar reserva', `${detailPath(id)}/editar`, 'button button-secondary')); if (booking.situacao !== 'cancelada') toolbar.append(cancel); toolbar.append(remove, refresh);
      refresh.addEventListener('click', () => { if (!busy) load(); });
      async function mutate(kind) {
        if (busy) return; busy = true; cancel.disabled = remove.disabled = refresh.disabled = true; feedback.textContent = '';
        try {
          if (kind === 'cancel') {
            const info = await service.cancellationPreview(id); if (!alive) return;
            if (info.paid) { feedback.textContent = 'Cancelamento bloqueado: há lançamentos liquidados. Consulte-os abaixo no Financeiro. Nenhum registro foi alterado; estorno/regularização de liquidados não está disponível nesta etapa.'; return; }
            const accepted = await confirmAction({ title: 'Cancelar reserva?', description: info.pending ? `Cancelar a reserva e todos os ${info.pending} lançamentos pendentes vinculados? O calendário será liberado e o histórico preservado. Se não concordar, mantenha a reserva.` : 'Cancelar esta reserva e liberar suas noites no calendário? O histórico será preservado. Reativação não está disponível nesta etapa.', confirmLabel: info.pending ? 'Cancelar reserva e pendências' : 'Cancelar reserva', cancelLabel: 'Manter reserva' });
            if (!accepted || !alive) return;
            await service.cancel(id, info.booking.revisao ?? 0, { cancelPending: info.pending > 0, financialStamp: info.financialStamp });
          } else {
            const accepted = await confirmAction({ title: 'Excluir reserva?', description: 'Exclusão definitiva, permitida somente sem lançamentos vinculados. Nenhum lançamento será removido em cascata.', confirmLabel: 'Excluir reserva', cancelLabel: 'Manter reserva' }); if (!accepted || !alive) return;
            await service.remove(id, booking.revisao ?? 0);
          }
          if (!alive) return; showToast(kind === 'cancel' ? 'Reserva cancelada; histórico preservado.' : 'Reserva excluída.');
          if (kind === 'cancel') await load(); else { busy = false; window.location.hash = '/reservas'; }
        } catch (error) { if (alive) feedback.textContent = error.message; }
        finally { busy = false; if (alive) cancel.disabled = remove.disabled = refresh.disabled = false; }
      }
      cancel.addEventListener('click', () => mutate('cancel')); remove.addEventListener('click', () => mutate('remove'));
      const facts = el('dl', 'property-facts lease-facts');
      for (const [label, value] of [['Imóvel', property?.nome || 'Imóvel não encontrado'], ['Hóspede', booking.hospede], ['Plataforma (cadastro manual)', PLATFORMS[booking.plataforma]], ['Situação', BOOKING_STATUSES[booking.situacao]], ['Check-in', formatCivilDate(booking.entrada)], ['Check-out', formatCivilDate(booking.saida)], ['Noites', String(calculateNights(booking.entrada, booking.saida))], ['Valor bruto', formatBRL(booking.valorBrutoCentavos)], ['Taxa da plataforma', formatBRL(booking.taxaPlataformaCentavos)], ['Outras despesas', formatBRL(booking.outrasDespesasCentavos)], ['Resultado estimado (não recebido)', formatBRL(bookingEstimate(booking))], ['Observações', booking.observacoes || 'Não informadas']]) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); facts.append(row); }
      const generation = el('section', 'lease-generation panel'); generation.append(el('h2', '', 'Gerar lançamentos'), el('p', 'financial-note', 'Uma receita bruta e até duas despesas, sempre pendentes. Zero não gera despesa. Existentes, inclusive cancelados, são preservados. Datas abaixo são propostas para os novos lançamentos.'));
      if (booking.situacao === 'cancelada') generation.append(el('p', '', 'Reserva cancelada: geração indisponível.'));
      else {
        const form = el('form', 'lease-range'); form.noValidate = true; const dates = {};
        for (const [key, label] of Object.entries(CHARGE_LABELS)) { dates[key] = field(`due-${key}`, `Vencimento · ${label}`, { type: 'date', value: booking.entrada, required: true }); form.append(dates[key].wrapper); }
        const review = button('Ver prévia'); review.type = 'submit'; form.append(review);
        const message = el('p', 'booking-feedback'); message.setAttribute('role', 'status'); const rows = el('div'); const generate = button('Gerar lançamentos', 'button button-primary'); generate.disabled = true; let preview;
        const invalidate = () => { preview = undefined; rows.replaceChildren(); generate.disabled = true; message.textContent = 'Confira a prévia para habilitar a geração.'; };
        for (const item of Object.values(dates)) item.control.addEventListener('input', invalidate);
        const toggle = (state) => { busy = state; review.disabled = cancel.disabled = remove.disabled = refresh.disabled = state; Object.values(dates).forEach((item) => { item.control.disabled = state; }); generate.disabled = state || !preview; };
        form.addEventListener('submit', async (event) => {
          event.preventDefault(); if (busy) return; invalidate(); toggle(true);
          try {
            preview = await service.preview(id, Object.fromEntries(Object.entries(dates).map(([key, item]) => [key, item.control.value]))); if (!alive) return;
            rows.append(el('p', 'booking-preview-summary', `${preview.createCount} novo(s) · ${preview.existingCount} já cadastrado(s). Nenhum valor será recebido automaticamente.`)); const list = el('ul', 'lease-preview');
            for (const row of preview.rows) list.append(el('li', '', `${CHARGE_LABELS[row.subtipoOrigem]}: ${formatBRL(row.valorCentavos)} · ${formatCivilDate(row.vencimento)} · ${row.state === 'new' ? 'Novo · pendente' : row.state === 'zero' ? 'Zero · não gerar' : `Existente · ${paymentLabels[financialStatus(row.record)]} · negociado atual: ${formatBRL(row.planned)} · não será alterado`}`)); rows.append(list); message.textContent = 'Confira valores e vencimentos.';
          } catch (error) { preview = undefined; if (alive) message.textContent = error.message; }
          finally { if (alive) toggle(false); else busy = false; }
        });
        generate.addEventListener('click', async () => {
          if (busy || !preview) return; toggle(true);
          try {
            const accepted = await confirmAction({ title: 'Gerar lançamentos pendentes?', description: `${preview.createCount} novo(s), ${preview.existingCount} existente(s) preservado(s). Nenhum recebimento/pagamento será lançado.`, confirmLabel: 'Gerar lançamentos', cancelLabel: 'Revisar prévia' }); if (!accepted || !alive) return;
            const result = await service.generate(id, preview.dates, preview.booking.revisao ?? 0);
            if (!alive) return; showToast(`${result.createCount} criado(s); ${result.existingCount} já cadastrado(s). Todos os novos estão pendentes.`); await load();
          } catch (error) { preview = undefined; rows.replaceChildren(); if (alive) message.textContent = error.message; }
          finally { if (alive) toggle(false); else busy = false; }
        });
        generation.append(form, message, rows, generate);
      }
      const linked = el('section', 'booking-panel'); linked.append(el('h2', '', 'Financeiro vinculado · caixa realizado'));
      const totals = calculateFinancialSummary(records); const summary = el('div', 'lease-summary');
      for (const [key, label] of [['receitaRealizada', 'Receitas recebidas'], ['despesaRealizada', 'Despesas pagas'], ['resultadoRealizado', 'Resultado realizado']]) { const card = el('div', 'metric-card'); card.dataset.bookingMetric = key; card.append(el('h3', '', label), el('p', 'metric-value', formatBRL(totals[key]))); summary.append(card); } linked.append(summary);
      if (!records.length) linked.append(el('p', 'financial-note', 'Nenhum lançamento gerado. O resultado estimado da reserva não entra no caixa.'));
      for (const record of records) {
        const card = el('article', 'lease-card'); card.dataset.bookingTransaction = record.id;
        card.append(el('h3', '', record.descricao), el('p', '', `${formatBRL(record.valorCentavos)} · ${paymentLabels[financialStatus(record)]}`), el('p', '', `Vencimento: ${formatCivilDate(record.vencimento)}${record.liquidadoEm ? ` · Liquidação: ${formatCivilDate(record.liquidadoEm)}` : ''}`), link(record.situacaoPersistida === 'pendente' ? 'Editar / liquidar no Financeiro' : 'Consultar no Financeiro', `#/financeiro/${encodeURIComponent(record.id)}/editar`, 'text-link')); linked.append(card);
      }
      host.replaceChildren(toolbar, feedback, facts, generation, linked);
    } catch (error) { if (alive) failure(host, error, load); }
    finally { loading = false; }
  }
  load(); return { element: screen, dispose() { alive = false; }, canLeave: () => !busy };
}
export function renderBookings(params) {
  if (params.mode === 'new' || params.mode === 'edit') return renderBookingForm(params);
  if (params.mode === 'detail') return renderBookingDetail(params);
  const screen = createScreen({ title: 'Reservas de temporada', description: 'Hospedagens manuais, noites e calendário por imóvel.' }); const panel = createBookingPanel(); screen.append(panel.element); return { element: screen, dispose: panel.dispose };
}
