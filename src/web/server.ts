import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/client.js';
import { syncCollectionsAndSkins, syncAllPrices, getCollectionName, validConditionsForSkin } from '../services/data-sync.js';
import { findProfitableTradeUps, EvaluatedTradeUp } from '../services/tradeup-finder.js';
import { RARITY_NAMES, Rarity, Condition, CONDITION_FLOAT_RANGES } from '../models/enums.js';
import { normalizeFloat } from '../services/float-calculator.js';
import { floatToCondition } from '../models/enums.js';
import { config } from '../config.js';
import { fetchPriceOverview } from '../api/price-overview.js';
import { buildMarketHashName } from '../api/prices.js';
import { fetchMarketQuotes, MarketQuoteTarget, dmarketSearchUrl, csMoneySearchUrl } from '../api/market-quotes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function parseBudgetCents(value: string | undefined): number | undefined {
  if (!value || value.trim() === '') return undefined;
  const euros = Number.parseFloat(value);
  return Number.isFinite(euros) && euros >= 0 ? Math.round(euros * 100) : undefined;
}

export function createServer(port = parseInt(process.env.PORT || '3000', 10)) {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // ── GET /api/status ──────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    try {
      const db = getDb();
      const skins = (db.prepare('SELECT COUNT(*) as c FROM skins').get() as any).c;
      const collections = (db.prepare('SELECT COUNT(*) as c FROM collections').get() as any).c;
      const prices = (db.prepare('SELECT COUNT(*) as c FROM prices WHERE price_cents > 0').get() as any).c;
      const lastPrice = (db.prepare('SELECT MAX(updated_at) as t FROM prices').get() as any).t;

      const byRarity = db.prepare(`
        SELECT s.rarity,
               COUNT(DISTINCT s.id) as total_skins,
               COUNT(DISTINCT p.skin_id) as priced_skins,
               COUNT(p.rowid) as price_entries
        FROM skins s
        LEFT JOIN prices p ON p.skin_id = s.id AND p.price_cents > 0
        GROUP BY s.rarity ORDER BY s.rarity
      `).all();

      const priceAgeMs = lastPrice ? Date.now() - lastPrice : null;
      res.json({ skins, collections, prices, lastPrice, priceAgeMs, byRarity });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/sync ───────────────────────────────────────────────────────
  // Streamed via SSE
  app.post('/api/sync', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    const { skipCollections, priceSource = 'csfloat' } = req.body ?? {};
    try {
      if (!skipCollections) {
        send('log', { msg: 'Fetching collections and skins from ByMykel API…' });
        await syncCollectionsAndSkins();
        const db = getDb();
        const cnt = (db.prepare('SELECT COUNT(*) as c FROM skins').get() as any).c;
        send('log', { msg: `✓ ${cnt} skins loaded` });
      }

      const sourceLabel = priceSource === 'steam' ? 'Steam Community Market' : 'CSFloat';
      send('log', { msg: `Fetching prices from ${sourceLabel}…` });
      send('progress', { step: 'prices', pct: priceSource === 'steam' ? 5 : 10 });

      const synced = await syncAllPrices(priceSource, (p) => {
        const pct = p.total > 0 ? Math.round(5 + (p.done / p.total) * 90) : 50;
        const sub = p.total > 0
          ? `${p.phase ?? ''} — Page ${p.done}/${p.total} — ${p.itemsFetched} items`
          : `${p.itemsFetched} items`;
        send('progress', { step: 'prices', pct, sub });
      });

      send('log', { msg: `✓ ${synced} prices stored` });
      send('progress', { step: 'prices', pct: 100 });
      send('done', { msg: `Sync complete! ${synced} prices from ${sourceLabel}.` });
    } catch (e: any) {
      send('error', { msg: e.message });
    } finally {
      res.end();
    }
  });

  // ── GET /api/scan ────────────────────────────────────────────────────────
  app.get('/api/scan', (req, res) => {
    try {
      const minRoi     = req.query.minRoi     ? parseFloat(req.query.minRoi as string)    : config.minRoiThreshold;
      const maxResults = req.query.maxResults ? parseInt(req.query.maxResults as string)  : config.maxResults;
      const statTrak   = req.query.statTrak   === 'true';
      const floatMode  = (['low', 'below_avg', 'mid', 'above_avg', 'high'] as const)
        .find(m => m === req.query.floatMode) ?? 'mid';
      const maxCollections = (['1', '2', '3', '4', '5'] as const)
        .find(value => value === req.query.maxCollections);
      const searchStrategy = (['auto', 'exact', 'beam'] as const)
        .find(value => value === req.query.searchStrategy) ?? 'auto';
      if (searchStrategy === 'exact' && maxCollections && Number(maxCollections) > 2) {
        return res.status(400).json({ error: 'Exact search is only available for up to 2 collections.' });
      }
      const minBudget = parseBudgetCents(req.query.minBudget as string | undefined);
      const maxBudget = parseBudgetCents(req.query.maxBudget as string | undefined);
      const priceSource = (['steam', 'csfloat'] as const)
        .find(s => s === req.query.priceSource) ?? 'csfloat';

      const results = findProfitableTradeUps({
        minRoi, maxResults, statTrak, floatMode, priceSource,
        maxCollections: maxCollections ? Number(maxCollections) as 1 | 2 | 3 | 4 | 5 : undefined,
        searchStrategy,
        minBudgetCents: minBudget,
        maxBudgetCents: maxBudget,
      });
      _scanPriceSource = priceSource;
      const feeRate = priceSource === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
      res.json({ results: results.map(serializeResult), count: results.length, feeRate, priceSource, hasCsfloatKey: !!config.csfloatApiKey });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/price/verify-batch ─────────────────────────────────────────
  // Body: { hashNames: string[] }
  // Streams live priceoverview (median sale price + volume) for each item via SSE.
  // Rate-limited to ~1 req/1.2s to avoid Steam rate-limiting.
  app.post('/api/price/verify-batch', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const { hashNames } = req.body as { hashNames: string[] };
    if (!hashNames?.length) { res.end(); return; }

    const unique = [...new Set(hashNames)].slice(0, 60); // cap at 60 items
    send({ type: 'start', total: unique.length });

    for (let i = 0; i < unique.length; i++) {
      if (i > 0) await new Promise<void>(r => setTimeout(r, 1200)); // ~1 req/sec
      const name = unique[i];
      try {
        const ov = await fetchPriceOverview(name);
        send({
          type: 'price',
          hashName: name,
          lowestPriceCents:  ov?.lowestPriceCents  ?? null,
          medianPriceCents:  ov?.medianPriceCents  ?? null,
          volume:            ov?.volume            ?? 0,
          progress: (i + 1) / unique.length,
        });
      } catch {
        send({ type: 'price', hashName: name, error: true, progress: (i + 1) / unique.length });
      }
    }
    send({ type: 'done' });
    res.end();
  });

  // ── GET /api/skins/search ────────────────────────────────────────────────
  app.get('/api/skins/search', (req, res) => {
    try {
      const db = getDb();
      const q = `%${req.query.q ?? ''}%`;
      const rarityFilter = req.query.rarity !== undefined ? parseInt(req.query.rarity as string) : null;
      let sql = `
        SELECT s.id, s.name, s.rarity, s.min_float, s.max_float,
               c.name as collection_name, s.collection_id,
               s.has_stattrak
        FROM skins s JOIN collections c ON c.id = s.collection_id
        WHERE s.name LIKE ?`;
      const params: unknown[] = [q];
      if (rarityFilter !== null) { sql += ' AND s.rarity = ?'; params.push(rarityFilter); }
      sql += ' ORDER BY s.rarity, s.name LIMIT 30';
      res.json(db.prepare(sql).all(...params));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/skins/:id/prices ────────────────────────────────────────────
  app.get('/api/skins/:id/prices', (req, res) => {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT condition, stattrak, price_cents, updated_at
        FROM prices WHERE skin_id = ? AND price_cents > 0 ORDER BY condition
      `).all(req.params.id);
      res.json(rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/market-quotes/batch ───────────────────────────────────────
  // Fetches targeted marketplace quotes for the inputs of displayed results.
  // This is intentionally separate from the regular price sync.
  app.post('/api/market-quotes/batch', async (req, res) => {
    try {
      const items = req.body?.items as MarketQuoteTarget[] | undefined;
      if (!Array.isArray(items) || items.length === 0) return res.json({ quotes: [] });

      const targets = items
        .filter(item => typeof item?.hashName === 'string' && item.hashName.length > 0)
        .slice(0, 100)
        .map(item => ({
          hashName: item.hashName,
          condition: item.condition,
          statTrak: item.statTrak === true,
          count: Math.max(1, Math.min(Number(item.count) || 1, 100)),
          defIndex: item.defIndex,
          paintIndex: item.paintIndex,
          estimatedFloat: item.estimatedFloat,
        }));
      const quotes = await fetchMarketQuotes(targets);
      res.json({ quotes });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/float/calculate ─────────────────────────────────────────────
  // Body: { inputs: [{ skinId, float }] }
  // Returns all possible outputs with probabilities and conditions.
  app.post('/api/float/calculate', (req, res) => {
    try {
      const { inputs } = req.body as { inputs: Array<{ skinId: string; float: number }> };
      if (!inputs?.length) return res.status(400).json({ error: 'inputs required' });

      const db = getDb();
      const resolved = inputs.map(i => {
        const skin = db.prepare('SELECT * FROM skins WHERE id = ?').get(i.skinId) as any;
        return skin ? { skin, float: i.float } : null;
      }).filter(Boolean) as Array<{ skin: any; float: number }>;

      if (!resolved.length) return res.status(400).json({ error: 'No valid skins' });

      const inputRarity = resolved[0].skin.rarity;
      const outputRarity = inputRarity + 1;

      // Normalized average of all inputs
      let sumNorm = 0;
      for (const { skin, float: f } of resolved) {
        const range = skin.max_float - skin.min_float;
        sumNorm += range === 0 ? 0 : (f - skin.min_float) / range;
      }
      const avgNorm = sumNorm / resolved.length;

      // Collect unique collections from inputs
      const collectionCounts = new Map<string, number>();
      for (const { skin } of resolved) {
        collectionCounts.set(skin.collection_id, (collectionCounts.get(skin.collection_id) ?? 0) + 1);
      }

      const outputResults: Array<{
        name: string; collection: string; condition: Condition;
        float: number; probability: number; priceUsd: number | null;
        minFloat: number; maxFloat: number;
      }> = [];

      for (const [colId, count] of collectionCounts) {
        const outputSkins = db.prepare(
          'SELECT * FROM skins WHERE collection_id = ? AND rarity = ?'
        ).all(colId, outputRarity) as any[];

        const collProb = count / resolved.length;
        const probPerSkin = collProb / outputSkins.length;

        for (const outSkin of outputSkins) {
          const raw = (outSkin.max_float - outSkin.min_float) * avgNorm + outSkin.min_float;
          const outFloat = Math.max(outSkin.min_float, Math.min(outSkin.max_float, raw));
          const outCond = floatToCondition(outFloat);
          const priceRow = db.prepare(
            'SELECT price_cents FROM prices WHERE skin_id = ? AND condition = ? AND stattrak = 0'
          ).get(outSkin.id, outCond) as any;

          outputResults.push({
            name: outSkin.name,
            collection: getCollectionName(colId),
            condition: outCond,
            float: parseFloat(outFloat.toFixed(6)),
            probability: probPerSkin,
            priceUsd: priceRow ? priceRow.price_cents / 100 : null,
            minFloat: outSkin.min_float,
            maxFloat: outSkin.max_float,
          });
        }
      }

      outputResults.sort((a, b) => b.probability - a.probability);

      const totalEv = outputResults.reduce((s, o) => s + (o.priceUsd ?? 0) * o.probability, 0);
      const feeRate = (req.body?.priceSource ?? 'csfloat') === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
      const evAfterTax = totalEv * (1 - feeRate);

      res.json({ avgNorm, evAfterTax, results: outputResults });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/skins/:id/price-history ─────────────────────────────────────
  app.get('/api/skins/:id/price-history', (req, res) => {
    try {
      const db = getDb();
      const source = (req.query.source as string) ?? 'csfloat';
      const condition = (req.query.condition as string) ?? null;
      const stattrak = req.query.stattrak === 'true' ? 1 : 0;
      const days = Math.min(parseInt(req.query.days as string || '30', 10), 90);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      let sql = `
        SELECT condition, stattrak, price_cents, volume, recorded_at
        FROM price_history
        WHERE skin_id = ? AND source = ? AND stattrak = ? AND recorded_at >= ?
      `;
      const params: unknown[] = [req.params.id, source, stattrak, cutoff];
      if (condition) { sql += ' AND condition = ?'; params.push(condition); }
      sql += ' ORDER BY recorded_at ASC';

      res.json(db.prepare(sql).all(...params));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/buy-orders/batch ────────────────────────────────────────────
  // Streams the highest CSFloat buy-order price for each output skin.
  // Body: { items: Array<{ defIndex, paintIndex, condition, hashName, statTrak? }> }
  // Requires CSFLOAT_API_KEY for auth (same as Doppler phase fetcher).
  app.post('/api/buy-orders/batch', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const { items } = req.body as {
      items: Array<{
        defIndex: number | null;
        paintIndex: number | null;
        condition: string;
        hashName: string;
        statTrak?: boolean;
        estimatedFloat?: number;
      }>;
    };

    if (!items?.length) { send({ type: 'done' }); res.end(); return; }

    // Deduplicate by defIndex:paintIndex:statTrak
    const unique = new Map<string, typeof items[0]>();
    for (const item of items) {
      if (item.defIndex == null || item.paintIndex == null) continue;
      const key = `${item.defIndex}:${item.paintIndex}:${item.statTrak ? 1 : 0}`;
      if (!unique.has(key)) unique.set(key, item);
    }

    const total = unique.size;
    send({ type: 'start', total });
    let done = 0;

    for (const [, item] of unique) {
      try {
        const url = new URL('https://csfloat.com/api/v1/listings');
        url.searchParams.set('def_index',   String(item.defIndex));
        url.searchParams.set('paint_index', String(item.paintIndex));
        url.searchParams.set('type',        'buy_order');
        url.searchParams.set('sort_by',     'highest_price');
        url.searchParams.set('limit',       '10');
        url.searchParams.set('quality',     item.statTrak ? '12' : '3');

        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (compatible; CS2TradeUpCalc/1.0)',
        };
        if (config.csfloatApiKey) headers['Authorization'] = config.csfloatApiKey;

        const response = await fetch(url.toString(), { headers });
        let buyOrderCents: number | null = null;
        let buyOrderCount = 0;

        if (response.ok) {
          const json = await response.json() as { data?: Array<{ price: number; min_float?: number; max_float?: number }> };
          const orders = json.data ?? [];
          buyOrderCount = orders.length;

          // If we know the estimated output float, prefer orders that accept it
          const outFloat = item.estimatedFloat;
          if (outFloat != null && orders.length > 0) {
            // Orders are sorted highest_price first; find highest that accepts our float
            const matching = orders.find(o =>
              (o.min_float == null || o.min_float <= outFloat) &&
              (o.max_float == null || o.max_float >= outFloat)
            );
            buyOrderCents = matching?.price ?? orders[0]?.price ?? null;
          } else {
            buyOrderCents = orders[0]?.price ?? null;
          }
        }

        send({
          type: 'price',
          hashName: item.hashName,
          buyOrderCents,
          buyOrderCount,
          progress: (done + 1) / total,
        });
      } catch {
        send({ type: 'price', hashName: item.hashName, buyOrderCents: null, buyOrderCount: 0, progress: (done + 1) / total });
      }
      done++;
      if (done < total) await new Promise<void>(r => setTimeout(r, 700));
    }

    send({ type: 'done' });
    res.end();
  });

  app.listen(port, () => {
    console.log(`\nCS2 Trade-Up Calculator → http://localhost:${port}\n`);
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────
// Serialization helpers
// ─────────────────────────────────────────────────────────────────

const COND_LABEL: Record<Condition, string> = {
  [Condition.FactoryNew]:   'Factory New',
  [Condition.MinimalWear]:  'Minimal Wear',
  [Condition.FieldTested]:  'Field-Tested',
  [Condition.WellWorn]:     'Well-Worn',
  [Condition.BattleScarred]:'Battle-Scarred',
};

function steamMarketUrl(weaponName: string, patternName: string, condition: Condition, statTrak: boolean): string {
  const prefix = statTrak ? 'StatTrak™ ' : '';
  const hashName = `${prefix}${weaponName} | ${patternName} (${COND_LABEL[condition]})`;
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hashName)}`;
}

// Condition float bounds for CSFloat search URL filtering
const COND_MIN_FLOAT: Record<Condition, number> = {
  [Condition.FactoryNew]:    0.00,
  [Condition.MinimalWear]:   0.07,
  [Condition.FieldTested]:   0.15,
  [Condition.WellWorn]:      0.38,
  [Condition.BattleScarred]: 0.45,
};
const COND_MAX_FLOAT: Record<Condition, number> = {
  [Condition.FactoryNew]:    0.07,
  [Condition.MinimalWear]:   0.15,
  [Condition.FieldTested]:   0.38,
  [Condition.WellWorn]:      0.45,
  [Condition.BattleScarred]: 1.00,
};

function csfloatUrl(skin: { weaponName: string; patternName: string; defIndex?: number; paintIndex?: number }, condition: Condition, statTrak: boolean): string {
  if (skin.defIndex != null && skin.paintIndex != null) {
    const minF = COND_MIN_FLOAT[condition];
    const maxF = COND_MAX_FLOAT[condition];
    // quality=12 = StatTrak, quality=3 = normal
    const quality = statTrak ? '12' : '3';
    return `https://csfloat.com/search?category=1&sort_by=lowest_price&type=buy_now` +
           `&def_index=${skin.defIndex}&paint_index=${skin.paintIndex}` +
           `&quality=${quality}` +
           `&min_float=${minF}&max_float=${maxF}`;
  }
  // Fallback: /db?name= (opens CSFloat database tab)
  const prefix = statTrak ? 'StatTrak™ ' : '';
  const hashName = `${prefix}${skin.weaponName} | ${skin.patternName} (${COND_LABEL[condition]})`;
  return `https://csfloat.com/db?name=${encodeURIComponent(hashName)}`;
}

let _scanPriceSource: 'steam' | 'csfloat' = 'csfloat';

function serializeResult(r: EvaluatedTradeUp) {
  // Deduplicate inputs by skin+condition
  const inputMap = new Map<string, {
    skinId: string; name: string; collection: string; condition: Condition; count: number; statTrak: boolean;
    priceUsd: number; inputFloat: number; minFloat: number; maxFloat: number;
    marketUrl: string; csfloatUrl: string; dmarketUrl: string; csMoneyUrl: string; hashName: string;
  }>();
  for (const inp of r.inputs) {
    const k = `${inp.skin.id}:${inp.condition}`;
    const ex = inputMap.get(k);
    if (ex) { ex.count++; }
    else {
      inputMap.set(k, {
        skinId: inp.skin.id,
        name: inp.skin.name,
        collection: getCollectionName(inp.skin.collectionId),
        condition: inp.condition,
        count: 1,
        statTrak: inp.statTrak,
        priceUsd: inp.priceCents / 100,
        inputFloat: parseFloat(inp.estimatedFloat.toFixed(4)),
        minFloat: inp.skin.minFloat,
        maxFloat: inp.skin.maxFloat,
        marketUrl: steamMarketUrl(inp.skin.weaponName, inp.skin.patternName, inp.condition, inp.statTrak),
        csfloatUrl: csfloatUrl(inp.skin, inp.condition, inp.statTrak),
        dmarketUrl: dmarketSearchUrl(
          buildMarketHashName(inp.skin.weaponName, inp.skin.patternName, inp.condition, inp.statTrak),
          inp.condition,
        ),
        csMoneyUrl: csMoneySearchUrl(
          buildMarketHashName(inp.skin.weaponName, inp.skin.patternName, inp.condition, inp.statTrak),
          inp.condition,
        ),
        hashName: buildMarketHashName(inp.skin.weaponName, inp.skin.patternName, inp.condition, inp.statTrak),
      });
    }
  }

  const contractSize = r.inputs.length; // 5 for knife/glove, 10 for regular

  const feeRate = _scanPriceSource === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
  return {
    roi: parseFloat(r.roi.toFixed(2)),
    profitUsd: r.expectedProfitCents / 100,
    evUsd: r.expectedValueAfterTaxCents / 100,
    costUsd: r.totalInputCostCents / 100,
    feeRate,
    inputRarity: RARITY_NAMES[r.inputRarity],
    outputRarity: RARITY_NAMES[r.outputRarity],
    inputCondition: r.inputCondition,
    inputFloat: parseFloat(r.inputFloat.toFixed(4)),
    floatMode: r.floatMode,
    requiredFloatNote: r.requiredFloatNote,
    contractSize,
    inputs: [...inputMap.values()],
    outputs: r.outputs
      .sort((a, b) => b.priceCents - a.priceCents)   // sort by price desc
      .map(o => {
        const statTrak = r.inputs[0]?.statTrak ?? false;
        // Detect Doppler variants — CSFloat aggregates all phases under one name.
        // The price shown is the minimum across Phase 1–4 (cheapest phases).
        // Ruby/Sapphire/Black Pearl/Emerald command much higher prices.
        const isDoppler = /\bDoppler\b/i.test(o.skin.patternName);
        return {
          name: o.skin.name,
          collection: getCollectionName(o.skin.collectionId),
          condition: o.condition,
          probability: parseFloat((o.probability * 100).toFixed(2)),
          priceUsd: o.priceCents / 100,
          statTrak,
          float: parseFloat(o.estimatedFloat.toFixed(4)),
          minFloat: o.skin.minFloat,
          maxFloat: o.skin.maxFloat,
          isDoppler,
          // hasPhasePrices: true when we have per-phase prices (API key set)
          hasPhasePrices: isDoppler && !!config.csfloatApiKey,
          defIndex: o.skin.defIndex ?? null,
          paintIndex: o.skin.paintIndex != null ? Number(o.skin.paintIndex) : null,
          marketUrl: steamMarketUrl(o.skin.weaponName, o.skin.patternName, o.condition, statTrak),
          csfloatUrl: csfloatUrl(o.skin, o.condition, statTrak),
          dmarketUrl: dmarketSearchUrl(
            buildMarketHashName(o.skin.weaponName, o.skin.patternName, o.condition, statTrak),
            o.condition,
          ),
          csMoneyUrl: csMoneySearchUrl(
            buildMarketHashName(o.skin.weaponName, o.skin.patternName, o.condition, statTrak),
            o.condition,
          ),
          hashName: buildMarketHashName(o.skin.weaponName, o.skin.patternName, o.condition, statTrak),
        };
      }),
  };
}
