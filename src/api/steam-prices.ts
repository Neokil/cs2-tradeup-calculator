/**
 * Steam Community Market bulk price fetcher.
 *
 * Strategy: filter by condition (Exterior) so we only fetch weapon/knife/glove skins,
 * not the 60k+ cases/stickers/agents that dominate unfiltered searches.
 *
 * Fetches conditions sequentially with a 1.5s delay between pages.
 * No parallel probing — total page count is discovered from each condition's first page.
 *
 * Wear category tags (Steam internal):
 *   Factory New   → tag_WearCategory0
 *   Minimal Wear  → tag_WearCategory1
 *   Field-Tested  → tag_WearCategory2
 *   Well-Worn     → tag_WearCategory3
 *   Battle-Scarred→ tag_WearCategory4
 *
 * StatTrak quality tag: tag_strange
 */

import { Condition } from '../models/enums.js';

const STEAM_SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
const PAGE_SIZE = 100;
const DELAY_MS = 1500;
const RATE_LIMIT_WAIT_MS = 60_000; // wait 1 min on 429
const MAX_RETRIES = 3;

const WEAR_TAGS: Record<Condition, string> = {
  [Condition.FactoryNew]:   'tag_WearCategory0',
  [Condition.MinimalWear]:  'tag_WearCategory1',
  [Condition.FieldTested]:  'tag_WearCategory2',
  [Condition.WellWorn]:     'tag_WearCategory3',
  [Condition.BattleScarred]: 'tag_WearCategory4',
};

export interface SteamPriceProgress {
  done: number;
  total: number;
  itemsFetched: number;
  phase: string;
}

export interface SteamPriceEntry {
  priceCents: number;
  /** Number of active sell listings on Steam Market. */
  listings: number;
}

export async function fetchAllPricesSteam(
  onProgress?: (p: SteamPriceProgress) => void
): Promise<Map<string, SteamPriceEntry>> {
  const out = new Map<string, SteamPriceEntry>();
  const conditions = Object.entries(WEAR_TAGS) as [Condition, string][];

  let donePages = 0;
  let totalPages = 0; // discovered dynamically from first page of each condition

  // All passes: regular then StatTrak, sequentially
  const passes: Array<{ condition: Condition; wearTag: string; statTrak: boolean }> = [
    ...conditions.map(([condition, wearTag]) => ({ condition, wearTag, statTrak: false })),
    ...conditions.map(([condition, wearTag]) => ({ condition, wearTag, statTrak: true })),
  ];

  for (const { condition, wearTag, statTrak } of passes) {
    const phase = statTrak ? `StatTrak ${condition}` : String(condition);

    // Small extra gap between condition switches to avoid bursts
    if (donePages > 0) await sleep(DELAY_MS);

    await fetchByCondition(wearTag, statTrak, out,
      (pagesAdded, conditionTotalPages) => {
        if (conditionTotalPages !== undefined) totalPages += conditionTotalPages;
        donePages += pagesAdded;
        onProgress?.({ done: donePages, total: totalPages, itemsFetched: out.size, phase });
      }
    );
  }

  return out;
}

async function fetchByCondition(
  wearTag: string,
  statTrak: boolean,
  out: Map<string, SteamPriceEntry>,
  onPage: (pagesAdded: number, conditionTotalPages?: number) => void,
): Promise<void> {
  const first = await fetchPage(0, wearTag, statTrak);
  if (!first) return;

  const total = (first.total_count as number) ?? 0;
  const pages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;

  processPage(first.results as any[], out);
  onPage(1, pages); // report this condition's total so caller can update totalPages

  for (let page = 1; page < pages; page++) {
    await sleep(DELAY_MS);
    const data = await fetchPage(page * PAGE_SIZE, wearTag, statTrak);
    if (data) processPage(data.results as any[], out);
    onPage(1);
  }
}

async function fetchPage(
  start: number,
  wearTag: string,
  statTrak: boolean,
  attempt = 0,
): Promise<Record<string, any> | null> {
  try {
    let url = `${STEAM_SEARCH_URL}?appid=730&query=&norender=1&currency=1&count=${PAGE_SIZE}&start=${start}`;
    url += `&category_730_Exterior[]=${wearTag}`;
    if (statTrak) url += `&category_730_Quality[]=tag_strange`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)' },
    });

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        console.warn(`Steam rate limited on start=${start}, giving up after ${MAX_RETRIES} retries`);
        return null;
      }
      const waitMs = RATE_LIMIT_WAIT_MS * (attempt + 1);
      console.warn(`Steam rate limited (attempt ${attempt + 1}), waiting ${waitMs / 1000}s…`);
      await sleep(waitMs);
      return fetchPage(start, wearTag, statTrak, attempt + 1);
    }

    if (!res.ok) {
      console.warn(`Steam page start=${start}: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (e) {
    console.warn(`Steam page start=${start} error:`, e);
    return null;
  }
}

function processPage(items: any[], out: Map<string, SteamPriceEntry>): void {
  for (const item of items) {
    const name: string = item.hash_name ?? item.name;
    const price: number = item.sell_price;
    const listings: number = typeof item.sell_listings === 'number' ? item.sell_listings : 0;
    if (name && typeof price === 'number' && price > 0) {
      out.set(name, { priceCents: price, listings });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
