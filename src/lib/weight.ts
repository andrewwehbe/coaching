/**
 * Toggle the sign of a weight-input string.
 *
 * Counterweighted machines (pendulum squat, assisted dip/pull-up) carry a
 * negative load, but the mobile decimal keypad has no minus key — the ±
 * button next to each weight field calls this to flip the sign.
 *
 *   ''    -> '-'   (start a negative, user then types digits)
 *   '-'   -> ''    (toggle back off)
 *   '30'  -> '-30'
 *   '-30' -> '30'
 */
export function toggleWeightSign(v: string): string {
  const t = v.trim();
  if (t === '') return '-';
  if (t === '-') return '';
  return t.startsWith('-') ? t.slice(1) : `-${t}`;
}
