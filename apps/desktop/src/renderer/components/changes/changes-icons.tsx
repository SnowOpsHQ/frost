import type { ReactNode } from 'react';

// The Changes panel's icons, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
// inheriting `currentColor`; sizing and colour come from styles.css (no inline styles: strict CSP).

function Glyph({ className, children }: { readonly className?: string | undefined; readonly children: ReactNode }) {
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

/** The rail item: an older page behind a newer one, with a clock hand on the newer (a page's versions over time). */
export function ChangesIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8.5 5.5V4.2c0-.4.3-.7.7-.7h9.6c.4 0 .7.3.7.7v11.6c0 .4-.3.7-.7.7h-1.3" />
      <rect x="4.5" y="7.5" width="11" height="13" rx="1.2" />
      <circle cx="10" cy="14" r="3.2" />
      <path d="M10 12.4V14l1.2.8" />
    </Glyph>
  );
}

/** Capture now: a ring around a filled dot (record this state). */
export function CaptureGlyph({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </Glyph>
  );
}
