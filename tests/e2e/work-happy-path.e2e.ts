/**
 * Issue 037 E2E — Rigo Work happy path (SPEC §9.4; PRD US-014, US-016).
 *
 * Fresh temp home + SQLite + knowledge files + target docs; the official
 * Rigo Work Bundle boots an isolated server; the real Web UI creates a
 * session, retrieves from the fixed knowledge set, streams the answer with
 * locatable sources, proposes a document write with a Diff + Approval
 * Request, and — after approval — the document changes exactly once with a
 * new version; the UI shows the action result and the audit timeline.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@teoclub/harness-session'
import { DocumentId } from '@teoclub/work-documents'
import { startHarness, happyPathScript, E2E_SECRET_MARKER } from './harness.ts'

test('happy path: knowledge answer, sources, approved write, audit', async ({ page }) => {
  const harness = await startHarness({
    script: happyPathScript(),
    knowledge: {
      'knowledge.md': '# Knowledge\n\nWhat do rockets use? Rockets use fuel for thrust. The plan lives in docs/plan.md.\n',
    },
    // The write target exists from the start (SPEC §9.4 fixed data): the
    // atomic write compares the baseline version instead of creating files.
    documents: {
      'docs/plan.md': '# Plan\n\nOriginal plan.\n',
    },
  })
  try {
    // The page is the real UI, served by Vite, proxying to the harness API.
    await page.goto(harness.baseUrl)
    await expect(page.getByRole('heading', { name: 'Rigo Work' })).toBeVisible()

    // Create the session through the UI form.
    await page.getByTestId('provider').fill('mock')
    await page.getByTestId('model').fill('mock')
    await page.getByTestId('workspaceRoot').fill(harness.workspace)
    await page.getByTestId('title').fill('E2E session')
    await page.getByTestId('createButton').click()
    await expect(page.getByTestId('sessionTitle')).toContainText('E2E session')

    // Ask a question: the agent retrieves from the fixed knowledge set.
    await page.getByTestId('messageInput').fill('What do rockets use?')
    await page.getByTestId('sendButton').click()
    await expect(page.getByTestId('assistantOutput')).toContainText('rockets use fuel', { timeout: 20000 })
    // The streaming answer shows locatable source references.
    await expect(page.getByTestId('source-s1')).toContainText('knowledge.md')

    // Second message: the mock LLM proposes a document write.
    await page.getByTestId('messageInput').fill('Please update the plan.')
    await page.getByTestId('sendButton').click()
    // The approval request appears with action name, target, summary, impact.
    await expect(page.locator('[data-testid^="approval-"] h4')).toContainText('document.write:', { timeout: 20000 })
    const card = page.locator('[data-testid^="approval-"]').first()
    await expect(card).toContainText('docs/plan.md')
    await expect(card).toContainText('unchanged line(s)') // the diff summary
    await expect(card).toContainText('Impact:')
    // The agent waits for approval (stable text status; the detailed phase
    // keeps advancing with post-tool progress events).
    await expect(page.getByTestId('pendingApprovals')).toContainText('1')

    // Approve through the UI: the approval card disappears.
    const approve = page.locator('[data-testid^="approve-"]').first()
    await approve.click()
    await expect(page.locator('[data-testid^="approval-"]')).toHaveCount(0, { timeout: 20000 })

    // The UI shows the action success result and the audit timeline. The
    // approval/resolved event lands before the resumed execution finishes,
    // so assert the action result FIRST — it is emitted only after the
    // atomic write commits.
    await expect(page.getByTestId('actionsPanel')).toContainText('Succeeded', { timeout: 20000 })
    await expect(page.getByTestId('actionsPanel')).toContainText('"version":2')
    await expect(page.getByTestId('auditTimeline')).toContainText('approval', { timeout: 20000 })
    await expect(page.getByTestId('auditTimeline')).toContainText('action')

    // The document changed exactly once.
    const written = readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')
    expect(written).toBe('# Plan\n\nUpdated by the approved write.\n')
    // The projection shows version 2 (baseline 1 + exactly one write).
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // Nothing credential-shaped appears on the page.
    await expect(page.locator('body')).not.toContainText(E2E_SECRET_MARKER)

    // Web UI and headless API agree on the same event log.
    const session = harness.ctx.sessions.get(SessionId(harness.sessionId))!
    const apiProjection = await harness.facade.auditProjection(harness.sessionId)
    expect(apiProjection.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
    expect(apiProjection.some((entry) => entry.category === 'document')).toBe(true)
  } finally {
    // Drop the browser connections FIRST: the open page keeps the Vite HMR
    // websocket and the SSE proxy connection alive, which would otherwise
    // block the servers' close() during teardown.
    await page.close()
    await harness.dispose()
  }
})

