import { syncCollectionsAndSkins, syncAllPrices } from '../../services/data-sync.js';

export async function syncCommand(options: { pricesOnly?: boolean }): Promise<void> {
  if (!options.pricesOnly) {
    console.log('=== Syncing collections and skins ===');
    await syncCollectionsAndSkins();
  }

  console.log('\n=== Syncing prices (bulk fetch) ===');
  const fetched = await syncAllPrices();
  console.log(`\nSync complete! ${fetched} prices stored.`);
}
