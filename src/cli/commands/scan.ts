import { findProfitableTradeUps, FinderOptions } from '../../services/tradeup-finder.js';
import { formatResultsTable, formatResultsJson } from '../formatters.js';
import { Rarity } from '../../models/enums.js';

export function scanCommand(options: {
  minRoi?: string;
  maxResults?: string;
  format?: string;
  stattrak?: boolean;
}): void {
  const finderOptions: FinderOptions = {
    minRoi: options.minRoi ? parseFloat(options.minRoi) : undefined,
    maxResults: options.maxResults ? parseInt(options.maxResults, 10) : undefined,
    statTrak: options.stattrak ?? false,
  };

  console.log('Scanning for profitable trade-ups...\n');
  const results = findProfitableTradeUps(finderOptions);

  if (options.format === 'json') {
    console.log(formatResultsJson(results));
  } else {
    console.log(formatResultsTable(results));
  }
}
