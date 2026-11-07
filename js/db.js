import { ValidationError, validateId } from './utils.js';

export const DB_NAME = 'imobigest';
export const DEMO_DB_NAME = 'imobigest-demo';
export const DB_VERSION = 1;
export const APP_VERSION = '0.11.0';

// [nome, keyPath, unique]. Nomes compostos são explícitos para consultas futuras.
const schema = {
  properties: [['tipo', 'tipo'], ['finalidade', 'finalidade'], ['situacaoManual', 'situacaoManual']],
  transactions: [
    ['propriedadeId', 'propriedadeId'], ['vencimento', 'vencimento'], ['liquidadoEm', 'liquidadoEm'],
    ['situacaoPersistida', 'situacaoPersistida'], ['origem', ['origem', 'origemId']],
    ['propriedadeVencimento', ['propriedadeId', 'vencimento']], ['chaveOrigem', 'chaveOrigem', true],
  ],
  leases: [['propriedadeId', 'propriedadeId'], ['situacao', 'situacao'], ['inicio', 'inicio']],
  bookings: [['propriedadeId', 'propriedadeId'], ['propriedadeEntrada', ['propriedadeId', 'entrada']], ['saida', 'saida'], ['situacao', 'situacao']],
  photos: [['propriedadeId', 'propriedadeId'], ['propriedadeCategoria', ['propriedadeId', 'categoriaComodo']]],
  appMeta: [],
};
export const STORE_NAMES = Object.freeze(Object.keys(schema));

export class DatabaseError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

export function toDatabaseError(error) {
  if (error instanceof DatabaseError) return error;
  if (error instanceof ValidationError) return new DatabaseError('VALIDATION', error.message, error);
  const messages = {
    QuotaExceededError: ['QUOTA', 'Não há espaço suficiente no armazenamento do navegador. Nenhuma alteração desta transação foi salva. Libere espaço e tente novamente.'],
    VersionError: ['VERSION', 'Este banco foi criado por uma versão mais recente do ImobiGest. Abra a versão compatível; não limpe os dados.'],
    SecurityError: ['UNAVAILABLE', 'O navegador bloqueou o armazenamento local. Confira as permissões do site e use HTTP local.'],
    InvalidStateError: ['UNAVAILABLE', 'A conexão de armazenamento não está disponível. Tente novamente ou recarregue a página.'],
    UnknownError: ['UNAVAILABLE', 'Não foi possível acessar o armazenamento local. Verifique o espaço e as permissões do navegador.'],
    ConstraintError: ['DUPLICATE', 'Já existe um registro com esse ID ou referência de origem. A operação foi cancelada sem sobrescrever dados.'],
    DataError: ['VALIDATION', 'A chave ou os dados informados não são válidos para esta operação.'],
    DataCloneError: ['VALIDATION', 'O registro contém um tipo de dado que não pode ser salvo.'],
    NotFoundError: ['SCHEMA', 'Uma coleção ou índice esperado não está disponível. Use uma versão compatível do aplicativo.'],
    ReadOnlyError: ['READ_ONLY', 'Esta transação permite somente leitura. Nenhuma alteração foi salva.'],
    TransactionInactiveError: ['INACTIVE', 'A transação já terminou. Prepare os dados antes de abrir uma nova transação.'],
    AbortError: ['ABORTED', 'A transação foi interrompida. Nenhuma alteração desta transação foi salva.'],
  };
  const [code, message] = messages[error?.name] || ['STORAGE', 'Não foi possível concluir a operação de armazenamento. Tente novamente.'];
  return new DatabaseError(code, message, error);
}

// Cada passo roda na transação versionchange. Futuras migrações devem ser adicionadas,
// nunca substituir a base por deleteDatabase/recriação.
const migrations = {
  1(db, transaction, name) {
    for (const [storeName, indexes] of Object.entries(schema)) {
      const store = db.createObjectStore(storeName, { keyPath: 'id' });
      for (const [indexName, keyPath, unique = false] of indexes) store.createIndex(indexName, keyPath, { unique });
    }
    transaction.objectStore('appMeta').add({
      id: 'app', schemaVersion: DB_VERSION, appVersion: APP_VERSION,
      datasetKind: name.startsWith('imobigest-test-') ? 'test' : name === DEMO_DB_NAME ? 'demo' : 'real', demoMode: name === DEMO_DB_NAME,
    });
  },
};

function inspectSchema(db) {
  if (db.version !== DB_VERSION || STORE_NAMES.some((name) => !db.objectStoreNames.contains(name))) {
    throw new DatabaseError('SCHEMA', 'A estrutura do banco não corresponde a esta versão. Os dados foram preservados.');
  }
  const transaction = db.transaction(STORE_NAMES, 'readonly');
  for (const [name, indexes] of Object.entries(schema)) {
    const store = transaction.objectStore(name);
    if (store.keyPath !== 'id' || store.autoIncrement) throw new DatabaseError('SCHEMA', 'A chave de uma coleção é incompatível com esta versão.');
    for (const [indexName, keyPath, unique = false] of indexes) {
      if (!store.indexNames.contains(indexName)) throw new DatabaseError('SCHEMA', 'Um índice esperado está ausente. Os dados foram preservados.');
      const index = store.index(indexName);
      if (JSON.stringify(index.keyPath) !== JSON.stringify(keyPath) || index.unique !== unique || index.multiEntry) {
        throw new DatabaseError('SCHEMA', 'Um índice é incompatível com esta versão. Os dados foram preservados.');
      }
    }
  }
  return { name: db.name, version: db.version, stores: [...db.objectStoreNames] };
}

function checkStore(name) {
  if (!STORE_NAMES.includes(name)) throw new ValidationError('Coleção desconhecida.');
}

function checkRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ValidationError('Informe um objeto de registro.');
  validateId(record.id);
}

function synchronous(callback, ...args) {
  const result = callback(...args);
  if (result && typeof result.then === 'function') {
    // Evita rejeição não tratada de callback indevido, além de abortar as escritas.
    Promise.resolve(result).catch(() => {});
    throw new DatabaseError('ASYNC_CALLBACK', 'O callback da transação deve ser síncrono. Encadeie requisições com request; prepare esperas externas antes da transação.');
  }
  return result;
}

export function createDatabase({ name = DB_NAME, factory, timeoutMs = 8000 } = {}) {
  if (![DB_NAME, DEMO_DB_NAME].includes(name) && !/^imobigest-test-[A-Za-z0-9-]+$/.test(name)) {
    throw new ValidationError('Nome de banco inválido. Use a base principal, demonstração ou um banco imobigest-test-*.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ValidationError('Tempo de abertura inválido.');
  let connection;
  let opening;
  let cancelOpening;
  let knownEpoch; let epochKnown = false;
  const errorLog = [];

  function recordError(error, operation) {
    const normalized = toDatabaseError(error);
    // Apenas metadados técnicos em memória: nenhum conteúdo dos registros.
    errorLog.push({ code: normalized.code, message: normalized.message, operation, at: new Date().toISOString() });
    if (errorLog.length > 20) errorLog.shift();
    return normalized;
  }

  async function guard(operation, work) {
    try { return await work(); } catch (error) { throw recordError(error, operation); }
  }

  function openConnection() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let upgradeError;
      const finishError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelOpening = undefined;
        reject(error);
      };
      const timer = setTimeout(() => finishError(new DatabaseError('TIMEOUT', 'O armazenamento demorou a responder. Feche outras abas do ImobiGest e tente novamente.')), timeoutMs);
      cancelOpening = () => finishError(new DatabaseError('CLOSED', 'A abertura do banco foi cancelada ao sair desta área.'));
      try {
        const provider = factory === undefined ? globalThis.indexedDB : factory;
        if (!provider?.open) throw new DatabaseError('UNAVAILABLE', 'IndexedDB não está disponível. Use HTTP local e confira as permissões de armazenamento do navegador.');
        request = provider.open(name, DB_VERSION);
        request.onblocked = () => finishError(new DatabaseError('BLOCKED', 'Outra aba está impedindo a abertura ou atualização do banco. Feche as outras abas do ImobiGest e tente novamente.'));
        request.onupgradeneeded = (event) => {
          if (settled) { request.transaction.abort(); return; }
          try {
            for (let version = event.oldVersion + 1; version <= DB_VERSION; version++) {
              if (!migrations[version]) throw new DatabaseError('VERSION', 'Não há migração disponível para esta versão.');
              migrations[version](request.result, request.transaction, name);
            }
          } catch (error) { upgradeError = error; request.transaction.abort(); }
        };
        request.onerror = () => finishError(upgradeError || request.error);
        request.onsuccess = () => {
          const db = request.result;
          // Pedidos IndexedDB não são canceláveis: nunca manter conexões tardias.
          if (settled) { db.close(); return; }
          try { inspectSchema(db); } catch (error) { db.close(); finishError(error); return; }
          db.onversionchange = () => {
            db.close();
            if (connection === db) connection = undefined;
            recordError(new DatabaseError('VERSION_CHANGED', 'Outra aba solicitou uma mudança de versão. A conexão foi fechada para preservar os dados; recarregue a página.'), 'versionchange');
          };
          db.onclose = () => { if (connection === db) connection = undefined; };
          connection = db;
          settled = true;
          clearTimeout(timer);
          cancelOpening = undefined;
          resolve(db);
        };
      } catch (error) { finishError(error); }
    });
    opening = promise;
    promise.then(() => { if (opening === promise) opening = undefined; }, () => { if (opening === promise) opening = undefined; });
    return promise;
  }

  // work e callbacks de request são síncronos. A Promise externa só resolve no
  // oncomplete. Leituras dependentes devem agendar novas requests em callbacks.
  function runTransaction(stores, mode, work) {
    return guard('transaction', async () => {
      if (!Array.isArray(stores) || !stores.length) throw new ValidationError('Selecione ao menos uma coleção.');
      stores.forEach(checkStore);
      if (!['readonly', 'readwrite'].includes(mode) || typeof work !== 'function') throw new ValidationError('Modo ou callback de transação inválido.');
      const db = await openConnection();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([...new Set([...stores, 'appMeta'])], mode);
        let value;
        let failure;
        const abort = (error = new DOMException('Aborted', 'AbortError')) => {
          failure ||= error;
          try { transaction.abort(); } catch { /* onabort já pendente */ }
        };
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(failure || transaction.error || new DOMException('Aborted', 'AbortError'));
        transaction.onerror = (event) => { abort(event.target.error || transaction.error); };
        const context = {
          store: (storeName) => transaction.objectStore(storeName),
          result: (result) => { value = result; },
          abort,
          request(request, onSuccess = (result) => { value = result; }) {
            request.addEventListener('success', () => {
              try { synchronous(onSuccess, request.result); } catch (error) { abort(error); }
            }, { once: true });
            return request;
          },
        };
        context.request(transaction.objectStore('appMeta').get('app'), (meta) => {
          const epoch = meta?.restoreEpoch || '';
          if (mode === 'readwrite' && epochKnown && knownEpoch !== epoch) throw new DatabaseError('STALE_DATASET', 'Esta base foi restaurada ou limpa em outra operação. Recarregue a página antes de salvar; seu formulário antigo não foi gravado.');
          if (!epochKnown) { knownEpoch = epoch; epochKnown = true; }
          synchronous(work, context);
        });
      });
    });
  }

  return Object.freeze({
    name,
    open: () => guard('open', async () => inspectSchema(await openConnection())),
    close() { cancelOpening?.(); connection?.close(); connection = undefined; },
    recentErrors: () => errorLog.map((entry) => ({ ...entry })),
    runTransaction,
    add(store, record) {
      return runTransaction([store], 'readwrite', (tx) => { checkRecord(record); tx.request(tx.store(store).add(record)); });
    },
    get(store, id) {
      return runTransaction([store], 'readonly', (tx) => { validateId(id); tx.request(tx.store(store).get(id)); });
    },
    list(store) { return runTransaction([store], 'readonly', (tx) => { tx.request(tx.store(store).getAll()); }); },
    queryIndex(store, index, query = undefined) {
      return runTransaction([store], 'readonly', (tx) => { tx.request(tx.store(store).index(index).getAll(query)); });
    },
    update(store, id, patch) {
      return runTransaction([store], 'readwrite', (tx) => {
        validateId(id);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('Informe os campos a atualizar.');
        if (Object.hasOwn(patch, 'id') && patch.id !== id) throw new ValidationError('O ID de um registro não pode ser alterado.');
        tx.request(tx.store(store).get(id), (existing) => {
          if (!existing) throw new DatabaseError('NOT_FOUND', 'O registro não existe. Atualizar não cria um registro novo.');
          const updated = { ...existing, ...patch, id };
          tx.request(tx.store(store).put(updated), () => tx.result(updated));
        });
      });
    },
    remove(store, id) {
      return runTransaction([store], 'readwrite', (tx) => {
        validateId(id);
        tx.request(tx.store(store).get(id), (existing) => {
          if (!existing) { tx.result(false); return; }
          tx.request(tx.store(store).delete(id), () => tx.result(true));
        });
      });
    },
  });
}

// Importar o módulo não abre nem escreve no banco. app.js inicia a conexão.
// Marcador consumido uma única vez após o botão explícito de troca. Reload
// subsequente volta à base real; não há preferência demo persistente.
export const DATASET_SWITCH_KEY = 'imobigest-open-once';
function initialDatabaseName() {
  try { const name = sessionStorage.getItem(DATASET_SWITCH_KEY); sessionStorage.removeItem(DATASET_SWITCH_KEY); return name === DEMO_DB_NAME ? DEMO_DB_NAME : DB_NAME; }
  catch { return DB_NAME; }
}
export const database = createDatabase({ name: initialDatabaseName() });
