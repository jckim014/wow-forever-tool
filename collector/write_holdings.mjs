// Writes a holdings-log reading by hand (the hourly sync does it by itself): node collector/write_holdings.mjs
import path from 'node:path';
import { updateHoldingsLog } from './holdings.mjs';

const dataRoot = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const wtfAccountDir = process.env.FOREVER_WTF_ACCOUNTS || 'F:\\World of Warcraft\\_forever_\\WTF\\Account';
const r = updateHoldingsLog({ wtfAccountDir, dir: path.join(dataRoot, 'holdings') });
console.log(`holdings: ${r.added} new reading(s) from ${r.accounts} TSM file(s)`);
