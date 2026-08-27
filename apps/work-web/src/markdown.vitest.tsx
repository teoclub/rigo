/**
 * Rigo Work Web safe-markdown tests (Issue 033; SPEC §7.5): raw HTML never
 * renders and links only use controlled schemes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { renderMarkdown } from './markdown.tsx'

afterEach(cleanup)
import { safeLinkHref } from './links.ts'

describe('work web safe markdown (Issue 033)', () => {
  it('never renders raw HTML — markup stays escaped text', () => {
    const { container } = render(<div>{renderMarkdown('# Title\n\nHello <script>alert(1)</script> <b>bold</b>')}</div>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('h1')!.textContent).toBe('Title')
    // The literal markup text is visible (escaped), never executed.
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<b>bold</b>')
  })

  it('renders headings, code blocks, lists, bold and inline code', () => {
    const { container } = render(<div>{renderMarkdown('# H\n\n```ts\nconst x = 1\n```\n\n- one\n- two\n\n**bold** and `code`')}</div>)
    expect(container.querySelector('h1')!.textContent).toBe('H')
    const code = container.querySelector('pre code')!
    expect(code.textContent).toBe('const x = 1')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('strong')!.textContent).toBe('bold')
    expect(container.querySelector('code')!.textContent).toBe('const x = 1')
    expect(container.textContent).toContain('and code')
  })

  it('sanitizes link hrefs to the controlled schemes', () => {
    const { container } = render(<div>{renderMarkdown('[safe](https://example.com/x) [bad](javascript:alert(1)) [rel](../docs/a.md)')}</div>)
    const anchors = [...container.querySelectorAll('a')]
    expect(anchors).toHaveLength(2)
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/x')
    expect(anchors[0]!.textContent).toBe('safe')
    expect(anchors[1]!.getAttribute('href')).toBe('../docs/a.md')
    expect(anchors[1]!.getAttribute('target')).toBeNull() // relative stays same-origin
    // The rejected link renders as plain text, not an anchor.
    expect(container.textContent).toContain('[bad](javascript:alert(1))')
  })

  it('safeLinkHref rejects dangerous schemes and accepts safe ones', () => {
    expect(safeLinkHref('https://example.com')).toBe('https://example.com')
    expect(safeLinkHref('/api/v1/health')).toBe('/api/v1/health')
    expect(safeLinkHref('file:///tmp/x.md')).toBe('file:///tmp/x.md')
    expect(safeLinkHref('javascript:alert(1)')).toBeUndefined()
    expect(safeLinkHref('data:text/html,x')).toBeUndefined()
    expect(safeLinkHref('')).toBeUndefined()
    expect(safeLinkHref('not a url')).toBeUndefined()
  })
})
