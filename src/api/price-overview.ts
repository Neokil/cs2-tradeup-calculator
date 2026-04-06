/**
 * Steam Market priceoverview API — returns median sale price and volume for one item.
 *
 * Unlike the bulk search/render endpoint (which gives the LOWEST CURRENT LISTING = ask price),
 * priceoverview gives:
 *   - lowest_price  : current cheapest listing (what buyers pay)
 *   - median_price  : median price of all sales in the last 24 h (what actually traded)
 *   - volume        : number of sales in the last 24 h
 *
 * For trade-up output valuation we use median_price, which represents what you'd
 * realistically receive when selling your output skin.
 */

const OVERVIEW_URL = 'https://steamcommunity.com/market/priceoverview/';

export interface PriceOverview {
  /** Current cheapest listing in cents (ask price — what buyers pay). */
  lowestPriceCents: number | null;
  /**
   * Median sale price in cents over the last ~24 h.
   * Use this for output skin valuation — it reflects what actually trades,
   * not a single inflated listing.
   */
  medianPriceCents: number | null;
  /** Number of sales in the last ~24 h. Low volume = unreliable price. */
  volume: number;
}

/** Parse a Steam formatted price string like "$12.74", "€ 10,99", "1,234.56" → cents. */
function parsePrice(s: string | undefined): number | null {
  if (!s) return null;
  // Strip everything that isn't a digit or decimal separator.
  // Steam uses period as decimal separator for USD (currency=1).
  const cleaned = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100);
}

export async function fetchPriceOverview(
  marketHashName: string,
): Promise<PriceOverview | null> {
  try {
    const url =
      `${OVERVIEW_URL}?country=US&currency=1&appid=730` +
      `&market_hash_name=${encodeURIComponent(marketHashName)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.success) return null;
    const vol = parseInt(String(data.volume ?? '0').replace(/,/g, ''), 10);
    return {
      lowestPriceCents:  parsePrice(data.lowest_price),
      medianPriceCents:  parsePrice(data.median_price),
      volume:            isNaN(vol) ? 0 : vol,
    };
  } catch {
    return null;
  }
}
