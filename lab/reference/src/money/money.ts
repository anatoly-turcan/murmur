export const CURRENCIES: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  SEK: 2,
  PLN: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
};

export const AMOUNT_RE = /^[0-9]{1,15}(\.[0-9]{1,6})?$/;

export interface Money {
  currency: string;
  amount: string;
  amount_minor: string;
}

export function isCurrency(code: string): boolean {
  return Object.hasOwn(CURRENCIES, code);
}

export function decimalsOf(currency: string): number {
  return CURRENCIES[currency] ?? 2;
}

export function fractionDigits(amount: string): number {
  const dot = amount.indexOf('.');

  return dot === -1 ? 0 : amount.length - dot - 1;
}

export function parseMinor(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');

  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export function formatMinor(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const body = decimals === 0 ? whole : `${whole}.${digits.slice(digits.length - decimals)}`;

  return negative ? `-${body}` : body;
}

export function money(currency: string, minor: bigint): Money {
  return { currency, amount: formatMinor(minor, decimalsOf(currency)), amount_minor: minor.toString() };
}

export function meanHalfAwayFromZero(total: bigint, count: bigint): bigint {
  if (count === 0n) return 0n;
  const negative = total < 0n !== count < 0n;
  const [t, c] = [total < 0n ? -total : total, count < 0n ? -count : count];
  const rounded = (2n * t + c) / (2n * c);

  return negative ? -rounded : rounded;
}
