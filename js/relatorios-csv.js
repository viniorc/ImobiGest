import { assertCentavos, formatBRL, formatCivilDate } from './utils.js';

// Decimal textual, sem divisão Number/100: preserva até o último centavo seguro.
export function csvMoney(value) {
  const number = BigInt(assertCentavos(value)); const absolute = number < 0n ? -number : number;
  return `${number < 0n ? '-' : ''}${absolute / 100n},${String(absolute % 100n).padStart(2, '0')}`;
}
export function formatReportCell(value, type, csv = false) {
  if (value === null || value === undefined) return type === 'money' || type === 'number' || type === 'percent' ? 'Não aplicável' : '';
  if (type === 'money') return csv ? csvMoney(value) : formatBRL(value);
  if (type === 'date') return formatCivilDate(value);
  if (type === 'percent') return `${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}${csv ? '' : '%'}`;
  if (type === 'number') return String(value);
  return String(value);
}
export function escapeCsv(value, numeric = false) {
  let text = String(value ?? '');
  // Aspas CSV não impedem fórmulas. Prefixar textos iniciados (mesmo após
  // espaços/controles) por operadores ou tab/newline, sem alterar números reais.
  if (!numeric && (/^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function reportCsv(model) {
  // Uma só linha de cabeçalho e mesma quantidade de colunas em todo o arquivo.
  // Seção identifica as tabelas; colunas que não pertencem à seção ficam vazias.
  const headers = [...new Set(model.tables.flatMap(t => t.columns.map(c => c.label)))];
  const contextHeaders = ['Relatório', 'Período inicial', 'Período final', 'Imóvel (filtro)', 'Tipo (filtro)', 'Categoria (filtro)', 'Situação (filtro)', 'Base de datas', 'Hoje para atrasos', 'Seção', 'Nota da seção'];
  const context = [model.title, formatCivilDate(model.period.inicio), formatCivilDate(model.period.fim), model.propertyLabel, model.typeLabel, model.categoryLabel, model.statusLabel, model.basis, formatCivilDate(model.today)];
  const lines = [[...contextHeaders, ...headers].map(v => escapeCsv(v)).join(';')];
  for (const section of model.tables) {
    const lookup = new Map(section.columns.map(c => [c.label, c]));
    for (const row of section.rows.length ? section.rows : [null]) {
      const prefix = [...context, section.title, `${section.note}${row === null ? ' Sem registros neste recorte.' : ''}`].map(v => escapeCsv(v));
      const cells = headers.map(label => {
        const c = lookup.get(label); if (!c || !row) return escapeCsv('');
        const value = row[c.key]; return escapeCsv(formatReportCell(value, c.type, true), typeof value === 'number' && ['money', 'number', 'percent'].includes(c.type));
      });
      lines.push([...prefix, ...cells].join(';'));
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
