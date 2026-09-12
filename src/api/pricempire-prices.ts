import { chromium } from "playwright";

const PRICEMPIRE_ITEM_URL = 'https://pricempire.com/api-data/v1/item';
const CSMONEY_PROVIDER = 'csmoneym';

interface PriceEmpireAssetPrice {
  price?: number | string | null;
  count?: number | string | null;
  provider_key?: string;
}

interface PriceEmpireAssetItem {
  market_hash_name?: string;
  prices?: PriceEmpireAssetPrice[];
}

interface PriceEmpireItemResponse {
  asset_items?: PriceEmpireAssetItem[];
}

export interface PriceEmpireMarketPrice {
  lowestPriceCents: number;
  averagePriceCents: number;
}

/** Fetches CS.Money prices from the PriceEmpire item-data endpoint. */
export async function fetchCSMoneyPricesFromPriceEmpire(
  targets: Array<{ hashName: string }>,
): Promise<Map<string, PriceEmpireMarketPrice>> {
  const prices = new Map<string, PriceEmpireMarketPrice>();

  const browser = await chromium.launch({
    headless: false,
    timeout: 1000,
  });
  const page = await browser.newPage();

  try {
    for (const target of targets) {
      const url = new URL(PRICEMPIRE_ITEM_URL);
      url.searchParams.set('app', 'cs2');
      url.searchParams.set('type', 'skin');
      url.searchParams.set('slug', marketHashNameToSlug(target.hashName));

      try {
        const response = await page.goto(
          url.toString(),
          { waitUntil: "domcontentloaded" }
        );

        if (!response) {
          throw new Error("No response received");
        }

        console.log("Status:", response.status());

        const data = await response.json() as PriceEmpireItemResponse;
        const asset = data.asset_items?.find(item => item.market_hash_name === target.hashName);
        const providerPrice = asset?.prices?.find(price =>
          price.provider_key === CSMONEY_PROVIDER && parsePrice(price.price) > 0
        );
        const priceCents = parsePrice(providerPrice?.price);
        if (priceCents == null || priceCents <= 0) continue;

        prices.set(target.hashName, {
          lowestPriceCents: Math.round(priceCents),
          averagePriceCents: Math.round(priceCents),
        });
      } catch (error) {
        console.warn(`PriceEmpire CS.Money request failed for ${target.hashName}:`, error);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`PriceEmpire: matched ${prices.size}/${targets.length} CS.Money prices`);
  return prices;
}

function marketHashNameToSlug(hashName: string): string {
  return hashName
    .replace(/^StatTrak™\s+/u, '')
    .replace(/^Souvenir\s+/u, '')
    .replace(/^★\s*/u, '')
    .replace(/\s+\([^()]+\)$/u, '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function parsePrice(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
