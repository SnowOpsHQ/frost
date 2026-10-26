import type { ReactNode } from 'react';

// frost's own toolbar icons: simple stroked shapes on a 24×24 grid, drawn for this app. They
// inherit `currentColor`; sizing and colour come from styles.css (no inline styles: strict CSP).

interface IconProps {
  readonly className?: string;
}

function Icon({ className, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5.5" />
      <path d="M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function ForwardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h13.5" />
      <path d="M13 6l6 6-6 6" />
    </Icon>
  );
}

export function ReloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18.6 13.2A6.8 6.8 0 1 1 16.8 7" />
      <path d="M18.8 3.8v4.4h-4.4" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 7l10 10" />
      <path d="M17 7L7 17" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="10.5" width="12" height="9" rx="2.2" />
      <path d="M8.8 10.5V8.2a3.2 3.2 0 0 1 6.4 0v2.3" />
    </Icon>
  );
}

export function NotSecureIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11.2v4.6" />
      <path d="M12 8.2h.01" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="M15.2 15.2L19.5 19.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </Icon>
  );
}

/** The tab close button's ×: shorter arms than `StopIcon`, for a small hit target. */
export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.75 7.75l8.5 8.5" />
      <path d="M16.25 7.75l-8.5 8.5" />
    </Icon>
  );
}

/**
 * The tab glyph for a loaded page, in place of a favicon (the chrome never shows page-supplied
 * images): a globe of two meridians and two parallels.
 */
export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4c-2.4 2.2-3.5 4.9-3.5 8s1.1 5.8 3.5 8" />
      <path d="M12 4c2.4 2.2 3.5 4.9 3.5 8s-1.1 5.8-3.5 8" />
      <path d="M4.6 9.3h14.8" />
      <path d="M4.6 14.7h14.8" />
    </Icon>
  );
}

/** frost's mark: a six-armed ice crystal, each arm with one pair of short branches. */
export function FrostMark(props: IconProps) {
  const arms = [0, 60, 120, 180, 240, 300];
  return (
    <svg
      className={props.className ? `mark ${props.className}` : 'mark'}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {arms.map((angle) => (
        <g key={angle} transform={`rotate(${angle} 24 24)`}>
          <path d="M24 24V6" />
          <path d="M18.5 9.5L24 14l5.5-4.5" />
        </g>
      ))}
      <circle cx="24" cy="24" r="3.2" />
    </svg>
  );
}

/** A small warning triangle: the tab glyph of a tab showing its error or crash panel. */
export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 4.9a2 2 0 0 1 3.4 0l7 12.2A2 2 0 0 1 19 20H5a2 2 0 0 1-1.7-2.9z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 16.6h.01" />
    </Icon>
  );
}

/**
 * The panels' illustrations: 48×48, the same rounded stroke as frost's mark. A `panel-art-gap`
 * stroke is drawn in the page colour (styles.css) to cut a clean gap where a slash crosses a shape.
 */
function PanelArt({ className, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      className={className ? `panel-art ${className}` : 'panel-art'}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Certificate refused: a shield with an exclamation mark. */
export function ShieldAlertArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <path d="M24 5.5l14.5 5.2v10.6c0 9.4-6 17.2-14.5 21.2C15.5 38.5 9.5 30.7 9.5 21.3V10.7z" />
      <path d="M24 15.5v11" />
      <path d="M24 32.5h.01" />
    </PanelArt>
  );
}

/** Site unreachable: frost's globe (two meridians, two parallels), struck through. */
export function UnreachableArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <circle cx="24" cy="24" r="15" />
      <path d="M24 9c-4.4 4.1-6.5 9.1-6.5 15s2.1 10.9 6.5 15" />
      <path d="M24 9c4.4 4.1 6.5 9.1 6.5 15s-2.1 10.9-6.5 15" />
      <path d="M10.2 18.5h27.6" />
      <path d="M10.2 29.5h27.6" />
      <path className="panel-art-gap" d="M8.5 8.5l31 31" strokeWidth="6" />
      <path d="M8.5 8.5l31 31" />
    </PanelArt>
  );
}

/** Offline: three signal arcs and a dot, struck through. */
export function OfflineArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <path d="M6.5 19.5a25 25 0 0 1 35 0" />
      <path d="M12.5 25.8a16.5 16.5 0 0 1 23 0" />
      <path d="M18.6 32a8 8 0 0 1 10.8 0" />
      <path d="M24 38h.01" />
      <path className="panel-art-gap" d="M9 9l30 30" strokeWidth="6" />
      <path d="M9 9l30 30" />
    </PanelArt>
  );
}

/** Generic load failure: a page with an exclamation mark. */
export function PageAlertArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <path d="M13 5.5h15.5L37 14v26.5a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2v-33a2 2 0 0 1 2-2z" />
      <path d="M28.5 5.5V14H37" />
      <path d="M24 21v9" />
      <path d="M24 35h.01" />
    </PanelArt>
  );
}

/** Crashed page: a browser frame split top to bottom by a jagged crack, its halves pushed apart. */
export function CrashArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <path d="M22 8.5H10a4 4 0 0 0-4 4v23a4 4 0 0 0 4 4h11.5l-3-6.5 4.5-6-5-4.5z" />
      <path d="M27.5 8.5H38a4 4 0 0 1 4 4v23a4 4 0 0 1-4 4H27l-3-6.5 4.5-6-5-4.5z" />
      <path d="M6 16h13" />
      <path d="M26.2 16H42" />
      <path d="M10.5 12.3h.01" />
      <path d="M14.5 12.3h.01" />
    </PanelArt>
  );
}

// ---- Permission prompt icons (24×24, the toolbar's stroke) -------------------------------------

/** Location: a map pin with a hollow centre. */
export function LocationIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20.5s-6.2-5.6-6.2-10.6a6.2 6.2 0 0 1 12.4 0c0 5-6.2 10.6-6.2 10.6z" />
      <circle cx="12" cy="9.9" r="2.3" />
    </Icon>
  );
}

/** Notifications: a bell with its clapper. */
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.2 16.5V11a5.8 5.8 0 0 1 11.6 0v5.5l1.5 1.6H4.7z" />
      <path d="M10.2 20.2a2 2 0 0 0 3.6 0" />
    </Icon>
  );
}

/** Camera: a video camera body with its lens wedge. */
export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="7" width="12" height="10" rx="2.2" />
      <path d="M15.5 10.6l5-2.8v8.4l-5-2.8" />
    </Icon>
  );
}

/** Microphone: a capsule on a stand. */
export function MicrophoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="3.8" width="6" height="10.4" rx="3" />
      <path d="M6 11.2a6 6 0 0 0 12 0" />
      <path d="M12 17.2v3" />
    </Icon>
  );
}

/** Camera and microphone: the camera with a small capsule beside it. */
export function CameraMicrophoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.8" y="8" width="10" height="8.4" rx="2" />
      <path d="M12.8 11l3.4-1.9v6.2l-3.4-1.9" />
      <rect x="18.3" y="5.6" width="3.2" height="6.4" rx="1.6" />
      <path d="M17.2 13.6a2.7 2.7 0 0 0 5.4 0" />
      <path d="M19.9 16.4v2" />
    </Icon>
  );
}

/** Clipboard read: a clipboard with two lines of text on it. */
export function ClipboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 5.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2h-1.5" />
      <rect x="8.5" y="3.5" width="7" height="3.6" rx="1.2" />
      <path d="M8.6 12h6.8" />
      <path d="M8.6 15.6h4.4" />
    </Icon>
  );
}

// ---- SEO sidebar ------------------------------------------------------------------------------

/** The toolbar's sidebar toggle: a window with a docked right-hand panel. */
export function SidebarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.6" />
      <path d="M14.5 5v14" />
      <path d="M16.8 9h1.4" />
      <path d="M16.8 12h1.4" />
    </Icon>
  );
}

/** Overview: a gauge with its needle. */
export function OverviewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.2 16.5a8 8 0 1 1 15.6 0" />
      <path d="M12 14.2l3.6-4.4" />
      <circle cx="12" cy="14.6" r="1.4" />
      <path d="M6.9 18.5h10.2" />
    </Icon>
  );
}

/** On-Page: a page with a headline and text lines. */
export function OnPageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 3.8h7.6l4.4 4.4v11a1.6 1.6 0 0 1-1.6 1.6H6.5a1.6 1.6 0 0 1-1.6-1.6V5.4a1.6 1.6 0 0 1 1.6-1.6z" />
      <path d="M14 3.9v4.4h4.4" />
      <path d="M8.2 12h7.2" />
      <path d="M8.2 15.2h7.2" />
      <path d="M8.2 8.8h3" />
    </Icon>
  );
}

/** Schema: curly braces around a dot. */
export function SchemaIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 4.5c-2 0-2.6 1-2.6 2.6v2.2c0 1.2-.8 2.2-2.1 2.7 1.3.5 2.1 1.5 2.1 2.7v2.2c0 1.6.6 2.6 2.6 2.6" />
      <path d="M15.5 4.5c2 0 2.6 1 2.6 2.6v2.2c0 1.2.8 2.2 2.1 2.7-1.3.5-2.1 1.5-2.1 2.7v2.2c0 1.6-.6 2.6-2.6 2.6" />
      <path d="M12 12h.01" />
    </Icon>
  );
}

/** Indexability: a magnifier over a page line. */
export function IndexabilityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
      <path d="M8 10.5h5" />
    </Icon>
  );
}

/** Page Speed: a lightning bolt. */
export function SpeedIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 3.5L5.8 13.3h5.6l-1 7.2 7.4-9.8h-5.6z" />
    </Icon>
  );
}

/** Compliance: a shield with a check mark. */
export function ComplianceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.6l7 2.6v5.3c0 4.6-2.9 8.3-7 10.2-4.1-1.9-7-5.6-7-10.2V6.2z" />
      <path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
    </Icon>
  );
}

/** An expander's chevron (points down; rotated by styles.css when collapsed). */
export function ChevronIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 10l5 5 5-5" />
    </Icon>
  );
}

/** Severity glyphs of the issue list. */
export function ErrorGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M9.2 9.2l5.6 5.6" />
      <path d="M14.8 9.2l-5.6 5.6" />
    </Icon>
  );
}

export function WarningGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 4.9a2 2 0 0 1 3.4 0l7 12.2A2 2 0 0 1 19 20H5a2 2 0 0 1-1.7-2.9z" />
      <path d="M12 9.8v3.8" />
      <path d="M12 16.6h.01" />
    </Icon>
  );
}

export function InfoGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11.2v4.8" />
      <path d="M12 8h.01" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M8.4 12.3l2.5 2.5 4.8-5" />
    </Icon>
  );
}

/** The sidebar's empty-tab hint: a magnifier over a page. */
export function AuditArt(props: IconProps) {
  return (
    <PanelArt {...props}>
      <path d="M12 6h15l7 7v15" />
      <path d="M27 6v7h7" />
      <path d="M12 6a2 2 0 0 0-2 2v30a2 2 0 0 0 2 2h12" />
      <path d="M16 16h7" />
      <path d="M16 22h12" />
      <circle cx="32" cy="33" r="6" />
      <path d="M36.4 37.4l4.1 4.1" />
    </PanelArt>
  );
}

export function LinksIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1" />
    </Icon>
  );
}

export function ImagesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.8" y="5" width="16.4" height="14" rx="2.2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.2 17l4.6-4.4 3.4 3.2 2.6-2.4 5 4.4" />
    </Icon>
  );
}

export function SocialIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="17" cy="6.2" r="2.4" />
      <circle cx="7" cy="12" r="2.4" />
      <circle cx="17" cy="17.8" r="2.4" />
      <path d="M9.1 10.8l5.8-3.4" />
      <path d="M9.1 13.2l5.8 3.4" />
    </Icon>
  );
}

/** Highlight mode: a dashed box around a cursor-free target. */
export function HighlightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <rect x="8.2" y="9.5" width="7.6" height="5" rx="1.2" />
    </Icon>
  );
}

export function OpenTabIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 5h6v6" />
      <path d="M19 5l-8 8" />
      <path d="M17 14v3.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 17.5v-9A1.5 1.5 0 0 1 6.5 7H10" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Icon>
  );
}

/**
 * The neutral stand-in for a social card's image: frost never loads the page's remote image into
 * the chrome (`SOCIAL_REMOTE_IMAGES`). It stretches to its box (styles.css sizes it).
 */
export function ImagePlaceholderArt({ className }: IconProps) {
  return (
    <svg className={className ? `seo-placeholder-art ${className}` : 'seo-placeholder-art'} viewBox="0 0 120 63" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <rect className="seo-placeholder-bg" x="0" y="0" width="120" height="63" />
      <circle className="seo-placeholder-shape" cx="86" cy="20" r="7" />
      <path className="seo-placeholder-shape" d="M0 63 L34 30 L54 48 L70 36 L120 63 Z" />
    </svg>
  );
}
