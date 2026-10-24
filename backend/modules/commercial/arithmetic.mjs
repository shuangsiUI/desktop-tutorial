// Exact decimal rational arithmetic avoids accidental extra billing steps such as 0.14 / 0.01.
const gcd = (a, b) => {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
};
const reduce = (n, d) => {
  if (d <= 0n) throw Error('计费除数无效');
  const g = gcd(n < 0n ? -n : n, d);
  return { n: n / g, d: d / g };
};
export function decimal(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw Error('计费数值无效');
  const [mantissa, exp = '0'] = String(value).split('e'),
    parts = mantissa.split('.'),
    digits = parts.join(''),
    power = Number(exp) - (parts[1]?.length || 0);
  return reduce(
    BigInt(digits) * (power > 0 ? 10n ** BigInt(power) : 1n),
    power < 0 ? 10n ** BigInt(-power) : 1n
  );
}
export const add = (a, b) => reduce(a.n * b.d + b.n * a.d, a.d * b.d);
export const multiply = (a, b) => reduce(a.n * b.n, a.d * b.d);
export const divide = (a, b) => reduce(a.n * b.d, a.d * b.n);
export const maximum = (a, b) => (a.n * b.d >= b.n * a.d ? a : b);
export const ceiling = (a) => (a.n + a.d - 1n) / a.d;
export const round = (a) => (2n * a.n + a.d) / (2n * a.d);
export const numeric = (a) => Number(a.n) / Number(a.d);
export function settlementDueDate(iso, settlement) {
  const date = new Date(iso + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    throw Error('账单日期无效');
  if (settlement === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  if (settlement === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
  }
  return date.toISOString().slice(0, 10);
}
