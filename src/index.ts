/**
 * A tool call's identity can be rewritten between the moment it is approved and
 * the moment it is dispatched. This plugin closes that window.
 *
 * ## The window
 *
 * The registry creates one execution object per call and hands **the live object**
 * to every `tools/pre-execute` listener:
 *
 * ```js
 * const execution = { ...base, arguments: deepFreeze(detached) }
 * ```
 *
 * `packages/core/tools/src/index.ts`. The asymmetry in that single line is the
 * whole defect: the arguments are deep-frozen, and the identity is not. The
 * types say otherwise — `ToolExecutionInput` declares `name`, `agent`, `parent`,
 * `callId` and `signal` as `readonly`, `ToolExecution` adds a `readonly token`,
 * and the interface's own documentation states the contract twice: *"call
 * identity, the caller signal, and the registry-assigned token are readonly"*,
 * and, for the around-dispatch stage, *"wrappers may change only `exec.signal`,
 * while call identity remains immutable"*. A `readonly` field is erased at
 * compile time; the object is a plain writable literal. A listener that assigns
 * `exec.name = 'other_tool'` therefore type-checks, runs, and changes which tool
 * the registry dispatches.
 *
 * What makes it more than a curiosity is where the registry reads those fields.
 * The waterfall settles **first**, and the reads happen afterwards:
 *
 * | read | where | effect of a rewrite |
 * | --- | --- | --- |
 * | `exec.name`, `exec.agent`, `exec.parent` | `resolveExecution` at dispatch | a different tool, resolved in a different agent scope, under a different nested-dispatch rule |
 * | `exec.agent` | `scopeTarget` for `tools/execute` | the around-dispatch listeners the call reaches |
 * | `exec.name`, `exec.agent`, `exec.callId`, `exec.signal` | the approval request | the operator approves a tool name that is not the one about to run |
 * | `exec.agent` | `scopeTarget` for `tools/result` and `tools/post-execute` | the observers of the outcome |
 * | `exec.token` | `canonicalResults.set(result, exec.token)` | the identity a result is recognised by |
 *
 * A guard, meanwhile, is consulted *after* the waterfall
 * (`decision.kind === 'allow' ? this.guardReason(exec) : …`), and reads the same
 * rewritten object — so the guard and the dispatch agree with each other while
 * both disagree with what the pre-execute listeners approved.
 *
 * ## The seam this plugin uses
 *
 * `tools/pre-execute` is a cordis waterfall, and a waterfall runs its listeners
 * **outermost-first**; `{ prepend: true }` registers at the front of the hook
 * list. The outermost frame is therefore the last to see the decision and the
 * first to have a capture: its `await next()` returns only after every inner
 * listener and the built-in allow have settled, and the registry has not read
 * the object yet. Restoring the captured fields inside that frame is enough to
 * make the registry — the resolver, the approval prompt, the guards, the
 * `tools/execute` carriers and the result notification — use the identity the
 * call was created with.
 *
 * The frame is also the right place for the *other* response: returning
 * `{ kind: 'deny', reason }` from it refuses the call before any approval prompt
 * is raised, which `mode: 'deny'` does.
 *
 * ## What this plugin cannot do
 *
 * - It cannot make the object immutable. That is the upstream fix, and it is the
 *   right one; this is a guard, not a patch.
 * - It reaches only the pre-execute window. A rewrite performed from a
 *   `tools/execute` wrapper, or by anything holding the object afterwards, is
 *   beyond this frame — the `tools/result` freeze is the only later boundary.
 * - `prepend` puts a listener at the front of the list, and a listener registered
 *   with `prepend` *after* this one sits outside it. Mount order decides.
 * - It observes drifts that happen while it is mounted. A rewrite that also
 *   unmounts it is not observed.
 *
 * The residual coverage is stated rather than implied; the README's boundaries
 * section carries the same list for users.
 *
 * @module @argszero/dsh-tool-identity-pin-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { capture, createLabeller, drift, restore } from './identity.ts'
import type { Drift, IdentityCapture, PinnedField } from './identity.ts'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { createLedger } from './ledger.ts'
import type { Ledger } from './ledger.ts'
import { renderDenial, renderReport } from './advice.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-identity-pin-guard'

/** The registry this plugin listens on and registers its report tool with. */
export const inject = ['tools']

export { PINNED_FIELDS, capture, createLabeller, drift, isPinnedField, restore } from './identity.ts'
export type { Captured, Drift, IdentityCapture, PinnedField } from './identity.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { Config, Normalized, PinMode, Settings } from './config.ts'
export { createLedger } from './ledger.ts'
export type { DriftEvent, Ledger, LedgerSnapshot } from './ledger.ts'
export { clamp, renderDenial, renderDrifts, renderReport } from './advice.ts'

/** The tool name the report is read with. */
export const REPORT_TOOL = 'tool_identity_drift_report'

/** The name a call was **created** with, which is the name a reader recognizes. */
function createdName(captured: IdentityCapture, exec: ToolExecution): string {
  const entry = captured.get('name')
  return typeof entry?.value === 'string' ? entry.value : exec.name
}

/** One line naming one drift, for the log. */
function logLine(drifts: readonly Drift[]): string {
  return drifts.map(entry => `${entry.field}: ${entry.from} -> ${entry.to}`).join('; ')
}

/**
 * Capture the identity of a call, reporting rather than propagating a failure.
 *
 * The capture reads foreign objects through a documented interface; if one of
 * them is a proxy that throws, that is not a reason to fail a tool call. A
 * capture that could not be taken returns `undefined`, and the call proceeds
 * unguarded — the failure mode of a guard must never be "every call in this
 * deployment errors".
 * @param exec - the pending call.
 * @param fields - the fields to capture.
 * @param onError - called with anything the capture threw.
 * @returns the capture, or `undefined` when it could not be taken.
 */
function tryCapture(
  exec: ToolExecution,
  fields: readonly PinnedField[],
  onError: (error: unknown) => void,
): IdentityCapture | undefined {
  try {
    return capture(exec, fields)
  } catch (error: unknown) {
    onError(error)
    return undefined
  }
}

/**
 * The read-only report tool.
 *
 * It is what makes the guard's posture checkable without reproducing an
 * incident: `inspections` says whether the frame runs at all, `drifts` says
 * whether anything in the deployment rewrites calls, and the retained events say
 * which field was rewritten into which other value.
 * @param settings - the resolved configuration.
 * @param ledger - the plugin's ledger.
 * @returns the tool definition.
 */
function reportTool(settings: Settings, ledger: Ledger) {
  return defineTool({
    name: REPORT_TOOL,
    description: 'Report whether anything in this deployment rewrites a tool call\'s identity between '
      + 'approval and dispatch: how many calls this guard inspected, how many had a rewritten name, scope, '
      + 'nested-dispatch flag, call id, token or signal, and which values were involved. Reads a counter and '
      + 'changes nothing.',
    parameters: {
      clear: {
        type: 'boolean',
        description: 'Clear the counters and the retained drifts after reporting them.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const snapshot = ledger.snapshot()
      const clear = (args as { clear?: unknown }).clear === true
      const note = clear
        ? `Counters cleared at ${new Date().toISOString()}; the report below is the state before that.`
        : undefined
      const text = renderReport(snapshot, note)
      if (clear) ledger.clear()
      return `${settings.mode === 'off' ? 'The guard is not mounted (mode: off).\n\n' : ''}${text}`
    },
  })
}

/** Everything one settled frame needs to decide its response. */
interface Settled {
  readonly exec: ToolExecution
  readonly captured: IdentityCapture
  readonly decision: PreToolDecision
  readonly inspection: number
}

/**
 * Respond to what drifted, in the configured posture.
 *
 * The three postures share this one place on purpose: the capture and the
 * comparison are identical, and only the response differs, so a deployment can
 * move from measuring to pinning to refusing without changing what is measured.
 * @param settled - the settled call, its capture before the waterfall, and the decision it settled with.
 * @param ledger - the plugin's ledger.
 * @param settings - the resolved configuration.
 * @param label - renders values for the report.
 * @param warn - the plugin's logger.
 * @returns the decision this frame passes on.
 */
function respond(
  settled: Settled,
  ledger: Ledger,
  settings: Settings,
  label: (value: unknown) => string,
  warn: (message: string) => void,
): PreToolDecision {
  const { exec, captured, decision, inspection } = settled
  const found = drift(captured, exec, label)
  if (found.length === 0) return decision
  const tool = createdName(captured, exec)
  if (settings.mode === 'report') {
    ledger.record({ inspection, tool, drifts: found, decision: decision.kind, restored: [] })
    warn(`tool-identity-pin-guard (report): ${JSON.stringify(tool)} reached the dispatch stage with a rewritten identity — ${logLine(found)}`)
    return decision
  }
  // Both remaining postures restore: a refusal is also reported under the
  // identity the call was created with, so the result the model sees names the
  // call it made rather than the one something tried to substitute.
  const written = restore(captured, exec, settings.fields)
  if (settings.mode === 'deny') {
    ledger.record({ inspection, tool, drifts: found, decision: decision.kind, restored: written })
    warn(`tool-identity-pin-guard: refused ${JSON.stringify(tool)} — ${logLine(found)}`)
    return { kind: 'deny', reason: renderDenial(tool, found, settings.messageMaxChars) }
  }
  ledger.record({ inspection, tool, drifts: found, decision: decision.kind, restored: written })
  warn(`tool-identity-pin-guard: pinned ${JSON.stringify(tool)} — ${logLine(found)}; restored ${written.join(', ') || 'nothing'}`)
  return decision
}

/**
 * Mount the guard.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the mount
 * throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { settings, rejected, emptyFields } = normalizeConfig(config)
  if (rejected.length > 0) {
    ctx.logger.warn(`tool-identity-pin-guard: ignoring unknown field name(s) ${rejected.join(', ')}; `
      + `this plugin pins ${settings.fields.length === 0 ? 'nothing' : settings.fields.join(', ')}`)
  }
  if (settings.mode === 'off') {
    ctx.logger.warn('tool-identity-pin-guard: mode "off" — no listener is mounted; the report tool still answers, and says so')
  } else if (emptyFields) {
    ctx.logger.warn('tool-identity-pin-guard: no field left to pin — the guard is mounted but nothing is compared')
  }

  const label = createLabeller()
  const ledger = createLedger(settings.maxReported, settings.mode, settings.fields)
  const active = settings.mode !== 'off' && settings.fields.length > 0

  const frame = async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const inspection = ledger.inspect()
    const captured = tryCapture(exec, settings.fields, error => {
      ctx.logger.warn('tool-identity-pin-guard: could not capture the call identity, letting the call proceed unguarded: '
        + String(error))
    })
    // `next()` is never wrapped: a downstream listener's throw is the
    // registry's to handle, and swallowing it here would change what the model
    // sees. Our own work is guarded instead, and fails open.
    const decision = await next()
    if (captured === undefined) return decision
    try {
      return respond({ exec, captured, decision, inspection }, ledger, settings, label,
        message => ctx.logger.warn(message))
    } catch (error: unknown) {
      ctx.logger.warn(`tool-identity-pin-guard: failed while responding to a drift, letting the call proceed: ${String(error)}`)
      return decision
    }
  }

  ctx.effect(() => {
    const off = active ? ctx.on('tools/pre-execute', frame, { prepend: true }) : () => {}

    const tool = settings.report ? ctx.tools.register(reportTool(settings, ledger)) : undefined
    return () => {
      off()
      tool?.()
    }
  }, `tool-identity-pin-guard: pin a call to the identity it was approved with (mode: ${settings.mode})`)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
