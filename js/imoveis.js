import { database, DatabaseError } from './db.js';
import { ValidationError, validateId, createId, parseBRL, formatBRL } from './utils.js';
import { el, icon, link, panel, createScreen, emptyState, confirmAction, showToast } from './ui.js';
import { createFinancialPanel } from './financeiro.js';
import { createLeasePanel } from './alugueis.js';
import { createBookingPanel } from './reservas.js';
import { createGalleryPanel } from './galeria.js';
import { createPhotoService } from './galeria-service.js';

export const PROPERTY_TYPES = Object.freeze({ casa: 'Casa', apartamento: 'Apartamento', sala_comercial: 'Sala comercial', ponto_comercial: 'Ponto comercial', outro: 'Outro' });
export const PROPERTY_PURPOSES = Object.freeze({ residencial: 'Residencial', comercial: 'Comercial', temporada: 'Temporada' });
export const PROPERTY_STATUSES = Object.freeze({ disponivel: 'Disponível', ocupado: 'Ocupado', manutencao: 'Em manutenção' });
const STATES = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

export class PropertyValidationError extends ValidationError {
  constructor(fields) { super('Revise os campos indicados antes de salvar.'); this.fields = fields; }
}

export function validatePropertyInput(input) {
  const fields = {};
  const data = {};
  for (const [name, label, limit, required] of [
    ['nome', 'Nome', 120, true], ['endereco', 'Endereço', 240, true], ['cidade', 'Cidade', 120, true],
    ['bairro', 'Bairro', 120, false], ['descricao', 'Descrição', 3000, false], ['observacoes', 'Observações', 3000, false],
  ]) {
    const value = typeof input?.[name] === 'string' ? input[name].trim() : '';
    if (required && !value) fields[name] = `${label} é obrigatório.`;
    else if (value.length > limit) fields[name] = `${label}: use até ${limit} caracteres.`;
    data[name] = value;
  }
  for (const [name, label, options] of [['tipo', 'Tipo', PROPERTY_TYPES], ['finalidade', 'Finalidade', PROPERTY_PURPOSES], ['situacaoManual', 'Situação cadastral', PROPERTY_STATUSES]]) {
    if (!Object.hasOwn(options, input?.[name] ?? '')) fields[name] = `Selecione uma opção válida para ${label.toLowerCase()}.`;
    data[name] = input?.[name];
  }
  data.uf = typeof input?.uf === 'string' ? input.uf.trim().toUpperCase() : '';
  if (!STATES.includes(data.uf)) fields.uf = 'Selecione uma UF válida.';
  const cep = typeof input?.cep === 'string' ? input.cep.trim() : '';
  if (cep && !/^\d{5}-?\d{3}$/.test(cep)) fields.cep = 'Informe 8 dígitos de CEP, por exemplo 60000-000.';
  const digits = cep.replace('-', '');
  data.cep = digits ? `${digits.slice(0, 5)}-${digits.slice(5)}` : '';
  for (const [inputName, storedName] of [['valorEstimado', 'valorEstimadoCentavos'], ['aluguelPrevisto', 'aluguelPrevistoCentavos']]) {
    const value = typeof input?.[inputName] === 'string' ? input[inputName].trim() : input?.[inputName];
    if (value === undefined || value === null || value === '') data[storedName] = null;
    else {
      try { data[storedName] = parseBRL(typeof value === 'string' ? value.trim() : value); }
      catch (error) { fields[inputName] = error.message; }
    }
  }
  if (Object.keys(fields).length) throw new PropertyValidationError(fields);
  return data;
}

export function createPropertyService(db = database) {
  return {
    list: () => db.list('properties'),
    get(id) { validateId(id); return db.get('properties', id); },
    async save(input, { id, expectedRevision } = {}) {
      const data = validatePropertyInput(input);
      const now = new Date().toISOString();
      if (id === undefined) {
        const record = { ...data, id: createId(), criadoEm: now, atualizadoEm: now, revisao: 1 };
        await db.add('properties', record);
        return record;
      }
      validateId(id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ValidationError('Recarregue o imóvel antes de editar.');
      return db.runTransaction(['properties'], 'readwrite', (tx) => {
        tx.request(tx.store('properties').get(id), (existing) => {
          if (!existing) throw new DatabaseError('NOT_FOUND', 'Este imóvel não existe mais. Volte à lista para conferir os registros.');
          const revision = existing.revisao ?? 0;
          if (revision !== expectedRevision) throw new DatabaseError('CONFLICT', 'Este imóvel foi alterado em outra aba. Seus campos foram mantidos nesta tela; anote as alterações e reabra o imóvel antes de salvar.');
          if (!Number.isSafeInteger(revision + 1)) throw new ValidationError('A revisão do cadastro excedeu o limite seguro.');
          const updated = { ...existing, ...data, id, atualizadoEm: now, revisao: revision + 1 };
          tx.request(tx.store('properties').put(updated), () => tx.result(updated));
        });
      });
    },
    async remove(id) {
      validateId(id);
      const related = ['leases', 'bookings', 'transactions', 'photos'];
      return db.runTransaction(['properties', ...related], 'readwrite', (tx) => {
        tx.request(tx.store('properties').get(id), (record) => {
          if (!record) { tx.result(false); return; }
          let remaining = related.length;
          let linked = false;
          for (const store of related) {
            tx.request(tx.store(store).index('propriedadeId').count(id), (count) => {
              linked ||= count > 0;
              remaining--;
              if (remaining) return;
              if (linked) throw new DatabaseError('LINKED', 'Este imóvel possui contratos, reservas, lançamentos ou fotos vinculados e não pode ser excluído. Nenhum registro foi removido.');
              tx.request(tx.store('properties').delete(id), () => tx.result(true));
            });
          }
        });
      });
    },
  };
}

const normalize = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
export function filterProperties(properties, { nome = '', query = '', tipo = '', situacao = '' } = {}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return properties.filter((property) => {
    const text = normalize([property.nome, property.endereco, property.bairro, property.cidade, property.uf, property.cep, property.descricao, property.observacoes, PROPERTY_TYPES[property.tipo], PROPERTY_PURPOSES[property.finalidade]].join(' '));
    return normalize(property.nome).includes(normalize(nome).trim()) && (!tipo || property.tipo === tipo)
      && (!situacao || property.situacaoManual === situacao) && terms.every((term) => text.includes(term));
  }).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}

export function matchPropertyRoute(path) {
  if (path === '/imoveis') return { mode: 'list' };
  if (path === '/imoveis/novo') return { mode: 'new' };
  const match = /^\/imoveis\/([^/]+)(\/editar)?$/.exec(path);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { id = ''; }
  return { mode: match[2] ? 'edit' : 'detail', id };
}

const detailPath = (id) => `#/imoveis/${encodeURIComponent(id)}`;
const propertyService = createPropertyService();
let listFilters = { nome: '', query: '', tipo: '', situacao: '' };

function life() {
  const callbacks = [];
  return {
    alive: true,
    onDispose(callback) { callbacks.push(callback); },
    dispose() { this.alive = false; callbacks.splice(0).forEach((callback) => callback()); },
  };
}

function statusBadge(property) {
  return el('span', `property-status status-${Object.hasOwn(PROPERTY_STATUSES, property.situacaoManual) ? property.situacaoManual : 'unknown'}`, PROPERTY_STATUSES[property.situacaoManual] || 'Não informado');
}

function cover(host, property, scope) {
  host.classList.add('property-cover');
  host.append(icon('building'), el('span', '', 'Sem foto de capa'));
  if (!property.coverPhotoId) return;
  let url; let image;
  scope.onDispose(() => {
    // Cancelar a imagem lazy antes de revogar: ela pode ainda estar no DOM
    // durante o descarte da rota e iniciar uma leitura da URL já liberada.
    image?.removeAttribute('src'); image?.remove();
    if (url) { URL.revokeObjectURL(url); url = undefined; }
  });
  createPhotoService().thumbnail(property.coverPhotoId, property.id).then((blob) => {
    if (!scope.alive || !(blob instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) return;
    image = el('img');
    image.alt = `Foto de capa de ${property.nome}`;
    image.loading = 'lazy';
    url = URL.createObjectURL(blob);
    image.src = url;
    image.addEventListener('error', () => {
      image.remove();
      if (url) { URL.revokeObjectURL(url); url = undefined; }
    }, { once: true });
    host.append(image);
  }).catch(() => { /* A capa é opcional; preservar o fallback e o cadastro. */ });
}

function button(text, className = 'button button-secondary') {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function problem(host, message, retry) {
  const state = emptyState({ title: 'Não foi possível carregar', description: message, iconName: 'info' });
  if (retry) { const action = button('Tentar novamente'); action.addEventListener('click', retry); state.append(action); }
  host.replaceChildren(state);
}

async function requestDelete(property, scope, onRemoved, action) {
  if (action.dataset.busy) return;
  action.dataset.busy = 'true';
  try {
    const accepted = await confirmAction({ title: 'Excluir imóvel?', description: `Deseja excluir “${property.nome}”? A exclusão só será realizada se não houver registros vinculados. Esta ação não pode ser desfeita.`, confirmLabel: 'Excluir imóvel' });
    if (!accepted || !scope.alive) return;
    action.disabled = true;
    const removed = await propertyService.remove(property.id);
    if (!scope.alive) return;
    showToast(removed ? 'Imóvel excluído.' : 'Este imóvel já não existe. A lista foi atualizada.');
    onRemoved();
  } catch (error) {
    if (scope.alive) {
      showToast(error.message, { tone: 'error', duration: 10000 });
      const feedback = document.querySelector('#property-feedback');
      if (feedback) feedback.textContent = error.message;
    }
  } finally {
    if (scope.alive) { action.disabled = false; delete action.dataset.busy; }
  }
}

function makeField(name, label, { options, value = '', type = 'text', required = false, maxLength, hint, multiline = false } = {}) {
  const wrapper = el('div', 'field');
  const caption = el('label', '', `${label}${required ? ' *' : ''}`);
  const control = el(options ? 'select' : multiline ? 'textarea' : 'input');
  control.name = name;
  control.id = `property-${name}`;
  caption.htmlFor = control.id;
  if (options) {
    for (const [key, text] of Object.entries(options)) {
      const option = el('option', '', text); option.value = key; control.append(option);
    }
  } else if (!multiline) control.type = type;
  if (maxLength) control.maxLength = maxLength;
  control.required = required;
  control.value = value;
  if (name === 'cep') { control.inputMode = 'numeric'; control.autocomplete = 'postal-code'; }
  if (['valorEstimado', 'aluguelPrevisto'].includes(name)) control.inputMode = 'decimal';
  if (multiline) control.rows = 4;
  const error = el('span', 'field-error'); error.id = `${control.id}-error`;
  const describedBy = [error.id];
  wrapper.append(caption, control);
  if (hint) { const help = el('small', 'field-hint', hint); help.id = `${control.id}-hint`; describedBy.push(help.id); wrapper.append(help); }
  control.setAttribute('aria-describedby', describedBy.join(' '));
  wrapper.append(error);
  return { wrapper, control, error };
}

export function renderPropertyList() {
  const scope = life();
  let covers = life();
  scope.onDispose(() => covers.dispose());
  const screen = createScreen({ title: 'Meus imóveis', description: 'Seu patrimônio organizado, um imóvel de cada vez.' });
  const newLink = link('Novo imóvel', '#/imoveis/novo', 'button button-primary'); newLink.prepend(icon('plus'));
  screen.querySelector('.page-heading').append(newLink);
  const filters = el('section', 'property-filters'); filters.setAttribute('aria-label', 'Filtros de imóveis');
  const controls = {};
  for (const [key, label, options] of [
    ['query', 'Busca textual'], ['nome', 'Nome do imóvel'],
    ['tipo', 'Tipo', { '': 'Todos os tipos', ...PROPERTY_TYPES }],
    ['situacao', 'Situação cadastral', { '': 'Todas as situações', ...PROPERTY_STATUSES }],
  ]) {
    const field = makeField(`filter-${key}`, label, { options, value: listFilters[key], type: 'search' });
    controls[key] = field.control;
    field.control.addEventListener('input', () => { listFilters[key] = field.control.value; draw(); });
    filters.append(field.wrapper);
  }
  const clear = button('Limpar filtros');
  function clearFilters() { listFilters = { nome: '', query: '', tipo: '', situacao: '' }; Object.values(controls).forEach((control) => { control.value = ''; }); draw(); }
  clear.addEventListener('click', clearFilters); filters.append(clear);
  const count = el('p', 'property-count', 'Carregando imóveis…'); count.setAttribute('role', 'status');
  const feedback = el('p', 'property-feedback'); feedback.id = 'property-feedback'; feedback.setAttribute('role', 'status');
  const results = el('div', 'property-results');
  let properties = [];
  let loaded = false;
  function draw() {
    if (!scope.alive || !loaded) return;
    covers.dispose(); covers = life();
    results.replaceChildren();
    const selected = filterProperties(properties, listFilters);
    count.textContent = `${selected.length} ${selected.length === 1 ? 'imóvel encontrado' : 'imóveis encontrados'} · ${properties.length} no cadastro`;
    if (!selected.length) {
      const action = properties.length ? button('Limpar filtros') : link('Cadastrar primeiro imóvel', '#/imoveis/novo', 'button button-primary');
      if (properties.length) action.addEventListener('click', clearFilters);
      results.append(emptyState({ title: properties.length ? 'Nenhum imóvel corresponde aos filtros' : 'Seu primeiro imóvel começa aqui', description: properties.length ? 'Tente outro nome, tipo ou situação cadastral.' : 'Cadastre as informações do imóvel para começar a organizar seu patrimônio.', action }));
      return;
    }
    const grid = el('div', 'property-grid');
    for (const property of selected) {
      const card = el('article', 'property-card'); card.dataset.propertyId = property.id;
      const image = el('div'); cover(image, property, covers);
      const copy = el('div', 'property-card-copy');
      const top = el('div', 'property-card-top'); top.append(el('span', 'property-type', PROPERTY_TYPES[property.tipo] || property.tipo), statusBadge(property));
      const title = el('h2'); title.append(link(property.nome, detailPath(property.id), 'property-name'));
      const location = [property.endereco, property.bairro, [property.cidade, property.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ');
      copy.append(top, title, el('p', 'property-address', location), el('p', 'property-purpose', PROPERTY_PURPOSES[property.finalidade] || property.finalidade));
      const actions = el('div', 'property-card-actions');
      const remove = button('Excluir', 'button button-text-danger'); remove.setAttribute('aria-label', `Excluir ${property.nome}`);
      remove.addEventListener('click', () => requestDelete(property, scope, load, remove));
      actions.append(link('Ver detalhes', detailPath(property.id), 'text-link'), link('Editar', `${detailPath(property.id)}/editar`, 'text-link'), remove);
      copy.append(actions); card.append(image, copy); grid.append(card);
    }
    results.append(grid);
  }
  async function load() {
    count.textContent = 'Carregando imóveis…';
    try { properties = await propertyService.list(); loaded = true; draw(); }
    catch (error) { if (scope.alive) { count.textContent = 'Armazenamento indisponível.'; problem(results, error.message, load); } }
  }
  screen.append(filters, count, feedback, results);
  load();
  return { element: screen, dispose: () => scope.dispose() };
}

export function renderPropertyForm({ id } = {}) {
  const scope = life();
  const editing = id !== undefined;
  let property;
  let dirty = false;
  let saving = false;
  let initial = '';
  const screen = createScreen({ title: editing ? 'Editar imóvel' : 'Novo imóvel', description: 'Informações claras para um cadastro bem organizado.' });
  const host = el('div'); screen.append(host);
  const beforeUnload = (event) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  scope.onDispose(() => window.removeEventListener('beforeunload', beforeUnload));
  function build() {
    const form = el('form', 'property-form panel'); form.noValidate = true;
    const fields = {};
    const summary = el('p', 'form-summary'); summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
    form.append(el('p', 'form-intro', 'Campos com * são obrigatórios. A situação cadastral é manual e não representa ocupação calculada por contratos ou reservas.'), summary);
    const fieldset = el('fieldset');
    for (const [legend, definitions] of [
      ['Identificação', [
        ['nome', 'Nome do imóvel', { required: true, maxLength: 120 }],
        ['tipo', 'Tipo', { required: true, options: { '': 'Selecione o tipo', ...PROPERTY_TYPES } }],
        ['finalidade', 'Finalidade', { required: true, options: { '': 'Selecione a finalidade', ...PROPERTY_PURPOSES } }],
        ['situacaoManual', 'Situação cadastral', { required: true, options: PROPERTY_STATUSES }],
      ]],
      ['Localização', [
        ['endereco', 'Endereço', { required: true, maxLength: 240 }], ['bairro', 'Bairro', { maxLength: 120 }],
        ['cidade', 'Cidade', { required: true, maxLength: 120 }], ['uf', 'UF', { required: true, options: { '': 'Selecione', ...Object.fromEntries(STATES.map((uf) => [uf, uf])) } }],
        ['cep', 'CEP', { maxLength: 9, hint: 'Opcional. Formato: 60000-000.' }],
      ]],
      ['Valores de referência', [
        ['valorEstimado', 'Valor estimado (R$)', { hint: 'Opcional. Exemplo: 350.000,00.' }],
        ['aluguelPrevisto', 'Aluguel de referência (R$)', { hint: 'Opcional. Este valor não gera cobrança ou recebimento.' }],
      ]],
      ['Informações adicionais', [
        ['descricao', 'Descrição', { multiline: true, maxLength: 3000 }],
        ['observacoes', 'Observações', { multiline: true, maxLength: 3000 }],
      ]],
    ]) {
      const section = el('section', 'form-section'); section.append(el('h2', '', legend));
      const grid = el('div', 'property-form-grid');
      for (const [name, label, options] of definitions) {
        let value = property?.[name] ?? (name === 'situacaoManual' ? 'disponivel' : '');
        const moneyField = { valorEstimado: 'valorEstimadoCentavos', aluguelPrevisto: 'aluguelPrevistoCentavos' }[name];
        if (moneyField) value = property?.[moneyField] == null ? '' : formatBRL(property[moneyField]).replace(/^R\$\s*/, '');
        fields[name] = makeField(name, label, { ...options, value });
        if (['nome', 'endereco', 'descricao', 'observacoes'].includes(name)) fields[name].wrapper.classList.add('field-wide');
        grid.append(fields[name].wrapper);
      }
      section.append(grid); fieldset.append(section);
    }
    function values() { return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.control.value])); }
    initial = JSON.stringify(values());
    form.addEventListener('input', () => { dirty = JSON.stringify(values()) !== initial; });
    form.addEventListener('change', () => { dirty = JSON.stringify(values()) !== initial; });
    const actions = el('div', 'form-actions');
    const save = button(editing ? 'Salvar alterações' : 'Cadastrar imóvel', 'button button-primary'); save.type = 'submit';
    actions.append(link('Cancelar', editing ? detailPath(id) : '#/imoveis', 'button button-secondary'), save);
    form.append(fieldset, actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      Object.values(fields).forEach(({ control, error }) => { control.removeAttribute('aria-invalid'); error.textContent = ''; });
      summary.textContent = '';
      saving = true; fieldset.disabled = true; save.disabled = true; save.textContent = 'Salvando…';
      try {
        const saved = await propertyService.save(values(), editing ? { id, expectedRevision: property.revisao ?? 0 } : {});
        if (!scope.alive) return;
        dirty = false; saving = false;
        showToast(editing ? 'Imóvel atualizado.' : 'Imóvel cadastrado.');
        window.location.hash = detailPath(saved.id).slice(1);
      } catch (error) {
        if (!scope.alive) return;
        summary.textContent = error.message;
        if (error.fields) {
          for (const [name, message] of Object.entries(error.fields)) {
            fields[name].error.textContent = message;
            fields[name].control.setAttribute('aria-invalid', 'true');
          }
        }
        fieldset.disabled = false;
        const firstInvalid = form.querySelector('[aria-invalid="true"]');
        (firstInvalid || summary).focus();
      } finally {
        saving = false;
        if (scope.alive) { fieldset.disabled = false; save.disabled = false; save.textContent = editing ? 'Salvar alterações' : 'Cadastrar imóvel'; }
      }
    });
    host.replaceChildren(form);
  }
  async function load() {
    host.textContent = 'Carregando imóvel…';
    try {
      property = await propertyService.get(id);
      if (!scope.alive) return;
      if (!property) { host.replaceChildren(missingProperty()); return; }
      build();
    } catch (error) { if (scope.alive) problem(host, error.message, load); }
  }
  if (editing) load(); else build();
  return {
    element: screen,
    dispose: () => scope.dispose(),
    canLeave: () => saving ? false : !dirty || confirmAction({ title: 'Descartar alterações?', description: 'Há alterações no formulário que ainda não foram salvas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar editando' }),
  };
}

function missingProperty() {
  return emptyState({ title: 'Imóvel não encontrado', description: 'O registro pode ter sido excluído em outra aba. Volte à lista para conferir seus imóveis.', action: link('Voltar aos imóveis', '#/imoveis', 'button button-primary') });
}

export function renderPropertyDetail({ id }) {
  const scope = life();
  let detailCanLeave = () => true;
  const screen = createScreen({ title: 'Detalhes do imóvel', description: 'Informações do cadastro e áreas relacionadas.' });
  const host = el('div', 'property-detail'); host.textContent = 'Carregando imóvel…';
  screen.append(link('Voltar aos imóveis', '#/imoveis', 'text-link'), host);
  async function load() {
    try {
      let property = await propertyService.get(id);
      if (!scope.alive) return;
      if (!property) { host.replaceChildren(missingProperty()); return; }
      screen.querySelector('h1').textContent = property.nome;
      document.title = `${property.nome} | ImobiGest`;
      const actions = el('div', 'property-detail-actions');
      const remove = button('Excluir imóvel', 'button button-text-danger');
      remove.addEventListener('click', () => requestDelete(property, scope, () => { window.location.hash = '/imoveis'; }, remove));
      actions.append(link('Editar imóvel', `${detailPath(id)}/editar`, 'button button-primary'), remove);
      screen.querySelector('.page-heading').append(actions);
      const hero = el('div', 'property-detail-hero panel');
      let coverScope = life(); scope.onDispose(() => coverScope.dispose());
      const image = el('div'); cover(image, property, coverScope);
      async function refreshCover() {
        const latest = await propertyService.get(id); if (!scope.alive || !latest) return;
        property = latest; coverScope.dispose(); coverScope = life(); image.replaceChildren(); cover(image, property, coverScope);
      }
      const intro = el('div', 'property-detail-intro');
      intro.append(statusBadge(property), el('h2', '', PROPERTY_TYPES[property.tipo] || property.tipo), el('p', '', [property.endereco, property.bairro, `${property.cidade}/${property.uf}`].filter(Boolean).join(' · ')), el('p', 'property-purpose', PROPERTY_PURPOSES[property.finalidade] || property.finalidade), el('small', 'field-hint', 'Situação cadastral informada manualmente. Não representa ocupação por datas.'));
      hero.append(image, intro);
      const section = el('section', 'panel property-tabs-panel');
      const tabs = el('div', 'property-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Informações do imóvel');
      const content = el('div', 'property-tab-content'); content.setAttribute('role', 'tabpanel'); content.id = 'property-tab-content'; content.tabIndex = 0;
      const definitions = [
        ['Visão Geral', null], ['Financeiro', '04'], ['Contratos/Reservas', '05–06'], ['Fotos', '07'],
      ];
      const tabButtons = [];
      let financialPanel;
      detailCanLeave = () => financialPanel?.canLeave?.() ?? true;
      scope.onDispose(() => financialPanel?.dispose());
      let switching = false;
      async function activate(index, focus = false) {
        if (switching) return;
        if (financialPanel?.canLeave) {
          switching = true; let accepted;
          try { accepted = await financialPanel.canLeave(); } finally { switching = false; }
          if (!accepted || !scope.alive) return;
        }
        financialPanel?.dispose(); financialPanel = undefined;
        tabButtons.forEach((tab, position) => { tab.setAttribute('aria-selected', String(position === index)); tab.tabIndex = position === index ? 0 : -1; });
        content.setAttribute('aria-labelledby', `property-tab-${index}`);
        content.replaceChildren();
        if (index === 0) {
          const facts = el('dl', 'property-facts');
          for (const [label, value] of [
            ['Nome', property.nome], ['Tipo', PROPERTY_TYPES[property.tipo]], ['Finalidade', PROPERTY_PURPOSES[property.finalidade]],
            ['Situação cadastral', PROPERTY_STATUSES[property.situacaoManual]], ['Endereço', property.endereco], ['Bairro', property.bairro],
            ['Cidade/UF', `${property.cidade}/${property.uf}`], ['CEP', property.cep],
            ['Valor estimado', property.valorEstimadoCentavos == null ? '' : formatBRL(property.valorEstimadoCentavos)],
            ['Aluguel de referência', property.aluguelPrevistoCentavos == null ? '' : formatBRL(property.aluguelPrevistoCentavos)],
            ['Descrição', property.descricao], ['Observações', property.observacoes],
          ]) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value || 'Não informado')); facts.append(row); }
          content.append(facts);
        } else if (index === 1) {
          financialPanel = createFinancialPanel({ propertyId: id });
          content.append(financialPanel.element);
        } else if (index === 2) {
          const leases = createLeasePanel({ propertyId: id });
          const bookings = createBookingPanel({ propertyId: id });
          financialPanel = { dispose() { leases.dispose(); bookings.dispose(); } };
          content.append(el('h2', '', 'Contratos tradicionais'), leases.element, el('h2', 'booking-section-title', 'Reservas de temporada'), bookings.element);
        } else {
          financialPanel = createGalleryPanel({ propertyId: id, onCoverChanged: refreshCover });
          content.append(financialPanel.element);
        }
        if (focus) tabButtons[index].focus();
      }
      definitions.forEach(([label], index) => {
        const tab = button(label, 'property-tab'); tab.id = `property-tab-${index}`;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', content.id);
        tab.addEventListener('click', () => activate(index));
        tab.addEventListener('keydown', (event) => {
          const target = { ArrowRight: (index + 1) % 4, ArrowLeft: (index + 3) % 4, Home: 0, End: 3 }[event.key];
          if (target === undefined) return;
          event.preventDefault(); activate(target, true);
        });
        tabs.append(tab); tabButtons.push(tab);
      });
      activate(0);
      section.append(tabs, content);
      const feedback = el('p', 'property-feedback'); feedback.id = 'property-feedback'; feedback.setAttribute('role', 'status');
      host.replaceChildren(hero, feedback, section);
    } catch (error) { if (scope.alive) problem(host, error.message, load); }
  }
  load();
  return { element: screen, dispose: () => scope.dispose(), canLeave: () => detailCanLeave() };
}

export function renderProperties(params) {
  if (params.mode === 'list') return renderPropertyList();
  if (params.mode === 'new') return renderPropertyForm();
  if (params.mode === 'edit') return renderPropertyForm({ id: params.id });
  return renderPropertyDetail({ id: params.id });
}
