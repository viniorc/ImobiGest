import { createDatabase, STORE_NAMES } from '../js/db.js';
import {
  parseBRL, formatBRL, addCentavos, subtractCentavos, assertCentavos,
  parseCivilDate, isCivilDate, formatCivilDate, daysBetween, addCivilDays,
  calculateNights, daysInMonth, dueDateForMonth, todayCivil, createId, validateId, requireText,
} from '../js/utils.js';

function assert(condition, message = 'Resultado diferente do esperado.') { if (!condition) throw new Error(message); }
function equal(actual, expected) { assert(JSON.stringify(actual) === JSON.stringify(expected), `Esperado ${JSON.stringify(expected)}; obtido ${JSON.stringify(actual)}.`); }
function throws(work) { let rejected = false; try { work(); } catch { rejected = true; } assert(rejected, 'A entrada inválida foi aceita.'); }
async function rejects(work, code) {
  let error;
  try { await work(); } catch (caught) { error = caught; }
  assert(error, 'A operação deveria ter sido rejeitada.');
  if (code) equal(error.code, code);
}

function rawOpen(name, version, upgrade = () => {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Banco de teste bloqueado.'));
  });
}

function deleteTestDatabase(name) {
  if (!name.startsWith('imobigest-test-suite-')) throw new Error('Limpeza restrita aos bancos desta suíte.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Feche outras abas de teste antes de repetir.'));
  });
}

export async function runStage02Tests(onResult = () => {}) {
  const results = [];
  const names = new Set();
  const clients = [];
  const rawConnections = [];
  const prefix = `imobigest-test-suite-${createId()}`;
  function client(suffix, options = {}) {
    const name = `${prefix}-${suffix}`;
    names.add(name);
    const db = createDatabase({ name, ...options });
    clients.push(db);
    return db;
  }
  async function test(name, work) {
    let result;
    try { await work(); result = { name, passed: true }; }
    catch (error) { result = { name, passed: false, error: error.message }; }
    results.push(result);
    onResult(result);
  }
  const db = client('crud');

  try {
    await test('Parsing BRL exato: R$ 1.234,56 = 123456 centavos', () => {
      for (const [input, expected] of [['R$ 1.234,56', 123456], ['1234,56', 123456], ['R$\u00a01.234,56', 123456], ['0,01', 1], ['12,3', 1230], ['12', 1200], ['1.234', 123400]]) equal(parseBRL(input), expected);
      equal(parseBRL('-0,01', { allowNegative: true }), -1);
    });
    await test('Parsing rejeita ambiguidade, excesso de casas, negativos e overflow', () => {
      for (const value of ['', '  ', '1.23', '1,234', '1,234.56', '1e3', 'NaN', 'Infinity', '12 34', '-1,00', '90.071.992.547.409,92', 12.34]) throws(() => parseBRL(value));
    });
    await test('Formatação BRL preserva centavos até o limite seguro', () => {
      equal(formatBRL(123456).replaceAll('\u00a0', ' '), 'R$ 1.234,56');
      equal(formatBRL(-1).replaceAll('\u00a0', ' '), '-R$ 0,01');
      equal(parseBRL(formatBRL(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    });
    await test('Soma/subtração de inteiros e limites seguros', () => {
      equal(addCentavos(10, 20), 30);
      equal(subtractCentavos(250000, 63000), 187000);
      equal(subtractCentavos(0, 1), -1);
      throws(() => addCentavos(Number.MAX_SAFE_INTEGER, 1));
      throws(() => subtractCentavos(Number.MIN_SAFE_INTEGER, 1));
      for (const value of [0.1, NaN, Infinity, '100']) throws(() => assertCentavos(value));
    });
    await test('Datas civis não deslocam o dia por fuso', () => {
      equal(formatCivilDate('2026-11-05'), '05/11/2026');
      equal(addCivilDays('2026-11-05', 0), '2026-11-05');
      equal(daysBetween('2026-11-05', '2026-11-06'), 1);
      equal(daysBetween('2026-03-07', '2026-03-10'), 3);
    });
    await test('Virada de ano, bissextos e anos abaixo de 100', () => {
      equal(addCivilDays('2026-12-31', 1), '2027-01-01');
      equal(addCivilDays('2024-02-28', 1), '2024-02-29');
      equal(addCivilDays('2026-03-01', -1), '2026-02-28');
      equal(addCivilDays('0099-12-31', 1), '0100-01-01');
      equal(addCivilDays('0001-01-01', 0), '0001-01-01');
      equal(daysInMonth(1900, 2), 28); equal(daysInMonth(2000, 2), 29);
    });
    await test('Datas impossíveis e fora dos limites são rejeitadas', () => {
      for (const date of ['2026-02-29', '2026-04-31', '0000-01-01', '10000-01-01', '2026-00-01', '2026-11-00', '2026-1-01', 'texto', null]) equal(isCivilDate(date), false);
      throws(() => parseCivilDate('2026-13-01'));
      throws(() => addCivilDays('9999-12-31', 1)); throws(() => addCivilDays('0001-01-01', -1));
    });
    await test('Noites usam entrada inclusiva e saída exclusiva', () => {
      equal(calculateNights('2026-11-10', '2026-11-13'), 3);
      equal(calculateNights('2024-02-28', '2024-03-01'), 2);
      throws(() => calculateNights('2026-11-10', '2026-11-10'));
      throws(() => calculateNights('2026-11-13', '2026-11-10'));
    });
    await test('Competência ajusta dia 31 e hoje usa componentes locais', () => {
      equal(dueDateForMonth('2026-02', 31), '2026-02-28');
      equal(dueDateForMonth('2024-02', 31), '2024-02-29');
      equal(dueDateForMonth('2026-04', 31), '2026-04-30');
      throws(() => dueDateForMonth('2026-02', 0));
      equal(todayCivil(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
    });
    await test('IDs nativos e fallback criptográfico; validação de texto/ID', () => {
      const first = createId(); const second = createId(); assert(first !== second);
      const fallback = createId({ getRandomValues: crypto.getRandomValues.bind(crypto) });
      assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fallback));
      equal(validateId(fallback), fallback); equal(requireText(' nome '), 'nome');
      for (const value of ['', ' id ', 123, '__proto__', 'x'.repeat(129)]) throws(() => validateId(value));
      throws(() => requireText(' ')); throws(() => createId({}));
    });
    await test('Versão 1 cria seis stores e índices esperados', async () => {
      const info = await db.open();
      equal(info.version, 1); equal(info.stores.sort(), [...STORE_NAMES].sort());
      await db.runTransaction(STORE_NAMES, 'readonly', (tx) => {
        equal(tx.store('transactions').index('origem').keyPath, ['origem', 'origemId']);
        equal(tx.store('transactions').index('chaveOrigem').unique, true);
        equal(tx.store('bookings').index('propriedadeEntrada').keyPath, ['propriedadeId', 'entrada']);
        equal(tx.store('photos').index('propriedadeCategoria').keyPath, ['propriedadeId', 'categoriaComodo']);
      });
      equal((await db.get('appMeta', 'app')).datasetKind, 'test');
    });
    await test('CRUD: inserir, ler, listar, editar e excluir pelo serviço', async () => {
      equal(await db.add('appMeta', { id: 'crud', texto: 'original', preservado: true }), 'crud');
      equal((await db.get('appMeta', 'crud')).texto, 'original');
      assert((await db.list('appMeta')).some((row) => row.id === 'crud'));
      const updated = await db.update('appMeta', 'crud', { texto: 'editado' });
      equal(updated, { id: 'crud', texto: 'editado', preservado: true });
      equal(await db.remove('appMeta', 'crud'), true);
      equal(await db.get('appMeta', 'crud'), undefined);
      equal(await db.remove('appMeta', 'crud'), false);
    });
    await test('Duplicatas, mudança de ID e atualização de ausente são rejeitadas', async () => {
      await db.add('appMeta', { id: 'stable', texto: 'preservar' });
      await rejects(() => db.add('appMeta', { id: 'stable', texto: 'sobrescrever' }), 'DUPLICATE');
      await rejects(() => db.update('appMeta', 'stable', { id: 'outro' }), 'VALIDATION');
      await rejects(() => db.update('appMeta', 'ausente', {}), 'NOT_FOUND');
      equal((await db.get('appMeta', 'stable')).texto, 'preservar');
    });
    await test('Coleções e IDs inválidos retornam erro tratável', async () => {
      await rejects(() => db.get('appMeta', ''), 'VALIDATION');
      await rejects(() => db.add('appMeta', { id: 1 }), 'VALIDATION');
      await rejects(() => db.list('storeInexistente'), 'VALIDATION');
      await rejects(() => db.remove('appMeta', null), 'VALIDATION');
    });
    await test('Índices por imóvel, data, origem composta e unicidade', async () => {
      await db.add('transactions', { id: 'index-1', propriedadeId: 'test-a', vencimento: '2026-11-05', origem: 'contrato', origemId: 'test-lease', chaveOrigem: 'contrato:test-lease:2026-11' });
      await db.add('transactions', { id: 'index-2', propriedadeId: 'test-b', vencimento: '2026-12-05' });
      await db.add('transactions', { id: 'index-3', propriedadeId: 'test-a', vencimento: '2026-11-10' });
      equal((await db.queryIndex('transactions', 'propriedadeId', 'test-a')).length, 2);
      equal((await db.queryIndex('transactions', 'origem', ['contrato', 'test-lease']))[0].id, 'index-1');
      equal((await db.queryIndex('transactions', 'vencimento', IDBKeyRange.bound('2026-11-01', '2026-11-30'))).length, 2);
      await rejects(() => db.add('transactions', { id: 'duplicate-origin', chaveOrigem: 'contrato:test-lease:2026-11' }), 'DUPLICATE');
      equal(await db.get('transactions', 'duplicate-origin'), undefined);
    });
    await test('Transação com vários stores confirma antes de resolver', async () => {
      const result = await db.runTransaction(['appMeta', 'properties'], 'readwrite', (tx) => {
        tx.request(tx.store('appMeta').add({ id: 'atomic-ok' }), () => {});
        tx.request(tx.store('properties').add({ id: 'atomic-ok' }), () => tx.result('commit'));
      });
      equal(result, 'commit');
      const reader = createDatabase({ name: db.name }); clients.push(reader);
      equal((await reader.get('properties', 'atomic-ok')).id, 'atomic-ok'); reader.close();
    });
    await test('Falha de unicidade reverte escritas anteriores em múltiplos stores', async () => {
      let firstRequestSucceeded = false;
      await rejects(() => db.runTransaction(['appMeta', 'properties'], 'readwrite', (tx) => {
        tx.request(tx.store('properties').add({ id: 'rollback' }), () => { firstRequestSucceeded = true; });
        tx.request(tx.store('appMeta').add({ id: 'stable' }));
      }), 'DUPLICATE');
      assert(firstRequestSucceeded, 'A primeira request precisa ter concluído antes do abort.');
      equal(await db.get('properties', 'rollback'), undefined);
    });
    await test('Exceção no callback e abort explícito revertem a transação', async () => {
      await rejects(() => db.runTransaction(['appMeta'], 'readwrite', (tx) => {
        tx.request(tx.store('appMeta').add({ id: 'callback-fail' }), () => { throw new Error('falha controlada'); });
      }), 'STORAGE');
      equal(await db.get('appMeta', 'callback-fail'), undefined);
      await rejects(() => db.runTransaction(['appMeta'], 'readwrite', (tx) => {
        tx.store('appMeta').add({ id: 'explicit-abort' }); tx.abort();
      }), 'ABORTED');
      equal(await db.get('appMeta', 'explicit-abort'), undefined);
    });
    await test('Callback async é rejeitado antes de permitir commit parcial', async () => {
      await rejects(() => db.runTransaction(['appMeta'], 'readwrite', async (tx) => {
        tx.store('appMeta').add({ id: 'async-invalid' });
      }), 'ASYNC_CALLBACK');
      equal(await db.get('appMeta', 'async-invalid'), undefined);
      await rejects(() => db.runTransaction(['appMeta'], 'readwrite', (tx) => {
        tx.request(tx.store('appMeta').add({ id: 'async-request' }), async () => {});
      }), 'ASYNC_CALLBACK');
      equal(await db.get('appMeta', 'async-request'), undefined);
    });
    await test('Modo readonly impede escrita', async () => {
      await rejects(() => db.runTransaction(['appMeta'], 'readonly', (tx) => { tx.store('appMeta').add({ id: 'readonly' }); }), 'READ_ONLY');
      equal(await db.get('appMeta', 'readonly'), undefined);
    });
    await test('Blob é preservado pelo IndexedDB sem localStorage/Base64', async () => {
      const bytes = new Uint8Array([0, 1, 128, 255]);
      await db.add('photos', { id: 'blob-fixture', propriedadeId: 'test-a', blob: new Blob([bytes], { type: 'application/octet-stream' }) });
      const saved = await db.get('photos', 'blob-fixture');
      assert(saved.blob instanceof Blob);
      equal([...new Uint8Array(await saved.blob.arrayBuffer())], [...bytes]);
    });
    await test('Fechar conexão e reabrir preserva registro e metadados', async () => {
      await db.add('appMeta', { id: 'reopen', texto: 'persistido' });
      await db.update('appMeta', 'app', { marcador: 'preservado' });
      db.close();
      equal((await db.get('appMeta', 'reopen')).texto, 'persistido');
      equal((await db.get('appMeta', 'app')).marcador, 'preservado');
    });
    await test('Versão futura é recusada sem apagar registro existente', async () => {
      const future = client('future');
      const raw = await rawOpen(future.name, 2, (native) => native.createObjectStore('sentinel', { keyPath: 'id' }).add({ id: 'keep' }));
      rawConnections.push(raw); raw.close();
      await rejects(() => future.open(), 'VERSION');
      const reopened = await rawOpen(future.name, 2); rawConnections.push(reopened);
      const value = await new Promise((resolve, reject) => {
        const request = reopened.transaction('sentinel').objectStore('sentinel').get('keep');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      equal(value.id, 'keep'); reopened.close();
    });
    await test('versionchange fecha conexão e libera upgrade de outra aba', async () => {
      const changing = client('versionchange');
      await changing.add('appMeta', { id: 'keep' });
      const upgraded = await rawOpen(changing.name, 2); rawConnections.push(upgraded);
      assert(changing.recentErrors().some((entry) => entry.code === 'VERSION_CHANGED'));
      upgraded.close();
      await rejects(() => changing.open(), 'VERSION');
    });
    await test('Esquema incompatível é recusado sem recriar a base', async () => {
      const malformed = client('schema');
      const raw = await rawOpen(malformed.name, 1, (native) => native.createObjectStore('sentinel')); rawConnections.push(raw); raw.close();
      await rejects(() => malformed.open(), 'SCHEMA');
      const reopened = await rawOpen(malformed.name, 1); rawConnections.push(reopened);
      equal([...reopened.objectStoreNames], ['sentinel']); reopened.close();
    });
    await test('Armazenamento indisponível e SecurityError viram mensagens compreensíveis', async () => {
      const absent = client('unavailable', { factory: null });
      await rejects(() => absent.open(), 'UNAVAILABLE');
      const denied = client('denied', { factory: { open() { throw new DOMException('simulado', 'SecurityError'); } } });
      await rejects(() => denied.open(), 'UNAVAILABLE');
      assert(denied.recentErrors()[0].message.includes('permissões'));
    });
    await test('QuotaExceededError simulado aborta escrita e é registrado', async () => {
      await rejects(() => db.runTransaction(['appMeta'], 'readwrite', (tx) => {
        tx.request(tx.store('appMeta').add({ id: 'quota-rollback' }), () => tx.abort(new DOMException('simulado', 'QuotaExceededError')));
      }), 'QUOTA');
      equal(await db.get('appMeta', 'quota-rollback'), undefined);
      assert(db.recentErrors().some((entry) => entry.code === 'QUOTA' && entry.message.includes('espaço')));
    });
    await test('Abertura bloqueada fecha conexão tardia; timeout não trava a Promise', async () => {
      let request; let closed = false; let aborted = false;
      const blocked = client('blocked', { factory: { open() { request = {}; queueMicrotask(() => request.onblocked()); return request; } } });
      await rejects(() => blocked.open(), 'BLOCKED');
      request.transaction = { abort() { aborted = true; } };
      request.onupgradeneeded({ oldVersion: 0 }); assert(aborted);
      request.result = { close() { closed = true; } }; request.onsuccess(); assert(closed);
      const timeout = client('timeout', { timeoutMs: 20, factory: { open() { return {}; } } });
      await rejects(() => timeout.open(), 'TIMEOUT');
    });
    await test('Erros ficam limitados a 20 entradas técnicas sem payload dos registros', async () => {
      for (let i = 0; i < 22; i++) await rejects(() => db.get('appMeta', ''), 'VALIDATION');
      equal(db.recentErrors().length, 20);
      equal(Object.keys(db.recentErrors()[0]).sort(), ['at', 'code', 'message', 'operation']);
      const copy = db.recentErrors(); copy[0].message = 'alterado';
      assert(db.recentErrors()[0].message !== 'alterado');
    });
  } finally {
    clients.forEach((item) => item.close());
    rawConnections.forEach((item) => item.close());
    await test('Limpeza remove somente os bancos descartáveis desta execução', async () => {
      for (const name of names) await deleteTestDatabase(name);
    });
  }
  return results;
}
