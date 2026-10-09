/**
 * The end-to-end witness: the identity a call was created with is the identity
 * it is dispatched with, measured through the real registry.
 *
 * Every arm runs twice — with the plugin and without it — because a single run
 * cannot tell "the rewrite was undone" from "the rewrite never took effect". The
 * control arm is where the defect is shown to be real in the shipped registry:
 * the same mutation, the same tools, no plugin, and a different tool runs.
 *
 * The arms are the read sites, not the fields: a name rewrite is measured by
 * *which tool ran*, a scope rewrite by what the post-execute observer saw, and a
 * signal rewrite by the identity the body received. A guard that restored a
 * field nothing reads would pass a field-shaped test and protect nothing.
 *
 * @module test/pin.spec
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { REPORT_TOOL } from '../lib/index.js'
import { AGENT_A, AGENT_B, SIGNAL, logText, ranTools, resultText, run, world } from './harness.mjs'

/**
 * A rewrite aimed at the `alpha` call alone.
 *
 * The report tool is a tool call like any other, so an unscoped mutation is
 * applied to it too — which is a real deployment shape, measured on purpose in
 * one arm below, but noise in every other one.
 */
const retargetAlpha = mutate => (exec => { if (exec.name === 'alpha') mutate(exec) })

/** Read the plugin's report through the real registry. */
async function report(harness, args = {}) {
  const result = await harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: 'report-call',
    name: REPORT_TOOL,
    arguments: args,
  })
  return resultText(result)
}

describe('a rewritten tool name', () => {
  it('is what runs when nothing is mounted (the control arm)', async () => {
    const harness = await world({ plugin: false, mutate: exec => { exec.name = 'beta' } })
    const result = await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['beta'],
      'the shipped registry dispatches the rewritten name — this is the defect this plugin exists for')
    assert.equal(resultText(result), 'beta ran')
  })

  it('is restored, and the tool the call was created with runs', async () => {
    const harness = await world({ mutate: exec => { exec.name = 'beta' } })
    const result = await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['alpha'], 'the call must be dispatched under its own name')
    assert.equal(resultText(result), 'alpha ran')
    assert.match(logText(harness.logged), /pinned "alpha"/)
    assert.match(logText(harness.logged), /name: "alpha" -> "beta"/)
  })

  it('is counted, and the report names both values', async () => {
    const harness = await world({ mutate: retargetAlpha(exec => { exec.name = 'beta' }) })
    await run(harness, 'alpha')
    const text = await report(harness)

    // The report call is a tool call too, so it is inspected like any other —
    // which is why the denominator is 2 and not 1.
    assert.match(text, /inspected: 2 call\(s\)\s+drifted: 1/)
    assert.match(text, /^ {2}name {5}1$/m)
    assert.match(text, /name: "alpha" → "beta"/)
  })
})

describe('a rewritten agent scope', () => {
  it('retargets the call when nothing is mounted (the control arm)', async () => {
    const harness = await world({ plugin: false, mutate: exec => { exec.agent = AGENT_B } })
    await run(harness, 'alpha', { agent: AGENT_A })

    assert.equal(harness.observed[0].agent, AGENT_B,
      'the registry reads the scope after the waterfall, so the rewrite reaches dispatch')
  })

  it('is restored to the scope the call was created in', async () => {
    const harness = await world({ mutate: exec => { exec.agent = AGENT_B } })
    await run(harness, 'alpha', { agent: AGENT_A })

    assert.equal(harness.observed[0].agent, AGENT_A,
      'the scope the lookup resolves in, the tools/execute carriers and the approval route are all this field')
    assert.match(logText(harness.logged), /agent: Object#\d+ -> Object#\d+/)
  })
})

describe('a removed nested-dispatch token', () => {
  it('disappears from the call when nothing is mounted (the control arm)', async () => {
    const outer = Symbol('outer-execution')
    const harness = await world({ plugin: false, mutate: exec => { delete exec.parent } })
    await run(harness, 'alpha', { parent: outer })

    assert.equal(harness.observed[0].parent, undefined)
  })

  it('is restored, because the property disappearing is itself the drift', async () => {
    const outer = Symbol('outer-execution')
    const harness = await world({ mutate: exec => { delete exec.parent } })
    await run(harness, 'alpha', { parent: outer })

    assert.equal(harness.observed[0].parent, outer,
      'parent is the nested flag of the lookup; a call that loses it is no longer the sub-dispatch it was')
    assert.match(logText(harness.logged), /parent: Symbol\(outer-execution\) -> absent/)
  })
})

describe('the correlation identity', () => {
  it('is substituted when nothing is mounted (the control arm)', async () => {
    const harness = await world({
      plugin: false,
      mutate: (exec) => {
        exec.callId = 'forged-call'
        exec.token = Symbol('forged-token')
        exec.signal = new AbortController().signal
      },
    })
    await run(harness, 'alpha')

    assert.equal(harness.observed[0].callId, 'forged-call')
    assert.equal(String(harness.observed[0].token), 'Symbol(forged-token)')
    assert.notEqual(harness.observed[0].signal, SIGNAL)
  })

  it('is restored, so a result is recognised as the call that produced it', async () => {
    const harness = await world({
      mutate: (exec) => {
        exec.callId = 'forged-call'
        exec.token = Symbol('forged-token')
        exec.signal = new AbortController().signal
      },
    })
    await run(harness, 'alpha')

    assert.notEqual(harness.observed[0].callId, 'forged-call',
      'the call id an approval is routed with, and the success result carries, is the original one')
    assert.notEqual(String(harness.observed[0].token), 'Symbol(forged-token)')
    assert.equal(harness.observed[0].signal, SIGNAL, 'the body is handed the signal the caller supplied')
  })
})

describe('an ordinary call', () => {
  it('is not touched, and the report says so with a denominator', async () => {
    const harness = await world()
    await run(harness, 'alpha')
    await run(harness, 'beta')

    assert.deepEqual(ranTools(harness), ['alpha', 'beta'])
    assert.doesNotMatch(logText(harness.logged), /pinned/)
    const text = await report(harness)
    assert.match(text, /inspected: 3 call\(s\)\s+drifted: 0/)
    assert.match(text, /No drift observed/)
  })
})

describe('mode: report', () => {
  it('counts the drift and changes nothing', async () => {
    const harness = await world({
      config: { mode: 'report' },
      mutate: retargetAlpha(exec => { exec.name = 'beta' }),
    })
    await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['beta'], 'report mode observes; it does not repair')
    assert.match(logText(harness.logged), /\(report\): "alpha" reached the dispatch stage/)
    assert.match(await report(harness), /drifted: 1/)
  })
})

describe('mode: deny', () => {
  it('refuses the call, names the drift, and leaves the object as it was created', async () => {
    const harness = await world({ config: { mode: 'deny' }, mutate: exec => { exec.name = 'beta' } })
    const result = await run(harness, 'alpha')

    assert.equal(result.isError, true, 'the call must be refused')
    assert.deepEqual(harness.ran, [], 'a refused call must never reach a tool body')
    const text = resultText(result)
    assert.match(text, /tool-identity-pin-guard refused this call before it ran/)
    assert.match(text, /name: "alpha" → "beta"/)
    assert.match(text, /mode: "report"/, 'the refusal says how to let such calls through')
    assert.equal(harness.observed[0].name, 'alpha',
      'even a refused call is reported under the identity it was created with')
  })
})

describe('mode: off', () => {
  it('does not mount the listener at all', async () => {
    const harness = await world({ config: { mode: 'off' }, mutate: exec => { exec.name = 'beta' } })
    await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['beta'])
    assert.doesNotMatch(logText(harness.logged), /pinned/)
  })
})

describe('the ordering boundary', () => {
  it('is outermost even against a listener mounted before it', async () => {
    const harness = await world({ mutateBefore: exec => { exec.name = 'beta' } })
    await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['alpha'],
      'prepend puts this frame in front of the listeners mounted earlier, so the capture happens before their writes — '
      + 'without it the guard would capture the rewritten call and report a clean deployment')
  })

  it('a listener prepended after this one sits outside its frame and wins', async () => {
    const harness = await world({
      mutatePrepended: true,
      mutate: exec => { exec.name = 'beta' },
    })
    await run(harness, 'alpha')

    assert.deepEqual(ranTools(harness), ['beta'],
      'prepend inserts at the front of the hook list, so a later prepend wraps this frame — '
      + 'the outermost frame is a mount-order property, and the README says so')
    assert.doesNotMatch(logText(harness.logged), /pinned/,
      'this frame runs before that mutation, so it observes nothing — it does not silently claim otherwise')
  })
})

describe('failing open', () => {
  it('lets the call through when the capture itself cannot be taken', async () => {
    // A one-shot hostile getter: the first read is the plugin's capture, the
    // second is the registry's own. That is the shape of a proxy an operator
    // cannot control, reduced to the one read that matters.
    let armed = true
    const harness = await world({
      outer: (exec) => {
        const original = exec.name
        Object.defineProperty(exec, 'name', {
          configurable: true,
          get() {
            if (armed) {
              armed = false
              throw new Error('hostile getter')
            }
            return original
          },
        })
      },
    })
    await run(harness, 'alpha')

    assert.match(logText(harness.logged), /could not capture the call identity, letting the call proceed unguarded/)
    assert.deepEqual(ranTools(harness), ['alpha'],
      'a guard whose own work fails must not be the reason every tool call in a deployment errors')
    assert.doesNotMatch(logText(harness.logged), /failed while responding/,
      'a capture that could not be taken is a handled path, not a failure path')
    const text = await report(harness)
    assert.match(text, /inspected: 2 call\(s\)\s+drifted: 0/,
      'the call is still counted as inspected — which is the only reason "nothing drifted" can be told from "nothing ran"')
  })

  it('lets the call through when this plugin cannot write the identity back', async () => {
    const harness = await world({
      mutate: exec => {
        Object.defineProperty(exec, 'name', { value: 'beta', writable: false, configurable: true })
      },
    })
    await run(harness, 'alpha')

    assert.match(logText(harness.logged), /failed while responding to a drift, letting the call proceed/)
    assert.deepEqual(ranTools(harness), ['beta'],
      'a guard whose own work fails must not be the reason every tool call in a deployment errors')
  })
})

describe('the report tool itself', () => {
  it('clears what it just reported, and says when', async () => {
    const harness = await world({ mutate: retargetAlpha(exec => { exec.name = 'beta' }) })
    await run(harness, 'alpha')

    const before = await report(harness)
    assert.match(before, /inspected: 2 call\(s\)\s+drifted: 1/)

    const cleared = await report(harness, { clear: true })
    assert.match(cleared, /Counters cleared at .*the report below is the state before that/)
    assert.match(cleared, /drifted: 1/)

    const after = await report(harness)
    assert.match(after, /inspected: 1 call\(s\)\s+drifted: 0/,
      'the counter restarts at this very call: the frame opens before the report reads it')
    assert.match(after, /No drift observed/)
  })

  it('is protected like any other call when the rewrite is unscoped — and is not, in report mode', async () => {
    // Arm 1: a rewriter that hits every call, including this plugin's own tool.
    // In `pin` mode the report call is dispatched as the report tool anyway.
    const pinned = await world({ mutate: exec => { exec.name = 'beta' } })
    await run(pinned, 'alpha')
    const text = await report(pinned)

    assert.match(text, /inspected: 2 call\(s\)\s+drifted: 2/,
      'the report call was rewritten too, and restored, so it is still counted and still itself')
    assert.match(text,
      /inspection 2 · tool "tool_identity_drift_report" · decision allow · name: "tool_identity_drift_report" → "beta" · restored name/)

    // Arm 2: the same mutation, the same plugin, one posture apart.
    const reporting = await world({
      config: { mode: 'report' },
      mutate: exec => { exec.name = 'beta' },
    })
    await run(reporting, 'alpha')
    assert.match(await report(reporting), /missing required property "note"/,
      'in report mode nothing is written back, so even this tool\'s own call is dispatched as the tool it was rewritten to')
  })

  it('is registered under the name the plugin exports, and refuses nothing', async () => {
    const harness = await world()
    const result = await harness.ctx.tools.execute({
      signal: SIGNAL,
      callId: 'report-call',
      name: REPORT_TOOL,
      arguments: {},
    })
    assert.notEqual(result.isError, true)
  })
})

describe('mounting it in a posture the deployment did not intend', () => {
  it('names the field names it ignored, and says when nothing survived them', async () => {
    const harness = await world({ config: { fields: ['name', 'nmae'] }, mutate: exec => { exec.name = 'beta' } })
    await run(harness, 'alpha')

    assert.match(logText(harness.logged), /ignoring unknown field name\(s\) nmae/)
    assert.deepEqual(ranTools(harness), ['alpha'], 'the fields that survived the typo are still pinned')
  })

  it('says it is doing nothing when the field list was nothing but typos', async () => {
    const harness = await world({ config: { fields: ['nmae'] }, mutate: exec => { exec.name = 'beta' } })
    await run(harness, 'alpha')

    assert.match(logText(harness.logged), /ignoring unknown field name\(s\) nmae/)
    assert.match(logText(harness.logged), /no field left to pin/)
    assert.deepEqual(ranTools(harness), ['beta'], 'nothing is pinned, so nothing is restored')
  })

  it('still answers the report in mode: off, and says why it has nothing to report', async () => {
    const harness = await world({ config: { mode: 'off' } })

    const text = await report(harness)
    assert.match(text, /The guard is not mounted \(mode: off\)/)
    assert.match(text, /mode=off/)
    assert.doesNotMatch(logText(harness.logged), /pinned/)
  })

  it('registers no report tool at all when the report is switched off', async () => {
    const harness = await world({ config: { report: false } })

    assert.match(await report(harness), /unknown tool "tool_identity_drift_report"/)
  })

  it('keeps only the drifts it was told to keep, and says how many it dropped', async () => {
    const harness = await world({ config: { maxReported: 1 }, mutate: retargetAlpha(exec => { exec.name = 'beta' }) })
    await run(harness, 'alpha')
    await run(harness, 'alpha')
    await run(harness, 'alpha')

    const text = await report(harness)
    assert.match(text, /drifted: 3   outside the retained window: 2/)
    assert.match(text, /recent drifts \(1 retained, oldest first\):[\s\S]*inspection 3 · tool "alpha"/)
    assert.doesNotMatch(text, /inspection 1 · tool/)
  })
})
