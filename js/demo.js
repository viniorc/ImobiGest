import { createDatabase, database, DEMO_DB_NAME, DATASET_SWITCH_KEY, STORE_NAMES, DB_VERSION, APP_VERSION, DatabaseError } from './db.js';
import { todayCivil, dueDateForMonth, createId, ValidationError } from './utils.js';
import { createOriginKey } from './financeiro-service.js';
import { preparePhoto } from './galeria-imagens.js';
import { validateBackupData } from './backup.js';

export async function buildDemoData(today = todayCivil()) {
  const month = today.slice(0, 7); const first = dueDateForMonth(month, 1);
  const year = Number(month.slice(0, 4)); const n = Number(month.slice(5));
  const previous = n === 1 ? `${String(year - 1).padStart(4, '0')}-12` : `${year}-${String(n - 1).padStart(2, '0')}`;
  dueDateForMonth(previous, 1);
  const now = new Date().toISOString(); const common = { criadoEm: now, atualizadoEm: now, revisao: 1 };
  const properties = [
    ['Apartamento Jardim', 'apartamento','residencial'], ['Casa das Palmeiras','casa','residencial'], ['Sala Comercial Centro','sala_comercial','comercial'], ['Casa de Temporada Mar Azul','casa','temporada'], ['Apartamento Airbnb Vista Sol','apartamento','temporada'],
  ].map(([nome,tipo,finalidade],i) => ({ ...common,id:`demo-property-${i+1}`,nome,tipo,finalidade,endereco:`Rua Exemplo, ${100+i}`,cidade:'Fortaleza',uf:'CE',bairro:'Bairro demonstrativo',cep:'60000-000',descricao:'Cadastro fictício para explorar o ImobiGest.',observacoes:'Demonstração: não corresponde a imóvel ou pessoa real.',situacaoManual:'disponivel',valorEstimadoCentavos:null,aluguelPrevistoCentavos:null }));
  const leases = properties.slice(0,3).map((p,i) => ({ ...common,id:`demo-lease-${i+1}`,propriedadeId:p.id,locatario:`Locatário exemplo ${i+1}`,inicio:first,fim:null,valorMensalCentavos:[250000,180000,320000][i],diaVencimento:1,situacao:'ativo',observacoes:'Contrato demonstrativo de unidade inteira.' }));
  const transactions = []; let serial = 0;
  function transaction(patch) { const row = { ...common,id:`demo-transaction-${++serial}`,propriedadeId:null,tipo:'receita',categoria:'Aluguel',descricao:'Movimentação demonstrativa',valorCentavos:10000,vencimento:first,liquidadoEm:null,situacaoPersistida:'pendente',origem:'manual',origemId:null,periodoReferencia:null,formaPagamento:'',observacoes:'Dados fictícios.',...patch }; if (row.origem !== 'manual') row.chaveOrigem=createOriginKey(row); transactions.push(row); }
  for (const lease of leases) transaction({propriedadeId:lease.propriedadeId,valorCentavos:lease.valorMensalCentavos,descricao:`Aluguel · ${lease.locatario}`,liquidadoEm:first,situacaoPersistida:'liquidado',origem:'contrato',origemId:lease.id,subtipoOrigem:'aluguel',periodoReferencia:month});
  properties.slice(0,3).forEach((p,i)=>transaction({propriedadeId:p.id,tipo:'despesa',categoria:'Manutenção',descricao:`Manutenção · ${p.nome}`,valorCentavos:[63000,25000,40000][i],liquidadoEm:first,situacaoPersistida:'liquidado'}));
  transaction({tipo:'despesa',categoria:'Administração',descricao:'Despesa geral demonstrativa',vencimento:dueDateForMonth(month,28)});
  const bookings=[];
  for (const [i,p] of properties.slice(3).entries()) for (const [j,period] of [previous,month].entries()) {
    const entrada=dueDateForMonth(period,i?20:10); const saida=dueDateForMonth(period,i?24:13);
    const b={...common,id:`demo-booking-${i+1}-${j+1}`,propriedadeId:p.id,hospede:`Hóspede exemplo ${i+1}-${j+1}`,plataforma:i?'airbnb':'direta',entrada,saida,valorBrutoCentavos:i?160000:90000,taxaPlataformaCentavos:i?24000:0,outrasDespesasCentavos:12000,situacao:saida<=today?'concluida':'confirmada',observacoes:'Reserva manual fictícia, sem integração externa.'}; bookings.push(b);
    for(const [subtipoOrigem,valorCentavos] of [['bruto',b.valorBrutoCentavos],['taxa',b.taxaPlataformaCentavos],['outras',b.outrasDespesasCentavos]]) if(valorCentavos) transaction({propriedadeId:p.id,tipo:subtipoOrigem==='bruto'?'receita':'despesa',categoria:subtipoOrigem==='bruto'?'Hospedagem':subtipoOrigem==='taxa'?'Taxa da plataforma':'Limpeza',descricao:`Reserva · ${b.hospede} · ${subtipoOrigem}`,valorCentavos,vencimento:entrada,liquidadoEm:j===0?saida:null,situacaoPersistida:j===0?'liquidado':'pendente',origem:'reserva',origemId:b.id,subtipoOrigem,periodoReferencia:null});
  }
  const photos=[];
  for(const [i,p] of properties.entries()) {
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=420;const ctx=canvas.getContext('2d');if(!ctx)throw new ValidationError('Canvas indisponível para preparar a demonstração.');
    ctx.fillStyle=['#d7e8dc','#dce8f3','#e8e2d6','#d7ecec','#ece0d5'][i];ctx.fillRect(0,0,640,420);ctx.fillStyle='#24495a';ctx.fillRect(180,130,280,200);ctx.fillStyle='#edf6f5';for(let x=215;x<430;x+=75)for(let y=160;y<290;y+=70)ctx.fillRect(x,y,36,42);ctx.fillStyle='#24495a';ctx.font='20px sans-serif';ctx.fillText('Ilustração de demonstração',170,380);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));canvas.width=canvas.height=0;
    const prepared=await preparePhoto(new File([blob],`demonstracao-${i+1}.png`,{type:'image/png'}));
    const photo={...prepared,id:`demo-photo-${i+1}`,propriedadeId:p.id,categoriaComodo:'fachada',legenda:'Ilustração fictícia de demonstração.',mimeType:prepared.blob.type,tamanho:prepared.blob.size,thumbnailSize:prepared.thumbnailBlob.size,createdAt:now,atualizadoEm:now,revisao:1};photos.push(photo);p.coverPhotoId=photo.id;
  }
  return {properties,transactions,leases,bookings,photos,appMeta:[{id:'app',schemaVersion:DB_VERSION,appVersion:APP_VERSION,datasetKind:'demo',demoMode:true,demoSeedVersion:1,demoMonth:month}]};
}
export async function ensureDemo(db = createDatabase({name:DEMO_DB_NAME}), today = todayCivil()) {
  if(db.name!==DEMO_DB_NAME&&!db.name.startsWith('imobigest-test-'))throw new ValidationError('Demonstração nunca pode substituir a base real.');
  try {
    const existing=await db.get('appMeta','app');if(existing?.demoSeedVersion)return {created:false};
    const data=await buildDemoData(today);await validateBackupData(data,'demo');
    return await db.runTransaction([...STORE_NAMES],'readwrite',tx=>{
      tx.request(tx.store('appMeta').get('app'),meta=>{
        if(meta?.demoSeedVersion){tx.result({created:false});return;}
        let left=STORE_NAMES.length-1;
        for(const name of STORE_NAMES.filter(s=>s!=='appMeta'))tx.request(tx.store(name).count(),count=>{
          if(count)throw new DatabaseError('DEMO_EXISTS','Há dados na demonstração sem identificação de carga. Exporte uma cópia e limpe a demonstração explicitamente antes de recriar.');
          if(--left)return;
          for(const name of STORE_NAMES)for(const row of data[name])tx.request(tx.store(name).put(name==='appMeta'&&meta?.restoreEpoch?{...row,restoreEpoch:meta.restoreEpoch}:row),()=>{});
          tx.result({created:true});
        });
      });
    });
  }finally{db.close();}
}
export async function clearDemo({confirmed=false, db=createDatabase({name:DEMO_DB_NAME})}={}) {
  if(!confirmed||db.name!==DEMO_DB_NAME&&!db.name.startsWith('imobigest-test-'))throw new ValidationError('Confirme a limpeza exclusiva da demonstração.');
  try{return await db.runTransaction([...STORE_NAMES],'readwrite',tx=>{
    for(const store of STORE_NAMES)tx.request(tx.store(store).clear(),()=>{});
    tx.request(tx.store('appMeta').put({id:'app',schemaVersion:DB_VERSION,appVersion:APP_VERSION,datasetKind:'demo',demoMode:true,restoreEpoch:createId()}),()=>tx.result(true));
  });}finally{db.close();}
}
export function reloadDataset(demo) {
  if(demo)sessionStorage.setItem(DATASET_SWITCH_KEY,DEMO_DB_NAME);else sessionStorage.removeItem(DATASET_SWITCH_KEY);
  database.close();window.location.hash='/configuracoes';window.location.reload();
}
