/**
 * Free-canvas positions for the inbox, persisted per library.
 *
 * Positions are stored in localStorage rather than library.json because they
 * are purely a view concern. Auto-placed import batches are flagged
 * `scatterOnly` so they keep their own region in the free canvas without
 * forcing an offset in the arranged modes (grid, colour, similar, time).
 */

export interface ManualPlacement {
  x: number
  y: number
  /** True for auto-placed import batches; only applied in scatter mode. */
  scatterOnly?: boolean
}

export type ManualPositions = Record<string, ManualPlacement>

function manualKey(libId: string): string {
  return `vault:manual:${libId}`
}

export function readManual(libId: string): ManualPositions {
  try {
    const raw = JSON.parse(localStorage.getItem(manualKey(libId)) ?? '{}') as Record<
      string,
      ManualPositions
    >
    return raw[libId] ?? {}
  } catch {
    return {}
  }
}

export function writeManual(libId: string, positions: ManualPositions): void {
  try {
    localStorage.setItem(manualKey(libId), JSON.stringify({ [libId]: positions }))
  } catch {
    /* storage full — non fatal */
  }
}
