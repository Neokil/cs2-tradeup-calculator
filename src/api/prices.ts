import { config } from '../config.js';
import { RateLimiter } from './rate-limiter.js';
import { Condition } from '../models/enums.js';

const rateLimiter = new RateLimiter(config.steamRateLimitMs);

interface SteamPriceResponse {
  success: boolean;
  lowest_price?: string;
  median_price?: string;
  volume?: string;
}

function parseSteamPrice(priceStr: string | undefined): number {
  if (!priceStr) return 0;
  // Steam returns prices like "$1,234.56" or "€1.234,56"
  const cleaned = priceStr.replace(/[^0-9.,]/g, '');
  // Handle US format: remove commas, parse
  const normalized = cleaned.replace(/,/g, '');
  const cents = Math.round(parseFloat(normalized) * 100);
  return isNaN(cents) ? 0 : cents;
}

export function buildMarketHashName(
  weaponName: string,
  patternName: string,
  condition: Condition,
  statTrak: boolean
): string {
  const prefix = statTrak ? 'StatTrak\u2122 ' : '';
  return `${prefix}${weaponName} | ${patternName} (${condition})`;
}

export async function fetchSteamPrice(marketHashName: string): Promise<{
  priceCents: number;
  volume: number;
} | null> {
  await rateLimiter.wait();

  const url = `${config.steamMarketBase}/priceoverview/?appid=${config.steamAppId}&currency=${config.steamCurrency}&market_hash_name=${encodeURIComponent(marketHashName)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        console.warn('Steam rate limited, waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
        return fetchSteamPrice(marketHashName); // retry once
      }
      return null;
    }

    const data: SteamPriceResponse = await response.json();
    if (!data.success) return null;

    const priceCents = parseSteamPrice(data.lowest_price) || parseSteamPrice(data.median_price);
    const volume = parseInt(data.volume || '0', 10);

    return priceCents > 0 ? { priceCents, volume } : null;
  } catch (error) {
    console.warn(`Failed to fetch price for "${marketHashName}":`, error);
    return null;
  }
}
