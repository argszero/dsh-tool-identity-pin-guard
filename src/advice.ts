/**
 * The two texts this plugin produces: the one a person reads in the report tool,
 * and the one a model reads when a call is refused.
 *
 * They are written for different readers on purpose. The report is a table —
 * counts first, because the question is usually "is anything happening at all".
 * The refusal is a short paragraph that says what changed, what it would have
 * meant, and how to make the call run anyway, because a denial the model cannot
 * act on is a denial the operator has to explain by hand.
 *
 * @module @argszero/dsh-tool-identity-pin-guard/advice
 */

import type { Drift } from './identity.ts'
import type { LedgerSnapshot } from './ledger.ts'

/** One drifted field, as `name: from → to`. */
function driftLine(drift: Drift): string {
  return `${drift.field}: ${drift.from} → ${drift.to}`
}

/** The drifted fields, one per line, indented under a heading. */
export function renderDrifts(drifts: readonly Drift[]): string {
  return drifts.map(drift => `  ${driftLine(drift)}`).join('\n')
}

/**
 * Truncate a message at a character budget, saying so when it does.
 * @param text - the message.
 * @param max - the budget in characters.
 * @returns the message, or its head plus a note.
 */
export function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const note = `\n… (${text.length - max} more characters omitted)`
  return text.slice(0, Math.max(0, max - note.length)) + note
}

/**
 * The reason a call is refused in `deny` mode.
 *
 * It names the call the way the registry will: by the identity it was created
 * with, not the one that was written onto it — because the model has to
 * recognise the call it made, and the tool that would have run is the one the
 * denial is preventing.
 * @param tool - the tool name the call was created with.
 * @param drifts - what changed.
 * @param max - the character budget for the whole reason.
 * @returns the refusal text.
 */
export function renderDenial(tool: string, drifts: readonly Drift[], max: number): string {
  return clamp([
    `tool-identity-pin-guard refused this call before it ran. Its identity was rewritten while the `
      + `pre-execute pipeline was running, so the call that would have been dispatched was not the call `
      + `that was approved.`,
    '',
    `  tool: ${JSON.stringify(tool)}`,
    renderDrifts(drifts),
    '',
    `Every field above is documented readonly for listeners on this event and is read again after the `
      + `pipeline settles: the name the registry resolves, the agent scope it resolves in, the nested-dispatch `
      + `flag, the id an approval is routed with, the token a result is recognised by, and the signal the body `
      + `receives. Something mounted in this deployment writes to them.`,
    '',
    `The call is refused here rather than retried: if you did not rewrite it, the rewrite is another plugin's `
      + `and the operator needs to see it. To let such calls through, mount this plugin with mode: "report" — `
      + `the drift is logged and counted in every mode.`,
  ].join('\n'), max)
}

/**
 * The report the tool returns.
 * @param snapshot - the ledger's current contents.
 * @param note - an optional line prepended to the output (used when the ledger was cleared).
 * @returns the report text.
 */
export function renderReport(snapshot: LedgerSnapshot, note?: string): string {
  const observed = snapshot.byField.filter(entry => entry.count > 0)
  const lines = [
    ...note === undefined ? [] : [note, ''],
    `tool-identity-pin-guard · mode=${snapshot.mode} · fields=${snapshot.fields.join(',')}`,
    '',
    `inspected: ${snapshot.inspections} call(s)   drifted: ${snapshot.drifts}   outside the retained window: ${snapshot.dropped}`,
  ]
  if (snapshot.inspections === 0) {
    lines.push('', 'No call has reached this plugin\'s frame yet. A deployment with no tool activity reports zero for that reason alone.')
    return lines.join('\n')
  }
  if (snapshot.drifts === 0) {
    lines.push(
      '',
      'No drift observed. Every call reached the dispatch stage with the identity it was created with, in every field this deployment pins.',
    )
    return lines.join('\n')
  }
  lines.push('', 'by field:')
  for (const entry of observed) lines.push(`  ${entry.field.padEnd(8)} ${entry.count}`)
  lines.push('', `recent drifts (${snapshot.recent.length} retained, oldest first):`)
  for (const event of snapshot.recent) {
    lines.push(
      `  inspection ${event.inspection} · tool ${JSON.stringify(event.tool)} · decision ${event.decision}`
        + ` · ${event.drifts.map(driftLine).join('; ')}`
        + ` · restored ${event.restored.length === 0 ? 'nothing' : event.restored.join(',')}`,
    )
  }
  return lines.join('\n')
}
