/**
 * Skinport bulk price fetcher.
 * Single request returns all CS2 items with min_price and quantity.
 * Uses Steam market_hash_name — maps directly to our skin names.
 */

export interface SkinportPriceEntry {
  priceCents: number;
  listings: number;
}

interface SkinportItem {
  market_hash_name: string;
  currency: string;
  min_price: number | null;
  quantity: number;
}

export async function fetchAllPricesSkinport(
  onProgress?: (p: { done: number; total: number; itemsFetched: number; phase?: string }) => void
): Promise<Map<string, SkinportPriceEntry>> {
  const url = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';
  console.log('Fetching bulk prices from Skinport API…');
  onProgress?.({ done: 0, total: 1, itemsFetched: 0, phase: 'Skinport' });

  const res = await fetch(url, {
    headers: {
      'Accept-Encoding': 'br',
      'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)',
    },
  });
  if (!res.ok) throw new Error(`Skinport API failed: ${res.status} ${res.statusText}`);

  const items = await res.json() as SkinportItem[];
  if (!Array.isArray(items)) throw new Error('Unexpected Skinport response format');

  const out = new Map<string, SkinportPriceEntry>();
  let skipped = 0;

  for (const item of items) {
    if (!item.market_hash_name) continue;
    if (!item.min_price || item.quantity === 0) { skipped++; continue; }
    const priceCents = Math.round(item.min_price * 100);
    if (priceCents > 0) {
      out.set(item.market_hash_name, { priceCents, listings: item.quantity });
    }
  }

  console.log(`Skinport: ${out.size} items with active listings (skipped ${skipped} out-of-stock)`);
  onProgress?.({ done: 1, total: 1, itemsFetched: out.size, phase: 'Skinport' });
  return out;
}
