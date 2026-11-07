// Utilitários puros: sem DOM, persistência ou regras financeiras de negócio.
export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

export function requireText(value, label = 'Campo', maxLength = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new ValidationError(`${label}: informe um texto de 1 a ${maxLength} caracteres.`);
  }
  return value.trim();
}

export function validateId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new ValidationError('ID inválido: use de 1 a 128 letras, números, pontos, dois-pontos, hífens ou sublinhados, iniciando com letra ou número.');
  }
  return id;
}

export function createId(cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.randomUUID === 'function') return cryptoProvider.randomUUID();
  if (typeof cryptoProvider?.getRandomValues !== 'function') {
    throw new ValidationError('Este navegador não oferece geração segura de IDs. Use um navegador atualizado em HTTP local.');
  }
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertCentavos(value) {
  if (!Number.isSafeInteger(value)) throw new ValidationError('O valor deve ser um inteiro seguro de centavos.');
  return value;
}

function safeBigInt(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError('Valor monetário acima do limite seguro de centavos.');
  }
  return Number(value);
}

// Aceita 1234,56, 1.234,56, R$ 1.234,56, 12 e 12,3. Ponto só agrupa milhares.
export function parseBRL(input, { allowNegative = false } = {}) {
  if (typeof input !== 'string') throw new ValidationError('Informe o valor monetário como texto no formato brasileiro.');
  // Aceita também o sinal antes de R$, como produzido por formatBRL.
  // A permissão de valores negativos continua explícita em allowNegative.
  const text = input.trim().replace(/^(-?)R\$\s*/, '$1');
  const match = /^(-?)(\d+|[1-9]\d{0,2}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(text);
  if (!match || (match[1] && !allowNegative)) {
    throw new ValidationError('Valor inválido. Use, por exemplo, R$ 1.234,56, sem mais de duas casas decimais.');
  }
  const whole = BigInt(match[2].replaceAll('.', ''));
  const fraction = BigInt((match[3] || '').padEnd(2, '0'));
  return safeBigInt((whole * 100n + fraction) * (match[1] ? -1n : 1n));
}

const brlFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function formatBRL(centavos) {
  assertCentavos(centavos);
  const absolute = BigInt(centavos < 0 ? -centavos : centavos);
  const cents = (absolute % 100n).toString().padStart(2, '0');
  // Não dividir Number por 100: nos valores-limite isso pode perder um centavo.
  const formatted = brlFormatter.formatToParts(absolute / 100n)
    .map((part) => part.type === 'fraction' ? cents : part.value).join('');
  return `${centavos < 0 ? '-' : ''}${formatted}`;
}

export function addCentavos(...values) {
  return safeBigInt(values.reduce((sum, value) => sum + BigInt(assertCentavos(value)), 0n));
}

export function subtractCentavos(left, right) {
  return safeBigInt(BigInt(assertCentavos(left)) - BigInt(assertCentavos(right)));
}

export function isLeapYear(year) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }

export function daysInMonth(year, month) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError('Ano ou mês inválido. Use anos de 0001 a 9999 e meses de 01 a 12.');
  }
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function parseCivilDate(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ValidationError('Data inválida. Use YYYY-MM-DD.');
  const [year, month, day] = match.slice(1).map(Number);
  if (day < 1 || day > daysInMonth(year, month)) throw new ValidationError('A data informada não existe no calendário.');
  return { year, month, day };
}

export function isCivilDate(value) {
  try { parseCivilDate(value); return true; } catch { return false; }
}

export function formatCivilDate(value) {
  parseCivilDate(value);
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

export function civilToOrdinal(value) {
  const { year, month, day } = parseCivilDate(value);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / 86400000;
}

export function addCivilDays(value, days) {
  if (!Number.isSafeInteger(days)) throw new ValidationError('A quantidade de dias deve ser um inteiro seguro.');
  const ordinal = civilToOrdinal(value) + days;
  if (ordinal < civilToOrdinal('0001-01-01') || ordinal > civilToOrdinal('9999-12-31')) {
    throw new ValidationError('A data resultante deve ficar entre os anos 0001 e 9999.');
  }
  const date = new Date(ordinal * 86400000);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function daysBetween(start, end) { return civilToOrdinal(end) - civilToOrdinal(start); }

export function calculateNights(start, end) {
  const nights = daysBetween(start, end);
  if (nights <= 0) throw new ValidationError('A saída deve ser posterior à entrada.');
  return nights;
}

export function dueDateForMonth(period, day) {
  const match = typeof period === 'string' && /^(\d{4})-(\d{2})$/.exec(period);
  if (!match || !Number.isInteger(day) || day < 1 || day > 31) {
    throw new ValidationError('Informe a competência YYYY-MM e um dia inteiro entre 1 e 31.');
  }
  const lastDay = daysInMonth(Number(match[1]), Number(match[2]));
  return `${period}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function todayCivil(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new ValidationError('Relógio local inválido.');
  const value = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  parseCivilDate(value);
  return value;
}
