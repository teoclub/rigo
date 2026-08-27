/**
 * Rigo Work Web safe Markdown renderer (Issue 033; SPEC §7.5): Markdown
 * NEVER renders raw HTML (all markup is escaped), and links only use the
 * controlled schemes. Renders React elements directly — no
 * `dangerouslySetInnerHTML` anywhere.
 *
 * @module @teoclub/work-web/markdown
 */

import { Fragment, type ReactNode } from 'react'
import { safeLinkHref } from './links.ts'

// React escapes text nodes automatically: raw HTML never becomes elements,
// and there is deliberately NO dangerouslySetInnerHTML anywhere.

/** Render inline markup: code spans, bold, italic, links (sanitized). */
export function renderInline(text: string, keyBase = 'inline'): ReactNode[] {
  const nodes: ReactNode[] = []
  let buffer = ''
  let key = 0
  const flush = (): void => {
    if (buffer.length > 0) {
      nodes.push(<Fragment key={`${keyBase}-${key}`}>{buffer}</Fragment>)
      buffer = ''
      key += 1
    }
  }
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let match: RegExpExecArray | null
  let lastIndex = 0
  while ((match = pattern.exec(text)) !== null) {
    buffer += text.slice(lastIndex, match.index)
    flush()
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyBase}-${key}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyBase}-${key}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={`${keyBase}-${key}`}>{token.slice(1, -1)}</em>)
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (linkMatch !== null) {
        const href = safeLinkHref(linkMatch[2]!)
        if (href !== undefined) {
          nodes.push(
            <a
              key={`${keyBase}-${key}`}
              href={href}
              rel="noreferrer"
              target={href.startsWith('/') || href.startsWith('./') || href.startsWith('../') ? undefined : '_blank'}
            >
              {linkMatch[1]!}
            </a>,
          )
        } else {
          nodes.push(<Fragment key={`${keyBase}-${key}`}>{token}</Fragment>)
        }
      }
    }
    key += 1
    lastIndex = pattern.lastIndex
  }
  buffer += text.slice(lastIndex)
  flush()
  return nodes
}

/**
 * Render a Markdown document to React nodes: headings, fenced code blocks,
 * lists, paragraphs. Raw HTML inside the text stays escaped text.
 */
export function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let blockKey = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim().length === 0) {
      i += 1
      continue
    }
    const fence = /^```(\w*)$/.exec(line.trim())
    if (fence !== null) {
      const language = fence[1] ?? ''
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!)
        i += 1
      }
      i += 1 // closing fence
      blocks.push(
        <pre key={`block-${blockKey}`} data-language={language}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      blockKey += 1
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1]!.length
      const content = heading[2]!
      const Element = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1]!
      blocks.push(<Element key={`block-${blockKey}`}>{renderInline(content, `h-${blockKey}`)}</Element>)
      blockKey += 1
      i += 1
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: ReactNode[] = []
      while (i < lines.length && (lines[i]!.startsWith('- ') || lines[i]!.startsWith('* '))) {
        items.push(<li key={`item-${blockKey}-${items.length}`}>{renderInline(lines[i]!.slice(2), `li-${blockKey}-${items.length}`)}</li>)
        i += 1
      }
      blocks.push(<ul key={`block-${blockKey}`}>{items}</ul>)
      blockKey += 1
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length
      && lines[i]!.trim().length > 0
      && !lines[i]!.trim().startsWith('```')
      && !/^#{1,4}\s/.test(lines[i]!)
      && !lines[i]!.startsWith('- ')) {
      paragraph.push(lines[i]!)
      i += 1
    }
    blocks.push(<p key={`block-${blockKey}`}>{renderInline(paragraph.join(' '), `p-${blockKey}`)}</p>)
    blockKey += 1
  }
  return blocks
}
