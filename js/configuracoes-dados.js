import { database, DEMO_DB_NAME } from './db.js';
import { exportBackup, prepareBackup, restoreBackup, readBackupSnapshot, snapshotStamp, BACKUP_MAX_BYTES } from './backup.js';
import { ensureDemo, clearDemo, reloadDataset } from './demo.js';
import { el, panel, confirmAction } from './ui.js';

const labels={properties:'Imóveis',transactions:'Lançamentos',leases:'Contratos',bookings:'Reservas',photos:'Fotos',appMeta:'Metadados'};
const size=bytes=>`${(bytes/1024/1024).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})} MiB (${bytes.toLocaleString('pt-BR')} bytes)`;
function download(blob,name){const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function createDataSettings() {
  let alive=true,busy=false,prepared,expectedStamp,exportedStamp,hasData=false;
  const demo=database.name===DEMO_DB_NAME;
  const root=el('div','data-settings');const backup=panel('Backup e recuperação local',`Base em uso: ${demo?'Modo demonstração':'Dados reais'}.`);
  backup.append(el('p','info-notice','Os dados podem desaparecer ao limpar dados do navegador, usar modo privado ou trocar de dispositivo/perfil/endereço. Guarde backups fora do navegador. O JSON inclui fotos e dados pessoais, sem senha ou criptografia. Não compartilhe publicamente.'));
  const controls=el('fieldset','data-controls');controls.append(el('legend','sr-only','Backup e restauração'));
  const exportButton=el('button','button button-primary','Exportar backup completo');exportButton.type='button';exportButton.id='export-backup';
  const exportInfo=el('p','field-hint','Exporta todas as seis coleções e os conteúdos das fotos/miniaturas. Limite: 100 MiB por arquivo JSON.');exportInfo.setAttribute('role','status');
  const input=el('input');input.type='file';input.accept='.json,application/json';input.id='backup-file';
  const inputLabel=el('label','','Selecionar backup JSON para validar');inputLabel.htmlFor=input.id;
  const preview=el('div','backup-preview');preview.id='backup-preview';preview.setAttribute('aria-live','polite');
  const preserved=el('input');preserved.type='checkbox';preserved.id='backup-preserved';
  const preservedLabel=el('label','backup-preserved');preservedLabel.htmlFor=preserved.id;preservedLabel.append(preserved,el('span','','Salvei o backup atual fora do navegador e conferi o arquivo baixado.'));
  const restore=el('button','button button-secondary','Substituir base pelo backup validado');restore.type='button';restore.id='restore-backup';restore.disabled=true;
  const reason=el('p','field-hint','Selecione um arquivo para conferir conteúdo, origem e tamanho antes de restaurar.');reason.id='restore-help';restore.setAttribute('aria-describedby',reason.id);
  const status=el('p','data-status');status.setAttribute('role','status');const error=el('p','dashboard-error');error.setAttribute('role','alert');
  controls.append(exportButton,exportInfo,inputLabel,input,preview,preservedLabel,restore,reason);backup.append(controls,status,error);
  backup.append(el('p','field-hint','A restauração substitui integralmente os seis conjuntos da base indicada. Se JSON, validação, conflito ou gravação falhar, os dados anteriores permanecem; não há restauração parcial. Falta de quota aborta a operação inteira. Feche outras abas antes de restaurar.'));
  const demoPanel=panel('Demonstração isolada','Cinco imóveis fictícios, contratos, reservas, lançamentos e ilustrações locais.');
  demoPanel.append(el('p','field-hint','A demonstração usa outro banco. Ativar novamente reutiliza seus dados, sem duplicar. Trocar de base recarrega a aplicação; a próxima atualização/abertura normal retorna aos dados reais. Limpar demonstração apaga somente esse banco.'));
  const demoControls=el('fieldset','data-controls');demoControls.append(el('legend','sr-only','Demonstração'));
  const activate=el('button','button button-primary',demo?'Voltar aos dados reais':'Ativar demonstração');activate.type='button';activate.id='activate-demo';
  const clear=el('button','button button-secondary','Limpar demonstração');clear.type='button';clear.id='clear-demo';demoControls.append(activate,clear);demoPanel.append(demoControls);
  root.append(backup,demoPanel);
  function eligibility(){restore.disabled=!prepared || busy || (hasData && (exportedStamp!==expectedStamp || !preserved.checked));preservedLabel.hidden=!hasData;reason.textContent=!prepared?'Selecione um arquivo válido.':hasData?'Antes de substituir, exporte a base atual e confirme que salvou o arquivo. A confirmação final informa o que será apagado.':'Base sem registros de negócio. A confirmação final ainda é obrigatória.';}
  function setBusy(value){busy=value;controls.disabled=demoControls.disabled=value;eligibility();}
  async function run(work){if(busy)return;setBusy(true);error.textContent='';try{await work();}catch(e){if(alive){error.textContent=e.message;status.textContent='Operação não concluída. Confira a mensagem acima.';}}finally{if(alive)setBusy(false);}}
  exportButton.addEventListener('click',()=>run(async()=>{
    status.textContent='Preparando backup completo…';const result=await exportBackup();if(!alive)return;
    download(result.blob,`ImobiGest-backup-${result.datasetKind}-${result.exportedAt.replaceAll(':','-')}.json`);
    exportedStamp=result.stamp;expectedStamp=result.stamp;hasData=Object.entries(result.counts).some(([key,count])=>key!=='appMeta'&&count>0);preserved.checked=false;
    exportInfo.textContent=`Backup ${demo?'de demonstração':'real'}: ${size(result.blob.size)}. ${Object.entries(result.counts).map(([key,n])=>`${labels[key]}: ${n}`).join(' · ')}. Download solicitado; confira o arquivo na pasta de downloads.`;status.textContent='Backup preparado. A cópia só estará protegida quando o arquivo estiver salvo fora do navegador.';
  }));
  input.addEventListener('change',()=>run(async()=>{
    prepared=undefined;preview.replaceChildren();preserved.checked=false;const file=input.files?.[0];if(!file){eligibility();return;}
    if(!file.size||file.size>BACKUP_MAX_BYTES)throw new Error('Selecione um arquivo JSON com conteúdo e até 100 MiB.');
    status.textContent='Validando estrutura, vínculos e imagens; nenhum dado está sendo substituído…';
    const candidate=await prepareBackup(await file.text());if(!alive)return;
    if(candidate.datasetKind!==(demo?'demo':'real'))throw new Error('Este arquivo pertence a outra base. Backups reais e de demonstração não podem ser misturados.');
    const current=await readBackupSnapshot();expectedStamp=snapshotStamp(current);hasData=Object.entries(current).some(([key,rows])=>key!=='appMeta'&&rows.length>0);
    preview.append(el('h3','','Backup validado'),el('p','',`${file.name} · ${size(candidate.bytes)} · Origem: ${candidate.datasetKind==='demo'?'Demonstração':'Real'} · Exportado em ${candidate.exportedAt}`));
    const counts=el('dl','settings-facts');for(const [key,n] of Object.entries(candidate.counts)){const row=el('div');row.append(el('dt','',labels[key]),el('dd','',String(n)));counts.append(row);}preview.append(counts);
    let quota='Estimativa de espaço indisponível.';try{const estimate=await navigator.storage?.estimate();if(estimate?.quota)quota=`Espaço estimado na origem: ${size(Math.max(0,estimate.quota-(estimate.usage||0)))} livres.`;}catch{/* informação complementar */}
    preview.append(el('p','field-hint',`${quota} O JSON usa Base64 e pode ser maior que os Blobs. Fotos e a transação de substituição precisam de espaço adicional; a estimativa não garante sucesso. Uma falha de quota preserva a base atual.`));
    prepared=candidate;status.textContent='Validação concluída. Nenhuma alteração no banco até a confirmação final.';
  }));
  preserved.addEventListener('change',eligibility);
  restore.addEventListener('click',()=>run(async()=>{
    if(!prepared||hasData&&(exportedStamp!==expectedStamp||!preserved.checked))return;
    const confirmed=await confirmAction({title:`Substituir todos os ${demo?'dados de demonstração':'dados reais'}?`,description:`Todos os imóveis, lançamentos, contratos, reservas, fotos e metadados desta base serão substituídos pelos ${prepared.counts.properties} imóveis e demais registros do arquivo validado. Não é uma mesclagem. A outra base permanece intacta. Se a transação falhar, a base anterior será mantida.`,confirmLabel:'Substituir toda esta base'});
    if(!confirmed||!alive)return;
    status.textContent='Restaurando em uma transação única…';await restoreBackup(prepared,database,{confirmed:true,expectedStamp});
    prepared=undefined;status.textContent='Restauração concluída. Recarregando a base restaurada…';setBusy(false);reloadDataset(demo);
  }));
  activate.addEventListener('click',()=>run(async()=>{if(!demo){status.textContent='Preparando demonstração isolada…';await ensureDemo();}if(alive){setBusy(false);reloadDataset(!demo);}}));
  clear.addEventListener('click',()=>run(async()=>{
    const confirmed=await confirmAction({title:'Limpar somente a demonstração?',description:'Todos os cadastros, alterações e fotos do banco de demonstração serão apagados. Dados reais não serão alterados. Para guardar alterações da demo, cancele, ative a demonstração e exporte seu backup antes.',confirmLabel:'Limpar demonstração'});
    if(!confirmed||!alive)return;await clearDemo({confirmed:true});if(demo){setBusy(false);reloadDataset(false);}else status.textContent='Demonstração limpa. Os dados reais foram preservados.';
  }));
  const beforeUnload=event=>{if(busy){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  return {element:root,canLeave(){if(busy){error.textContent='Aguarde a operação de dados terminar antes de navegar.';return false;}return true;},dispose(){alive=false;prepared=undefined;window.removeEventListener('beforeunload',beforeUnload);}};
}
