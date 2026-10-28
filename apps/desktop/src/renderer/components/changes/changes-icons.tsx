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

/** The Inspector's rail item: an element's corner marks with a pointer picking it. */
export function InspectorIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3" />
      <path d="M11 10.5 19.5 14l-3.7 1.3-1.3 3.7z" />
    </Glyph>
  );
}

/** Pick element: a pointer over a target ring. */
export function PickGlyph({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="10" cy="10" r="6" />
      <path d="M10 2.5V5M10 15v2.5M2.5 10H5M15 10h2.5" />
      <path d="m13 13 7 3-3 1-1 3z" />
    </Glyph>
  );
}
