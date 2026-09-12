import { Condition } from '../models/enums.js';
import { fetchCSMoneyPricesFromPriceEmpire } from './pricempire-prices.js';

const DMARKET_ITEMS_URL = 'https://api.dmarket.com/exchange/v1/market/items/v2';
const DMARKET_PAGE_SIZE = 10;

const EXTERIOR_NAMES: Record<Condition, string> = {
  [Condition.FactoryNew]: 'factory new',
  [Condition.MinimalWear]: 'minimal wear',
  [Condition.FieldTested]: 'field-tested',
  [Condition.WellWorn]: 'well-worn',
  [Condition.BattleScarred]: 'battle-scarred',
};

export interface MarketQuoteTarget {
  hashName: string;
  condition: Condition;
  statTrak: boolean;
  count: number;
}

export interface MarketQuote {
  hashName: string;
  dmarketLowestPriceCents: number | null;
  dmarketAveragePriceCents: number | null;
  dmarketUrl: string;
  csMoneyPriceCents: number | null;
  csMoneyAveragePriceCents: number | null;
  csMoneyUrl: string;
}

interface DMarketOffer {
  priceCents?: number;
  locked?: boolean;
}

interface DMarketResponse {
  offers?: DMarketOffer[];
}

export async function fetchMarketQuotes(
  targets: MarketQuoteTarget[],
  delayMs = 1000,
): Promise<MarketQuote[]> {
  const uniqueByHash = new Map<string, MarketQuoteTarget>();
  for (const target of targets) {
    const existing = uniqueByHash.get(target.hashName);
    if (!existing || target.count > existing.count) uniqueByHash.set(target.hashName, target);
  }
  const unique = [...uniqueByHash.values()];
  const quotes: MarketQuote[] = [];
  const priceEmpirePrices = await fetchCSMoneyPricesFromPriceEmpire(unique);

  for (let i = 0; i < unique.length; i++) {
    if (i > 0) await sleep(delayMs);
    const target = unique[i];
    const dmarketUrl = dmarketSearchUrl(target.hashName, target.condition);
    const csMoneyUrl = csMoneySearchUrl(target.hashName, target.condition);
    const dmarketPrices = await fetchDMarketPrices(target);
    const csMoneyPrices = priceEmpirePrices.get(target.hashName) ?? null;
    quotes.push({
      hashName: target.hashName,
      dmarketLowestPriceCents: dmarketPrices?.lowestPriceCents ?? null,
      dmarketAveragePriceCents: dmarketPrices?.averagePriceCents ?? null,
      dmarketUrl,
      csMoneyPriceCents: csMoneyPrices?.lowestPriceCents ?? null,
      csMoneyAveragePriceCents: csMoneyPrices?.averagePriceCents ?? null,
      csMoneyUrl,
    });
  }

  return quotes;
}

async function fetchDMarketPrices(target: MarketQuoteTarget): Promise<{
  lowestPriceCents: number;
  averagePriceCents: number;
} | null> {
  const baseName = target.hashName
    .replace(/^StatTrak™ /, '')
    .replace(/^★ /, '')
    .replace(/ \([^()]+\)$/, '');
  const url = new URL(DMARKET_ITEMS_URL);
  url.searchParams.set('orderBy', 'price');
  url.searchParams.set('orderDir', 'asc');
  url.searchParams.set('isLoggedIn', 'false');
  url.searchParams.set('treeFilters', `exterior[]=${EXTERIOR_NAMES[target.condition]},itemSlug[]=${slugify(baseName)}`);
  url.searchParams.set('gameId', 'a8db');
  const offerCount = Math.max(1, Math.min(Math.floor(target.count || 1), DMARKET_PAGE_SIZE));
  url.searchParams.set('pageSize', String(DMARKET_PAGE_SIZE));
  url.searchParams.set('side', 'market');
  url.searchParams.set('currency', 'USD');
  url.searchParams.set('platform', 'browser');
  url.searchParams.set('pageToken', '');

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Language: 'EN',
        'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)',
      },
    });
    if (!response.ok) return null;

    const data = await response.json() as DMarketResponse;
    const prices = (data.offers ?? [])
      .filter(item => !item.locked && (item.priceCents ?? 0) > 0)
      .map(item => item.priceCents as number)
      .slice(0, offerCount);
    if (!prices.length) return null;
    return {
      lowestPriceCents: prices[0],
      averagePriceCents: Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length),
    };
  } catch {
    return null;
  }
}

export function dmarketSearchUrl(hashName: string, condition: Condition): string {
  const params = new URLSearchParams({
    title: stripCondition(hashName),
    exterior: EXTERIOR_NAMES[condition],
    orderBy: 'price',
    orderDir: 'asc',
  });
  return `https://dmarket.com/ingame-items/item-list/csgo-skins?${params}`;
}

export function csMoneySearchUrl(hashName: string, condition: Condition): string {
  const params = new URLSearchParams({
    search: stripCondition(hashName),
    order: 'asc',
    sort: 'price',
    exterior: condition,
  });
  return `https://cs.money/de/market/buy/?${params}`;
}

function stripCondition(hashName: string): string {
  return hashName.replace(/ \([^()]+\)$/, '');
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[★™]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
