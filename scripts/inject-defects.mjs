/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and this harness reports it as a
 * failure of itself rather than hiding it.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and one
 * that does not compile is reported as TYPEFAIL, because it never reached the
 * suite either.
 *
 * Every arm is a defect this package could plausibly have shipped — one
 * distinction it exists to make, removed with one edit. The arms that matter
 * most are the ones where the guard would still *look* like it works:
 *
 * - the **write back** — a guard that captures, compares and reports, and never
 *   writes anything, passes every "was the drift seen" test and protects
 *   nothing. The name arm catches it by measuring which tool ran.
 * - the **positions** — `prepend` and the frame's own `await next()` are the
 *   whole seam. A frame that runs one position too deep captures the call
 *   *after* the rewrite, sees no drift, and reports a clean deployment.
 * - the **presence rule** — a value-only comparison misses a field that appeared
 *   or vanished, which is how `delete exec.parent` becomes a model-direct call.
 * - the **fail-open** — a guard whose bug breaks working model calls is worse
 *   than the failure it prevents.
 *
 * ```sh
 * node scripts/inject-defects.mjs                 # every arm
 * node scripts/inject-defects.mjs --filter=restore
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    name: 'restore: the captured value is never written back',
    file: 'src/identity.ts',
    edits: [['    if (before.present) (target as Record<string, unknown>)[field] = before.value',
      '    if (before.present) void before.value']],
  },
  {
    name: 'restore: a field the deployment did not ask for is written anyway',
    file: 'src/identity.ts',
    edits: [['  const written: PinnedField[] = []\n  for (const field of fields) {',
      '  const written: PinnedField[] = []\n  for (const field of PINNED_FIELDS) {']],
  },
  {
    name: 'restore: a field that did not drift is written back anyway',
    file: 'src/identity.ts',
    edits: [['    if (present === before.present && now === before.value) continue\n    if (before.present)',
      '    if (before.present)']],
  },
  {
    name: 'restore: a property that appeared is kept instead of removed',
    file: 'src/identity.ts',
    edits: [['    else if (present) delete (target as Record<string, unknown>)[field]',
      '    else if (false) delete (target as Record<string, unknown>)[field]']],
  },
  {
    name: 'capture: whether the property existed is not recorded',
    file: 'src/identity.ts',
    edits: [['    captured.set(field, { value: present ? read(target, field) : undefined, present })',
      '    captured.set(field, { value: present ? read(target, field) : undefined, present: true })']],
  },
  {
    name: 'drift: a changed value is not compared',
    file: 'src/identity.ts',
    edits: [['    if (present === before.present && now === before.value) continue',
      '    if (present === before.present) continue']],
  },
  {
    name: 'drift: a property that appeared or vanished is not compared',
    file: 'src/identity.ts',
    edits: [['    if (present === before.present && now === before.value) continue\n    found.push(',
      '    if (now === before.value) continue\n    found.push(']],
  },
  {
    name: 'labeller: two objects are given one label',
    file: 'src/identity.ts',
    edits: [['    let id = seen.get(object)\n    if (id === undefined) {',
      '    let id: number | undefined = undefined\n    if (id === undefined) {']],
  },
  {
    name: 'labeller: a string value is rendered for a person instead of a reader',
    file: 'src/identity.ts',
    edits: [["    if (type === 'string') return JSON.stringify(value)",
      "    if (type === 'string') return String(value)"]],
  },
  {
    name: 'labeller: the session detail is read without guarding the accessor',
    file: 'src/identity.ts',
    edits: [["  } catch {\n    return ''\n  }",
      '  } catch (error: unknown) {\n    throw error\n  }']],
  },
  {
    name: 'config: a field name this plugin does not pin is pinned anyway',
    file: 'src/config.ts',
    edits: [['    } else rejected.push(name)', '    } else fields.push(name as PinnedField)']],
  },
  {
    name: 'config: a request for no fields at all is reported as a list of typos',
    file: 'src/config.ts',
    edits: [['    emptyFields: requested.length > 0 && fields.length === 0,',
      '    emptyFields: fields.length === 0,']],
  },
  {
    name: 'config: a bound is honoured without being a positive integer',
    file: 'src/config.ts',
    edits: [['  return typeof value === \'number\' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback',
      '  return typeof value === \'number\' ? value : fallback']],
  },
  {
    name: 'config: a mode this plugin does not implement is taken as configured',
    file: 'src/config.ts',
    edits: [['      mode: MODES.includes(mode) ? mode : defaultConfig.mode!,', '      mode,']],
  },
  {
    name: 'config: an unconfigured mount measures instead of pinning',
    file: 'src/config.ts',
    edits: [["  const mode = config.mode ?? defaultConfig.mode!", "  const mode = config.mode ?? 'report'"]],
  },
  {
    name: 'ledger: an inspected call is not counted',
    file: 'src/ledger.ts',
    edits: [['    inspect(): number {\n      inspections += 1', '    inspect(): number {\n      inspections += 0']],
  },
  {
    name: 'ledger: the retained window keeps the oldest drifts instead of the newest',
    file: 'src/ledger.ts',
    edits: [['        recent = recent.slice(recent.length - max)', '        recent = recent.slice(0, max)']],
  },
  {
    name: 'ledger: the retained window is unbounded',
    file: 'src/ledger.ts',
    edits: [['      if (recent.length > max) {', '      if (recent.length > 10_000_000) {']],
  },
  {
    name: 'ledger: clearing forgets the counts but keeps the drifts',
    file: 'src/ledger.ts',
    edits: [['      counts.clear()\n      recent = []', '      counts.clear()']],
  },
  {
    name: 'report: a deployment that never ran is reported as a clean one',
    file: 'src/advice.ts',
    edits: [['  if (snapshot.inspections === 0) {', '  if (snapshot.inspections === -1) {']],
  },
  {
    name: 'report: the fields that drifted are not named',
    file: 'src/advice.ts',
    edits: [['  const observed = snapshot.byField.filter(entry => entry.count > 0)',
      '  const observed = snapshot.byField.filter(entry => entry.count > 10_000_000)']],
  },
  {
    name: 'report: a drift that was not written back is not distinguished from one that was',
    file: 'src/advice.ts',
    edits: [["        + ` · restored ${event.restored.length === 0 ? 'nothing' : event.restored.join(',')}`,",
      '        + ` · restored ${event.restored.join(\',\')}`,']],
  },
  {
    name: 'denial: the refusal does not say which field was rewritten',
    file: 'src/advice.ts',
    edits: [['    renderDrifts(drifts),\n    \'\',', '    \'\',']],
  },
  {
    name: 'clamp: an over-long message is truncated without saying so',
    file: 'src/advice.ts',
    edits: [['  return text.slice(0, Math.max(0, max - note.length)) + note', '  return text.slice(0, max)']],
  },
  {
    name: 'position: the frame no longer takes the outermost pre-execute boundary',
    file: 'src/index.ts',
    edits: [["    const off = active ? ctx.on('tools/pre-execute', frame, { prepend: true }) : () => {}",
      "    const off = active ? ctx.on('tools/pre-execute', frame, { prepend: false }) : () => {}"]],
  },
  {
    name: 'mode: off mounts the listener anyway',
    file: 'src/index.ts',
    edits: [['  const active = settings.mode !== \'off\' && settings.fields.length > 0',
      '  const active = settings.fields.length > 0']],
  },
  {
    name: 'mode: report restores the identity it exists to measure',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'report') {", "  if (String(settings.mode) === '_report') {"]],
  },
  {
    name: 'mode: deny lets the call through without refusing it',
    file: 'src/index.ts',
    edits: [['    return { kind: \'deny\', reason: renderDenial(tool, found, settings.messageMaxChars) }',
      '    return decision']],
  },
  {
    name: 'fail-open: a failure while responding is thrown at the caller',
    file: 'src/index.ts',
    edits: [['      ctx.logger.warn(`tool-identity-pin-guard: failed while responding to a drift, letting the call proceed: ${String(error)}`)\n      return decision',
      '      throw error']],
  },
  {
    name: 'fail-open: a capture that failed is not reported',
    file: 'src/index.ts',
    edits: [["    const captured = tryCapture(exec, settings.fields, error => {\n      ctx.logger.warn('tool-identity-pin-guard: could not capture the call identity, letting the call proceed unguarded: '\n        + String(error))\n    })",
      '    const captured = tryCapture(exec, settings.fields, () => {})']],
  },
  {
    name: 'fail-open: a capture that threw is thrown at the caller',
    file: 'src/index.ts',
    edits: [['    onError(error)\n    return undefined', '    onError(error)\n    throw error']],
  },
  {
    name: 'report tool: clearing is asked for and not done',
    file: 'src/index.ts',
    edits: [['      if (clear) ledger.clear()', '      if (false) ledger.clear()']],
  },
  {
    name: 'report tool: the report is registered even when the report is switched off',
    file: 'src/index.ts',
    edits: [['    const tool = settings.report ? ctx.tools.register(reportTool(settings, ledger)) : undefined',
      '    const tool = ctx.tools.register(reportTool(settings, ledger))']],
  },
  {
    name: 'report tool: missing in exactly the case it exists to explain',
    file: 'src/index.ts',
    edits: [['    const tool = settings.report ? ctx.tools.register(reportTool(settings, ledger)) : undefined',
      '    const tool = settings.report && active ? ctx.tools.register(reportTool(settings, ledger)) : undefined']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm can leave the suite waiting on
 * something, and a mutant that never terminates is a mutant the suite cannot
 * report on. It is killed here and counted as caught, which is what it is — the
 * suite never reaches its assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug. Measured
  // in this family: one flat `edits: ['…', '…']` reported "the suite stayed
  // green" while the real mutation was never applied.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
