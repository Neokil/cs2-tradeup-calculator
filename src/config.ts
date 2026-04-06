import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

export const config = {
  dbPath: path.join(ROOT_DIR, 'data', 'tradeup.db'),
  steamRateLimitMs: parseInt(process.env.STEAM_RATE_LIMIT_MS || '3000', 10),
  priceRefreshCron: process.env.PRICE_REFRESH_CRON || '0 */4 * * *',
  minRoiThreshold: parseFloat(process.env.MIN_ROI_THRESHOLD || '5'),
  steamTaxRate: parseFloat(process.env.STEAM_TAX_RATE || '0.13'),
  // CSFloat charges ~2% seller fee (vs Steam's ~13%)
  csfloatFeeRate: parseFloat(process.env.CSFLOAT_FEE_RATE || '0.02'),

  // ByMykel CSGO-API base URL
  csgoApiBase: 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en',

  // Steam Community Market
  steamMarketBase: 'https://steamcommunity.com/market',
  steamAppId: 730,
  steamCurrency: 1, // USD
};
