# CS2 Trade-Up Calculator

Finds **profitable CS2 trade-up contracts** by combining live market prices with the game's float and probability mechanics — so the expected value of every viable contract is computed, not guessed.

A trade-up contract converts ten skins of one rarity into a single random skin of the next rarity. Whether that gamble is +EV depends on outcome probabilities (driven by collection composition), float value propagation (input floats map to the output's wear), Steam's marketplace tax, and prices that move all day. This tool does that math across thousands of combinations.

## Features

- **Multi-source price ingestion** — Steam Market, CSFloat and Skinport, with rate-limit-aware fetching and bulk endpoints; per-phase Doppler pricing via the CSFloat API
- **Float engine** — computes the output float from input floats and each skin's min/max range, including `above_avg`/`high` float modes for cheaper inputs (covered by unit tests)
- **Contract finder & evaluator** — exhaustive scan over viable input pools (1–2 collection mixes), ranked by expected ROI after the 13% Steam tax; buy-order pricing for outputs
- **Web UI** — interactive results browser with float bars, live float editing with debounced re-evaluation, and contract verification
- **CLI** — `scan`, `sync` and `watch` commands with pretty terminal tables
- **Scheduler** — cron-based price refresh (default every 4 hours)
- **SQLite storage** — versioned price snapshots via better-sqlite3, fully reproducible results

## Quick start

```bash
npm install
npm run sync        # pull collections + initial prices into data/*.db
npm run scan        # find profitable contracts (CLI)
npm run dev web     # web UI on http://localhost:3000
npm test            # vitest — float/probability engine
```

Configuration lives in `.env` (see [.env.example](.env.example)): rate limits, refresh cron, ROI threshold, tax rate and an optional `CSFLOAT_API_KEY`.

## How the math works

1. For a candidate set of 10 inputs, outcome probabilities follow the collection ticket model: each input contributes one ticket to its collection's output pool.
2. The output float is `min + (max − min) · avgInputFloat`, evaluated per candidate output skin — so cheap high-float inputs can still land desirable wear tiers on outputs with narrow ranges.
3. Expected value = Σ p(outcome) · price(outcome, wear) · (1 − tax) − cost(inputs). Contracts are ranked by ROI, with variance shown so you can tell lottery tickets from steady earners.

## Project layout

```
src/
├── api/          # price sources: steam, csfloat (+ doppler phases), skinport, bulk endpoints, rate limiter
├── services/     # tradeup-finder, tradeup-evaluator, float-calculator, price-service, data-sync
├── db/           # better-sqlite3 schema + client
├── cli/          # commander-based commands (scan, sync, watch) + table formatters
├── web/          # express server + interactive UI (public/index.html)
└── scheduler/    # cron price refresh
```

## Disclaimer

Market prices move; nothing here is financial advice. Respect the rate limits and terms of the price sources you enable.

## License

MIT © Ondřej Úlehla
