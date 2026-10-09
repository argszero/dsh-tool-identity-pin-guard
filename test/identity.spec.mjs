/**
 * The unit witness: the parts of the guard that have no opinion about cordis.
 *
 * These are the distinctions the end-to-end arms cannot make one at a time —
 * a property that appeared versus one whose value changed, a label that stays
 * stable for one object and differs for two, a field list that survives a typo.
 * Each one is stated by a test rather than by a comment above it.
 *
 * @module test/identity.spec
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  PINNED_FIELDS,
  capture,
  clamp,
  createLabeller,
  createLedger,
  drift,
  normalizeConfig,
  renderReport,
  restore,
} from '../lib/index.js'

/** A call-shaped object with every pinned field present. */
function callOf(overrides = {}) {
  return {
    name: 'alpha',
    agent: { id: 'agent-a' },
    parent: Symbol('outer'),
    callId: 'call-1',
    token: Symbol('dsh.tool.execution'),
    signal: new AbortController().signal,
    arguments: Object.freeze({ note: 'test' }),
    ...overrides,
  }
}

describe('capture', () => {
  it('records every pinned field and whether the property existed', () => {
    const call = callOf()
    delete call.parent
    const captured = capture(call, PINNED_FIELDS)

    assert.equal(captured.size, PINNED_FIELDS.length)
    assert.equal(captured.get('name').value, 'alpha')
    assert.equal(captured.get('name').present, true)
    assert.equal(captured.get('parent').present, false)
    assert.equal(captured.get('parent').value, undefined)
  })

  it('captures before the object changes, which is the whole point of a capture', () => {
    const call = callOf()
    const captured = capture(call, PINNED_FIELDS)
    call.name = 'beta'

    assert.equal(captured.get('name').value, 'alpha')
    assert.equal(call.name, 'beta')
  })
})

describe('drift', () => {
  const label = createLabeller()

  it('finds nothing on an unchanged call', () => {
    const call = callOf()
    assert.deepEqual(drift(capture(call, PINNED_FIELDS), call, label), [])
  })

  it('finds a changed value', () => {
    const call = callOf()
    const captured = capture(call, PINNED_FIELDS)
    call.name = 'beta'

    assert.deepEqual(drift(captured, call, label), [{ field: 'name', from: '"alpha"', to: '"beta"' }])
  })

  it('finds a property that appeared, and one that vanished', () => {
    const call = callOf()
    delete call.parent
    const captured = capture(call, PINNED_FIELDS)

    call.parent = Symbol('other')
    assert.deepEqual(drift(captured, call, label).map(entry => entry.field), ['parent'])

    delete call.parent
    assert.deepEqual(drift(captured, call, label), [], 'a property that came back is not a drift')
  })

  it('counts a property that appeared, even when it reads the same as its absence', () => {
    const call = callOf()
    delete call.parent
    const captured = capture(call, PINNED_FIELDS)
    call.parent = undefined

    assert.deepEqual(drift(captured, call, label).map(entry => entry.field), ['parent'],
      'an own property with the value undefined is not the same shape as no property at all')
  })

  it('treats a deletion as a drift even though the value reads as undefined either way', () => {
    const call = callOf()
    const captured = capture(call, PINNED_FIELDS)
    delete call.parent

    const found = drift(captured, call, label)
    assert.equal(found.length, 1)
    assert.equal(found[0].field, 'parent')
    assert.equal(found[0].to, 'absent')
  })

  it('reports in the order the fields were captured, not in object order', () => {
    const call = callOf()
    const captured = capture(call, ['signal', 'name'])
    call.signal = new AbortController().signal
    call.name = 'beta'

    assert.deepEqual(drift(captured, call, label).map(entry => entry.field), ['signal', 'name'])
  })
})

describe('restore', () => {
  it('puts back what changed and says which fields it wrote', () => {
    const call = callOf()
    const captured = capture(call, PINNED_FIELDS)
    call.name = 'beta'
    call.callId = 'forged'

    assert.deepEqual(restore(captured, call, PINNED_FIELDS), ['name', 'callId'])
    assert.equal(call.name, 'alpha')
    assert.equal(call.callId, 'call-1')
  })

  it('writes nothing when nothing drifted', () => {
    const call = callOf()
    assert.deepEqual(restore(capture(call, PINNED_FIELDS), call, PINNED_FIELDS), [])
  })

  it('re-adds a property that was deleted, and removes one that appeared', () => {
    const call = callOf()
    delete call.parent
    const captured = capture(call, PINNED_FIELDS)

    call.parent = Symbol('invented')
    assert.deepEqual(restore(captured, call, PINNED_FIELDS), ['parent'])
    assert.equal('parent' in call, false, 'the property did not exist when the call was created, and does not now')

    const second = callOf()
    const secondCaptured = capture(second, PINNED_FIELDS)
    delete second.parent
    assert.deepEqual(restore(secondCaptured, second, PINNED_FIELDS), ['parent'])
    assert.equal(second.parent, secondCaptured.get('parent').value)
  })

  it('restores only the fields it was asked to, leaving the rest as the deployment left them', () => {
    const call = callOf()
    const captured = capture(call, PINNED_FIELDS)
    call.name = 'beta'
    call.callId = 'forged'

    assert.deepEqual(restore(captured, call, ['name']), ['name'])
    assert.equal(call.name, 'alpha')
    assert.equal(call.callId, 'forged', 'a field this deployment does not pin is not a field this plugin writes')
  })

  it('throws on a property that cannot be written, which is what the plugin catches', () => {
    const call = callOf()
    call.name = 'beta'
    Object.defineProperty(call, 'name', { value: 'beta', writable: false, configurable: true })
    const captured = capture(callOf(), ['name'])

    assert.throws(() => restore(captured, call, ['name']), TypeError)
  })
})

describe('the labeller', () => {
  it('gives one object one label and two objects two', () => {
    const label = createLabeller()
    const first = { id: 'x' }
    const second = { id: 'y' }

    assert.notEqual(label(first), label(second))
    assert.equal(label(first), label(first))
  })

  it('renders the values a reader has to compare, not JSON for everything', () => {
    const label = createLabeller()
    assert.equal(label(undefined), 'absent')
    assert.equal(label(null), 'null')
    assert.equal(label('alpha'), '"alpha"')
    assert.equal(label(Symbol('dsh.tool.execution')), 'Symbol(dsh.tool.execution)')
    assert.equal(label(7), '7')
    assert.equal(label(true), 'true')
  })

  it('names the class it was given, so a scope retarget reads as one', () => {
    class Agent {}
    const label = createLabeller()
    assert.match(label(new Agent()), /^Agent#\d+$/)
  })

  it('adds a session id when the object carries one, and survives a getter that throws', () => {
    const label = createLabeller()
    assert.match(label({ session: { id: 'session-7' } }), /\(session=session-7\)$/)

    const hostile = {}
    Object.defineProperty(hostile, 'session', {
      get() {
        throw new Error('not readable')
      },
    })
    assert.doesNotMatch(label(hostile), /session=/, 'a detail that cannot be read is a detail that is omitted')
  })
})

describe('configuration', () => {
  it('defaults to pinning every field the registry reads after the waterfall', () => {
    const { settings } = normalizeConfig()
    assert.equal(settings.mode, 'pin')
    assert.deepEqual(settings.fields, [...PINNED_FIELDS])
    assert.equal(settings.report, true)
    assert.equal(settings.maxReported, 50)
  })

  it('rejects a field name it does not pin instead of pretending to pin it', () => {
    const { settings, rejected } = normalizeConfig({ fields: ['name', 'nmae'] })
    assert.deepEqual(settings.fields, ['name'])
    assert.deepEqual(rejected, ['nmae'])
  })

  it('reports a field list that was entirely typos, which is how a guard goes silently blind', () => {
    const { settings, rejected, emptyFields } = normalizeConfig({ fields: ['nmae'] })
    assert.deepEqual(settings.fields, [])
    assert.deepEqual(rejected, ['nmae'])
    assert.equal(emptyFields, true)
  })

  it('does not call an empty request a typo', () => {
    const { emptyFields } = normalizeConfig({ fields: [] })
    assert.equal(emptyFields, false)
  })

  it('de-duplicates, and falls back on a mode or a bound it does not recognise', () => {
    assert.deepEqual(normalizeConfig({ fields: ['name', 'name'] }).settings.fields, ['name'])
    assert.equal(normalizeConfig({ mode: 'enforce' }).settings.mode, 'pin')
    assert.equal(normalizeConfig({ maxReported: 0 }).settings.maxReported, 50)
    assert.equal(normalizeConfig({ maxReported: 3.7 }).settings.maxReported, 3)
    assert.equal(normalizeConfig({ messageMaxChars: -1 }).settings.messageMaxChars, 4000)
  })
})

describe('the ledger', () => {
  const event = (inspection, fields) => ({
    inspection,
    tool: 'alpha',
    drifts: fields.map(field => ({ field, from: '"alpha"', to: '"beta"' })),
    decision: 'allow',
    restored: fields,
  })

  it('counts inspections and drifts separately, so zero can be told from never ran', () => {
    const ledger = createLedger(10, 'pin', PINNED_FIELDS)
    ledger.inspect()
    ledger.inspect()
    ledger.record(event(2, ['name']))

    const snapshot = ledger.snapshot()
    assert.equal(snapshot.inspections, 2)
    assert.equal(snapshot.drifts, 1)
    assert.equal(snapshot.mode, 'pin')
  })

  it('counts per field, in the pinned order, including the fields that never drifted', () => {
    const ledger = createLedger(10, 'pin', PINNED_FIELDS)
    ledger.record(event(1, ['agent']))
    ledger.record(event(2, ['name', 'agent']))

    assert.deepEqual(ledger.snapshot().byField, [
      { field: 'name', count: 1 },
      { field: 'agent', count: 2 },
      { field: 'parent', count: 0 },
      { field: 'callId', count: 0 },
      { field: 'token', count: 0 },
      { field: 'signal', count: 0 },
    ])
  })

  it('keeps the newest events and counts the ones that fell out', () => {
    const ledger = createLedger(2, 'pin', PINNED_FIELDS)
    for (let index = 1; index <= 5; index += 1) ledger.record(event(index, ['name']))

    const snapshot = ledger.snapshot()
    assert.deepEqual(snapshot.recent.map(entry => entry.inspection), [4, 5])
    assert.equal(snapshot.dropped, 3)
    assert.equal(snapshot.drifts, 5, 'the count is not the window: dropping an event does not un-count it')
  })

  it('clears every counter and the window', () => {
    const ledger = createLedger(2, 'pin', PINNED_FIELDS)
    ledger.inspect()
    ledger.record(event(1, ['name']))
    ledger.clear()

    const snapshot = ledger.snapshot()
    assert.equal(snapshot.inspections, 0)
    assert.equal(snapshot.drifts, 0)
    assert.equal(snapshot.dropped, 0)
    assert.deepEqual(snapshot.recent, [])
    assert.deepEqual(snapshot.byField.map(entry => entry.count), [0, 0, 0, 0, 0, 0])
  })
})

describe('the report text', () => {
  const snapshotOf = (overrides = {}) => ({
    inspections: 0,
    drifts: 0,
    byField: PINNED_FIELDS.map(field => ({ field, count: 0 })),
    recent: [],
    dropped: 0,
    mode: 'pin',
    fields: PINNED_FIELDS,
    ...overrides,
  })

  it('says the frame has not run yet, rather than claiming a clean deployment', () => {
    const text = renderReport(snapshotOf())
    assert.match(text, /No call has reached this plugin's frame yet/)
    assert.doesNotMatch(text, /No drift observed/)
  })

  it('separates "nothing drifted" from "nothing ran"', () => {
    const text = renderReport(snapshotOf({ inspections: 9 }))
    assert.match(text, /inspected: 9 call\(s\)\s+drifted: 0/)
    assert.match(text, /No drift observed/)
  })

  it('names the fields that drifted and the events that produced them', () => {
    const text = renderReport(snapshotOf({
      inspections: 9,
      drifts: 1,
      byField: PINNED_FIELDS.map(field => ({ field, count: field === 'name' ? 1 : 0 })),
      recent: [{
        inspection: 4,
        tool: 'alpha',
        drifts: [{ field: 'name', from: '"alpha"', to: '"beta"' }],
        decision: 'allow',
        restored: ['name'],
      }],
    }))
    assert.match(text, /^ {2}name {5}1$/m)
    assert.doesNotMatch(text, /^ {2}parent {3}0$/m, 'a field with nothing to report is not in the table')
    assert.match(text, /inspection 4 · tool "alpha" · decision allow · name: "alpha" → "beta" · restored name/,
      'the report says what the value was rewritten to, not only which field moved')
  })

  it('says when nothing was written back, so a report-mode deployment is not read as a broken one', () => {
    const text = renderReport(snapshotOf({
      inspections: 1,
      drifts: 1,
      mode: 'report',
      byField: PINNED_FIELDS.map(field => ({ field, count: field === 'agent' ? 1 : 0 })),
      recent: [{
        inspection: 1,
        tool: 'alpha',
        drifts: [{ field: 'agent', from: 'Object#1', to: 'Object#2' }],
        decision: 'allow',
        restored: [],
      }],
    }))
    assert.match(text, /mode=report/)
    assert.match(text, /agent: Object#1 → Object#2 · restored nothing/)
  })
})

describe('clamp', () => {
  it('leaves a short message alone and says how much it dropped', () => {
    assert.equal(clamp('short', 100), 'short')
    const clamped = clamp('x'.repeat(200), 100)
    assert.equal(clamped.length, 100)
    assert.match(clamped, /more characters omitted\)$/)
  })
})
