/**
 * The integration harness: a REAL cordis context, the REAL `ToolRuntime` from
 * `@deepseek-ai/dsh-tools`, and REAL tool definitions registered on it.
 *
 * Nothing about the seam is simulated. The plugin listens on `tools/pre-execute`;
 * this harness dispatches through `ctx.tools.execute()`, which is the registry's
 * own public entry point, so the pipeline under test — the waterfall, its
 * ordering, the resolver, the post-execute notification — is the shipped one.
 *
 * Two fabricated pieces, and both of them are the point:
 *
 * - the tool **bodies** only record that they ran, which is what lets a test
 *   assert *which tool was dispatched* rather than what a result string says;
 * - the **mutator**, a `tools/pre-execute` listener registered after the plugin
 *   that writes to the execution object. It is the shape every arm is about: a
 *   listener running inside the guard's frame, changing what the registry will
 *   read once the frame settles.
 *
 * Every arm runs twice — with the plugin and without it (`plugin: false`). The
 * control is what turns "the mutation had no effect" into "this plugin is why".
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/** The neutral signal every fabricated call carries. */
export const SIGNAL = new AbortController().signal

/** Two objects that stand in for two agents; `ScopeKey` is any object. */
export const AGENT_A = { name: 'agent-a' }
export const AGENT_B = { name: 'agent-b' }

/**
 * Mount a real context with a real tool registry, and by default this plugin.
 *
 * @param spec - `plugin: false` mounts everything except this plugin (the control
 *   arm); `config` is the plugin's configuration; `tools` names the tools to
 *   register; `mutate` is called with each pending execution from a listener
 *   registered *after* the plugin, so it runs inside the plugin's frame;
 *   `mutatePrepended: true` registers that listener with `prepend` instead,
 *   which puts it *outside* the plugin's frame — the ordering boundary.
 * @returns the context, the record of every body that ran, the log, and what the
 *   `tools/post-execute` observer saw of each call's final identity.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const ran = []
  const logged = []
  const observed = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  for (const toolName of spec.tools ?? ['alpha', 'beta']) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: `the ${toolName} tool`,
      parameters: {
        note: { type: 'string', required: true, description: 'what the call is for' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        ran.push({ tool: toolName, note: args.note })
        return `${toolName} ran`
      },
    }))
  }

  // `mutateBefore` registers before the plugin is mounted, which is what makes
  // `prepend` observable: a frame that does not prepend ends up *inside* this
  // listener and captures the call after it was already rewritten.
  if (spec.mutateBefore !== undefined) {
    const before = spec.mutateBefore
    ctx.on('tools/pre-execute', async (exec, next) => {
      before(exec)
      return next()
    })
  }

  if (spec.plugin !== false) {
    // `plugin` is this module's namespace; a loader entry mounts its **default**
    // export (`exports.default ?? exports`), and the two differ by the `Config` key.
    // `plugin: 'default'` mounts the object a profile entry actually reaches — see
    // test/mount.spec.mjs for the defect that difference hides.
    await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
  }

  // `outer` runs *before* the plugin's frame, from a listener registered after
  // it with `prepend`. That is the only position from which the execution object
  // can be armed against the plugin's own capture — the plugin's frame is
  // otherwise the first thing to see the call.
  if (spec.outer !== undefined) {
    const outer = spec.outer
    ctx.on('tools/pre-execute', async (exec, next) => {
      outer(exec)
      return next()
    }, { prepend: true })
  }

  if (spec.mutate !== undefined) {
    const mutate = spec.mutate
    if (spec.mutatePrepended === true) {
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        mutate(exec)
        return decision
      }, { prepend: true })
    } else {
      ctx.on('tools/pre-execute', async (exec, next) => {
        mutate(exec)
        return next()
      })
    }
  }

  // The observer is how a restoration is measured without reaching into the
  // registry: `post-execute` receives the same execution object, after every
  // stage that reads it has read it.
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    observed.push({
      name: exec.name,
      agent: exec.agent,
      parent: exec.parent,
      callId: exec.callId,
      token: exec.token,
      signal: exec.signal,
    })
    return next()
  })

  return { ctx, ran, logged, observed }
}

/**
 * Run one call through the real registry.
 * @param harness - a harness from {@link world}.
 * @param toolName - the tool to call.
 * @param extra - extra execution input fields, such as `agent` or `parent`.
 * @returns the normalized tool result.
 */
export function run(harness, toolName = 'alpha', extra = {}) {
  return harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
    name: toolName,
    arguments: { note: 'test' },
    ...extra,
  })
}

/** The tools whose bodies ran, in order. */
export function ranTools(harness) {
  return harness.ran.map(entry => entry.tool)
}

/** The text of a result's first content block. */
export function resultText(result) {
  const block = result.content?.[0]
  return block?.type === 'text' ? block.text : ''
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
