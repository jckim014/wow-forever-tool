import defaults from '../../data/config/defaults.json'
import deTable from '../../data/config/de-table.json'
import { makeConfig, type Config, type DeBand, type GameData, type Settings } from './model'

export const config: Config = makeConfig(
  defaults as { settings: Settings; cooldownCrafts: Config['cooldownCrafts'] },
  deTable as { bands: DeBand[] },
)

export async function loadGameData(): Promise<GameData> {
  const res = await fetch(`${import.meta.env.BASE_URL}game-data.json`)
  if (!res.ok) throw new Error(`Could not load game data (HTTP ${res.status}).`)
  return res.json()
}
