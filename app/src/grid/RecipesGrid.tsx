import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ColGroupDef, type GridApi, type IRowNode, type SortComparatorFn } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney, formatQty, QUALITY_NAMES } from '../format'
import type { Money, RecipeRow } from '../model'

ModuleRegistry.registerModules([AllCommunityModule])

const theme = themeQuartz.withParams({ fontSize: 13, headerFontSize: 12, spacing: 5, wrapperBorderRadius: 4 })

// Blank values sort last in both directions.
const blanksLast: SortComparatorFn = (a, b, _na, _nb, desc) => {
  const an = a === null || a === undefined || a === '', bn = b === null || b === undefined || b === ''
  if (an || bn) return an && bn ? 0 : (an ? 1 : -1) * (desc ? -1 : 1)
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
}

type Col = ColDef<RecipeRow>
type Get<T> = (r: RecipeRow) => T

function money(headerName: string, get: Get<Money>, extra: Col = {}): Col {
  return {
    headerName,
    valueGetter: (p) => (p.data ? get(p.data) : null),
    valueFormatter: (p) => formatMoney(p.value),
    filterValueGetter: (p) => (p.data && get(p.data) !== null ? get(p.data)! / 10000 : null),
    filter: 'agNumberColumnFilter',
    headerTooltip: `${headerName}. Filter values are in gold.`,
    type: 'rightAligned',
    width: 118,
    ...extra,
  }
}

const profit = (headerName: string, get: Get<Money>, extra: Col = {}): Col =>
  money(headerName, get, { cellClassRules: { 'cell-pos': (p) => p.value > 0, 'cell-neg': (p) => p.value < 0 }, ...extra })

function text(headerName: string, get: Get<string | number | null>, extra: Col = {}): Col {
  return { headerName, valueGetter: (p) => (p.data ? get(p.data) : null), filter: 'agTextColumnFilter', width: 110, ...extra }
}

function num(headerName: string, get: Get<number | null>, extra: Col = {}): Col {
  return { headerName, valueGetter: (p) => (p.data ? get(p.data) : null), filter: 'agNumberColumnFilter', type: 'rightAligned', width: 80, ...extra }
}

const detail = (c: Col): Col => ({ ...c, columnGroupShow: 'open' })

const columns: (Col | ColGroupDef<RecipeRow>)[] = [
  text('Profession', (r) => r.recipe.profession, { pinned: 'left', width: 120 }),
  text('Recipe', (r) => r.recipe.name, { pinned: 'left', width: 230, tooltipValueGetter: (p) => p.data && `Makes ${p.data.productName} (recipe ${p.data.recipe.id})` }),
  num('Skill', (r) => r.recipe.skill, { pinned: 'left', width: 72 }),
  {
    headerName: 'Result',
    children: [
      text('Best exit', (r) => r.bestExit, { width: 170, headerTooltip: 'The priced exit worth the most per craft (ties: Vendor, then Disenchant, then AH). Exits that apply but have no price yet are named in brackets.' }),
      profit('Profit at best exit', (r) => r.profitBest, { width: 128, sort: 'desc' }),
      text('Beats reagents (any exit)?', (r) => r.beatsAny, { width: 120 }),
    ],
  },
  {
    headerName: 'Reagent cost',
    openByDefault: false,
    children: [
      money('Cheapest path', (r) => r.cheapest, { headerTooltip: 'Each reagent at its best cost (crafted when cheaper and allowed). All profits use this. Filter values are in gold.' }),
      detail(money('Buy all', (r) => r.buyAll, { headerTooltip: 'Every reagent bought at its normal reagent cost. Filter values are in gold.' })),
      detail(text('Reagents priced', (r) => `${r.reagentsPriced} of ${r.recipe.reagents.length}`, { width: 90 })),
      detail(text('Use chains?', (r) => (r.useChains ? 'Yes' : 'No'), { width: 80 })),
      text('Crafted inputs', (r) => r.craftedInputs, { width: 200, comparator: blanksLast, headerTooltip: 'Reagents the cheapest path crafts instead of buying (top level only).' }),
    ],
  },
  {
    headerName: 'Vendor',
    openByDefault: false,
    children: [
      money('Vendor value per craft', (r) => r.vendorValue),
      profit('Profit vendoring', (r) => r.profitVendor),
      detail(num('Qty made', (r) => r.qtyMade, { valueFormatter: (p) => (p.value === null ? '' : formatQty(p.value)), width: 70 })),
      detail(money('Unit sell price', (r) => r.unitSell)),
      detail(money('Reagents vendor value', (r) => r.reagentsVendorValue)),
      detail(money('Gain over vendoring reagents', (r) => (r.vendorValue === null ? null : r.vendorValue - r.reagentsVendorValue))),
      detail(text('Vendor beats reagents?', (r) => r.vendorBeats, { width: 100 })),
      detail(num('Reagents w/o sell price', (r) => r.reagentsWithoutSell, { width: 90 })),
    ],
  },
  {
    headerName: 'Item / Disenchant',
    openByDefault: false,
    children: [
      money('Expected DE value (after AH cut)', (r) => r.deValue, { width: 128 }),
      profit('Profit disenchanting', (r) => r.profitDE),
      detail(text('Item', (r) => r.productName, { width: 190 })),
      detail(text('Item quality', (r) => (r.quality === null ? null : QUALITY_NAMES[r.quality] ?? String(r.quality)), { width: 90 })),
      detail(num('Item level', (r) => r.ilvl, { width: 70 })),
      detail(text('DE band', (r) => r.deBand?.band ?? 'Not disenchantable', { width: 170 })),
      detail(text('Breaks into', (r) => r.deBand?.results.map((x) => x.name).join(' / ') ?? '', { width: 220 })),
      detail(text('DE materials priced', (r) => (r.deBand ? `${r.deMaterialsPriced} of ${r.deMaterialsWithChance}` : null), { width: 90 })),
      detail(text('DE beats reagents?', (r) => r.deBeats, { width: 90 })),
    ],
  },
  {
    headerName: 'Auction house',
    openByDefault: false,
    children: [
      money('AH value per craft (after AH cut)', (r) => r.ahValue, { width: 128 }),
      profit('Profit selling on AH', (r) => r.profitAH),
      detail(money('AH price (each)', (r) => r.ahPrice)),
      detail(text('AH price source', (r) => r.ahSource, { width: 90 })),
      detail(text('AH beats reagents?', (r) => r.ahBeats, { width: 90 })),
    ],
  },
  text('Reagents', (r) => r.reagentsText, { width: 380 }),
]

export interface RecipeFilters {
  search: string
  professions: Set<string>
  minProfitGold: number | null
  hideUnpriced: boolean
}

export function RecipesGrid({ rows, filters, onCount }: { rows: RecipeRow[]; filters: RecipeFilters; onCount: (n: number) => void }) {
  const apiRef = useRef<GridApi<RecipeRow> | null>(null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const [ready, setReady] = useState(false)

  const defaultColDef = useMemo<Col>(() => ({
    sortable: true, resizable: true, comparator: blanksLast, wrapHeaderText: true, autoHeaderHeight: true,
    filterParams: { buttons: ['reset'], maxNumConditions: 1 },
  }), [])

  const isExternalFilterPresent = useCallback(() => {
    const f = filtersRef.current
    return f.hideUnpriced || f.minProfitGold !== null || f.professions.size > 0
  }, [])
  const doesExternalFilterPass = useCallback((node: IRowNode<RecipeRow>) => {
    const f = filtersRef.current, r = node.data!
    if (f.professions.size && !f.professions.has(r.recipe.profession)) return false
    if (f.hideUnpriced && r.profitBest === null) return false
    if (f.minProfitGold !== null && (r.profitBest === null || r.profitBest < f.minProfitGold * 10000)) return false
    return true
  }, [])

  useEffect(() => {
    if (ready) apiRef.current?.onFilterChanged()
  }, [filters.professions, filters.minProfitGold, filters.hideUnpriced, ready])

  return (
    <div className="grid">
      <AgGridReact<RecipeRow>
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(p) => String(p.data.recipe.id)}
        quickFilterText={filters.search}
        isExternalFilterPresent={isExternalFilterPresent}
        doesExternalFilterPass={doesExternalFilterPass}
        enableCellTextSelection
        animateRows={false}
        tooltipShowDelay={400}
        onGridReady={(e) => { apiRef.current = e.api; setReady(true) }}
        onModelUpdated={(e) => onCount(e.api.getDisplayedRowCount())}
      />
    </div>
  )
}
