import { createDatabase } from '../js/db.js';
import { createId } from '../js/utils.js';
import { createPropertyService, filterProperties, validatePropertyInput, matchPropertyRoute } from '../js/imoveis.js';

function assert(value, message = 'Resultado inesperado.') { if (!value) throw new Error(message); }
function equal(actual, expected) { assert(JSON.stringify(actual) === JSON.stringify(expected), `Esperado ${JSON.stringify(expected)}; obtido ${JSON.stringify(actual)}`); }
async function rejects(work, code) {
  let error;
  try { await work(); } catch (caught) { error = caught; }
  assert(error, 'A operação deveria ter sido recusada.');
  if (code) equal(error.code, code);
  return error;
}
const fixture = (name = 'Casa A', type = 'casa') => ({ nome: name, tipo: type, finalidade: 'residencial', endereco: 'Rua das Palmeiras, 10', bairro: 'Centro', cidade: 'Fortaleza', uf: 'CE', cep: '60000000', descricao: 'Cadastro de teste', situacaoManual: 'disponivel', valorEstimado: '350.000,00', aluguelPrevisto: '2.500,00', observacoes: '' });

export async function runStage03Tests(onResult = () => {}) {
  const results = [];
  const name = `imobigest-test-properties-${createId()}`;
  const db = createDatabase({ name });
  const secondDB = createDatabase({ name });
  const service = createPropertyService(db);
  const secondService = createPropertyService(secondDB);
  const test = async (name, work) => {
    let result;
    try { await work(); result = { name, passed: true }; }
    catch (error) { result = { name, passed: false, error: error.message }; }
    results.push(result); onResult(result);
  };
  let a; let b; let c;
  try {
    await test('Campos obrigatórios, UF, CEP e valores inválidos são recusados', async () => {
      const invalid = { ...fixture(), nome: ' ', tipo: 'inválido', finalidade: '', cidade: '', endereco: '', uf: 'ZZ', cep: '12', valorEstimado: '-1,00', aluguelPrevisto: '1.23' };
      const error = await rejects(() => service.save(invalid));
      for (const field of ['nome', 'tipo', 'finalidade', 'cidade', 'endereco', 'uf', 'cep', 'valorEstimado', 'aluguelPrevisto']) assert(error.fields[field]);
      equal((await service.list()).length, 0);
    });
    await test('Criar três tipos distintos e armazenar centavos/CEP normalizados', async () => {
      a = await service.save(fixture());
      b = await service.save(fixture('Apartamento B', 'apartamento'));
      c = await service.save({ ...fixture('Sala C', 'sala_comercial'), finalidade: 'comercial', situacaoManual: 'manutencao' });
      equal((await service.list()).length, 3);
      equal(a.valorEstimadoCentavos, 35000000); equal(a.aluguelPrevistoCentavos, 250000);
      equal(a.cep, '60000-000'); assert(a.id !== b.id && b.id !== c.id);
    });
    await test('Opcionais vazios e valor zero são diferenciados', () => {
      const input = validatePropertyInput({ ...fixture(), cep: '', valorEstimado: ' ', aluguelPrevisto: '0,00' });
      equal(input.valorEstimadoCentavos, null); equal(input.aluguelPrevistoCentavos, 0); equal(input.cep, '');
    });
    await test('Edição preserva ID, criação e campos de outro imóvel', async () => {
      const beforeB = await service.get(b.id);
      a = await service.save({ ...fixture(), endereco: 'Rua Editada, 50' }, { id: a.id, expectedRevision: a.revisao });
      equal(a.endereco, 'Rua Editada, 50'); equal(a.revisao, 2);
      equal(await service.get(b.id), beforeB);
      db.close(); equal((await service.get(a.id)).endereco, 'Rua Editada, 50');
    });
    await test('Campos técnicos/referências não são sobrescritos pelo formulário', async () => {
      const creation = a.criadoEm;
      await db.update('properties', a.id, { coverPhotoId: 'cover-reference', outroMetadado: true });
      a = await service.save({ ...fixture(), id: 'id-injetado', coverPhotoId: 'outra-capa', criadoEm: 'injetado' }, { id: a.id, expectedRevision: a.revisao });
      equal(a.criadoEm, creation); equal(a.coverPhotoId, 'cover-reference'); equal(a.outroMetadado, true);
    });
    await test('Filtros por nome, tipo, situação e busca textual não escrevem dados', async () => {
      const before = await service.list();
      equal(filterProperties(before, { nome: 'casa a' }).map((item) => item.id), [a.id]);
      equal(filterProperties(before, { tipo: 'apartamento' }).map((item) => item.id), [b.id]);
      equal(filterProperties(before, { situacao: 'manutencao' }).map((item) => item.id), [c.id]);
      equal(filterProperties(before, { query: 'fortaleza centro', tipo: 'sala_comercial' }).map((item) => item.id), [c.id]);
      equal(filterProperties(before, { query: 'inexistente' }).length, 0);
      equal(await service.list(), before);
    });
    await test('Busca ignora acentos e mantém combinação dos filtros', () => {
      const rows = [{ ...a, nome: 'Casa São José', descricao: 'Área externa', bairro: 'Benfica' }];
      equal(filterProperties(rows, { nome: 'sao jose', query: 'area benfica' }).length, 1);
      equal(filterProperties(rows, { nome: 'sao jose', tipo: 'apartamento' }).length, 0);
    });
    await test('Duas conexões editando a mesma revisão: uma salva, a outra conflita', async () => {
      const snapshot = await service.get(b.id);
      const attempts = await Promise.allSettled([
        service.save(fixture('Versão 1', 'apartamento'), { id: b.id, expectedRevision: snapshot.revisao }),
        secondService.save(fixture('Versão 2', 'apartamento'), { id: b.id, expectedRevision: snapshot.revisao }),
      ]);
      equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
      equal(attempts.find((item) => item.status === 'rejected').reason.code, 'CONFLICT');
      equal((await service.get(b.id)).revisao, snapshot.revisao + 1);
    });
    for (const [store, label] of [['leases', 'contrato'], ['bookings', 'reserva'], ['transactions', 'lançamento'], ['photos', 'foto']]) {
      await test(`Exclusão bloqueada por ${label}, inclusive histórico cancelado`, async () => {
        const id = `link-${store}`;
        await db.add(store, { id, propriedadeId: c.id, situacao: 'cancelada', situacaoPersistida: 'cancelado' });
        await rejects(() => service.remove(c.id), 'LINKED');
        assert(await service.get(c.id)); assert(await db.get(store, id));
        await db.remove(store, id);
      });
    }
    await test('Vínculo de outro imóvel não impede excluir imóvel sem dependências', async () => {
      await db.add('photos', { id: 'other-link', propriedadeId: a.id });
      equal(await service.remove(c.id), true); equal(await service.get(c.id), undefined);
      assert(await db.get('photos', 'other-link')); assert(await service.get(a.id));
    });
    await test('Imóvel ausente/ID inválido não recria nem remove outro registro', async () => {
      equal(await service.remove('inexistente'), false);
      await rejects(() => service.save(fixture(), { id: 'inexistente', expectedRevision: 0 }), 'NOT_FOUND');
      await rejects(() => service.remove('ID inválido'));
      assert(await service.get(a.id));
    });
    await test('Rotas de lista, criação, detalhe e edição selecionam o ID correto', () => {
      equal(matchPropertyRoute('/imoveis'), { mode: 'list' });
      equal(matchPropertyRoute('/imoveis/novo'), { mode: 'new' });
      equal(matchPropertyRoute('/imoveis/id-a/editar'), { mode: 'edit', id: 'id-a' });
      equal(matchPropertyRoute('/imoveis/id-b'), { mode: 'detail', id: 'id-b' });
      equal(matchPropertyRoute('/imoveis/id-b/extra/editar'), null);
    });
  } finally {
    db.close(); secondDB.close();
    await test('Limpeza restrita ao banco isolado desta execução', () => new Promise((resolve, reject) => {
      if (!name.startsWith('imobigest-test-properties-')) { reject(new Error('Nome de teste inesperado.')); return; }
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Feche outras abas de teste.'));
    }));
  }
  return results;
}
