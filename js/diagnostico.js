import { createDatabase, toDatabaseError } from './db.js';
import { el, panel, link, confirmAction } from './ui.js';

export const DIAGNOSTIC_DB_NAME = 'imobigest-test-diagnostic';
const RECORD_ID = 'persistencia';

export function createDiagnosticPanel({ storageReady }) {
  const db = createDatabase({ name: DIAGNOSTIC_DB_NAME });
  const element = panel('Diagnóstico de armazenamento', 'Verifique a persistência com um registro isolado dos seus dados.');
  const body = el('div', 'diagnostic-body');
  const storageStatus = el('p', 'diagnostic-status', 'Verificando a estrutura do armazenamento principal…');
  storageStatus.setAttribute('role', 'status');
  storageStatus.id = 'storage-status';
  const help = el('p', 'diagnostic-help', 'O teste usa um banco separado. Salve o registro, feche o navegador e reabra este mesmo endereço e perfil. Depois clique em “Ler registro salvo”. Editar e excluir afetam apenas esse registro de teste.');
  const actions = el('div', 'diagnostic-actions');
  const result = el('p', 'diagnostic-status', 'Nenhuma operação solicitada.');
  result.id = 'diagnostic-status';
  result.setAttribute('role', 'status');
  const recordView = el('pre', 'diagnostic-record', 'Nenhum registro lido nesta tela.');
  recordView.setAttribute('aria-label', 'Conteúdo do registro de teste');
  const details = el('details', 'diagnostic-details');
  details.append(el('summary', '', 'Detalhes técnicos e erros desta sessão'));
  const detailText = el('pre', 'diagnostic-record', `Banco de teste: ${DIAGNOSTIC_DB_NAME}\nStore: appMeta\nChave: ${RECORD_ID}\nErros: nenhum nesta sessão.`);
  details.append(detailText);
  const buttons = [];
  let disposed = false;
  let busy = false;

  function updateLog() {
    detailText.textContent = `Banco de teste: ${DIAGNOSTIC_DB_NAME}\nStore: appMeta\nChave: ${RECORD_ID}\nErros: ${JSON.stringify(db.recentErrors(), null, 2)}`;
  }
  function showRecord(record) { recordView.textContent = record ? JSON.stringify(record, null, 2) : 'Nenhum registro de teste salvo.'; }

  function addAction(label, id, action) {
    const button = el('button', 'button button-secondary', label);
    button.type = 'button';
    button.id = id;
    button.addEventListener('click', async () => {
      if (busy || disposed) return;
      busy = true;
      buttons.forEach((item) => { item.disabled = true; });
      result.textContent = 'Aguarde…';
      result.classList.remove('diagnostic-error');
      try {
        const message = await action();
        if (!disposed) result.textContent = message;
      } catch (error) {
        if (!disposed) {
          result.textContent = toDatabaseError(error).message;
          result.classList.add('diagnostic-error');
        }
      } finally {
        busy = false;
        if (!disposed) { buttons.forEach((item) => { item.disabled = false; }); updateLog(); }
        else db.close();
      }
    });
    buttons.push(button);
    actions.append(button);
  }

  addAction('Salvar registro de teste', 'diagnostic-save', async () => {
    const existing = await db.get('appMeta', RECORD_ID);
    if (existing) { showRecord(existing); return 'Já existe um registro salvo. Ele foi preservado; use Editar ou Excluir para alterá-lo.'; }
    const record = { id: RECORD_ID, texto: 'Registro de teste original.', criadoEm: new Date().toISOString() };
    await db.add('appMeta', record);
    showRecord(await db.get('appMeta', RECORD_ID));
    return 'Registro salvo e lido após a conclusão da transação. Reabra o navegador para conferir a persistência.';
  });
  addAction('Ler registro salvo', 'diagnostic-read', async () => {
    const record = await db.get('appMeta', RECORD_ID);
    showRecord(record);
    return record ? 'Registro encontrado no armazenamento local.' : 'Nenhum registro de teste salvo. Use Salvar registro de teste.';
  });
  addAction('Editar registro de teste', 'diagnostic-edit', async () => {
    await db.update('appMeta', RECORD_ID, { texto: 'Registro de teste editado.', atualizadoEm: new Date().toISOString() });
    showRecord(await db.get('appMeta', RECORD_ID));
    return 'Registro editado e relido; o ID e a data de criação foram preservados.';
  });
  addAction('Excluir registro de teste', 'diagnostic-delete', async () => {
    const accepted = await confirmAction({ title: 'Excluir o registro de teste?', description: 'Somente o registro do diagnóstico será removido. Os dados da base principal não serão alterados.', confirmLabel: 'Excluir registro de teste' });
    if (!accepted || disposed) return 'Exclusão cancelada.';
    const removed = await db.remove('appMeta', RECORD_ID);
    showRecord(await db.get('appMeta', RECORD_ID));
    return removed ? 'Registro de teste excluído. A leitura confirmou sua ausência.' : 'O registro de teste já estava ausente.';
  });

  body.append(storageStatus, help, actions, result, recordView,
    link('Abrir verificações de persistência, BRL e datas', './tests/index.html', 'text-link'),
    link('Executar regressão completa do sistema', './tests/todas.html', 'text-link'), details);
  element.append(body);
  storageReady.then(({ schema, error }) => {
    if (disposed) return;
    if (error) {
      storageStatus.textContent = `Armazenamento principal: ${error.message}`;
      storageStatus.classList.add('diagnostic-error');
    } else {
      storageStatus.textContent = `Armazenamento principal disponível · versão ${schema.version} · ${schema.stores.length} coleções. Nenhum cadastro de negócio foi criado por este diagnóstico.`;
    }
  });
  return { element, dispose() { disposed = true; db.close(); } };
}
