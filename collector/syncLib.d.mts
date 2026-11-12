// Types for the parts of syncLib.mjs that the app's tests import (app/src/history/collectorSummary.test.ts).
export type SummaryRow = [lowest: number, median: number, cheapest15: number, units: number, listings: number];
export function summarizeUnits(byItem: Map<number, [number, number][]>): Record<string, SummaryRow>;
export function summarizeHouse(
  auctionsJson: unknown,
  commoditiesJson: unknown,
): { listings: number; bidOnly: number; items: Record<string, SummaryRow> };
