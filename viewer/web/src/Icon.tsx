import React from 'react';

export type IconName =
  | 'dot' | 'search' | 'material' | 'func' | 'folder' | 'caret' | 'caretDown'
  | 'plus' | 'minus' | 'frame' | 'refresh' | 'settings' | 'check' | 'warn' | 'x'
  | 'bolt' | 'clip' | 'download' | 'upload' | 'layers' | 'clock' | 'chip'
  | 'zoomfit' | 'link' | 'hash' | 'branch' | 'eye' | 'history' | 'more'
  | 'send' | 'stop';

const ICONS: Record<IconName, React.ReactNode> = {
  dot: <circle cx="12" cy="12" r="3" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  material: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  func: <><path d="M4 7h12a3 3 0 0 0 3-3" /><path d="M4 12h9" /><path d="M4 17h12a3 3 0 0 1 3 3" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  caret: <path d="M9 6l6 6-6 6" />,
  caretDown: <path d="M6 9l6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  frame: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1l-.4-2.5h-4l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.5L4.1 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  warn: <><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7z" />,
  clip: <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2H9z" />,
  download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
  upload: <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 21h14" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="1.5" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></>,
  zoomfit: <><path d="M3 8V5a2 2 0 0 1 2-2h3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  hash: <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />,
  branch: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M6 16a9 9 0 0 0 9-9" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
};

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const p = ICONS[name] ?? ICONS.dot;
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {p}
    </svg>
  );
}
