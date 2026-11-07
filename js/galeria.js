import { database } from './db.js';
import { createPhotoService, PHOTO_CATEGORIES } from './galeria-service.js';
import { preparePhoto, validatePhotoFiles, PHOTO_HELP, createObjectURLPool } from './galeria-imagens.js';
import { el, icon, link, createScreen, emptyState, confirmAction, showToast } from './ui.js';

const service = createPhotoService();
const button = (text, style = 'button button-secondary') => { const node = el('button', style, text); node.type = 'button'; return node; };
const sizeLabel = (bytes) => `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KiB`;
function field(name, label, { options, value = '', maxLength } = {}) {
  const wrapper = el('div', 'field'); const control = el(options ? 'select' : 'input'); control.name = name; control.id = name;
  const caption = el('label', '', label); caption.htmlFor = name;
  if (options) for (const [id, text] of Object.entries(options)) { const option = el('option', '', text); option.value = id; control.append(option); }
  else { control.type = 'text'; if (maxLength) control.maxLength = maxLength; }
  control.value = value; wrapper.append(caption, control); return { wrapper, control };
}
function thumbnail(host, blob, alt, pool) {
  host.append(icon('photo')); if (!(blob instanceof Blob) || !blob.size) { host.append(el('span', '', 'Miniatura indisponível')); return; }
  const image = el('img'); image.alt = alt; image.loading = 'lazy'; image.decoding = 'async'; const url = pool.create(blob); image.src = url;
  image.addEventListener('error', () => { image.remove(); pool.revoke(url); host.append(el('span', '', 'Não foi possível abrir a miniatura')); }, { once: true }); host.append(image);
}
function clearImages(host) {
  host.querySelectorAll('img').forEach(image => image.removeAttribute('src'));
  host.replaceChildren();
}
export function matchGalleryRoute(path) {
  const [pathname, query = ''] = path.split('?'); return pathname === '/fotos' ? { propertyId: new URLSearchParams(query).get('imovel') || '' } : null;
}

export function createGalleryPanel({ propertyId = '', onCoverChanged = () => {} } = {}) {
  let alive = true; let busy = false; let loading = false; let properties = []; let page = 0; let pending = []; let dialogDirty = false;
  const previews = createObjectURLPool(); const thumbnails = createObjectURLPool(); const modals = new Map();
  const root = el('div', 'gallery-panel'); const controls = el('fieldset', 'gallery-controls'); controls.append(el('legend', 'sr-only', 'Biblioteca de fotos'));
  const feedback = el('p', 'gallery-feedback'); feedback.setAttribute('role', 'status'); feedback.tabIndex = -1;
  const toolbar = el('div', 'gallery-toolbar'); const filter = field('photo-filter', 'Filtrar por imóvel', { options: { '': 'Todos os imóveis' } }); const refresh = button('Atualizar galeria');
  if (!propertyId) toolbar.append(filter.wrapper); else toolbar.append(el('p', 'field-hint', 'Fotos somente deste imóvel.'));
  toolbar.append(refresh);
  const upload = el('details', 'gallery-upload panel'); upload.append(el('summary', '', 'Adicionar fotos'));
  const uploadBody = el('div', 'gallery-upload-body'); const target = field('photo-target', 'Salvar fotos em *', { options: { '': 'Selecione o imóvel' } });
  const local = el('p', 'financial-note', 'Fotos permanecem somente neste navegador e dispositivo, vinculadas a este endereço local. Limpar dados do navegador pode apagá-las. Não há envio a servidor nem backup automático.');
  const help = el('p', 'field-hint', PHOTO_HELP); help.id = 'photo-limits';
  const fileField = el('div', 'field'); const label = el('label', '', 'Selecionar fotos (múltiplas)'); label.htmlFor = 'photo-files';
  const files = el('input'); files.type = 'file'; files.multiple = true; files.accept = 'image/jpeg,image/png,image/webp'; files.id = 'photo-files'; files.name = 'photo-files'; files.setAttribute('aria-describedby', 'photo-limits'); fileField.append(label, files);
  const progress = el('p', 'gallery-feedback'); progress.setAttribute('role', 'status'); const previewList = el('div', 'gallery-grid gallery-previews');
  const save = button('Salvar fotos', 'button button-primary'); const discard = button('Descartar seleção'); const uploadActions = el('div', 'gallery-actions'); uploadActions.append(save, discard);
  uploadBody.append(target.wrapper, help, fileField, progress, previewList, uploadActions); upload.append(uploadBody);
  const count = el('p', 'field-hint', 'Carregando fotos…'); count.setAttribute('role', 'status'); const gallery = el('div', 'gallery-grid'); const pager = el('nav', 'gallery-pager'); pager.setAttribute('aria-label', 'Páginas de fotos');
  controls.append(local, toolbar, upload, count, gallery, pager); root.append(controls, feedback);
  const dirty = () => pending.length > 0 || dialogDirty;
  const beforeUnload = (event) => { if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload);
  function setBusy(value) { busy = value; controls.disabled = value; }
  function sync() {
    target.control.disabled = !!propertyId || pending.length > 0 || !properties.length;
    files.disabled = pending.length > 0 || !target.control.value || !properties.length;
    save.disabled = !pending.length; discard.disabled = !pending.length;
  }
  function notifyError(error) { if (alive) { feedback.textContent = error.message; feedback.focus(); } }
  function clearPending() { pending = []; clearImages(previewList); previews.dispose(); files.value = ''; progress.textContent = ''; sync(); }
  function drawPreviews() {
    previewList.replaceChildren();
    for (const item of pending) {
      const card = el('article', 'gallery-card'); card.dataset.previewId = item.photo.id; const media = el('div', 'gallery-media');
      const image = el('img'); image.src = item.url; image.alt = `Prévia de ${item.photo.nomeArquivo}`; media.append(image);
      const copy = el('div', 'gallery-card-body'); copy.append(el('h3', '', item.photo.nomeArquivo), el('p', 'field-hint', `Preparada: ${item.photo.width} × ${item.photo.height} px · ${sizeLabel(item.photo.blob.size)}`));
      const caption = field(`caption-${item.photo.id}`, 'Legenda', { value: item.photo.legenda, maxLength: 500 }); const category = field(`category-${item.photo.id}`, 'Categoria', { options: PHOTO_CATEGORIES, value: item.photo.categoriaComodo });
      caption.control.addEventListener('input', () => { item.photo.legenda = caption.control.value; }); category.control.addEventListener('change', () => { item.photo.categoriaComodo = category.control.value; });
      const remove = button('Remover da seleção', 'button button-text-danger'); remove.addEventListener('click', () => { previews.revoke(item.url); pending = pending.filter((row) => row !== item); if (!pending.length) clearPending(); else drawPreviews(); });
      copy.append(caption.wrapper, category.wrapper, remove); card.append(media, copy); previewList.append(card);
    }
    sync();
  }
  files.addEventListener('change', async () => {
    if (busy || pending.length || !files.files.length) return;
    setBusy(true); feedback.textContent = ''; const prepared = [];
    try {
      const selection = validatePhotoFiles(files.files); const destination = target.control.value;
      if (!destination) throw new Error('Selecione o imóvel antes das fotos.');
      for (const [index, file] of selection.entries()) {
        if (!alive) return; progress.textContent = `Preparando ${index + 1} de ${selection.length}: ${file.name}`;
        let photo; try { photo = await preparePhoto(file); } catch (error) { throw new Error(`${file.name}: ${error.message}`); }
        if (!alive) return; prepared.push({ photo, url: previews.create(photo.thumbnailBlob) });
      }
      pending = prepared; drawPreviews(); progress.textContent = `${pending.length} foto(s) pronta(s). Confira as prévias e clique em Salvar fotos. Nada foi salvo ainda.`;
    } catch (error) { for (const item of prepared) previews.revoke(item.url); files.value = ''; progress.textContent = 'Nenhuma foto desta seleção foi salva. Selecione novamente.'; notifyError(error); }
    finally { setBusy(false); if (alive) sync(); else previews.dispose(); }
  });
  discard.addEventListener('click', async () => {
    if (busy || !pending.length) return; setBusy(true);
    try { if (await confirmAction({ title: 'Descartar fotos selecionadas?', description: 'As prévias ainda não foram salvas. Os arquivos do seu dispositivo permanecem intactos.', confirmLabel: 'Descartar seleção', cancelLabel: 'Manter prévias' }) && alive) clearPending(); }
    finally { setBusy(false); }
  });
  save.addEventListener('click', async () => {
    if (busy || !pending.length) return; setBusy(true); feedback.textContent = '';
    try { const amount = pending.length; await service.addBatch(target.control.value, pending.map((item) => item.photo)); if (!alive) return; clearPending(); page = 0; showToast(`${amount} foto(s) salva(s) neste navegador.`); await load(); }
    catch (error) { notifyError(error); }
    finally { setBusy(false); }
  });
  function modal(title, editing = false, previousFocus = document.activeElement) {
    const dialog = el('dialog', 'gallery-dialog'); const heading = el('h2', '', title); heading.id = 'gallery-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const close = button('Fechar'); close.autofocus = true; const header = el('div', 'gallery-dialog-header'); header.append(heading, close); dialog.append(header); document.body.append(dialog);
    const pool = createObjectURLPool(); let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearImages(dialog); dialog.remove(); pool.dispose(); modals.delete(dialog); dialogDirty = false; if (previousFocus?.isConnected) previousFocus.focus(); };
    modals.set(dialog, cleanup);
    close.addEventListener('click', () => { if (!editing) dialog.close(); }); dialog.addEventListener('close', cleanup, { once: true });
    return { dialog, pool, close, cleanup };
  }
  async function view(photo) {
    if (busy) return;
    // Desabilitar o fieldset desloca o foco: guardar o acionador antes da leitura.
    const opener = document.activeElement;
    setBusy(true); feedback.textContent = '';
    try {
      const record = await service.get(photo.id, photo.propriedadeId); if (!alive) return;
      const viewer = modal(record.legenda || 'Foto ampliada', false, opener); const image = el('img', 'gallery-full'); image.alt = record.legenda || `${PHOTO_CATEGORIES[record.categoriaComodo]} · ${record.nomeArquivo}`;
      const url = viewer.pool.create(record.blob); image.src = url;
      image.addEventListener('error', () => { viewer.pool.revoke(url); image.replaceWith(el('p', 'gallery-error', 'Não foi possível abrir esta imagem. O registro foi preservado.')); }, { once: true });
      viewer.dialog.append(image, el('p', 'field-hint', `${record.nomeArquivo} · ${record.width} × ${record.height} px · versão armazenada localmente`)); viewer.dialog.showModal();
    } catch (error) { notifyError(error); } finally { setBusy(false); }
  }
  function edit(photo) {
    if (busy) return;
    const editor = modal('Editar foto', true); editor.dialog.classList.add('gallery-editor'); const form = el('form'); form.noValidate = true;
    const caption = field('photo-edit-caption', 'Legenda', { value: photo.legenda, maxLength: 500 }); const category = field('photo-edit-category', 'Categoria', { options: PHOTO_CATEGORIES, value: photo.categoriaComodo }); const summary = el('p', 'gallery-error'); summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
    const saveEdit = button('Salvar alterações', 'button button-primary'); saveEdit.type = 'submit'; form.append(caption.wrapper, category.wrapper, summary, saveEdit); editor.dialog.append(form);
    const initial = JSON.stringify([caption.control.value, category.control.value]); const changed = () => { dialogDirty = JSON.stringify([caption.control.value, category.control.value]) !== initial; };
    form.addEventListener('input', changed); form.addEventListener('change', changed);
    const closeEditor = async (event) => { event.preventDefault(); if (busy) return; if (!dialogDirty || await confirmAction({ title: 'Descartar alterações da foto?', description: 'A legenda e a categoria ainda não foram salvas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar editando' })) editor.dialog.close(); };
    // Substitui o fechamento direto, preservando rascunho também ao pressionar Escape.
    const closeButton = editor.close; closeButton.addEventListener('click', closeEditor); editor.dialog.addEventListener('cancel', closeEditor);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy) return; setBusy(true); saveEdit.disabled = closeButton.disabled = caption.control.disabled = category.control.disabled = true; summary.textContent = '';
      try { await service.update(photo.id, photo.propriedadeId, { legenda: caption.control.value, categoriaComodo: category.control.value }, photo.revisao ?? 0); if (!alive) return; dialogDirty = false; editor.dialog.close(); showToast('Legenda e categoria salvas.'); await load(); }
      catch (error) { if (alive) { summary.textContent = error.message; summary.focus(); } }
      finally { setBusy(false); saveEdit.disabled = closeButton.disabled = caption.control.disabled = category.control.disabled = false; }
    });
    editor.dialog.showModal();
  }
  async function changePhoto(photo, kind) {
    if (busy) return; setBusy(true); feedback.textContent = '';
    try {
      const accepted = await confirmAction(kind === 'cover' ? { title: 'Definir foto de capa?', description: 'Esta foto substituirá a capa atual deste imóvel. As demais fotos serão preservadas.', confirmLabel: 'Definir capa', cancelLabel: 'Manter capa atual' } : { title: 'Excluir foto?', description: 'Esta foto será removida deste navegador. Se for a capa, a referência será removida e o imóvel mostrará a imagem alternativa.', confirmLabel: 'Excluir foto', cancelLabel: 'Manter foto' });
      if (!accepted || !alive) return;
      if (kind === 'cover') await service.setCover(photo.id, photo.propriedadeId, photo.revisao ?? 0); else await service.remove(photo.id, photo.propriedadeId, photo.revisao ?? 0);
      if (!alive) return; await onCoverChanged(); if (!alive) return; showToast(kind === 'cover' ? 'Capa do imóvel atualizada.' : 'Foto excluída; imóvel preservado.'); await load();
    } catch (error) { notifyError(error); } finally { setBusy(false); }
  }
  async function load() {
    if (loading || !alive) return; loading = true; const previousBusy = busy; setBusy(true); clearImages(gallery); thumbnails.dispose(); pager.replaceChildren(); count.textContent = 'Carregando fotos…';
    try {
      const previousFilter = filter.control.value; const previousTarget = target.control.value;
      properties = await database.list('properties'); if (!alive) return;
      if (propertyId && !properties.some((property) => property.id === propertyId)) throw new Error('Imóvel não encontrado. Volte à galeria geral ou ao cadastro.');
      const options = properties.map((property) => [property.id, property.nome]);
      for (const [control, first, previous] of [[filter.control, 'Todos os imóveis', previousFilter], [target.control, 'Selecione o imóvel', previousTarget]]) {
        control.replaceChildren(); for (const [id, text] of [['', first], ...options]) { const option = el('option', '', text); option.value = id; control.append(option); }
        if (previous && !properties.some((p) => p.id === previous)) { const missing = el('option', '', 'Imóvel removido — descarte a seleção'); missing.value = previous; control.append(missing); }
        control.value = propertyId || previous;
      }
      const selected = propertyId || filter.control.value;
      const result = await service.page({ propertyId: selected, page }); if (!alive) return; page = result.page;
      feedback.textContent = ''; count.textContent = `${result.total} foto(s) · Página ${page + 1} de ${Math.max(1, Math.ceil(result.total / result.pageSize))}. Até ${result.pageSize} miniaturas por página.`;
      if (!result.rows.length) {
        const action = properties.length ? button('Selecionar fotos', 'button button-primary') : link('Cadastrar imóvel', '#/imoveis/novo', 'button button-primary');
        if (properties.length) action.addEventListener('click', () => { upload.open = true; if (!target.control.value) target.control.focus(); else files.click(); });
        gallery.append(emptyState({ title: 'Cada imóvel tem uma história para mostrar', description: properties.length ? 'Adicione fotos para organizar ambientes, legendas e a capa do imóvel.' : 'Cadastre um imóvel para começar sua biblioteca de fotos.', iconName: 'photo', action }));
      }
      const names = new Map(properties.map((p) => [p.id, p]));
      for (const photo of result.rows) {
        const property = names.get(photo.propriedadeId); const card = el('article', 'gallery-card'); card.dataset.photoId = photo.id;
        const media = button('', 'gallery-media gallery-open'); media.setAttribute('aria-label', `Ampliar foto: ${photo.legenda || photo.nomeArquivo}`); thumbnail(media, photo.thumbnailBlob, photo.legenda || PHOTO_CATEGORIES[photo.categoriaComodo] || 'Foto', thumbnails); media.addEventListener('click', () => view(photo));
        const copy = el('div', 'gallery-card-body'); const isCover = property?.coverPhotoId === photo.id;
        if (isCover) copy.append(el('span', 'status-badge', 'Capa do imóvel'));
        copy.append(el('p', 'gallery-property', property?.nome || 'Imóvel não encontrado'), el('h3', '', photo.legenda || 'Sem legenda'), el('p', 'field-hint', PHOTO_CATEGORIES[photo.categoriaComodo] || 'Categoria desconhecida'), el('small', 'field-hint', `${photo.width || '—'} × ${photo.height || '—'} px · ${sizeLabel(photo.tamanho || 0)}`));
        const actions = el('div', 'gallery-actions'); const editButton = button('Editar legenda'); const coverButton = button(isCover ? 'Capa atual' : 'Definir capa'); coverButton.disabled = isCover; if (isCover) coverButton.title = 'Esta foto já é a capa deste imóvel.'; const remove = button('Excluir foto', 'button button-text-danger');
        editButton.addEventListener('click', () => edit(photo)); coverButton.addEventListener('click', () => changePhoto(photo, 'cover')); remove.addEventListener('click', () => changePhoto(photo, 'remove')); actions.append(editButton, coverButton, remove);
        if (!propertyId) actions.append(link('Ver imóvel', `#/imoveis/${encodeURIComponent(photo.propriedadeId)}`, 'text-link')); copy.append(actions); card.append(media, copy); gallery.append(card);
      }
      for (const [label, targetPage, disabled] of [['Página anterior', page - 1, page === 0], ['Próxima página', page + 1, (page + 1) * result.pageSize >= result.total]]) {
        const action = button(label); action.disabled = disabled; action.addEventListener('click', () => { if (!busy) { page = targetPage; load(); } }); pager.append(action);
      }
      sync();
    } catch (error) {
      if (alive) { count.textContent = 'Fotos indisponíveis'; gallery.replaceChildren(emptyState({ title: 'Não foi possível carregar as fotos', description: error.message, iconName: 'info' })); notifyError(error); }
    } finally { loading = false; setBusy(previousBusy); }
  }
  filter.control.addEventListener('change', () => { if (!busy) { page = 0; if (!pending.length && !propertyId) target.control.value = filter.control.value; load(); } });
  target.control.addEventListener('change', sync); refresh.addEventListener('click', () => { if (!busy) load(); });
  sync(); load();
  return {
    element: root,
    canLeave: () => busy ? false : !dirty() || confirmAction({ title: 'Descartar alterações da galeria?', description: 'Há prévias ou alterações de legenda ainda não salvas. As fotos já armazenadas serão preservadas.', confirmLabel: 'Descartar alterações', cancelLabel: 'Continuar na galeria' }),
    dispose() { alive = false; for (const [dialog, cleanup] of [...modals]) { dialog.close(); cleanup(); } clearImages(previewList); clearImages(gallery); previews.dispose(); thumbnails.dispose(); window.removeEventListener('beforeunload', beforeUnload); },
  };
}
export function renderGallery({ propertyId = '' } = {}) {
  const screen = createScreen({ title: 'Galeria de fotos', description: 'Ambientes, detalhes e memórias de cada imóvel, guardados neste navegador.' });
  const panel = createGalleryPanel({ propertyId }); screen.append(panel.element);
  return { element: screen, dispose: panel.dispose, canLeave: panel.canLeave };
}
