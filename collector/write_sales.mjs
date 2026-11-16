// Writes sales.json in the auction data folder now (the sync does it after each new snapshot).
// Run: node --disable-warning=ExperimentalWarning collector/write_sales.mjs
import path from 'node:path';
import { openDb } from './marketDb.mjs';
import { writeSalesFile } from './salesFile.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const db = openDb(path.join(root, 'market.db'));
try {
  const t0 = Date.now();
  const n = writeSalesFile(db, root);
  console.log(`sales.json: ${Object.entries(n).map(([h, c]) => `house ${h} ${c} items`).join(', ')} (${Date.now() - t0} ms)`);
} finally {
  db.close();
}
