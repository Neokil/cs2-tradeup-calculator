/**
 * CSFloat per-phase Doppler price fetcher.
 *
 * Uses the authenticated CSFloat listings API to fetch the cheapest buy-now
 * price for each specific Doppler phase (Ruby, Sapphire, Black Pearl, Phase 1-4,
 * Emerald, etc.) identified by their unique paint_index.
 *
 * Requires: CSFLOAT_API_KEY env variable.
 * Rate limit: ~1 request/second to stay safe.
 */

import { config } from '../config.js';

export interface DopplerPriceEntry {
  priceCents: number;
  listings: number;
  floatValue?: number;
}

interface CSFloatListing {
  price: number;        // cents
  item?: {
    float_value?: number;
    def_index?: number;
    paint_index?: number;
  };
}

interface CSFloatListingsResponse {
  data?: CSFloatListing[];
  cursor?: string;
}

/**
 * Fetch cheapest buy-now price for a specific def_index + paint_index combo.
 * Returns null if no listings found or API unavailable.
 */
async function fetchPhasePrice(
  defIndex: number,
  paintIndex: number,
): Promise<DopplerPriceEntry | null> {
  const url = new URL('https://csfloat.com/api/v1/listings');
  url.searchParams.set('def_index', String(defIndex));
  url.searchParams.set('paint_index', String(paintIndex));
  url.searchParams.set('sort_by', 'lowest_price');
  url.searchParams.set('type', 'buy_now');
  url.searchParams.set('limit', '5');

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': config.csfloatApiKey,
      'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)',
    },
  });

  if (res.status === 429) throw new Error('CSFloat rate limited');
  if (!res.ok) return null;

  const json = await res.json() as CSFloatListingsResponse;
  const listings = json.data ?? [];
  if (!listings.length) return null;

  return {
    priceCents: listings[0].price,
    listings: listings.length,
    floatValue: listings[0].item?.float_value,
  };
}

/**
 * Fetch prices for all Doppler phase skins from the DB.
 * Groups by (defIndex, paintIndex) and fetches one price per unique pair.
 *
 * @param dopplerSkins  Array of skins with isDoppler=true and defIndex+paintIndex set
 * @param onProgress    Optional progress callback
 * @returns Map of "defIndex:paintIndex" → DopplerPriceEntry
 */
export async function fetchDopplerPhasePrices(
  dopplerSkins: Array<{ defIndex: number; paintIndex: number; name: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, DopplerPriceEntry>> {
  if (!config.csfloatApiKey) {
    console.log('No CSFLOAT_API_KEY — skipping per-phase Doppler prices');
    return new Map();
  }

  // Deduplicate by defIndex:paintIndex
  const unique = new Map<string, { defIndex: number; paintIndex: number; name: string }>();
  for (const s of dopplerSkins) {
    if (s.defIndex != null && s.paintIndex != null) {
      const key = `${s.defIndex}:${s.paintIndex}`;
      if (!unique.has(key)) unique.set(key, s);
    }
  }

  console.log(`Fetching CSFloat prices for ${unique.size} Doppler phase variants…`);
  const results = new Map<string, DopplerPriceEntry>();
  let done = 0;
  const total = unique.size;

  for (const [key, { defIndex, paintIndex, name }] of unique) {
    onProgress?.(done, total);
    try {
      const entry = await fetchPhasePrice(defIndex, paintIndex);
      if (entry) {
        results.set(key, entry);
        console.log(`  ${name} (${paintIndex}): $${(entry.priceCents / 100).toFixed(2)} [${entry.listings} listings]`);
      }
    } catch (e: any) {
      if (e.message?.includes('rate limited')) {
        console.log('  Rate limited — waiting 10s…');
        await new Promise(r => setTimeout(r, 10_000));
        // Retry once
        try {
          const entry = await fetchPhasePrice(defIndex, paintIndex);
          if (entry) results.set(key, entry);
        } catch { /* skip */ }
      }
    }
    done++;
    // 700ms between requests to stay within rate limits
    if (done < total) await new Promise(r => setTimeout(r, 700));
  }

  onProgress?.(total, total);
  console.log(`Doppler phases: fetched prices for ${results.size}/${total} variants`);
  return results;
}
