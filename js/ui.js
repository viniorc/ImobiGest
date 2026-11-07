// Componentes de interface: conteúdo textual sempre passa por textContent.
const svgNamespace = 'http://www.w3.org/2000/svg';
const iconPaths = {
  dashboard: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  building: ['M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 7h1M15 7h1M8 11h1M15 11h1M2 21h20'],
  wallet: ['M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7M20 11h-6v6h6M16 14h.01'],
  contract: ['M7 3h10l3 3v15H4V3h3M14 3v5h6M8 12h8M8 16h5'],
  calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 3v4M17 3v4M3 11h18M8 15h2M14 15h2'],
  photo: ['M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 17l5-5 4 4 3-3 6 6M16 7h.01'],
  report: ['M4 3h16v18H4zM8 16v-3M12 16V9M16 16v-5M8 6h8'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  arrow: ['M5 12h14M14 7l5 5-5 5'],
  up: ['M7 17 17 7M7 7h10v10'],
  down: ['M7 7l10 10M7 17h10V7'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2'],
  check: ['M5 12l4 4L19 6'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7h.01'],
  plus: ['M12 5v14M5 12h14'],
};

export function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name, className = '') {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const path of iconPaths[name] || iconPaths.info) {
    const element = document.createElementNS(svgNamespace, 'path');
    element.setAttribute('d', path);
    svg.append(element);
  }
  return svg;
}

export function link(text, href, className = 'text-link') {
  const anchor = el('a', className, text);
  anchor.href = href;
  return anchor;
}

export function createScreen({ title, description, eyebrow = 'ESPAÇO DE TRABALHO', badge }) {
  const screen = el('div', 'screen');
  const heading = el('div', 'page-heading');
  const copy = el('div');
  const titleNode = el('h1', '', title);
  titleNode.tabIndex = -1;
  titleNode.id = 'page-title';
  copy.append(el('p', 'eyebrow', eyebrow), titleNode, el('p', 'page-description', description));
  heading.append(copy);
  if (badge) heading.append(el('span', 'status-badge', badge));
  screen.append(heading);
  return screen;
}

export function emptyState({ title, description, iconName = 'building', action }) {
  const state = el('div', 'empty-state');
  const mark = el('span', 'empty-icon');
  mark.append(icon(iconName));
  state.append(mark, el('h3', '', title), el('p', '', description));
  if (action) state.append(action);
  return state;
}

export function panel(title, subtitle, action) {
  const section = el('section', 'panel');
  const header = el('div', 'panel-header');
  const copy = el('div');
  copy.append(el('h2', '', title));
  if (subtitle) copy.append(el('p', '', subtitle));
  header.append(copy);
  if (action) header.append(action);
  section.append(header);
  return section;
}

export function showToast(message, { tone = 'success', duration = 5000 } = {}) {
  const region = document.querySelector('#toast-region');
  const toast = el('div', `toast toast-${tone}`);
  const close = el('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fechar mensagem');
  toast.append(icon(tone === 'success' ? 'check' : 'info'), el('span', '', message), close);
  region.append(toast);
  const timer = window.setTimeout(() => toast.remove(), duration);
  close.addEventListener('click', () => { window.clearTimeout(timer); toast.remove(); });
  return () => { window.clearTimeout(timer); toast.remove(); };
}

// Dialog nativo oferece modal, Escape e contenção de foco sem bibliotecas.
// Somente a escolha afirmativa resolve true; fechar/cancelar resolve false.
let confirmationSequence = 0;
export function confirmAction({ title, description, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = el('dialog', 'confirmation-dialog');
    const prefix = `confirmation-${++confirmationSequence}`;
    dialog.setAttribute('aria-labelledby', `${prefix}-title`);
    dialog.setAttribute('aria-describedby', `${prefix}-description`);
    const heading = el('h2', '', title);
    heading.id = `${prefix}-title`;
    const descriptionNode = el('p', '', description);
    descriptionNode.id = `${prefix}-description`;
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'button button-secondary', cancelLabel);
    const confirm = el('button', 'button button-primary', confirmLabel);
    cancel.type = confirm.type = 'button';
    cancel.autofocus = true;
    cancel.addEventListener('click', () => dialog.close('cancel'));
    confirm.addEventListener('click', () => dialog.close('confirm'));
    actions.append(cancel, confirm);
    dialog.append(heading, descriptionNode, actions);
    dialog.addEventListener('close', () => {
      const result = dialog.returnValue === 'confirm';
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
