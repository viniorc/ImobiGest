import { formatBRL } from './utils.js';
import { el, emptyState } from './ui.js';

const namespace = 'http://www.w3.org/2000/svg';
const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
let chartSequence = 0;
export const chartMonthLabel = (period) => `${months[Number(period.slice(5)) - 1]}/${period.slice(0, 4)}`;
function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text; return node;
}
function chartShell(title, description, key) {
  const root = el('section', 'panel dashboard-chart'); root.dataset.chart = key;
  const heading = el('div', 'dashboard-chart-heading'); heading.append(el('h2', '', title), el('p', 'field-hint', description)); root.append(heading); return root;
}
function tableDisclosure(headers, rows) {
  const details = el('details', 'chart-data'); details.append(el('summary', '', 'Ver valores em tabela'));
  const table = el('table', 'chart-table'); const caption = el('caption', 'sr-only', 'Valores exatos do gráfico, em reais'); const head = el('thead'); const header = el('tr');
  for (const name of headers) { const th = el('th', '', name); th.scope = 'col'; header.append(th); } head.append(header);
  const body = el('tbody');
  for (const cells of rows) { const row = el('tr'); cells.forEach((text, index) => { const cell = el(index ? 'td' : 'th', '', text); if (!index) cell.scope = 'row'; row.append(cell); }); body.append(row); }
  table.append(caption, head, body); details.append(table); return details;
}
function legend(items) {
  const root = el('div', 'chart-legend');
  for (const [text, tone] of items) { const item = el('span'); const mark = el('i', `chart-key chart-${tone}`); mark.setAttribute('aria-hidden', 'true'); item.append(mark, document.createTextNode(text)); root.append(item); } return root;
}
function tickText(centavos) {
  // Aproximação apenas para escala visual; valores exatos permanecem em centavos na tabela.
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: Math.abs(centavos) < 100000 ? 2 : 1 }).format(centavos / 100);
}

export function createMonthlyChart({ title, description, rows, kind = 'comparison' }) {
  const root = chartShell(title, description, kind); const id = `chart-${++chartSequence}`;
  const active = rows.some((row) => row.totals.receitaRealizada || row.totals.despesaRealizada);
  if (!active) {
    root.append(emptyState({ title: 'Nenhuma liquidação neste período', description: 'Recebimentos e pagamentos confirmados formarão este gráfico. Pendências não entram no realizado.', iconName: 'report' }));
    return { element: root, dispose() {} };
  }
  root.append(legend(kind === 'comparison' ? [['Receitas recebidas', 'revenue'], ['Despesas pagas', 'expense']] : [['Resultado de cada mês', 'result']]));
  const host = el('div', 'chart-plot'); root.append(host);
  const tableRows = rows.map((row) => kind === 'comparison' ? [chartMonthLabel(row.key), formatBRL(row.totals.receitaRealizada), formatBRL(row.totals.despesaRealizada)] : [chartMonthLabel(row.key), formatBRL(row.totals.resultadoRealizado)]);
  root.append(el('p', 'chart-axis-note', 'Eixo vertical em R$ (escala abreviada); eixo horizontal por mês. Valores exatos na tabela.'), tableDisclosure(kind === 'comparison' ? ['Mês', 'Receitas', 'Despesas'] : ['Mês', 'Resultado'], tableRows));
  function draw() {
    const width = Math.max(240, Math.round(host.getBoundingClientRect().width || 520)); const height = 280;
    const margin = { left: 64, right: 14, top: 18, bottom: 45 }; const plotWidth = width - margin.left - margin.right; const plotHeight = height - margin.top - margin.bottom;
    const values = rows.flatMap((row) => kind === 'comparison' ? [row.totals.receitaRealizada, row.totals.despesaRealizada] : [row.totals.resultadoRealizado]);
    const extent = values.reduce((max, value) => Math.max(max, Math.abs(value)), 100);
    const negative = kind !== 'comparison' && values.some((value) => value < 0); const positive = values.some((value) => value > 0);
    const low = negative ? -extent : 0; const high = !negative || positive ? extent : 0;
    const y = (value) => margin.top + (high - value) / (high - low) * plotHeight;
    const step = plotWidth / rows.length; const x = (index) => margin.left + step * (index + .5);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': `${id}-title ${id}-description`, class: 'monthly-svg' });
    svg.append(svgNode('title', { id: `${id}-title` }, title), svgNode('desc', { id: `${id}-description` }, `${description} ${rows.length} mês(es). ${kind === 'comparison' ? 'Barras de receitas e despesas liquidadas.' : 'Linha do resultado mensal, sem acumulação.'} Consulte a tabela para todos os valores.`));
    for (let index = 0; index <= 4; index++) {
      const value = high + (low - high) * (index / 4); const py = y(value);
      svg.append(svgNode('line', { x1: margin.left, x2: width - margin.right, y1: py, y2: py, class: 'chart-gridline' }), svgNode('text', { x: margin.left - 8, y: py + 4, 'text-anchor': 'end', class: 'chart-tick' }, tickText(value)));
    }
    svg.append(svgNode('line', { x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), class: 'chart-baseline' }));
    const maxLabels = Math.max(1, Math.floor(plotWidth / 76));
    const tickCount = Math.min(rows.length, maxLabels);
    const ticks = new Set(Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? Math.floor((rows.length - 1) / 2) : Math.round(index * (rows.length - 1) / (tickCount - 1))));
    for (const index of ticks) svg.append(svgNode('text', { x: x(index), y: height - 15, 'text-anchor': 'middle', class: 'chart-tick' }, chartMonthLabel(rows[index].key)));
    if (kind === 'comparison') {
      const barWidth = Math.min(20, step * .3);
      rows.forEach((row, index) => {
        for (const [key, tone, label, offset] of [['receitaRealizada', 'revenue', 'Receitas', -barWidth], ['despesaRealizada', 'expense', 'Despesas', 0]]) {
          const value = row.totals[key]; if (!value) continue;
          const rect = svgNode('rect', { x: x(index) + offset, y: y(value), width: barWidth, height: Math.max(0, y(0) - y(value)), rx: Math.min(3, barWidth / 3), class: `chart-${tone}` }); rect.append(svgNode('title', {}, `${chartMonthLabel(row.key)} · ${label}: ${formatBRL(value)}`)); svg.append(rect);
        }
      });
    } else {
      svg.append(svgNode('polyline', { points: rows.map((row, index) => `${x(index)},${y(row.totals.resultadoRealizado)}`).join(' '), class: 'chart-result-line' }));
      rows.forEach((row, index) => { const point = svgNode('circle', { cx: x(index), cy: y(row.totals.resultadoRealizado), r: 3, class: 'chart-result' }); point.append(svgNode('title', {}, `${chartMonthLabel(row.key)}: ${formatBRL(row.totals.resultadoRealizado)}`)); svg.append(point); });
    }
    host.replaceChildren(svg);
  }
  draw(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (observer) observer.observe(host); else window.addEventListener('resize', draw);
  return { element: root, dispose() { observer?.disconnect(); if (!observer) window.removeEventListener('resize', draw); } };
}

export function createCategoryChart({ title, description, rows, tone = 'revenue', key }) {
  const root = chartShell(title, description, key); const data = rows.filter((row) => row.value > 0);
  if (!data.length) { root.append(emptyState({ title: 'Sem valores realizados neste recorte', description: 'Somente lançamentos liquidados entram neste gráfico.', iconName: 'report' })); return root; }
  const maximum = data.reduce((max, row) => Math.max(max, row.value), 1); const list = el('div', 'category-bars');
  for (const row of data.slice(0, 8)) {
    const item = el('div', 'category-bar'); const caption = el('div', 'category-bar-caption'); caption.append(el('span', '', row.label), el('strong', '', formatBRL(row.value)));
    const svg = svgNode('svg', { viewBox: '0 0 100 10', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'category-bar-svg' }); svg.append(svgNode('rect', { x: 0, y: 0, width: 100, height: 10, rx: 1, class: 'chart-track' }), svgNode('rect', { x: 0, y: 0, width: row.value / maximum * 100, height: 10, rx: 1, class: `chart-${tone}` })); item.append(caption, svg); list.append(item);
  }
  root.append(legend([[tone === 'expense' ? 'Despesas pagas' : 'Receitas recebidas', tone]]), list, el('p', 'chart-axis-note', `Escala de R$ 0,00 a ${formatBRL(maximum)}. ${data.length > 8 ? `Exibindo as 8 maiores de ${data.length}; tabela com todas abaixo.` : 'Todos os grupos do recorte estão representados.'}`), tableDisclosure(['Grupo', 'Valor realizado'], data.map((row) => [row.label, formatBRL(row.value)])));
  return root;
}
