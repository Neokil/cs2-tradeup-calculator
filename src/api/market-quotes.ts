import { Condition } from '../models/enums.js';
import { fetchCSMoneyPricesFromPriceEmpire } from './pricempire-prices.js';
import { config } from '../config.js';

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
  defIndex?: number | null;
  paintIndex?: number | null;
  estimatedFloat?: number;
}

export interface MarketQuote {
  hashName: string;
  dmarketLowestPriceCents: number | null;
  dmarketAveragePriceCents: number | null;
  dmarketUrl: string;
  csMoneyPriceCents: number | null;
  csMoneyAveragePriceCents: number | null;
  csMoneyUrl: string;
  csfloatBuyOrderCents: number | null;
  csfloatBuyOrderCount: number;
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
  let priceEmpirePrices = new Map<string, { lowestPriceCents: number; averagePriceCents: number }>();
  try {
    priceEmpirePrices = await fetchCSMoneyPricesFromPriceEmpire(unique);
  } catch (error) {
    console.warn('PriceEmpire CS.Money provider failed; continuing with other providers:', error);
  }

  for (let i = 0; i < unique.length; i++) {
    if (i > 0) await sleep(delayMs);
    const target = unique[i];
    const dmarketUrl = dmarketSearchUrl(target.hashName, target.condition);
    const csMoneyUrl = csMoneySearchUrl(target.hashName, target.condition);
    const dmarketPrices = await fetchDMarketPrices(target);
    const csMoneyPrices = priceEmpirePrices.get(target.hashName) ?? null;
    const csfloatBuyOrder = await fetchCSFloatBuyOrder(target);
    quotes.push({
      hashName: target.hashName,
      dmarketLowestPriceCents: dmarketPrices?.lowestPriceCents ?? null,
      dmarketAveragePriceCents: dmarketPrices?.averagePriceCents ?? null,
      dmarketUrl,
      csMoneyPriceCents: csMoneyPrices?.lowestPriceCents ?? null,
      csMoneyAveragePriceCents: csMoneyPrices?.averagePriceCents ?? null,
      csMoneyUrl,
      csfloatBuyOrderCents: csfloatBuyOrder?.priceCents ?? null,
      csfloatBuyOrderCount: csfloatBuyOrder?.count ?? 0,
    });
  }

  return quotes;
}

async function fetchCSFloatBuyOrder(target: MarketQuoteTarget): Promise<{
  priceCents: number;
  count: number;
} | null> {
  if (target.defIndex == null || target.paintIndex == null) return null;
  if (!config.csfloatApiKey) {
    console.warn(`CSFloat buy order skipped for ${target.hashName}: CSFLOAT_API_KEY is not configured`);
    return null;
  }

  const url = new URL('https://csfloat.com/api/v1/listings');
  url.searchParams.set('def_index', String(target.defIndex));
  url.searchParams.set('paint_index', String(target.paintIndex));
  url.searchParams.set('market_hash_name', target.hashName);
  url.searchParams.set('type', 'buy_now');
  url.searchParams.set('sort_by', 'lowest_price');
  url.searchParams.set('limit', '1');
  url.searchParams.set('category', target.statTrak ? '2' : '1');

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)',
    };
    if (config.csfloatApiKey) headers.Authorization = config.csfloatApiKey;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.warn(`CSFloat listing lookup failed for ${target.hashName}: HTTP ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as {
      data?: Array<{ id: string }>;
    };
    const listingId = data.data?.[0]?.id;
    if (!listingId) return null;

    const buyOrdersResponse = await fetch(
      `https://csfloat.com/api/v1/listings/${listingId}/buy-orders?limit=10`,
      { headers },
    );
    if (!buyOrdersResponse.ok) {
      console.warn(`CSFloat buy-order request failed for ${target.hashName}: HTTP ${buyOrdersResponse.status} ${buyOrdersResponse.statusText}`);
      return null;
    }

    const buyOrders = await buyOrdersResponse.json() as Array<{
      price?: number;
      qty?: number;
    }>;
    const validOrders = buyOrders.filter(order => (order.price ?? 0) > 0);
    const bestOrder = validOrders[0];
    return bestOrder?.price
      ? { priceCents: bestOrder.price, count: validOrders.length }
      : null;
  } catch {
    console.warn(`CSFloat buy order request failed for ${target.hashName}: network error`);
    return null;
  }
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
