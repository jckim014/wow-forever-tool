// Profession leveling planner (pure; no UI). Money in copper, null = unpriced.
//
// Each skill point is bought with "actions": craft a recipe, optionally crafting some of its reagents yourself with
// a recipe of the same profession (e.g. Linen Cloak with its 3 bolts). Every craft in the action may give a point.
// Chance of a point at skill s with colours [orange, yellow, green, grey]: 1 below yellow, (grey - s) / (grey - yellow)
// from yellow to grey, 0 from grey. Expected cost per point = (action cost - vendor value of what it makes) / expected
// points (a craft that makes money counts as free when choosing, with fewer crafts winning). At each skill level the cheapest action among the learned recipes is used (an approximation: it treats the
// chance as fixed for the whole action). Recipes: starters (free), trainer (training cost, non-specialisation) and
// recipes whose recipe item has an AH price. Which AH recipes to buy is a greedy search: add the one that lowers the
// total most (its price included), repeat; drop trainer recipes that don't pay for their training cost. Quantities
// come from simulating the chosen route with real dice rolls (`runs` times): expected and safe (e.g. 90%) crafts.
import type { Config, IntermediateRow, Item, Money, PriceInfo, Reagent } from '../model/types'

export interface RecipeItem { id: number; name: string }

export interface LvRecipe {
  id: number
  name: string
  profession: string
  /** [orange, yellow, green, grey] */
  colors: [number, number, number, number]
  learnedat: number | null
  /** Wowhead source codes: 6 trainer, 5 vendor, 2 drop, 4 quest */
  source: number[]
  reagents: Reagent[]
  trainer?: number
  spec?: number
  starter?: boolean
  product?: number
  qtyMin?: number
  qtyMax?: number
  recipeItems?: RecipeItem[]
}

export interface LevelingData {
  recipes: LvRecipe[]
  /** items used only by leveling recipes (the rest are in game-data.json) */
  items: Record<string, Item>
}

export interface PlanInput {
  profession: string
  from: number
  to: number
  recipes: LvRecipe[]
  price: (id: number) => PriceInfo
  intermediates: Map<number, IntermediateRow>
  item: (id: number) => Item | undefined
  /** cooldown crafts (Transmute..., Mooncloth) can't be used for leveling: left out */
  cooldownCrafts?: Config['cooldownCrafts']
  /** copper added per craft when choosing recipes (your time); not in the totals. Default 100 (1s; Josh 2026-11-15), at least 1 */
  perCraft?: number
  /** share of runs the safe quantity covers (default 0.9) */
  safety?: number
  runs?: number
  seed?: number
}

export type Access = 'starter' | 'trainer' | 'ah'

export interface Learnable {
  recipe: LvRecipe
  access: Access
  /** training cost or recipe item price; 0 for starters */
  cost: number
  recipeItem: RecipeItem | null
}

export interface Component {
  maker: LvRecipe
  item: number
  qty: number
  /** maker crafts per top craft */
  crafts: number
  /** ingredients of one maker craft */
  craftCost: number
}

export interface Action {
  key: string
  recipe: LvRecipe
  /** reagents crafted yourself (skill points counted) */
  crafted: Component[]
  /** reagents bought, per top craft, at the price used (buy price, or the model's best cost for other reagents) */
  bought: { item: number; qty: number; price: number }[]
  /** cost per top craft: bought reagents + crafted reagents' ingredients */
  cost: number
  /** vendor value of what one top craft makes */
  credit: number
  recipes: number[]
}

export interface ReagentLine { item: number; qtyMean: number; qtySafe: number; price: Money }

export interface Segment {
  from: number
  to: number
  action: Action
  crafts: { mean: number; safe: number }
  makerCrafts: { recipe: LvRecipe; mean: number; safe: number }[]
  /** expected gold spent on reagents minus the vendor value of the products */
  costMean: number
  shopping: ReagentLine[]
}

export interface Plan {
  segments: Segment[]
  learn: (Learnable & { firstUsed: number; saving: number | null })[]
  /** skill levels no learnable recipe can raise (the route stops at the first) */
  gaps: number[]
  /** expected total: reagents - vendor value + training + recipe items */
  totalMean: number
  reagentsMean: number
  learnCost: number
  /** total gold in the safe share of simulated runs (the whole route, not the sum of segments) */
  totalSafe: number
  reached: { mean: number; min: number }
}

export const qtyMade = (r: LvRecipe) => ((r.qtyMin ?? 1) + (r.qtyMax ?? 1)) / 2

export function minSkill(r: LvRecipe): number {
  if (r.starter) return 1
  return r.learnedat ?? (r.colors[0] || r.colors[1])
}

/** Chance of a skill point when crafting r at skill s (0 if not yet learnable). */
export function chance(r: LvRecipe, s: number): number {
  if (s < minSkill(r)) return 0
  const [, y, , g] = r.colors
  if (s >= g) return 0
  if (s < y) return 1
  return (g - s) / (g - y)
}

export function isCooldown(r: LvRecipe, rule: Config['cooldownCrafts'] | undefined): boolean {
  if (!rule) return false
  return rule.namePrefixes.some((p) => r.name.startsWith(p)) || rule.names.includes(r.name)
}

export function learnables(recipes: LvRecipe[], profession: string, price: (id: number) => PriceInfo, cooldown?: Config['cooldownCrafts']): Learnable[] {
  const out: Learnable[] = []
  for (const r of recipes) {
    if (r.profession !== profession || r.spec || isCooldown(r, cooldown)) continue
    if (r.starter) out.push({ recipe: r, access: 'starter', cost: 0, recipeItem: null })
    else if (r.source.includes(6) && r.trainer != null) out.push({ recipe: r, access: 'trainer', cost: r.trainer, recipeItem: null })
    else {
      let best: { it: RecipeItem; p: number } | null = null
      for (const it of r.recipeItems ?? []) {
        const p = price(it.id).reagent
        if (p != null && p > 0 && (!best || p < best.p)) best = { it, p }
      }
      if (best) out.push({ recipe: r, access: 'ah', cost: best.p, recipeItem: best.it })
    }
  }
  return out
}

/** Every action for the learnable recipes: each subset of same-profession craftable reagents crafted or bought. */
export function buildActions(input: PlanInput, learn: Learnable[]): Action[] {
  const { price, intermediates, item } = input
  const makers = new Map<number, LvRecipe>()
  for (const l of learn) {
    const r = l.recipe
    if (r.product == null) continue
    const cur = makers.get(r.product)
    if (!cur || minSkill(r) < minSkill(cur)) makers.set(r.product, r)
  }
  const best = (id: number): Money => intermediates.get(id)?.best ?? price(id).reagent
  const makerCost = (m: LvRecipe): Money => {
    let c = 0
    for (const g of m.reagents) {
      const p = best(g.item)
      if (p == null) return null
      c += g.qty * p
    }
    return c
  }
  const actions: Action[] = []
  for (const l of learn) {
    const r = l.recipe
    const sell = r.product != null ? item(r.product)?.sell : undefined
    const credit = sell != null ? Math.round(sell * qtyMade(r)) : 0
    const craftable = r.reagents.filter((g) => {
      const m = makers.get(g.item)
      return m && m.id !== r.id && !m.reagents.some((x) => x.item === r.product)
    })
    const k = Math.min(craftable.length, 4)
    for (let mask = 0; mask < 1 << k; mask++) {
      const crafted: Component[] = []
      const bought: Action['bought'] = []
      let cost = 0
      let ok = true
      for (const g of r.reagents) {
        const ci = craftable.indexOf(g)
        if (ci >= 0 && ci < k && mask & (1 << ci)) {
          const m = makers.get(g.item)!
          const mc = makerCost(m)
          if (mc == null) { ok = false; break }
          const crafts = g.qty / qtyMade(m)
          crafted.push({ maker: m, item: g.item, qty: g.qty, crafts, craftCost: mc })
          cost += crafts * mc
        } else {
          const p = ci >= 0 ? price(g.item).reagent : best(g.item)
          if (p == null) { ok = false; break }
          cost += g.qty * p
          bought.push({ item: g.item, qty: g.qty, price: p })
        }
      }
      if (!ok) continue
      const recipes = [r.id, ...crafted.map((c) => c.maker.id)]
      actions.push({ key: recipes.join('+'), recipe: r, crafted, bought, cost, credit, recipes })
    }
  }
  return actions
}

export function expectedPoints(a: Action, s: number): number {
  if (s < minSkill(a.recipe)) return 0
  let e = chance(a.recipe, s)
  for (const c of a.crafted) {
    if (s < minSkill(c.maker)) return 0
    e += c.crafts * chance(c.maker, s)
  }
  return e
}

const GAP = 1e13

interface Ranked { a: Action; cpp: number }

function evaluate(levels: Ranked[][], avail: Set<number>, fixed: Map<number, number>) {
  const chosen: (Action | null)[] = []
  const used = new Set<number>()
  let total = 0
  for (const list of levels) {
    const hit = list.find((x) => x.a.recipes.every((id) => avail.has(id)))
    chosen.push(hit?.a ?? null)
    if (!hit) { total += GAP; continue }
    total += hit.cpp
    for (const id of hit.a.recipes) used.add(id)
  }
  for (const id of used) total += fixed.get(id) ?? 0
  return { total, chosen, used }
}

function rng(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0
}

export function plan(input: PlanInput): Plan {
  const { from, to, price } = input
  const safety = input.safety ?? 0.9
  const runs = input.runs ?? 2000
  const learn = learnables(input.recipes, input.profession, price, input.cooldownCrafts)
  const perCraft = Math.max(1, input.perCraft ?? 100)
  const byId = new Map(learn.map((l) => [l.recipe.id, l]))
  const actions = buildActions(input, learn)
  const levels: Ranked[][] = []
  for (let s = from; s < to; s++) {
    const list: Ranked[] = []
    for (const a of actions) {
      const e = expectedPoints(a, s)
      // a craft that makes money counts as free here (else a low chance would look better: more crafts, more
      // profit); among free ones the fewest crafts per point wins (perCraft, at least 1 copper, per craft)
      const crafts = 1 + a.crafted.reduce((t, c) => t + c.crafts, 0)
      if (e > 0) list.push({ a, cpp: (Math.max(0, a.cost - a.credit) + perCraft * crafts) / e })
    }
    list.sort((x, y) => x.cpp - y.cpp)
    levels.push(list)
  }
  const fixed = new Map(learn.map((l) => [l.recipe.id, l.cost]))
  const avail = new Set(learn.filter((l) => l.access !== 'ah').map((l) => l.recipe.id))
  const candidates = learn.filter((l) => l.access === 'ah').map((l) => l.recipe.id)
  let cur = evaluate(levels, avail, fixed)
  for (let round = 0; round < 200; round++) {
    let bestId: number | null = null
    let bestEval = cur
    let remove = false
    for (const id of candidates) {
      if (avail.has(id)) continue
      avail.add(id)
      const e = evaluate(levels, avail, fixed)
      avail.delete(id)
      if (e.total < bestEval.total - 0.5) [bestId, bestEval, remove] = [id, e, false]
    }
    for (const id of cur.used) {
      const l = byId.get(id)!
      if (l.cost === 0) continue
      avail.delete(id)
      const e = evaluate(levels, avail, fixed)
      avail.add(id)
      if (e.total < bestEval.total - 0.5) [bestId, bestEval, remove] = [id, e, true]
    }
    if (bestId == null) break
    if (remove) avail.delete(bestId)
    else avail.add(bestId)
    cur = bestEval
  }
  // what each recipe bought or trained saves: the total without it, minus the total with it
  const savingOf = (id: number): number | null => {
    if (fixed.get(id) === 0) return null
    avail.delete(id)
    const e = evaluate(levels, avail, fixed)
    avail.add(id)
    return e.total >= GAP ? null : e.total - cur.total
  }

  // segments: consecutive levels with the same action
  const gaps: number[] = []
  const segActs: { from: number; to: number; action: Action }[] = []
  cur.chosen.forEach((a, i) => {
    const s = from + i
    if (!a) { gaps.push(s); return }
    const last = segActs[segActs.length - 1]
    if (last && last.action === a && last.to === s) last.to = s + 1
    else segActs.push({ from: s, to: s + 1, action: a })
  })
  const stopAt = gaps.length ? gaps[0] : to
  const segIndex: (number | null)[] = []
  for (let s = from; s < to; s++) segIndex.push(segActs.findIndex((g) => s >= g.from && s < g.to))

  // simulation of the route with real rolls
  const rand = rng(input.seed ?? 1)
  const nSeg = segActs.length
  const tops: number[][] = segActs.map(() => [])
  const mk: number[][][] = segActs.map((g) => g.action.crafted.map(() => []))
  const totals: number[] = []
  const reachedAll: number[] = []
  for (let run = 0; run < runs; run++) {
    let s = from
    const top = new Array(nSeg).fill(0)
    const mc = segActs.map((g) => g.action.crafted.map(() => 0))
    const stock = new Map<number, number>()
    let gold = 0
    let steps = 0
    while (s < stopAt && steps++ < 200000) {
      const gi = segIndex[s - from]!
      const a = segActs[gi].action
      a.crafted.forEach((c, ci) => {
        while ((stock.get(c.item) ?? 0) < c.qty - 1e-9) {
          if (rand() < chance(c.maker, s)) s++
          stock.set(c.item, (stock.get(c.item) ?? 0) + qtyMade(c.maker))
          mc[gi][ci]++
        }
        stock.set(c.item, stock.get(c.item)! - c.qty)
      })
      if (rand() < chance(a.recipe, s)) s++
      top[gi]++
    }
    for (let i = 0; i < nSeg; i++) {
      const a = segActs[i].action
      tops[i].push(top[i])
      mc[i].forEach((n, ci) => mk[i][ci].push(n))
      gold += top[i] * (boughtCost(a) - a.credit) + mc[i].reduce((t, n, ci) => t + n * a.crafted[ci].craftCost, 0)
    }
    totals.push(gold)
    reachedAll.push(s)
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

  const segments: Segment[] = segActs.map((g, i) => {
    const a = g.action
    const crafts = { mean: mean(tops[i]), safe: quantile(tops[i], safety) }
    const makerCrafts = a.crafted.map((c, ci) => ({ recipe: c.maker, mean: mean(mk[i][ci]), safe: quantile(mk[i][ci], safety) }))
    const shop = new Map<number, ReagentLine>()
    const add = (id: number, m: number, sf: number, price: Money) => {
      const l = shop.get(id) ?? { item: id, qtyMean: 0, qtySafe: 0, price }
      l.qtyMean += m
      l.qtySafe += sf
      shop.set(id, l)
    }
    for (const b of a.bought) add(b.item, b.qty * crafts.mean, b.qty * crafts.safe, b.price)
    a.crafted.forEach((c, ci) => {
      for (const r of c.maker.reagents) add(r.item, r.qty * makerCrafts[ci].mean, r.qty * makerCrafts[ci].safe, bestOf(r.item, input))
    })
    const costMean = crafts.mean * (boughtCost(a) - a.credit) + makerCrafts.reduce((t, m, ci) => t + m.mean * a.crafted[ci].craftCost, 0)
    return { from: g.from, to: g.to, action: a, crafts, makerCrafts, costMean, shopping: [...shop.values()] }
  })

  const firstUsed = new Map<number, number>()
  for (const g of segActs) for (const id of g.action.recipes) if (!firstUsed.has(id)) firstUsed.set(id, g.from)
  const learnList = [...cur.used].map((id) => ({ ...byId.get(id)!, firstUsed: firstUsed.get(id)!, saving: savingOf(id) }))
    .sort((x, y) => x.firstUsed - y.firstUsed || x.recipe.name.localeCompare(y.recipe.name))
  const learnCost = learnList.reduce((t, l) => t + l.cost, 0)
  const reagentsMean = mean(totals)
  return {
    segments, learn: learnList, gaps, totalMean: reagentsMean + learnCost, reagentsMean, learnCost,
    totalSafe: quantile(totals, safety) + learnCost,
    reached: { mean: mean(reachedAll), min: Math.min(...reachedAll) },
  }
}

function bestOf(id: number, input: PlanInput): Money {
  return input.intermediates.get(id)?.best ?? input.price(id).reagent
}
const boughtCost = (a: Action) => a.bought.reduce((t, b) => t + b.qty * b.price, 0)
