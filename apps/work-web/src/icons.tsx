/**
 * Inline SVG marks shared by the shell, forms and chat view. Zero network.
 */
import type { JSX } from 'react'

export function LogoMark(props: { size?: number }): JSX.Element {
  const size = props.size ?? 24
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="7.4" r="1.7" fill="currentColor" />
      <circle cx="7" cy="15" r="1.7" fill="currentColor" />
      <circle cx="17" cy="15" r="1.7" fill="currentColor" />
      <path d="M11 8.7 8 13.4M13 8.7 16 13.4M8.7 15h6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function Icon(props: { path: string, size?: number }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={props.path} />
    </svg>
  )
}

export const ICONS = {
  send: 'M2 8l12-5.5L9.5 14 8 9.5z',
  history: 'M8 3a5 5 0 1 1-4.5 2.8M3 2.5v3h3M8 5.5V8l2 1.5',
  alert: 'M8 2.5 14.5 13.5h-13zM8 6.5v3M8 11.6v.4',
  info: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 7.5v3M8 5v.5',
  approve: 'M3 8.5 6.5 12 13 4.5',
  deny: 'M4 4l8 8M12 4l-8 8',
  doc: 'M4 2h5.5L12.5 5v9H4zM9.5 2v3h3',
  sparkle: 'M8 2.5 9.3 6 13 7.3 9.3 8.6 8 12l-1.3-3.4L3 7.3 6.7 6z',
  clipboard: 'M6 2.5h4v1.5h-4zM4.5 4H4v9.5h8V4h-.5M6.5 8.5h3M6.5 11h3',
  stop: 'M4.5 4.5h7v7h-7z',
  sources: 'M3 3.5h10M3 6.5h7M3 9.5h10M3 12.5h5',
  activity: 'M2 8.5h2.5L6 4l3 8 1.5-3.5H14',
  ledger: 'M3 2.5h2.5v11H3zM6.5 2.5h2.5v11H6.5zM10 2.5h3l-1.5 11z',
  plus: 'M8 3.5v9M3.5 8h9',
  work: 'M3.5 3.5h9v10h-9zM6 6.5h4M6 9.2h5',
  code: 'M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5',
  folder: 'M2.5 4.5h4l1.3 1.6H13.5v6.4H2.5z',
  chevron: 'M5 6l3 3 3-3',
  gear: 'M6.37 3.97 6.67 1.74 9.33 1.74 9.63 3.97 10.68 4.57 12.76 3.72 14.09 6.02 12.31 7.39 12.31 8.61 14.09 9.98 12.76 12.28 10.68 11.43 9.63 12.03 9.33 14.26 6.67 14.26 6.37 12.03 5.32 11.43 3.24 12.28 1.91 9.98 3.69 8.61 3.69 7.39 1.91 6.02 3.24 3.72 5.32 4.57zM10.2 8a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z',
} as const
