/**
 * Rigo Document Write Tool (Issue 026; SPEC §5.4, §9.3; PRD US-010,
 * US-011, FR-17–FR-21).
 *
 * The model-visible `document.write` tool that ONLY creates an Action
 * Request (AC-2): the target, expected version, new content and idempotency
 * key ride the Issue 021 pipeline (`document.write`, `local-write`), so the
 * default policy requires approval BEFORE any filesystem touch (AC-5).
 *
 *   - a DETERMINISTIC plain-text line diff between the current and the new
 *     content is rendered before the request is created (AC-3), and the
 *     diff summary becomes the approval request's parameter summary;
 *   - tool results are unified (AC-4): every outcome references the action
 *     execution id; `requires-approval` / `denied` / `completed` /
 *     `conflict` (a `DOCUMENT_VERSION_CONFLICT` execution failure — AC-6:
 *     the target changed while the request was pending, nothing is
 *     overwritten) / `failed`, and raw exceptions become the unified
 *     failure shape (`toolFailureResult`);
 *   - unload revokes the registration, so new model requests no longer see
 *     the tool schema (AC-7).
 *
 * @module @teoclub/work-tool-document-write
 */

import { Context } from '@teoclub/cordis'
import { type Session } from '@teoclub/harness-session'
import {
  registerModelTool,
  type ModelToolDefinition,
} from '@teoclub/harness-tools-protocol'
import { type ActionsService } from '@teoclub/shared-actions'
import { type ApprovalsService } from '@teoclub/shared-approvals'
import {
  DocumentId,
  DocumentNotFoundError,
  type DocumentsService,
} from '@teoclub/work-documents'
import { WRITE_DOCUMENT_ACTION_NAME, type DocumentWriteInput } from '@teoclub/work-documents-write'

/** The stable model-visible tool name (mirrors the action name). */
export const WRITE_DOCUMENT_TOOL_NAME = 'document.write'

// ---------------------------------------------------------------------------
// Deterministic plain-text diff (AC-3)
// ---------------------------------------------------------------------------

export interface LineDiff {
  /** Diff lines with ` ` (unchanged), `-` (deleted), `+` (inserted) prefixes. */
  lines: string[]
  insertions: number
  deletions: number
  unchanged: number
}

/** LCS cell budget guard; above it the diff falls back to a full replace. */
const MAX_DIFF_CELLS = 4_000_000

/**
 * A deterministic line-based diff (LCS) between two texts. The same inputs
 * ALWAYS produce the same output (AC-3). Oversized inputs fall back to a
 * deterministic full-replace diff.
 */
export function diffText(oldText: string, newText: string): LineDiff {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length
  if (n * m > MAX_DIFF_CELLS) {
    return {
      lines: [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)],
      insertions: b.length,
      deletions: a.length,
      unchanged: 0,
    }
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const lines: string[] = []
  let insertions = 0
  let deletions = 0
  let unchanged = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      unchanged += 1
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push(`-${a[i]}`)
      deletions += 1
      i += 1
    } else {
      lines.push(`+${b[j]}`)
      insertions += 1
      j += 1
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`)
    deletions += 1
    i += 1
  }
  while (j < m) {
    lines.push(`+${b[j]}`)
    insertions += 1
    j += 1
  }
  return { lines, insertions, deletions, unchanged }
}

/** A deterministic one-line modification summary (AC-3). */
export function diffSummary(oldText: string, newText: string): string {
  const diff = diffText(oldText, newText)
  return `${diff.insertions} insertion(s), ${diff.deletions} deletion(s), ${diff.unchanged} unchanged line(s)`
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface WriteDocumentToolConfig {
  /** The Documents service (reads the current content for the diff). */
  documents: DocumentsService
  /** The Action pipeline (with the `document.write` action registered). */
  actions: ActionsService
  /** The Approval service (creates the pending request; optional). */
  approvals?: ApprovalsService
  /** The session the action runs under. */
  session: Session
  /** The action name to route to (default {@link WRITE_DOCUMENT_ACTION_NAME}). */
  actionName?: string
  /** Model-visible name (default {@link WRITE_DOCUMENT_TOOL_NAME}); multi-session hosts use one name per session. */
  name?: string
}

/** The unified write-tool result (AC-4: always references the execution id). */
export interface WriteDocumentToolResult {
  status: 'completed' | 'requires-approval' | 'denied' | 'conflict' | 'failed'
  executionId: string
  action: string
  relativePath: string
  /** New version after a completed write. */
  version?: number
  contentHash?: string
  /** The deterministic plain-text diff (AC-3). */
  diff: string
  reason?: string
}

/** The `document.write` tool definition. */
export function createWriteDocumentTool(config: WriteDocumentToolConfig): ModelToolDefinition {
  if (config?.documents === undefined) {
    throw new TypeError('write document tool requires the documents service')
  }
  if (config?.actions === undefined) {
    throw new TypeError('write document tool requires the actions service')
  }
  if (config?.session === undefined) {
    throw new TypeError('write document tool requires a session')
  }
  return {
    name: config.name ?? WRITE_DOCUMENT_TOOL_NAME,
    description: 'Propose an atomic write to a Markdown or text document inside the workspace root; the write requires approval',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string' },
        expectedVersion: { type: 'integer' },
        content: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['relativePath', 'expectedVersion', 'content', 'idempotencyKey'],
    },
    async execute(args) {
      const input = args as unknown as DocumentWriteInput
      try {
        // The deterministic diff BEFORE any request is created (AC-3).
        let current = ''
        try {
          current = (await config.documents.read(DocumentId(input.relativePath))).content
        } catch (error) {
          if (!(error instanceof DocumentNotFoundError)) throw error
        }
        const diff = diffText(current, input.content).lines.join('\n')

        const result = await config.actions.execute({
          action: config.actionName ?? WRITE_DOCUMENT_ACTION_NAME,
          input,
          idempotencyKey: input.idempotencyKey,
          sessionId: config.session.id,
        })
        switch (result.status) {
          case 'requires-approval': {
            if (config.approvals !== undefined) {
              await config.approvals.create({
                sessionId: config.session.id,
                actionExecutionId: result.executionId,
                actionName: config.actionName ?? WRITE_DOCUMENT_ACTION_NAME,
                target: input.relativePath,
                paramsSummary: diffSummary(current, input.content),
                expectedImpact: `writes ${input.relativePath}`,
                session: config.session,
              })
            }
            return {
              status: 'requires-approval',
              executionId: result.executionId,
              action: WRITE_DOCUMENT_ACTION_NAME,
              relativePath: input.relativePath,
              diff,
              reason: result.reason,
            }
          }
          case 'completed':
            return {
              status: 'completed',
              executionId: result.executionId,
              action: WRITE_DOCUMENT_ACTION_NAME,
              relativePath: input.relativePath,
              version: (result.result as { version?: number }).version,
              contentHash: (result.result as { contentHash?: string }).contentHash,
              diff,
            }
          case 'denied':
            return {
              status: 'denied',
              executionId: result.executionId,
              action: WRITE_DOCUMENT_ACTION_NAME,
              relativePath: input.relativePath,
              diff,
              reason: result.reason,
            }
          case 'failed':
            // AC-6: the target moved while the request was pending — the
            // execution failed with DOCUMENT_VERSION_CONFLICT; nothing was
            // overwritten.
            return {
              status: result.error.code === 'DOCUMENT_VERSION_CONFLICT' ? 'conflict' : 'failed',
              executionId: result.executionId,
              action: WRITE_DOCUMENT_ACTION_NAME,
              relativePath: input.relativePath,
              diff,
              reason: result.error.message,
            }
          default:
            return {
              status: 'failed',
              executionId: result.executionId,
              action: WRITE_DOCUMENT_ACTION_NAME,
              relativePath: input.relativePath,
              diff,
              reason: 'unexpected action outcome',
            }
        }
      } catch (error) {
        // Unexpected failures THROW and the tool registry converts them
        // into the unified failure result (SPEC §7.4: no raw exceptions).
        throw error
      }
    },
  }
}

/**
 * Register the write tool and revoke it on unload (AC-7).
 * @param ctx - the registering context.
 * @param config - the tool wiring.
 * @returns the disposer.
 */
export function registerWriteDocumentTool(ctx: Context, config: WriteDocumentToolConfig): () => void {
  return registerModelTool(ctx, createWriteDocumentTool(config))
}

export default createWriteDocumentTool
