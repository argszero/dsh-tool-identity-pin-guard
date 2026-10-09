/**
 * The plugin's configuration: what it pins, how loudly, and whether it refuses.
 *
 * Defaults are chosen so that mounting the plugin is a change in *behaviour you
 * cannot see until it matters* rather than a change in what the harness does:
 * `pin` restores the identity the call was approved with and lets the call run.
 * The other postures exist because a guard whose only response is silent
 * repair is a guard whose findings nobody ever reads:
 *
 * - `pin` — restore the captured identity after the downstream waterfall
 *   settles, log and count the drift, let the call proceed. The default.
 * - `report` — log and count, change nothing. For measuring whether a deployment
 *   has anything to pin before pinning it.
 * - `deny` — refuse the call, naming the field and both values. `pin` already
 *   makes the call safe; `deny` is for a deployment that would rather fail a
 *   call than run it after something tried to rewrite it.
 * - `off` — do not mount the listener at all.
 *
 * @module @argszero/dsh-tool-identity-pin-guard/config
 */

import { PINNED_FIELDS, isPinnedField } from './identity.ts'
import type { PinnedField } from './identity.ts'

/** How the plugin responds to a drift it observed. */
export type PinMode = 'pin' | 'report' | 'deny' | 'off'

/** The plugin's user-facing configuration. Every field is optional. */
export interface Config {
  /** Response posture. Defaults to `pin`. */
  mode?: PinMode
  /** Fields to pin, by name. Defaults to every field the registry reads after the waterfall. */
  fields?: readonly string[]
  /** Register the read-only report tool. Defaults to `true`. */
  report?: boolean
  /** How many drifts the in-memory report keeps. Defaults to 50. */
  maxReported?: number
  /** Cap on the length of a denial's explanation. Defaults to 4000 characters. */
  messageMaxChars?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: PinMode
  readonly fields: readonly PinnedField[]
  readonly report: boolean
  readonly maxReported: number
  readonly messageMaxChars: number
}

/** What {@link normalizeConfig} produced, and what it had to reject to do so. */
export interface Normalized {
  readonly settings: Settings
  /** Field names the caller listed that this plugin does not pin. */
  readonly rejected: readonly string[]
  /** Whether the caller asked to pin nothing at all, which disables the guard. */
  readonly emptyFields: boolean
}

/** The default configuration, exported for the manifest and for tests. */
export const defaultConfig: Config = {
  mode: 'pin',
  fields: [...PINNED_FIELDS],
  report: true,
  maxReported: 50,
  messageMaxChars: 4000,
}

const MODES: readonly PinMode[] = ['pin', 'report', 'deny', 'off']

/** A positive integer, or the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Resolve a user configuration into settings.
 *
 * Unknown field names are **rejected and reported**, never silently honoured or
 * silently ignored: a typo in this list is the difference between a guard that
 * pins the scope an approval was granted in and one that pins nothing. An empty
 * surviving list is not an error — it is how a deployment turns the guard off
 * without unmounting it — but it is reported so the caller can tell it apart
 * from a list that only contained typos.
 * @param config - the raw configuration.
 * @returns the settings and whatever had to be rejected.
 */
export function normalizeConfig(config: Config = {}): Normalized {
  const requested = config.fields ?? [...PINNED_FIELDS]
  const fields: PinnedField[] = []
  const rejected: string[] = []
  for (const name of requested) {
    if (isPinnedField(name)) {
      if (!fields.includes(name)) fields.push(name)
    } else rejected.push(name)
  }
  const mode = config.mode ?? defaultConfig.mode!
  return {
    settings: {
      mode: MODES.includes(mode) ? mode : defaultConfig.mode!,
      fields,
      report: config.report ?? true,
      maxReported: positive(config.maxReported, 50),
      messageMaxChars: positive(config.messageMaxChars, 4000),
    },
    rejected,
    emptyFields: requested.length > 0 && fields.length === 0,
  }
}
