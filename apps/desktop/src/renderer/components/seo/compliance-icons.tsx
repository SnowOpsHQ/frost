import type { ReactNode } from 'react';

// The Compliance panel's icons, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
// inheriting `currentColor`; sizing and colour come from styles.css (no inline styles: strict CSP).

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

const SHIELD = 'M12 3.2l7 2.6v5.4c0 4.4-2.9 8-7 9.6-4.1-1.6-7-5.2-7-9.6V5.8z';

/** A shield with a tick: the page is secure. */
export function ShieldCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} />
      <path d="M8.9 12.1l2.2 2.2 4.1-4.4" />
    </Icon>
  );
}

/** A shield with an exclamation mark: something weakens it. */
export function ShieldWarnIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} />
      <path d="M12 8.2v4.4" />
      <path d="M12 15.6h.01" />
    </Icon>
  );
}

/** A shield crossed out: not secure. */
export function ShieldOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} />
      <path d="M9.4 9.6l5.2 5.2" />
      <path d="M14.6 9.6l-5.2 5.2" />
    </Icon>
  );
}

/** A laptop: a page served from this computer. */
export function LocalHostIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="5.5" width="15" height="10" rx="1.6" />
      <path d="M2.8 18.5h18.4" />
      <path d="M10.4 18.5l.5-1.2h2.2l.5 1.2" />
    </Icon>
  );
}

/** Stacked header lines with a key: response headers. */
export function HeadersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 6.5h9" />
      <path d="M4.5 11h6" />
      <path d="M4.5 15.5h4.5" />
      <circle cx="16.4" cy="14.6" r="2.6" />
      <path d="M18.3 16.5l2.2 2.2" />
    </Icon>
  );
}

/** A padlock with a broken shackle: mixed content. */
export function MixedContentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 6.4-2" />
      <path d="M12 14.4v2.4" />
    </Icon>
  );
}

/** A person with open arms in a circle: accessibility. */
export function AccessibilityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="7.6" r="1.3" />
      <path d="M7.6 10.2l4.4 1 4.4-1" />
      <path d="M12 11.2v3.1l-2.2 3.6" />
      <path d="M12 14.3l2.2 3.6" />
    </Icon>
  );
}

/** A triangle pointing right: run. */
export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.8v12.4l9.6-6.2z" />
    </Icon>
  );
}

/** A stopwatch: timed out. */
export function StopwatchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="13.2" r="7" />
      <path d="M12 13.2V9.6" />
      <path d="M10 3.4h4" />
      <path d="M18.2 7.2l1.3-1.3" />
    </Icon>
  );
}

/** A small arrow pointing down-right inside a box: an element (a node) of the page. */
export function ElementIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 6L4 12l4.5 6" />
      <path d="M15.5 6L20 12l-4.5 6" />
      <path d="M13.2 5.2l-2.4 13.6" />
    </Icon>
  );
}

/** A large, quiet illustration for a check that has not run yet: a page with an accessibility mark. */
export function A11yArt(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 3.5h7.5l4 4v13h-11.5z" />
      <path d="M14 3.5v4h4" />
      <circle cx="12.2" cy="11.2" r="1" />
      <path d="M9.3 13.2l2.9.7 2.9-.7" />
      <path d="M12.2 13.9v2l-1.4 2.3" />
      <path d="M12.2 15.9l1.4 2.3" />
    </Icon>
  );
}
