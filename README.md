# @argszero/dsh-tool-identity-pin-guard

Pins a tool call to the identity it was created with, so the call that runs is
the call that was approved.

A `tools/pre-execute` listener is handed the registry's live execution object,
whose identity fields are documented `readonly` and are not. A listener that
writes to them changes which tool is dispatched, in which agent's scope, under
which nested-dispatch rule, under which call id an approval is routed, and under
which token a result is recognised — after every policy listener has already
approved the original call. This plugin captures those fields in the outermost
`tools/pre-execute` frame, and writes them back before the registry reads them.

One report, one mechanism, one seam:
[#9279](https://github.com/deepseek-ai/deepseek-harness/discussions/9279) —
*"dsh-tools: createExecution identity is mutable until final notification —
pre-execute listeners can retarget calls"*.

## The problem

The registry creates one execution object per call, at
`packages/core/tools/src/index.ts`:

```ts
const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
```

The asymmetry in that single line is the whole defect: the parsed arguments are
deep-frozen, and the identity is not. The types say otherwise — `ToolExecution`
documents the contract twice:

```
 * … call identity, the caller signal, and the registry-assigned {@link token} are
 * readonly. The registry freezes the complete object before `tools/result`
 * observers run.
```

```
 * … wrappers may change only `exec.signal`, while call identity remains immutable
```

A `readonly` field is erased at compile time. The object is a plain writable
literal — the only `Object.freeze` on it happens in `notifyResult`, after every
stage that reads it has read it. So `exec.name = 'other_tool'` inside a
`tools/pre-execute` listener type-checks, runs, and changes what the registry
does.

The control arm of this package's own suite measures exactly that, on the
shipped registry and with nothing mounted:

```js
world({ plugin: false, mutate: exec => { exec.name = 'beta' } })   // call 'alpha'
ranTools(harness)  // → ['beta']
```

### Where the rewritten values are read

The waterfall settles **first**; the reads happen afterwards. Every row below is
a read site in the current registry, not a guess:

| read | where | effect of a rewrite |
|---|---|---|
| `exec.name`, `exec.agent`, `exec.parent` | `resolveExecution(…)` at dispatch (`index.ts`), also in the guard path | a different tool, resolved in a different agent scope, under a different nested-dispatch rule |
| `exec.agent` | `scopeTarget(this, exec.agent)` for the `tools/execute` waterfall | which around-dispatch listeners the call reaches |
| `exec.name`, `exec.agent`, `exec.callId`, `exec.signal` | the approval request (`approval.request({ agent, toolName, callId, signal })`) | the operator approves a tool name that is not the one about to run |
| `exec.agent` | `scopeTarget(this, exec.agent)` for `tools/result` and for `tools/post-execute` | who observes the outcome |
| `exec.token` | `canonicalResults.set(result, exec.token)` | the identity a result is recognised by |

Two of these are the ones worth pausing on. The **guard** is consulted *after*
the waterfall — `decision.kind === 'allow' ? this.guardReason(exec) : …` — and it
resolves the same rewritten object, so the guard and the dispatch agree with each
other while both disagree with what the pre-execute listeners approved. And the
**approval prompt** is built from the object after the waterfall, so a rewritten
`name` asks a human to approve one tool while another one runs.

## The seam

`tools/pre-execute` is a cordis waterfall, and a waterfall runs its listeners
**outermost-first** (`vendor/cordis/src/events.ts`: *"Listeners run
outermost-first; a listener that does not call `next()` vetoes the rest of the
chain"*), while `{ prepend: true }` registers at the front of the hook list
(`register()`: `const method = options.prepend ? 'unshift' : 'push'`).

So the outermost frame is the last to see the decision and the first to have a
capture. Its `await next()` returns only after every inner listener and the
built-in allow have settled, and the registry has not read the object yet.
Restoring the captured fields inside that frame is therefore enough to make the
resolver, the approval prompt, the guards, the `tools/execute` carriers and the
result notification use the identity the call was created with.

That frame is also the right place for the other response: returning
`{ kind: 'deny', reason }` from it refuses the call before any approval prompt is
raised.

## Install

```sh
npm install @argszero/dsh-tool-identity-pin-guard
```

Mount it in a dsh profile like any other plugin, or apply the bundle patch this
package ships:

```yaml
- insert:
    - id: tool-identity-pin-guard
      name: '@argszero/dsh-tool-identity-pin-guard'
      config:
        mode: pin
```

The plugin declares `dsh.bundle.patch`, so `cordis.patch.yml` is what the harness
applies; the file carries the source anchors this README cites.

## Configuration

| option | default | meaning |
|---|---|---|
| `mode` | `'pin'` | `pin` restores the captured identity; `report` counts and logs the drift and changes nothing; `deny` refuses the call; `off` installs no listener |
| `fields` | every field the registry reads after the waterfall: `name`, `agent`, `parent`, `callId`, `token`, `signal` | which fields to pin; unknown names are rejected and reported, never silently honoured |
| `report` | `true` | register the read-only `tool_identity_drift_report` tool |
| `maxReported` | `50` | how many drifts the in-memory report retains |
| `messageMaxChars` | `4000` | cap on the length of a denial's explanation |

`report` is how a deployment is measured before the guard is trusted with it:
it decides and counts exactly as `pin` would and writes nothing. `deny` is for a
deployment that would rather fail a call than run it after something tried to
rewrite it — and it is worth knowing that `pin` already makes such a call safe,
so `deny` is about being told, not about being protected.

`mode: 'off'` installs no listener *and still registers the report tool*, whose
one job in that posture is to say that the guard is off. "Why is nothing being
guarded?" is a question a deployment asks exactly once, usually after an
incident.

## The report

The `tool_identity_drift_report` tool answers the question a guard exists to
answer — *is anything in this deployment rewriting calls?* — without reproducing
the incident:

```
tool-identity-pin-guard · mode=pin · fields=name,agent,parent,callId,token,signal

inspected: 42 call(s)   drifted: 1   outside the retained window: 0

by field:
  name     1

recent drifts (1 retained, oldest first):
  inspection 41 · tool "read_file" · decision allow · name: "read_file" → "bash" · restored name
```

(Verbatim output of the suite's own harness: forty ordinary calls, one call whose
name a listener rewrote to `bash` and which ran as `read_file` anyway, then this
report — 42 inspections because the report call is a tool call too.)

The **denominator** is the part that makes it usable: `inspected` counts every
call this plugin's frame opened on, so `drifted: 0` can be told apart from "this
listener never ran". A report on a deployment with no tool activity says so in
those words rather than claiming a clean bill of health.

`clear: true` reports the current contents and then forgets them, which is how a
deployment is re-measured after a change.

## Honest boundaries

- **It cannot make the object immutable.** That is the upstream fix, and it is
  the right one — the type says `readonly` and the runtime should agree. This is
  a guard, not a patch.
- **It reaches only the pre-execute window.** A rewrite performed from inside a
  `tools/execute` wrapper, or by anything holding the object afterwards, is
  beyond this frame; the `Object.freeze` in `notifyResult` is the only later
  boundary.
- **Mount order decides, and `prepend` is a race.** `prepend` puts this listener
  at the front of the list, so a listener registered with `prepend` *after* this
  one sits outside its frame and wins. Both orderings are measured in the suite:
  the guard is outermost against listeners mounted before it, and loses to one
  prepended after it. It reports nothing in the second case rather than claiming
  a clean deployment.
- **It observes drifts that happen while it is mounted.** A rewrite that also
  unmounts it is not observed.
- **A hostile capture is let through.** If reading the call identity throws
  (a proxy, a throwing accessor), the capture fails, the call proceeds unguarded,
  and the attempt is logged and counted — because a guard whose bug breaks every
  tool call in a deployment is a worse failure than the one it prevents.
- **It is a second line, not the first.** Anything that can rewrite the call can
  equally well run before this plugin. The upstream fix is the one that closes
  the window; this one makes the window visible and expensive.

## Tests

`npm test` runs the suite against the real `ToolRuntime` from
`@deepseek-ai/dsh-tools` and a real cordis context — the pipeline under test is
the shipped one, and every end-to-end arm runs **twice**, with and without the
plugin, because a single run cannot tell "the rewrite was undone" from "the
rewrite never took effect".

```sh
npm test                  # unit + end-to-end arms
npm run test:inject       # defect injection: mutate, rebuild, require the suite to catch it
npm run test:probe-lines  # pin each supported line, install it, assert the pins took, run the suite
```

`test:inject` is the one worth reading. Each arm removes exactly one distinction
this package claims in prose, rebuilds `lib/`, and requires the suite to go red;
an arm that leaves the suite green is reported as SILENT, which is a failure of
the harness rather than a pass. The arms a defect would most plausibly take are
the ones where the guard still *looks* like it works: a frame that captures and
compares and never writes back, a frame one position too deep that sees no drift
and reports a clean deployment, or a value-only comparison that misses a field
which appeared or vanished.

## Compatibility

This plugin reads the tool registry's `tools/pre-execute` waterfall and its
`PreToolDecision` / `ToolExecution` types, so its peer range names the lines it
was verified against — every one of them pinned and run, not inferred:

- `@deepseek-ai/dsh-tools`: `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0`
- `@deepseek-ai/cordis`: `^4.0.2`

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines (`npm run
test:probe-lines` pins every harness package to one line, asserts the pins took,
and runs the suite against it). Each `||` segment's floor is the build that was
actually run, so the range and the probed set are the same set — a line this
plugin has not been run on is a line it does not claim.

One value import is real and is declared as a **peer**, not a dependency:
`defineTool` (and the pipeline's types) come from `@deepseek-ai/dsh-tools`. The
distinction is the whole point. A bare `dependencies` entry is how a plugin ends
up in a `profile` deployment with its *own* copy of the registry's package —
a second evaluation of the module, whose classes and symbols are equal to nothing
the host holds, a failure this repository has already shipped more than once. A
peer range installs beside whatever the deployment already resolved, and the range
is what keeps the type the plugin is compiled against and the registry it talks to
the same one.

## License

MIT
