// Group accent helper for member-created lotteries (F5). Uses the first colour of each group's
// palette from the catalog so custom lotteries blend in with the global list.
import type { Group } from '../types'
import { GROUP_PALETTE } from '../db/catalog'

export function groupAccent(group: Group): string {
  return GROUP_PALETTE[group][0]
}
