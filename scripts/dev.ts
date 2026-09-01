/**
 * Local development entry: boots the full Rigo Work application (the
 * official Work Base Bundle + Runtime Facade + HTTP/SSE server) and the
 * Rigo Work Web UI (Vite dev server proxying /api), so the product runs
 * end-to-end on this machine with one command.
 *
 *   - the API listens on 127.0.0.1:3081 (the port the UI's vite config
 *     proxies /api to); the UI on 127.0.0.1:5173;
 *   - state persists under .local/ (gitignored): .local/data keeps the
 *     SQLite session/documents databases, .local/workspace is the demo
 *     workspace root every session is created against;
 *   - Markdown files under the workspace are indexed into the FTS5
 *     knowledge base on every boot, so the sources panel has material;
 *   - the LLM provider is the script-less dev mock (no credentials, no
 *     network): it streams an echo of the user's message, and a message
 *     of the form
 *
 *       /write docs/plan.md
 *       # New content…
 *
 *     proposes a document.write tool call (session-scoped), which enters
 *     the real approval pipeline — approve or deny it in the UI;
 *   - Ctrl+C disposes the Vite server and the whole bundle in reverse
 *     order.
 *
 * Usage: bun run dev
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@teoclub/harness-llm'
import { textResponse, toolCallResponse } from '@teoclub/harness-llm-mock'
import { bootWorkBase } from '@teoclub/work-base'
import { DocumentId, type DocumentsService } from '@teoclub/work-documents'
import { NodeSqliteDriver } from '@teoclub/shared-storage-sqlite-node/node'
import { SqliteFtsKnowledgeProvider } from '@teoclub/shared-knowledge-sqlite-fts'

// Bun exposes import.meta.dir; Node runs this entry (node:sqlite), where
// the URL form is the portable equivalent.
const root = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(root, '.local', 'data')
const workspace = join(root, '.local', 'workspace')
const API_PORT = 3081
const UI_PORT = 5173

/** Markdown files seeded into a fresh workspace (knowledge + write targets). */
const SEED_DOCUMENTS: Record<string, string> = {
  'README.md': [
    '# Rigo Demo Workspace',
    '',
    'This workspace backs the local dev instance of Rigo Work.',
    'Ask a question whose words appear here and the answer cites this file.',
    '',
  ].join('\n'),
  'docs/plan.md': [
    '# Plan',
    '',
    'The original plan. Send `/write docs/plan.md` followed by new content',
    'to propose an approved overwrite of this document.',
    '',
  ].join('\n'),
  'docs/knowledge.md': [
    '# Knowledge Base',
    '',
    '- Rockets use fuel for thrust.',
    '- SQLite WAL allows concurrent readers.',
    '- Approvals expire after ten minutes by default.',
    '',
  ].join('\n'),
}

// ---------------------------------------------------------------------------
// The dev mock LLM adapter: no script, never exhausts
// ---------------------------------------------------------------------------

/** Extract the text blocks of a message (merge-extensible blocks → plain text). */
function messageText(message: { content: { type: string, text?: string }[] }): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * The interactive stand-in LLM: echoes the user's text back (streamed, so
 * the SSE path is exercised), or — for `/write <path>` messages — proposes
 * the session's document.write tool call at the CURRENT indexed version,
 * driving the real approval → atomic-write pipeline.
 */
class DevMockAdapter extends LlmAdapter {
  constructor(private readonly currentVersion: (relativePath: string) => Promise<number>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages as { role: string, content: { type: string, text?: string }[] }[]
    let lastUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === 'user') { lastUserIndex = index; break }
    }
    const userText = lastUserIndex === -1 ? '' : messageText(messages[lastUserIndex]!)
    const writeMatch = /^\/write\s+(\S+)\s*\n?([\s\S]*)$/.exec(userText.trim())

    if (writeMatch !== null) {
      // Only propose on the first pass: once the tool result came back the
      // loop re-calls the model, and the answer must be plain text.
      const toolResultPending = messages
        .slice(lastUserIndex + 1)
        .some((message) => message.content.some((block) => block.type === 'tool-result'))
      if (!toolResultPending) {
        const relativePath = writeMatch[1]!
        const content = writeMatch[2] ?? ''
        const tool = options.tools?.find((candidate) => candidate.name === `document.write:${options.sessionId}`)
          ?? options.tools?.find((candidate) => candidate.name.startsWith('document.write:'))
        if (tool === undefined) {
          yield* this.streamText('The write tool is not enabled for this session.')
          return
        }
        const version = await this.currentVersion(relativePath)
        yield* withPace(toolCallResponse(
          CallId(`call_${randomUUID().slice(0, 8)}`),
          tool.name,
          {
            relativePath,
            expectedVersion: version,
            content: content.endsWith('\n') ? content : `${content}\n`,
            idempotencyKey: `dev_${randomUUID().slice(0, 8)}`,
          },
          `Proposing to write ${relativePath} (currently at version ${version}).`,
        ))
        return
      }
      yield* this.streamText(`The write of ${writeMatch[1]!} has been processed — check the action results panel.`)
      return
    }

    yield* this.streamText(
      [
        `**mock provider** · echo: ${userText || '(empty message)'}`,
        '',
        'This local instance runs the scripted dev mock provider. Try:',
        '- a question containing words from `docs/knowledge.md` to see knowledge retrieval and sources;',
        '- `/write docs/plan.md` + a newline + new content to drive the approval flow.',
      ].join('\n'),
    )
  }

  private async * streamText(text: string): AsyncIterable<StreamChunk> {
    yield* withPace(textResponse(text))
  }
}

/** Re-yield a canned chunk list at the dev streaming pace (ms per chunk). */
async function * withPace(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function ensureDirectories(): void {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  for (const [relativePath, content] of Object.entries(SEED_DOCUMENTS)) {
    const target = join(workspace, relativePath)
    mkdirSync(join(target, '..'), { recursive: true })
    try {
      readFileSync(target, 'utf8')
    } catch {
      writeFileSync(target, content)
    }
  }
}

/**
 * Index every workspace Markdown file into the FTS5 knowledge base. Each
 * file is read through the Documents service FIRST: the read materializes
 * the projection row the chunks' FOREIGN KEY references, and yields the
 * document's current version.
 */
async function indexWorkspaceKnowledge(documents: DocumentsService): Promise<number> {
  const files: { relativePath: string, body: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name)
      if (entry.isDirectory()) { walk(target); continue }
      if (!entry.name.endsWith('.md')) continue
      files.push({ relativePath: relative(workspace, target), body: readFileSync(target, 'utf8') })
    }
  }
  walk(workspace)
  if (files.length === 0) return 0
  const driver = new NodeSqliteDriver(join(dataDir, 'documents.sqlite'))
  try {
    const provider = new SqliteFtsKnowledgeProvider({ driver })
    const inputs: { documentId: string, documentVersion: number, title: string, body: string }[] = []
    for (const file of files) {
      const read = await documents.read(DocumentId(file.relativePath))
      inputs.push({
        documentId: file.relativePath,
        documentVersion: read.record.version,
        title: file.relativePath,
        body: read.content,
      })
    }
    await provider.indexDocuments(inputs)
    return files.length
  } finally {
    driver.close()
  }
}

async function main(): Promise<void> {
  ensureDirectories()

  // Read-through version lookup: the documents service materializes after
  // boot, and the adapter is only consulted once a session (and therefore
  // its provider registration) exists.
  let documents: DocumentsService | undefined
  const currentVersion = async (relativePath: string): Promise<number> => {
    if (documents === undefined) return 0
    const existing = documents.projection(DocumentId(relativePath))
    if (existing !== undefined) return existing.version
    try {
      const read = await documents.read(DocumentId(relativePath))
      return read.record.version
    } catch {
      return 0 // a brand-new file starts at version 0
    }
  }

  const handle = await bootWorkBase(
    { adapters: { mock: new DevMockAdapter(currentVersion) } },
    { dataDir, port: API_PORT, provider: 'mock', model: 'mock' },
  )
  documents = handle.ctx.documents

  // Index (or refresh) the workspace knowledge whenever a session is
  // created: the read-through needs a registered document provider (the
  // bundle wires it per session), and every session then sees current files.
  let indexedCount = 0
  handle.ctx.on('session/created', () => {
    indexWorkspaceKnowledge(handle.ctx.documents)
      .then((count) => { indexedCount = count })
      .catch((error: unknown) => {
        console.warn(`knowledge indexing failed: ${String(error instanceof Error ? error.message : error)}`)
      })
  })

  const vite = await createViteServer({
    configFile: join(root, 'apps/work-web/vite.config.ts'),
    root: join(root, 'apps/work-web'),
    server: { host: '127.0.0.1', port: UI_PORT },
  })
  await vite.listen()

  console.log(`Rigo Work (local dev)
  UI          http://127.0.0.1:${UI_PORT}
  API         http://127.0.0.1:${API_PORT}/api/v1/health
  workspace   ${workspace}
  knowledge   ${indexedCount} markdown file(s) indexed per session creation
  provider    mock (echo + /write <path> proposals)
Ctrl+C stops both servers.`)

  let disposing = false
  const dispose = async (): Promise<void> => {
    if (disposing) return
    disposing = true
    const server = vite.httpServer
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    }
    await handle.dispose()
  }
  process.on('SIGINT', () => { void dispose().then(() => process.exit(0)) })
  process.on('SIGTERM', () => { void dispose().then(() => process.exit(0)) })
}

await main()
