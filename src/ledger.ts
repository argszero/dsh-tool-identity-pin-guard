/**
 * The plugin's memory: how many calls it inspected, how many drifts it saw, and
 * the most recent ones.
 *
 * A guard that only logs is a guard whose findings are gone by the time anyone
 * asks. This ledger is what the report tool answers from, and it exists so the
 * first question an operator asks — *is anything in this deployment rewriting
 * calls?* — has an answer that does not require reproducing the incident.
 *
 * The denominator matters as much as the numerator: `inspections` counts every
 * call this plugin's frame opened on, so "0 drifts" can be told apart from
 * "the listener never ran".
 *
 * @module @argszero/dsh-tool-identity-pin-guard/ledger
 */

import type { Drift, PinnedField } from './identity.ts'

/** One observed drift, as the report tool shows it. */
export interface DriftEvent {
  /** The inspection ordinal this drift happened on. */
  readonly inspection: number
  /** The tool name the call was created with — never the mutated one. */
  readonly tool: string
  /**
   * What drifted, with both values.
   *
   * The values are carried rather than only the field names because the question
   * the report exists to answer is "rewritten into *what*" — a field name alone
   * cannot tell an operator whether a deployment is doing something benign.
   */
  readonly drifts: readonly Drift[]
  /** The decision the downstream waterfall returned. */
  readonly decision: string
  /** The fields this plugin wrote back, which is empty in `report` and `deny` mode. */
  readonly restored: readonly PinnedField[]
}

/** A read of the ledger's current contents. */
export interface LedgerSnapshot {
  /** How many calls the plugin's frame opened on. */
  readonly inspections: number
  /** How many of those drifted. */
  readonly drifts: number
  /** Drift counts per field, in the pinned order. */
  readonly byField: readonly { readonly field: PinnedField; readonly count: number }[]
  /** The retained drifts, oldest first. */
  readonly recent: readonly DriftEvent[]
  /** How many drifts fell out of the retained window. */
  readonly dropped: number
  /** How this plugin was configured in this deployment. */
  readonly mode: string
  /** The fields this deployment pins. */
  readonly fields: readonly PinnedField[]
}

/** The write side of the ledger. */
export interface Ledger {
  /** Count one inspected call and return its ordinal. */
  inspect(): number
  /** Record one drift. */
  record(event: DriftEvent): void
  /** Read the current contents. */
  snapshot(): LedgerSnapshot
  /** Forget every count and every retained drift. */
  clear(): void
}

/**
 * Create a ledger retaining at most `max` drifts.
 * @param max - how many drift events to keep.
 * @param mode - the configured posture, reported alongside the counts.
 * @param fields - the pinned fields, reported alongside the counts.
 * @returns the ledger.
 */
export function createLedger(max: number, mode: string, fields: readonly PinnedField[]): Ledger {
  let inspections = 0
  let drifts = 0
  let dropped = 0
  const counts = new Map<PinnedField, number>()
  let recent: DriftEvent[] = []

  return {
    inspect(): number {
      inspections += 1
      return inspections
    },
    record(event: DriftEvent): void {
      drifts += 1
      for (const entry of event.drifts) counts.set(entry.field, (counts.get(entry.field) ?? 0) + 1)
      recent.push(event)
      if (recent.length > max) {
        dropped += recent.length - max
        recent = recent.slice(recent.length - max)
      }
    },
    snapshot(): LedgerSnapshot {
      return {
        inspections,
        drifts,
        byField: fields.map(field => ({ field, count: counts.get(field) ?? 0 })),
        recent,
        dropped,
        mode,
        fields,
      }
    },
    clear(): void {
      inspections = 0
      drifts = 0
      dropped = 0
      counts.clear()
      recent = []
    },
  }
}
