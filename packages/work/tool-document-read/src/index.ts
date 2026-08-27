/**
 * Rigo Document Read Tool (Issue 026; SPEC §5.4, §9.3; PRD US-009).
 *
 * The model-visible `document.read` tool over the Issue 016 Documents
 * service (AC-1): returns the content, the monotonic version and the
 * traceable source location; a missing or invalid target surfaces the
 * UNIFIED failure shape (`toolFailureResult`) — never a raw exception —
 * and reads never require approval (AC-5).
 *
 * @module @teoclub/work-tool-document-read
 */

import { Context } from '@teoclub/cordis'
import {
  registerModelTool,
  type ModelToolDefinition,
} from '@teoclub/harness-tools-protocol'
import {
  DocumentId,
  type DocumentsService,
} from '@teoclub/work-documents'

/** The stable model-visible tool name. */
export const READ_DOCUMENT_TOOL_NAME = 'document.read'

/** The normalized read tool result. */
export interface ReadDocumentToolResult {
  relativePath: string
  content: string
  version: number
  mediaType: string
  /** Traceable source location. */
  source: string
}

export interface ReadDocumentToolConfig {
  /** The Documents service (must have a read provider registered). */
  documents: DocumentsService
  /** Model-visible name (default {@link READ_DOCUMENT_TOOL_NAME}); multi-session hosts use one name per session. */
  name?: string
}

/** The `document.read` tool definition. */
export function createReadDocumentTool(config: ReadDocumentToolConfig): ModelToolDefinition {
  if (config?.documents === undefined) {
    throw new TypeError('read document tool requires the documents service')
  }
  return {
    name: config.name ?? READ_DOCUMENT_TOOL_NAME,
    description: 'Read a Markdown or text document inside the workspace root; returns its content, version and source',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string' },
      },
      required: ['relativePath'],
    },
    async execute(args) {
      const relativePath = String((args as { relativePath: unknown }).relativePath)
      // Failures THROW and the tool registry converts them into the unified
      // failure result (safe message only — never a raw exception object).
      const content = await config.documents.read(DocumentId(relativePath))
      return {
        relativePath,
        content: content.content,
        version: content.record.version,
        mediaType: content.record.mediaType,
        source: content.source,
      } satisfies ReadDocumentToolResult
    },
  }
}

/**
 * Register the read tool and revoke it on unload (AC-7): the disposer (or
 * fiber teardown) removes the tool from the registry AND the schema mirror,
 * so new model requests stop seeing the schema.
 * @param ctx - the registering context.
 * @param config - the tool wiring.
 * @returns the disposer.
 */
export function registerReadDocumentTool(ctx: Context, config: ReadDocumentToolConfig): () => void {
  return registerModelTool(ctx, createReadDocumentTool(config))
}

export default createReadDocumentTool
