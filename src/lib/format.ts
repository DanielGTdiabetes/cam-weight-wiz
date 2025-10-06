export function formatWeight(
  grams: number | null | undefined,
  decimals: 0 | 1,
  locale = 'es-ES'
): string {
  if (grams == null || !Number.isFinite(grams as number)) {
    return '–';
  }

  const n = Number(grams);
  const displayValue = decimals === 0 && Math.abs(n) < 0.5 ? 0 : n;

  const opts: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  };

  return new Intl.NumberFormat(locale, opts).format(displayValue / 1);
}
