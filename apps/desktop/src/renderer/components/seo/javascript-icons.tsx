// The JavaScript panel's icon, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
// inheriting `currentColor`; sizing and colour come from styles.css (no inline styles: strict CSP).

/** The rail item: a page outline with angle brackets at its corner (served markup vs the rendered page). */
export function JavascriptIcon({ className }: { readonly className?: string }) {
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
      <path d="M6.5 3.5h8l3 3v4" />
      <path d="M14.5 3.5v3h3" />
      <path d="M6.5 3.5v17h4" />
      <path d="M15 13.5l-3 3.5 3 3.5" />
      <path d="M19 13.5l3 3.5-3 3.5" />
    </svg>
  );
}
