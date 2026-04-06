import cron from 'node-cron';
import { syncAllPrices } from '../../services/data-sync.js';
import { findProfitableTradeUps } from '../../services/tradeup-finder.js';
import { config } from '../../config.js';

export function watchCommand(options: { minRoi?: string }): void {
  const minRoi = options.minRoi ? parseFloat(options.minRoi) : config.minRoiThreshold;

  console.log(`Starting watcher (cron: ${config.priceRefreshCron}, minROI: ${minRoi}%)`);
  runCycle(minRoi);

  cron.schedule(config.priceRefreshCron, () => runCycle(minRoi));
  console.log('Watcher running. Ctrl+C to stop.\n');
}

async function runCycle(minRoi: number): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] Refresh cycle starting…`);
  try {
    await syncAllPrices();
    const results = findProfitableTradeUps({ minRoi });
    console.log(`Found ${results.length} profitable trade-ups (ROI ≥ ${minRoi}%)`);
    for (const r of results.slice(0, 10)) {
      console.log(`  ROI +${r.roi.toFixed(1)}% | profit $${(r.expectedProfitCents/100).toFixed(2)} | ${r.inputs[0]?.condition} → ${r.outputs[0]?.condition}`);
    }
  } catch (e) {
    console.error('Cycle error:', e);
  }
}
