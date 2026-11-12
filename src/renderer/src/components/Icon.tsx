import type { JSX } from 'react'

export type IconName =
  | 'inbox'
  | 'library'
  | 'duplicates'
  | 'sparkles'
  | 'settings'
  | 'search'
  | 'plus'
  | 'x'
  | 'check'
  | 'trash'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'play'
  | 'pause'
  | 'image'
  | 'film'
  | 'book'
  | 'folder'
  | 'star'
  | 'more'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'shuffle'
  | 'palette'
  | 'clock'
  | 'tag'
  | 'refresh'
  | 'alert'
  | 'external'
  | 'frame'
  | 'layers'
  | 'arrowLeft'
  | 'arrowRight'
  | 'stepBack'
  | 'stepForward'
  | 'grid'
  | 'similar'
  | 'sort'
  | 'eye'
  | 'wand'
  | 'edit'

const P: Record<IconName, JSX.Element> = {
  inbox: (
    <>
      <path d="M3.5 13.5h4l1.6 2.4h5.8l1.6-2.4h4" />
      <path d="M4.6 4.5h14.8l1.6 9v4.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.6z" />
    </>
  ),
  library: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </>
  ),
  duplicates: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11.5 3.5l1.7 4.8 4.8 1.7-4.8 1.7-1.7 4.8-1.7-4.8L5 10l4.8-1.7z" />
      <path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17.5 7H20M4 17h3.5M11 17h9" />
      <circle cx="15" cy="7" r="2.4" />
      <circle cx="8.5" cy="17" r="2.4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
      <path d="M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  chevronDown: <path d="M5 9l7 7 7-7" />,
  play: <path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="8.8" cy="9.4" r="1.7" />
      <path d="M4 17l4.7-4.6 3.3 3.2 2.8-2.7L20 17.4" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M8 4.5v15M16 4.5v15M3.5 9.5h4.5M16 9.5h4.5M3.5 14.5h4.5M16 14.5h4.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.2A1.2 1.2 0 0 1 5.2 4H11v16H5.2A1.2 1.2 0 0 1 4 18.8z" />
      <path d="M20 5.2A1.2 1.2 0 0 0 18.8 4H13v16h5.8a1.2 1.2 0 0 0 1.2-1.2z" />
    </>
  ),
  folder: <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.4l2 2.5h8.1a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  star: <path d="M12 4l2.5 5.3 5.5.7-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.7z" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.5 15.5L20 20M8 10.8h5.6M10.8 8v5.6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.5 15.5L20 20M8 10.8h5.6" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    </>
  ),
  shuffle: <path d="M17 4l3 3-3 3M17 14l3 3-3 3M4 7h4l8 10h4M4 17h4l2.5-3.1M14.5 9.9L16 8h4" />,
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.8 0-.9-.6-1.4-.6-2.3 0-1 .8-1.9 1.9-1.9h1.6a3.6 3.6 0 0 0 3.6-3.6c0-4.1-3.9-7.4-8.5-7.4z" />
      <circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  tag: (
    <>
      <path d="M3.8 11.2V5.4A1.6 1.6 0 0 1 5.4 3.8h5.8l9 9a1.6 1.6 0 0 1 0 2.3l-5.1 5.1a1.6 1.6 0 0 1-2.3 0z" />
      <circle cx="8.3" cy="8.3" r="1.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.6h-4.6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4.2M12 17.2v.2" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  frame: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.8" />
      <path d="M8.5 5.5v13M15.5 5.5v13M3.5 12h17" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5l8.5 4.6L12 12.7 3.5 8.1z" />
      <path d="M3.5 12.4L12 17l8.5-4.6M3.5 16.6L12 21.2l8.5-4.6" />
    </>
  ),
  arrowLeft: <path d="M20 12H4M10 6l-6 6 6 6" />,
  arrowRight: <path d="M4 12h16M14 6l6 6-6 6" />,
  stepBack: (
    <>
      <path d="M18 6l-8 6 8 6z" fill="currentColor" stroke="none" />
      <path d="M6 5v14" />
    </>
  ),
  stepForward: (
    <>
      <path d="M6 6l8 6-8 6z" fill="currentColor" stroke="none" />
      <path d="M18 5v14" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1" />
    </>
  ),
  similar: (
    <>
      <circle cx="9" cy="9" r="4.5" />
      <circle cx="15.5" cy="15.5" r="4.5" />
      <path d="M12.2 12.2l.1.1" />
    </>
  ),
  sort: <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />,
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  wand: (
    <>
      <path d="M5 19L16 8" />
      <path d="M18 3l.8 2.2L21 6l-2.2.8L18 9l-.8-2.2L15 6l2.2-.8z" />
      <path d="M7 5l.5 1.5L9 7l-1.5.5L7 9l-.5-1.5L5 7l1.5-.5z" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17z" />
      <path d="M13.6 6.6l3 3" />
    </>
  )
}

export function Icon({
  name,
  size,
  className,
  strokeWidth = 1.6
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  )
}
