// Writes ApiPrices.lua into the BavvbScan addon folder now (the sync does it after each new snapshot).
// Run: node --disable-warning=ExperimentalWarning collector/write_addon_prices.mjs
import path from 'node:path';
import { openDb } from './marketDb.mjs';
import { ADDON_DIR, writeAddonPrices } from './addonPrices.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const db = openDb(path.join(root, 'market.db'));
try {
  const t0 = Date.now();
  const n = writeAddonPrices(db);
  console.log(`ApiPrices.lua in ${ADDON_DIR}: ${Object.entries(n).map(([f, c]) => `${f} ${c} items`).join(', ')} (${Date.now() - t0} ms)`);
} finally {
  db.close();
}
