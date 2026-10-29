/** Small stroke icons (24×24 grid, 1.75 stroke) drawn for this app; decorative only, so hidden from assistive tech. */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  folderPlus: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM12 11.5v5M9.5 14h5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  cpu: 'M8 8h8v8H8zM5 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  cloud: 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.4 9.1 4.75 4.75 0 0 0 7 18.5z',
  export: 'M12 3v12M7.5 10.5 12 15l4.5-4.5M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 3v5h7V3M8 21v-7h8v7',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M10 14.5v5',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  close: 'M6 6l12 12M18 6 6 18',
  logout: 'M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h10',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
  stop: 'M7 7h10v10H7z',
  check: 'M5 12.5 10 17.5 19 7',
  zoomIn: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M10.5 8v5M8 10.5h5',
  zoomOut: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M8 10.5h5',
  fit: 'M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  layers: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  face: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 10v.5M15 10v.5M8.5 14.5a4.5 4.5 0 0 0 7 0',
  shield: 'M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const s = props.size ?? 16;
  return (
    <svg
      className={`icon${props.className ? ` ${props.className}` : ''}`}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
