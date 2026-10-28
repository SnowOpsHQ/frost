import type { ReactNode } from 'react';

// The SERP and Visibility panels' icons, drawn for frost: stroked shapes on a 24×24 grid like
// `icons.tsx`, inheriting `currentColor`; sizing and colour come from styles.css (no inline styles:
// strict CSP).

function Glyph({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
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

/** The SERP rail item: a short stack of result lines under a search field. */
export function SerpIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="3.5" y="3.5" width="17" height="5" rx="2.5" />
      <path d="M6.5 12.5h11" />
      <path d="M6.5 16h7" />
      <path d="M6.5 19.5h9" />
    </Glyph>
  );
}

/** The Visibility rail item: an eye whose pupil is a small crawler's head. */
export function VisibilityIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M2.5 12c2.4-4.2 5.6-6.3 9.5-6.3s7.1 2.1 9.5 6.3c-2.4 4.2-5.6 6.3-9.5 6.3S4.9 16.2 2.5 12z" />
      <rect x="9" y="9.5" width="6" height="5" rx="1.4" />
      <path d="M12 9.5V8" />
    </Glyph>
  );
}

/** The outline toggle: a dashed box around a result line. */
export function OutlineIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" strokeDasharray="2.6 2.2" />
      <path d="M7.5 10.5h9" />
      <path d="M7.5 14h5.5" />
    </Glyph>
  );
}
