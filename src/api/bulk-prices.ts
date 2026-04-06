/**
 * Bulk price fetcher — dispatches to the chosen price source.
 * Returns Map<marketHashName, PriceEntry> where PriceEntry includes
 * both the price and the number of active sell listings.
 */
import { fetchAllPricesSteam, SteamPriceEntry } from './steam-prices.js';
import { fetchAllPricesCSFloat } from './csfloat-prices.js';

export type PriceSource = 'steam' | 'csfloat';
export type PriceEntry = SteamPriceEntry; // { priceCents: number; listings: number }

export interface FetchPricesOptions {
  source: PriceSource;
  onProgress?: (p: { done: number; total: number; itemsFetched: number; phase?: string }) => void;
}

/** Fetch all CS2 skin prices from the chosen source. Returns Map<marketHashName, PriceEntry>. */
export async function fetchAllPricesBulk(
  opts: FetchPricesOptions = { source: 'csfloat' }
): Promise<Map<string, PriceEntry>> {
  if (opts.source === 'steam') {
    return fetchAllPricesSteam(opts.onProgress as any);
  }
  // default: csfloat
  return fetchAllPricesCSFloat(opts.onProgress);
}
