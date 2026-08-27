/**
 * Rigo system-prompt / tool-registry protocol (Issue 012; SPEC §2.4, §5.1,
 * §9.2; PRD US-006, US-010, FR-16/17/35).
 *
 * The Rigo-facing surface over the ported system prompt and tool registry:
 *
 *   - {@link registerModelTool} registers a model-visible tool (name,
 *     description, input schema) whose schema is NORMALIZED up front
 *     (`assertSupportedJsonSchema`) and mirrored so the Context Assembly can
 *     reference it at the {@link CONTEXT_ORDER.TOOL_SCHEMAS} band
 *     ({@link attachToolSchemasToContext});
 *   - tool execution always produces the UNIFIED success/failure result —
 *     {@link toolFailureResult} converts any thrown value into the
 *     `isError: true` shape carrying only a safe message, never the raw
 *     provider exception object;
 *   - unload (disposer or fiber) revokes the tool from the registry AND the
 *     schema mirror, so new model requests never see it;
 *   - {@link ToolActionDelegate} is the STABLE extension seam for the
 *     Tool → Action delegation: registration surface only in this issue
 *     (no external side effects are executed here; the Action pipeline of
 *     Issue 021 wires execution).
 *
 * The upstream prompt-assembly and tool-lifecycle suites pass unmodified
 * (dual runtime) and remain the behavioral ground truth for the ported
 * machinery this package builds on.
 *
 * @module @teoclub/harness-tools-protocol
 */

import { Context } from '@teoclub/cordis'
import { CONTEXT_ORDER, type ContextContributor } from '@teoclub/harness-context'
import {
  assertSupportedJsonSchema,
  type JsonSchemaNode,
} from '@teoclub/harness-tools'
import type { ContentBlock } from '@teoclub/harness-llm'
import ToolRuntime from '@teoclub/harness-tools'

/** The Rigo-facing model-visible tool declaration. */
export interface ModelToolDefinition {
  /** Stable model-visible tool name. */
  name: string
  /** Model-visible description. */
  description: string
  /** Raw JSON Schema for the tool arguments (normalized at registration). */
  parameters: Record<string, unknown>
  /** Execute one accepted call; settle only after owned work reaches quiescence. */
  execute(args: unknown, signal?: AbortSignal): Promise<unknown> | unknown
}

/** One normalized model-visible tool schema (the Context Assembly reference). */
export interface NormalizedToolSchema {
  name: string
  description: string
  parameters: JsonSchemaNode
}

/** The unified failure result: `isError: true` with a safe message only. */
export interface UnifiedToolFailure {
  isError: true
  content: ContentBlock[]
  error: { name: string; code: string }
}

const TOOL_SCHEMAS_CONTRIBUTOR_ID = 'harness:tool-schemas'

/** The context contributor id exposing the normalized tool schemas. */
export { TOOL_SCHEMAS_CONTRIBUTOR_ID }

/**
 * Convert any thrown value into the unified failure result. Only the safe
 * string form of the error travels — never the raw provider exception object
 * (SPEC: no provider internals in tool results, session events, or logs).
 * @param error - whatever the tool (or its provider) threw.
 * @param errorName - stable failure name for the result (defaults to the
 *   error's own name or `ToolError`).
 * @param code - stable machine code (defaults to `TOOL_FAILED`).
 * @returns the unified `isError: true` result.
 */
export function toolFailureResult(
  error: unknown,
  errorName = 'ToolError',
  code = 'TOOL_FAILED',
): UnifiedToolFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    content: [{ type: 'text', text: `Tool failed: ${message}` }],
    error: { name: errorName, code },
  }
}

interface MirrorEntry {
  schema: NormalizedToolSchema
}

/**
 * Register one model-visible tool through the Rigo protocol: the input
 * schema is normalized and validated up front (an unsupported JSON Schema
 * rejects the registration), the tool is registered with the ported
 * registry for execution, and the normalized schema enters the mirror the
 * Context Assembly reads. Unload removes the tool from BOTH surfaces.
 * @param ctx - a context with the tool registry mounted.
 * @param definition - the Rigo-facing tool declaration.
 * @returns the disposer (also revokes the tool immediately).
 */
export function registerModelTool(ctx: Context, definition: ModelToolDefinition): () => void {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) {
    throw new TypeError('model tool name must be a non-empty string')
  }
  if (typeof definition.description !== 'string') {
    throw new TypeError(`model tool "${definition.name}" must declare a description`)
  }
  // Normalize the input schema BEFORE anything is registered (AC: tool
  // schemas are normalized before they can reach a model request).
  const rawSchema = definition.parameters as JsonSchemaNode
  assertSupportedJsonSchema(rawSchema)
  const normalized: NormalizedToolSchema = {
    name: definition.name,
    description: definition.description,
    parameters: rawSchema,
  }
  const mirror = modelToolMirror(ctx)
  if (mirror.has(definition.name)) {
    throw new Error(`model tool "${definition.name}" is already registered`)
  }
  mirror.set(definition.name, { schema: normalized })
  const revokeTools = ctx.tools.register({
    name: definition.name,
    description: definition.description,
    parameters: { ...normalized.parameters } as Record<string, unknown>,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => Promise.resolve(definition.execute(args, exec.signal)),
  })
  // Fiber-bound revocation: unload (or the returned disposer) removes the
  // tool from both the ported registry and the schema mirror.
  return ctx.effect(() => () => {
    mirror.delete(definition.name)
    revokeTools()
  }, `modelTool.register(${definition.name})`)
}

interface Mirror {
  entries: Map<string, MirrorEntry>
}

const mirrors = new WeakMap<Context, Mirror>()

/** The Rigo model-tool mirror, shared per ROOT context (created on first use). */
function modelToolMirror(ctx: Context): Map<string, MirrorEntry> {
  const scope = ctx.root
  let mirror = mirrors.get(scope)
  if (mirror === undefined) {
    mirror = { entries: new Map() }
    mirrors.set(scope, mirror)
  }
  return mirror.entries
}

/**
 * The normalized model-visible tool schemas (stable name order) — the
 * Context Assembly's TOOL_SCHEMAS reference.
 * @param ctx - a context with registered model tools.
 * @returns the normalized schemas in name order.
 */
export function modelToolSchemas(ctx: Context): NormalizedToolSchema[] {
  return [...modelToolMirror(ctx).values()].map((entry) => entry.schema)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Attach the normalized tool schemas to the Context Assembly at the
 * TOOL_SCHEMAS band: registers a stable contributor that snapshots the
 * mirror on every assembly, so an unloaded tool disappears from new model
 * requests immediately.
 * @param ctx - a context with BOTH the context service and the tool
 *   registry mounted.
 * @returns the disposer for the contribution.
 */
export function attachToolSchemasToContext(ctx: Context): () => void {
  const contributor: ContextContributor = {
    id: TOOL_SCHEMAS_CONTRIBUTOR_ID,
    order: CONTEXT_ORDER.TOOL_SCHEMAS,
    contribute: () => {
      const schemas = modelToolSchemas(ctx)
      const body = schemas.map((schema) =>
        `${schema.name}: ${schema.description}\n${JSON.stringify(schema.parameters)}`,
      ).join('\n\n')
      return {
        source: { contributorId: TOOL_SCHEMAS_CONTRIBUTOR_ID, label: 'Tool Schemas' },
        content: body.length === 0 ? '(no tools registered)' : body,
      }
    },
  }
  return ctx.context.register(contributor)
}

/** One delegated tool call handed to a {@link ToolActionDelegate}. */
export interface ToolActionRequest {
  toolName: string
  callId: string
  arguments: unknown
}

/** The unified result a delegate returns (same contract as tool results). */
export interface ToolActionResult {
  content: ContentBlock[]
  isError: boolean
}

/**
 * The stable Tool → Action delegation seam (Issue 012 AC: extension
 * interface only — no external side effects are executed by this package;
 * the Action pipeline wires execution in Issue 021).
 */
export interface ToolActionDelegate {
  /** Whether this delegate owns the tool call. */
  accepts(request: ToolActionRequest): boolean
  /** Execute the action side of the tool call. */
  execute(request: ToolActionRequest, ctx: Context, signal?: AbortSignal): Promise<ToolActionResult>
}

const delegates = new WeakMap<Context, Map<number, ToolActionDelegate>>()
let delegateSeq = 0

/**
 * Register a Tool → Action delegate. The seam is inert in this issue: the
 * delegate is recorded (and queryable) but never invoked for side effects.
 * @param ctx - any context (the registry is shared per context).
 * @param delegate - the delegate to record.
 * @returns the disposer.
 */
export function registerToolActionDelegate(ctx: Context, delegate: ToolActionDelegate): () => void {
  const scope = ctx.root
  let map = delegates.get(scope)
  if (map === undefined) {
    map = new Map()
    delegates.set(scope, map)
  }
  const key = delegateSeq
  delegateSeq += 1
  map.set(key, delegate)
  return () => {
    map.delete(key)
  }
}

/** The recorded delegates (inert seam inspection for tests/diagnostics). */
export function listToolActionDelegates(ctx: Context): ToolActionDelegate[] {
  return [...(delegates.get(ctx.root)?.values() ?? [])]
}

// Re-export the ported registry service so consumers mount one import surface.
export { ToolRuntime }
