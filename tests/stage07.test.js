import { createDatabase } from '../js/db.js';
import { createId } from '../js/utils.js';
import { createPhotoService, PHOTO_PAGE_SIZE, validatePhotoMetadata } from '../js/galeria-service.js';
import { preparePhoto, inspectPhotoBlob, validatePhotoFiles, PHOTO_LIMITS, createObjectURLPool } from '../js/galeria-imagens.js';
import { createPropertyService } from '../js/imoveis.js';
import { matchGalleryRoute } from '../js/galeria.js';

const assert = (value, message = 'Resultado inesperado.') => { if (!value) throw new Error(message); };
const equal = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `Esperado ${JSON.stringify(b)}; obtido ${JSON.stringify(a)}`);
async function rejects(work, code) { let error; try { await work(); } catch (caught) { error = caught; } assert(error, 'Deveria falhar.'); if (code) equal(error.code, code); return error; }
export async function imageFixture(type = 'image/png', width = 800, height = 600, name = 'mesmo-nome.png') {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); const gradient = ctx.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, '#233d4d'); gradient.addColorStop(1, '#9bc4ac'); ctx.fillStyle = gradient; ctx.fillRect(0,0,width,height); ctx.fillStyle = '#fff'; ctx.fillRect(width*.25,height*.3,width*.5,height*.45);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, .9)); canvas.width = canvas.height = 0;
  return new File([blob], name, { type: blob.type });
}
export async function runStage07Tests(onResult = () => {}) {
  const name = `imobigest-test-photos-${createId()}`; const db = createDatabase({ name }); const second = createDatabase({ name }); const service = createPhotoService(db); const other = createPhotoService(second);
  const results = []; let file; let prepared; let a; let b;
  async function test(name, work) { let result; try { await work(); result = { name, passed: true }; } catch (error) { result = { name, passed: false, error: error.message }; } results.push(result); onResult(result); }
  const fresh = (patch = {}) => ({ ...prepared, id: createId(), ...patch });
  try {
    for (const id of ['casa-a', 'apartamento-b', 'casa-c']) await db.add('properties', { id, nome: id, revisao: 1 });
    file = await imageFixture();
    await test('Seleção exige 1–10 imagens e MIME JPEG/PNG/WebP; PDF/SVG/vazio recusados', async () => {
      for (const files of [[], Array(11).fill(file), [new File(['pdf'], 'doc.pdf', {type:'application/pdf'})], [new File(['<svg/>'], 'img.svg', {type:'image/svg+xml'})], [new File([], 'zero.png', {type:'image/png'})], [new File(['x'], 'sem-mime.png')]]) await rejects(() => validatePhotoFiles(files));
    });
    await test('Arquivo acima de 20 MiB e seleção acima de 60 MiB são rejeitados antes de decodificar', async () => {
      const big = new Blob([new Uint8Array(21 * 1024 * 1024)], {type:'image/jpeg'}); await rejects(() => validatePhotoFiles([big]));
      const part = new Blob([new Uint8Array(16 * 1024 * 1024)], {type:'image/png'}); await rejects(() => validatePhotoFiles([part,part,part,part]));
    });
    await test('Assinatura real prevalece sobre nome e MIME declarado', async () => {
      await rejects(() => preparePhoto(new File(['arquivo falso'], 'foto.png', {type:'image/png'})));
      await rejects(() => preparePhoto(new File([file], 'foto.jpg', {type:'image/jpeg'})));
      const renamed = new File([file], 'imagem.nome.qualquer', {type:'image/png'}); equal((await inspectPhotoBlob(renamed)).width, 800);
    });
    await test('Cabeçalho de imagem gigante bloqueia antes da decodificação; truncada também falha', async () => {
      const bytes = new Uint8Array(await file.arrayBuffer()); const view = new DataView(bytes.buffer); view.setUint32(16, 12001); await rejects(() => preparePhoto(new File([bytes], 'gigante.png', {type:'image/png'})));
      view.setUint32(16, 10000); view.setUint32(20, 5000); await rejects(() => preparePhoto(new File([bytes], '50mp.png', {type:'image/png'})));
      await rejects(() => preparePhoto(new File([file.slice(0,33)], 'truncada.png', {type:'image/png'})));
    });
    await test('Preparação não grava; produz Blobs, miniatura compacta e ID estável próprio', async () => {
      prepared = await preparePhoto(file); assert(prepared.blob instanceof Blob); assert(prepared.thumbnailBlob instanceof Blob); assert(prepared.id !== file.name);
      equal(prepared.width, 800); equal(prepared.height, 600); equal(prepared.thumbnailWidth, 480); equal(prepared.thumbnailHeight, 360); assert(prepared.thumbnailBlob.size < file.size); equal((await db.list('photos')).length, 0);
    });
    await test('JPEG, PNG e WebP decodificam e saem com formato válido; transparência preservada', async () => {
      for (const type of ['image/jpeg','image/png','image/webp']) { const input = await imageFixture(type,120,80); const output = await preparePhoto(input); equal((await inspectPhotoBlob(output.blob)).width,120); assert(output.blob.size > 0); }
      const canvas=document.createElement('canvas');canvas.width=canvas.height=10;const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const output=await preparePhoto(new File([blob],'transparente.png',{type:'image/png'}));const image=await createImageBitmap(output.blob);canvas.getContext('2d').drawImage(image,0,0);equal(canvas.getContext('2d').getImageData(0,0,1,1).data[3],0);image.close();
    });
    await test('Foto grande é redimensionada proporcionalmente e respeita limites de bytes', async () => {
      const output=await preparePhoto(await imageFixture('image/jpeg',2400,1800));equal(output.width,1920);equal(output.height,1440);assert(output.blob.size<=PHOTO_LIMITS.imageBytes);assert(output.thumbnailBlob.size<=PHOTO_LIMITS.thumbnailBytes);
    });
    await test('Decodificação alternativa funciona e revoga URL temporária', async () => {
      const original = window.createImageBitmap; const create=URL.createObjectURL; const revoke=URL.revokeObjectURL;const active=new Set();
      URL.createObjectURL=(blob)=>{const url=create.call(URL,blob);active.add(url);return url;};URL.revokeObjectURL=(url)=>{active.delete(url);return revoke.call(URL,url);};
      try { window.createImageBitmap=undefined; const output=await preparePhoto(file);equal(output.width,800);equal(active.size,0); } finally { window.createImageBitmap=original;URL.createObjectURL=create;URL.revokeObjectURL=revoke; }
    });
    await test('Lote de três fotos de mesmo nome para Casa A recebe IDs independentes', async () => {
      a=await service.addBatch('casa-a',[fresh(),fresh(),fresh()]);equal(a.length,3);equal(new Set(a.map(p=>p.id)).size,3);assert(a.every(p=>p.propriedadeId==='casa-a' && !Object.hasOwn(p,'blob')));
    });
    await test('Duas fotos do Apartamento B ficam isoladas por índice e por consulta', async () => {
      b=await service.addBatch('apartamento-b',[fresh(),fresh()]);equal((await service.page({propertyId:'casa-a'})).total,3);equal((await service.page({propertyId:'apartamento-b'})).total,2);equal((await service.page()).total,5);
      await rejects(()=>service.get(a[0].id,'apartamento-b'),'PROPERTY');await rejects(()=>service.thumbnail(a[0].id,'apartamento-b'),'PROPERTY');
    });
    await test('Imóvel ausente/ID inválido e Blob inválido impedem qualquer gravação', async () => {
      await rejects(()=>service.addBatch('ausente',[fresh()]),'PROPERTY_NOT_FOUND');await rejects(()=>service.addBatch('inválido',[fresh()]));await rejects(()=>service.addBatch('casa-a',[fresh({blob:new Blob(['x'],{type:'image/png'})})]));equal((await service.page()).total,5);
    });
    await test('Lote com ID repetido aborta inteiro sem sobrescrever foto existente', async () => {
      await rejects(()=>service.addBatch('casa-a',[fresh(),{...prepared,id:a[0].id}]),'DUPLICATE');equal((await service.page()).total,5);
    });
    await test('Salvar Blob acima dos limites compactados é recusado', async () => {
      const blob=new Blob([prepared.blob,new Uint8Array(PHOTO_LIMITS.imageBytes)],{type:prepared.blob.type});await rejects(()=>service.addBatch('casa-a',[fresh({blob})]));equal((await service.page()).total,5);
    });
    await test('Legenda/categoria são validadas; texto com tag permanece dado textual', async () => {
      await rejects(()=>validatePhotoMetadata({legenda:'x'.repeat(501),categoriaComodo:'sala'}));await rejects(()=>validatePhotoMetadata({legenda:'',categoriaComodo:'arquivo_juridico'}));
      const updated=await service.update(a[0].id,'casa-a',{legenda:'<img src=x onerror=alert(1)>',categoriaComodo:'fachada',propriedadeId:'apartamento-b'},a[0].revisao);equal(updated.legenda,'<img src=x onerror=alert(1)>');equal(updated.categoriaComodo,'fachada');equal(updated.propriedadeId,'casa-a');a[0]=updated;
    });
    await test('Edição exige imóvel correto e revisão atual, preservando bytes/ID/criação', async () => {
      const before=await service.get(a[0].id,'casa-a');await rejects(()=>service.update(a[0].id,'apartamento-b',{legenda:'Errada',categoriaComodo:'sala'},a[0].revisao),'PROPERTY');await rejects(()=>service.update(a[0].id,'casa-a',{legenda:'Antiga',categoriaComodo:'sala'},1),'CONFLICT');
      const updated=await service.update(a[0].id,'casa-a',{legenda:'Fachada principal',categoriaComodo:'fachada'},a[0].revisao);const after=await service.get(updated.id,'casa-a');equal(after.createdAt,before.createdAt);equal([...new Uint8Array(await after.blob.arrayBuffer())],[...new Uint8Array(await before.blob.arrayBuffer())]);a[0]=updated;
    });
    await test('Definir capa atualiza somente imóvel correto e incrementa revisão', async () => {
      const beforeB=await db.get('properties','apartamento-b');const property=await service.setCover(a[0].id,'casa-a',a[0].revisao);equal(property.coverPhotoId,a[0].id);equal(property.revisao,2);equal(await db.get('properties','apartamento-b'),beforeB);
    });
    await test('Capa de outro imóvel é recusada e substituição mantém fotos', async () => {
      await rejects(()=>service.setCover(b[0].id,'casa-a',b[0].revisao),'PROPERTY');const property=await service.setCover(a[1].id,'casa-a',a[1].revisao);equal(property.coverPhotoId,a[1].id);equal((await service.page({propertyId:'casa-a'})).total,3);
    });
    await test('Edição antiga de imóvel não sobrescreve referência da nova capa', async () => {
      const form={nome:'Casa A',tipo:'casa',finalidade:'temporada',endereco:'Rua A',cidade:'Fortaleza',uf:'CE',situacaoManual:'disponivel'};await rejects(()=>createPropertyService(db).save(form,{id:'casa-a',expectedRevision:1}),'CONFLICT');equal((await db.get('properties','casa-a')).coverPhotoId,a[1].id);
    });
    await test('Excluir foto comum preserva capa e imóvel; imóvel com fotos não pode ser excluído', async () => {
      await service.remove(a[2].id,'casa-a',a[2].revisao);equal((await db.get('properties','casa-a')).coverPhotoId,a[1].id);await rejects(()=>createPropertyService(db).remove('casa-a'),'LINKED');
    });
    await test('Excluir capa limpa referência atomicamente sem apagar imóvel ou outras fotos', async () => {
      await service.remove(a[1].id,'casa-a',a[1].revisao);const property=await db.get('properties','casa-a');assert(property);assert(!Object.hasOwn(property,'coverPhotoId'));equal((await service.page({propertyId:'casa-a'})).total,1);equal((await service.page({propertyId:'apartamento-b'})).total,2);
    });
    await test('Duas edições concorrentes da mesma revisão aceitam somente uma', async () => {
      const attempts=await Promise.allSettled([service.update(a[0].id,'casa-a',{legenda:'A',categoriaComodo:'sala'},a[0].revisao),other.update(a[0].id,'casa-a',{legenda:'B',categoriaComodo:'quarto'},a[0].revisao)]);equal(attempts.filter(r=>r.status==='fulfilled').length,1);equal(attempts.find(r=>r.status==='rejected').reason.code,'CONFLICT');a[0]=attempts.find(r=>r.status==='fulfilled').value;
    });
    await test('Quota simulada após segunda inserção reverte todo lote e preserva anteriores', async () => {
      const before=(await service.page()).total;let inserted=0;const failing={...db,runTransaction(stores,mode,work){return db.runTransaction(stores,mode,tx=>work({...tx,request(request,callback){return tx.request(request,result=>{if(request.source?.name==='photos'&&++inserted===2)throw new DOMException('Quota de teste','QuotaExceededError');callback?.(result);});}}));}};
      await rejects(()=>createPhotoService(failing).addBatch('casa-c',[fresh(),fresh(),fresh()]),'QUOTA');equal((await service.page()).total,before);assert(db.recentErrors().some(e=>e.code==='QUOTA'));
    });
    await test('Falha depois de gravar capa reverte mudança do imóvel', async () => {
      const before=await db.get('properties','casa-a');const failing={...db,runTransaction(stores,mode,work){return db.runTransaction(stores,mode,tx=>work({...tx,request(request,callback){return tx.request(request,result=>{if(request.source?.name==='properties'&&typeof result==='string')throw new DOMException('Quota de teste','QuotaExceededError');callback?.(result);});}}));}};
      await rejects(()=>createPhotoService(failing).setCover(a[0].id,'casa-a',a[0].revisao),'QUOTA');equal(await db.get('properties','casa-a'),before);
    });
    await test('Falha depois de excluir capa reverte foto e referência juntas', async () => {
      await service.setCover(a[0].id,'casa-a',a[0].revisao);const before=await db.get('properties','casa-a');const failing={...db,runTransaction(stores,mode,work){return db.runTransaction(stores,mode,tx=>work({...tx,request(request,callback){return tx.request(request,result=>{if(request.source?.name==='photos'&&result===undefined)throw new DOMException('Quota de teste','QuotaExceededError');callback?.(result);});}}));}};
      await rejects(()=>createPhotoService(failing).remove(a[0].id,'casa-a',a[0].revisao),'QUOTA');equal(await db.get('properties','casa-a'),before);assert(await service.get(a[0].id,'casa-a'));
    });
    await test('Paginações retornam só miniaturas, até 12 por página, sem IDs repetidos', async () => {
      await service.addBatch('casa-a',Array.from({length:10},()=>fresh()));await service.addBatch('casa-a',[fresh(),fresh()]);const first=await service.page({propertyId:'casa-a'});const last=await service.page({propertyId:'casa-a',page:1});equal(first.total,13);equal(first.rows.length,PHOTO_PAGE_SIZE);equal(last.rows.length,1);equal(new Set([...first.rows,...last.rows].map(r=>r.id)).size,13);assert(first.rows.every(r=>!Object.hasOwn(r,'blob')&&r.thumbnailBlob instanceof Blob));equal((await service.page({propertyId:'casa-a',page:999})).page,1);
    });
    await test('Páginas e IDs inválidos e foto ausente são relatados com clareza', async () => {
      await rejects(()=>service.page({page:-1}));await rejects(()=>service.page({page:1.5}));await rejects(()=>service.get('ausente','casa-a'),'NOT_FOUND');await rejects(()=>service.remove('ausente','casa-a',1),'NOT_FOUND');await rejects(()=>service.setCover(a[0].id,'casa-a',1),'CONFLICT');
    });
    await test('Reabrir banco conserva Blob, miniatura, legenda, categoria e capa', async () => {
      const before=await service.get(a[0].id,'casa-a');db.close();second.close();const after=await other.get(a[0].id,'casa-a');equal(after.legenda,before.legenda);equal(after.categoriaComodo,before.categoriaComodo);equal(after.blob.type,before.blob.type);equal([...new Uint8Array(await after.thumbnailBlob.arrayBuffer())],[...new Uint8Array(await before.thumbnailBlob.arrayBuffer())]);equal((await second.get('properties','casa-a')).coverPhotoId,a[0].id);
    });
    await test('Pool de Object URLs revoga cada recurso uma vez e pode ser reutilizado', () => {
      const created=[];const revoked=[];const pool=createObjectURLPool({createObjectURL(){const url=`blob:${created.length}`;created.push(url);return url;},revokeObjectURL(url){revoked.push(url);}});const a=pool.create(file);pool.create(file);pool.revoke(a);pool.revoke(a);pool.dispose();pool.dispose();pool.create(file);pool.dispose();equal(revoked,created);
    });
    await test('Rotas de galeria aceitam filtro por imóvel e recusam caminho futuro', () => {
      equal(matchGalleryRoute('/fotos'),{propertyId:''});equal(matchGalleryRoute('/fotos?imovel=casa-a'),{propertyId:'casa-a'});equal(matchGalleryRoute('/fotos/editar'),null);
    });
  } finally {
    db.close();second.close();await test('Limpeza somente do banco isolado de fotos desta execução',()=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Banco bloqueado.'));}));
  }
  return results;
}
