import './env.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

export const config = {
  dbPath: path.join(ROOT_DIR, 'data', 'tradeup.db'),
  steamRateLimitMs: parseInt(process.env.STEAM_RATE_LIMIT_MS || '3000', 10),
  priceRefreshCron: process.env.PRICE_REFRESH_CRON || '0 */4 * * *',
  minRoiThreshold: parseFloat(process.env.MIN_ROI_THRESHOLD || '100'),
  maxResults: parseInt(process.env.MAX_RESULTS || '50', 10),
  steamTaxRate: parseFloat(process.env.STEAM_TAX_RATE || '0.13'),
  // CSFloat charges ~2% seller fee (vs Steam's ~13%)
  csfloatFeeRate: parseFloat(process.env.CSFLOAT_FEE_RATE || '0.02'),
  // CSFloat API key — enables per-phase Doppler prices (optional)
  // Get yours at: https://csfloat.com/developer
  csfloatApiKey: process.env.CSFLOAT_API_KEY || '',
  // ByMykel CSGO-API base URL
  csgoApiBase: 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en',

};
