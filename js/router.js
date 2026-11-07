// Rotas hash funcionam com um servidor estático e preservam voltar/avançar.
export function createRouter({ routes, outlet, onNavigate }) {
  let disposeScreen;
  let canLeave;
  let activeHash;
  let deciding = false;

  async function render() {
    if (window.location.hash === '#main-content') {
      outlet.focus();
      return;
    }
    if (deciding) return;
    if (canLeave) {
      deciding = true;
      let accepted;
      try { accepted = await canLeave(); } finally { deciding = false; }
      if (!accepted) {
        history.replaceState(null, '', activeHash);
        return;
      }
    }
    const path = window.location.hash.slice(1) || '/dashboard';
    const route = routes.find((item) => item.match ? item.match(path) : item.path === path);
    const params = route?.match?.(path);
    disposeScreen?.();
    disposeScreen = undefined;
    outlet.replaceChildren();
    const result = route ? route.render(params) : onNavigate.notFound();
    outlet.append(result.element || result);
    disposeScreen = result.dispose;
    canLeave = result.canLeave;
    activeHash = window.location.hash || '#/dashboard';
    document.title = `${route?.label || 'Página não encontrada'} | ImobiGest`;
    onNavigate.update(route);
    outlet.querySelector('h1')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function start() {
    if (!window.location.hash) history.replaceState(null, '', '#/dashboard');
    window.addEventListener('hashchange', render);
    render();
  }

  return {
    start,
    destroy() { window.removeEventListener('hashchange', render); disposeScreen?.(); },
  };
}
