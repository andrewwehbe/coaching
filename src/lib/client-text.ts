const QUOTE_MAX = 160;

/**
 * A client's own words, quoted for an alert message, or null when there
 * is nothing worth reading. Skip reasons are a required field, so clients
 * often type "." just to get past it; those carry no words and get no
 * quote. Pure so tests can import it.
 */
export function quoteClientText(text: string | null | undefined): string | null {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  const cut = t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1).trimEnd()}…` : t;
  return `“${cut}”`;
}
