import { el, icon, link, createScreen, emptyState, panel, showToast, confirmAction } from './ui.js';
import { createRouter } from './router.js';
import { database, DEMO_DB_NAME } from './db.js';
import { createDataSettings } from './configuracoes-dados.js';
import { createDiagnosticPanel } from './diagnostico.js';
import { matchPropertyRoute, renderProperties } from './imoveis.js';
import { matchFinancialRoute, renderFinancial } from './financeiro.js';
import { matchLeaseRoute, renderLeases } from './alugueis.js';
import { matchBookingRoute, renderBookings } from './reservas.js';
import { matchGalleryRoute, renderGallery } from './galeria.js';
import { renderDashboard } from './dashboard.js';
import { renderReports } from './relatorios.js';

// A navegação não depende do banco: falhas ficam visíveis sem bloquear a interface.
const storageReady = database.open().then((schema) => ({ schema })).catch((error) => {
  showToast(error.message, { tone: 'error', duration: 10000 });
  return { error };
});

const shell = document.querySelector('#app-shell');
const sidebar = document.querySelector('#sidebar');
const workspace = document.querySelector('#workspace');
const menuButton = document.querySelector('#open-menu');
const closeButton = document.querySelector('#close-menu');
const backdrop = document.querySelector('#menu-backdrop');
const collapseButton = document.querySelector('#collapse-menu');
const mobileQuery = window.matchMedia('(max-width: 900px)');
const demoMode = database.name === DEMO_DB_NAME;
document.body.dataset.dataset = demoMode ? 'demo' : 'real';
if (demoMode) {
  const banner = el('div', 'dataset-banner', 'Modo demonstração · dados fictícios em banco separado. Volte aos dados reais em Configurações. Recarregar a página retorna à base real.');
  banner.id = 'dataset-banner'; banner.setAttribute('role', 'status');
  document.querySelector('#main-content').before(banner);
  document.querySelector('.local-badge').textContent = 'Modo demonstração';
}
let collapsed = false;
let menuOpen = false;

function setMenuOpen(open, restoreFocus = false) {
  menuOpen = open && mobileQuery.matches;
  shell.classList.toggle('menu-open', menuOpen);
  backdrop.hidden = !menuOpen;
  menuButton.setAttribute('aria-expanded', String(menuOpen));
  document.body.classList.toggle('menu-is-open', menuOpen);
  sidebar.inert = mobileQuery.matches && !menuOpen;
  workspace.inert = menuOpen;
  if (menuOpen) closeButton.focus();
  else if (restoreFocus) menuButton.focus();
}

function setCollapsed(value) {
  collapsed = value;
  shell.classList.toggle('sidebar-collapsed', collapsed);
  collapseButton.setAttribute('aria-expanded', String(!collapsed));
  collapseButton.setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
  collapseButton.querySelector('.toggle-label').textContent = collapsed ? 'Expandir menu' : 'Recolher menu';
  collapseButton.firstElementChild.textContent = collapsed ? '»' : '«';
}

menuButton.addEventListener('click', () => setMenuOpen(true));
closeButton.addEventListener('click', () => setMenuOpen(false, true));
backdrop.addEventListener('click', () => setMenuOpen(false, true));
collapseButton.addEventListener('click', () => setCollapsed(!collapsed));
mobileQuery.addEventListener('change', () => setMenuOpen(false));
document.addEventListener('keydown', (event) => {
  if (!menuOpen || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false, true); }
  if (event.key === 'Tab') {
    const focusable = [...sidebar.querySelectorAll('a[href], button:not([disabled])')]
      .filter((node) => node.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

const modules = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', render: renderDashboard },
  { path: '/imoveis', label: 'Meus Imóveis', icon: 'building', match: matchPropertyRoute, render: renderProperties },
  { path: '/financeiro', label: 'Financeiro', icon: 'wallet', match: matchFinancialRoute, render: renderFinancial },
  { path: '/alugueis', label: 'Aluguéis', icon: 'contract', match: matchLeaseRoute, render: renderLeases },
  { path: '/reservas', label: 'Reservas', icon: 'calendar', match: matchBookingRoute, render: renderBookings },
  { path: '/fotos', label: 'Fotos', icon: 'photo', match: matchGalleryRoute, render: renderGallery },
  { path: '/relatorios', label: 'Relatórios', icon: 'report', render: renderReports },
  { path: '/configuracoes', label: 'Configurações', icon: 'settings', render: renderSettings },
];

const navigation = document.querySelector('#main-navigation');
sidebar.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]');
  if (menuOpen && anchor?.getAttribute('href') === window.location.hash) {
    setMenuOpen(false);
    document.querySelector('h1')?.focus({ preventScroll: true });
  }
});
for (const module of modules) {
  if (!module.render) module.render = () => renderFutureModule(module);
  const anchor = link('', `#${module.path}`, 'nav-link');
  anchor.setAttribute('aria-label', module.label);
  anchor.title = module.label;
  anchor.append(icon(module.icon), el('span', 'nav-label', module.label));
  if (module.path === '/configuracoes') anchor.classList.add('nav-settings');
  navigation.append(anchor);
}

function disabledAction(label, descriptionId) {
  const button = el('button', 'button button-primary', label);
  button.type = 'button';
  button.disabled = true;
  button.setAttribute('aria-describedby', descriptionId);
  button.prepend(icon('plus'));
  return button;
}

function renderFutureModule(module) {
  const screen = createScreen({ title: module.title, description: module.description, badge: 'Em desenvolvimento' });
  const section = panel(module.feature, `Disponível a partir da etapa ${module.stage}.`);
  const descriptionId = `future-note-${module.stage}`;
  const description = el('p', 'feature-note', `Em breve · Esta funcionalidade será implementada na etapa ${module.stage}.`);
  description.id = descriptionId;
  section.append(emptyState({ title: `${module.feature} em desenvolvimento`, description: 'A navegação já está pronta. Esta área receberá suas funcionalidades na etapa indicada.', iconName: module.icon }), el('div', 'future-actions'));
  section.lastElementChild.append(disabledAction(module.action, descriptionId), description);
  screen.append(section, link('Voltar ao Dashboard', '#/dashboard', 'button button-secondary back-link'));
  return screen;
}

function renderSettings() {
  const screen = createScreen({ title: 'Configurações', description: 'Informações sobre este espaço e a sua experiência de navegação.' });
  const local = panel('Um espaço local', 'Transparência desde o primeiro acesso.');
  const info = el('div', 'info-notice');
  info.append(icon('info'), el('p', '', 'O armazenamento do ImobiGest é local a este navegador e dispositivo. Limpar os dados do navegador ou trocar de dispositivo pode causar perda de registros. Não há sincronização em nuvem. Exportar e guardar backups é fundamental. O diagnóstico abaixo usa um banco de teste separado.'));
  local.append(info);
  const rows = el('dl', 'settings-facts');
  for (const [title, value] of [['Versão', 'Revisão de integridade · Etapa 11'], ['Idioma e moeda', 'Português do Brasil · Real (BRL)'], ['Armazenamento', 'IndexedDB · Consulte o diagnóstico abaixo'], ['Base atual', demoMode ? 'Modo demonstração · banco separado' : 'Dados reais'], ['Backup', 'Arquivo JSON local com fotos · sem sincronização']]) {
    const row = el('div'); row.append(el('dt', '', title), el('dd', '', value)); rows.append(row);
  }
  local.append(rows);
  const appearance = panel('Visualização', 'Ajustes válidos durante esta sessão.');
  const body = el('div', 'settings-action');
  const copy = el('div');
  copy.append(el('h3', '', 'Restaurar visualização inicial'), el('p', '', 'Expande o menu no desktop e retorna ao Dashboard.'));
  const button = el('button', 'button button-secondary', 'Restaurar visualização');
  button.type = 'button';
  button.addEventListener('click', async () => {
    const confirmed = await confirmAction({ title: 'Restaurar visualização inicial?', description: 'O menu será expandido no desktop e você voltará ao Dashboard.', confirmLabel: 'Restaurar visualização' });
    if (!confirmed) return;
    setCollapsed(false);
    window.location.hash = '/dashboard';
    showToast('Visualização inicial restaurada.');
  });
  body.append(copy, button); appearance.append(body);
  const diagnostic = createDiagnosticPanel({ storageReady });
  const dataSettings = createDataSettings();
  screen.append(local, dataSettings.element, diagnostic.element, appearance);
  return { element: screen, canLeave: dataSettings.canLeave, dispose() { diagnostic.dispose(); dataSettings.dispose(); } };
}

function notFound() {
  const screen = createScreen({ title: 'Página não encontrada', description: 'Este endereço não corresponde a uma seção do ImobiGest.' });
  screen.append(emptyState({ title: 'Vamos voltar ao seu espaço?', description: 'Use o menu ou retorne à visão geral.', iconName: 'info', action: link('Voltar ao Dashboard', '#/dashboard', 'button button-primary') }));
  return screen;
}

const router = createRouter({
  routes: modules,
  outlet: document.querySelector('#main-content'),
  onNavigate: {
    notFound,
    update(route) {
      document.querySelector('#breadcrumb').textContent = route?.label || 'Página não encontrada';
      navigation.querySelectorAll('a').forEach((anchor) => {
        if (anchor.getAttribute('href') === `#${route?.path}`) anchor.setAttribute('aria-current', 'page');
        else anchor.removeAttribute('aria-current');
      });
      setMenuOpen(false);
    },
  },
});

// O link de salto mantém o hash de rota e leva o teclado ao conteúdo.
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  document.querySelector('#main-content').focus();
});
setMenuOpen(false);
setCollapsed(false);
router.start();
