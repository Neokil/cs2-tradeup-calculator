/**
 * CSFloat bulk price fetcher.
 * Single GET to https://csfloat.com/api/v1/listings/price-list
 * Returns all CS2 items with min_price (in USD cents) and quantity.
 * Uses Steam market_hash_name — maps directly to our skin names.
 * No authentication required.
 */

export interface CSFloatPriceEntry {
  priceCents: number;
  listings: number;
}

interface CSFloatItem {
  market_hash_name: string;
  min_price: number;   // USD cents
  quantity: number;
}

export async function fetchAllPricesCSFloat(
  onProgress?: (p: { done: number; total: number; itemsFetched: number; phase?: string }) => void
): Promise<Map<string, CSFloatPriceEntry>> {
  const url = 'https://csfloat.com/api/v1/listings/price-list';
  console.log('Fetching bulk prices from CSFloat API…');
  onProgress?.({ done: 0, total: 1, itemsFetched: 0, phase: 'CSFloat' });

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)' },
  });
  if (!res.ok) throw new Error(`CSFloat API failed: ${res.status} ${res.statusText}`);

  const items = await res.json() as CSFloatItem[];
  if (!Array.isArray(items)) throw new Error('Unexpected CSFloat response format');

  const out = new Map<string, CSFloatPriceEntry>();
  let skipped = 0;

  for (const item of items) {
    if (!item.market_hash_name) continue;
    // Skip out-of-stock, sentinel prices, or illiquid items (< 3 listings)
    // CSFloat uses values like 10_000_000 as placeholders for items with no real listing.
    // Items with 1–2 listings have artificial/unreliable prices — not tradeable at scale.
    if (!item.min_price || (item.quantity ?? 0) < 3) { skipped++; continue; }
    if (item.min_price > 1_500_000) { skipped++; continue; } // > $15,000 = likely sentinel
    if (item.min_price > 0) {
      out.set(item.market_hash_name, { priceCents: item.min_price, listings: item.quantity });
    }
  }

  console.log(`CSFloat: ${out.size} items with active listings (skipped ${skipped} out-of-stock)`);
  onProgress?.({ done: 1, total: 1, itemsFetched: out.size, phase: 'CSFloat' });
  return out;
}
