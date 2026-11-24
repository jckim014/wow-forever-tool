// TSM's region sale data parser lives in collector/ (the cloud collector run checks out only that folder, and the sync
// uses it for sales.json); Forever Market uses it from there.
export { itemIdOf, parseRegionSale } from '../collector/tsmRegion.mjs';
