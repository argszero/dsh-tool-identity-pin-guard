/**
 * The identity a call is dispatched with, captured and compared without any
 * dependency on cordis or the registry.
 *
 * The registry hands `tools/pre-execute` listeners the live execution object and
 * documents the fields on it as `readonly` — *"call identity, the caller signal,
 * and the registry-assigned token are readonly"* — while the object itself is a
 * plain writable literal (`packages/core/tools/src/index.ts`, `createExecution`:
 * `const execution = { ...base, arguments: deepFreeze(detached) }`). Only the
 * arguments are frozen. So a listener that writes `exec.name` compiles, runs, and
 * changes which tool the registry dispatches — the type is a contract, and the
 * runtime is not.
 *
 * This module is the part of the guard that has no opinion about cordis: which
 * fields are read after the waterfall, what their values were, and whether they
 * still are. Everything here is pure; the capture is an immutable map, the
 * comparison returns descriptions rather than touching the object, and the write
 * back is the only side effect, in one function, so a test can assert that
 * nothing else in the plugin mutates the call.
 *
 * @module @argszero/dsh-tool-identity-pin-guard/identity
 */

/**
 * The identity fields the registry reads **after** the `tools/pre-execute`
 * waterfall settles. Each one is a real read site, not a guess:
 *
 * - `name` — `resolveExecution(exec.name, …)` at dispatch, at post-execute, and
 *   in the finalize path; also the name the approval prompt shows.
 * - `agent` — `scopeTarget(this, exec.agent)`: the carrier for `tools/execute`,
 *   for `tools/post-execute` and for the `tools/result` notification, plus the
 *   scope key of the lookup and the session an approval is routed through.
 * - `parent` — the `nested` flag of that same lookup (`exec.parent !== undefined`),
 *   which is the `ptc` collapse's own input.
 * - `callId` — carried into the approval request and into the success result.
 * - `token` — the canonical-result identity (`canonicalResults.set(result, exec.token)`),
 *   which is how a result is recognized as its own.
 * - `signal` — read by the dispatch stage, which fuses it with the captured
 *   caller signal.
 *
 * Deliberately **not** compared: `rootCallId` and `schema`. Both are read only
 * while the execution is being created, so drift in them is inert — including
 * them would inflate the report with changes that cannot matter.
 */
export const PINNED_FIELDS = ['name', 'agent', 'parent', 'callId', 'token', 'signal'] as const

/** One field of the pinned set. */
export type PinnedField = (typeof PINNED_FIELDS)[number]

/** Whether `value` names a field this plugin pins. */
export function isPinnedField(value: string): value is PinnedField {
  return (PINNED_FIELDS as readonly string[]).includes(value)
}

/** A field's value at capture time, and whether the property existed at all. */
export interface Captured {
  /** The captured value; only meaningful when {@link present}. */
  readonly value: unknown
  /** Whether the property existed on the object when it was captured. */
  readonly present: boolean
}

/** One capture: every pinned field's value at the moment the frame opened. */
export type IdentityCapture = ReadonlyMap<PinnedField, Captured>

/** One field that changed while the downstream waterfall was running. */
export interface Drift {
  /** The field that changed. */
  readonly field: PinnedField
  /** Its value when this frame opened, rendered for a reader. */
  readonly from: string
  /** Its value when the downstream waterfall settled. */
  readonly to: string
}

/** Whether `target` owns `field` (never inherited, never through a prototype). */
function owns(target: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, field)
}

/** Read one field off an object without trusting its type to describe it. */
function read(target: object, field: string): unknown {
  return (target as Record<string, unknown>)[field]
}

/**
 * A stable, readable name for a value that is usually an object identity.
 *
 * Two calls to the same labeller give the same object the same label, so a drift
 * report can say `Agent#2` became `Agent#5` and a test can assert exactly that.
 * A label is not an equality check — the comparison is by identity — it exists so
 * a human reading the log can tell *which* two things are being talked about.
 * @returns a function mapping a value to a short label.
 */
export function createLabeller(): (value: unknown) => string {
  const seen = new WeakMap<object, number>()
  let next = 0

  const label = (value: unknown): string => {
    if (value === undefined) return 'absent'
    if (value === null) return 'null'
    const type = typeof value
    if (type === 'string') return JSON.stringify(value)
    if (type === 'symbol') return value.toString()
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
    if (type !== 'object' && type !== 'function') return type
    const object = value as object
    let id = seen.get(object)
    if (id === undefined) {
      next += 1
      id = next
      seen.set(object, id)
    }
    return `${kindOf(object, type)}#${id}${detailOf(object)}`
  }
  return label
}

/** The constructor name of an object, or a generic word when it has none. */
function kindOf(object: object, type: string): string {
  if (type === 'function') return 'function'
  const constructor: unknown = (object as { constructor?: unknown }).constructor
  const name = typeof constructor === 'function' && typeof constructor.name === 'string' ? constructor.name : ''
  return name === '' || name === 'Object' ? 'Object' : name
}

/**
 * A best-effort readable detail for an object that carries one — the session id
 * behind an agent, so an operator can tell two agents apart in the report.
 *
 * Every step is guarded: these are foreign objects, a getter that throws is not
 * a reason to fail a tool call, and a missing detail is not a defect.
 */
function detailOf(object: object): string {
  try {
    const session: unknown = (object as { session?: unknown }).session
    if (session === null || typeof session !== 'object') return ''
    const id: unknown = (session as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? `(session=${id})` : ''
  } catch {
    return ''
  }
}

/**
 * Capture the pinned fields of a call before the downstream waterfall runs.
 * @param target - the live execution object.
 * @param fields - the fields to capture.
 * @returns one immutable entry per field.
 */
export function capture(target: object, fields: readonly PinnedField[]): IdentityCapture {
  const captured = new Map<PinnedField, Captured>()
  for (const field of fields) {
    const present = owns(target, field)
    captured.set(field, { value: present ? read(target, field) : undefined, present })
  }
  return captured
}

/**
 * Compare a capture against the object it came from.
 *
 * A field has drifted when its value is a different value, **or** when the
 * property appeared or disappeared. The second case is not decoration: `agent`
 * and `parent` are optional at creation, so `delete exec.parent` is a real
 * retarget (it turns a nested sub-dispatch into a model-direct call) that a
 * value comparison alone would report as `undefined → undefined`.
 * @param captured - the capture made when the frame opened.
 * @param target - the same object, read now.
 * @param label - renders values for the report.
 * @returns one entry per drifted field, in the pinned order.
 */
export function drift(
  captured: IdentityCapture,
  target: object,
  label: (value: unknown) => string,
): Drift[] {
  const found: Drift[] = []
  for (const [field, before] of captured) {
    const present = owns(target, field)
    const now = present ? read(target, field) : undefined
    if (present === before.present && now === before.value) continue
    found.push({ field, from: label(before.value), to: label(now) })
  }
  return found
}

/**
 * Write the captured identity back onto the call.
 *
 * This is the plugin's whole remedy: the registry reads `exec.name`,
 * `exec.agent` and `exec.parent` *after* the waterfall returns, so a value
 * restored here is the value it dispatches with, the value the approval prompt
 * shows, and the value the post-execute listeners see. The write is deliberately
 * narrow — only the fields that actually drifted, only when the property existed
 * before the same way it exists now.
 * @param captured - the capture made when the frame opened.
 * @param target - the object to restore.
 * @param fields - the fields to restore.
 * @returns the fields actually written back.
 */
export function restore(
  captured: IdentityCapture,
  target: object,
  fields: readonly PinnedField[],
): PinnedField[] {
  const written: PinnedField[] = []
  for (const field of fields) {
    const before = captured.get(field)
    if (before === undefined) continue
    const present = owns(target, field)
    const now = present ? read(target, field) : undefined
    if (present === before.present && now === before.value) continue
    if (before.present) (target as Record<string, unknown>)[field] = before.value
    else if (present) delete (target as Record<string, unknown>)[field]
    written.push(field)
  }
  return written
}
