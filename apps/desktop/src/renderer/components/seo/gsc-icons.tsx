// The Search Console panel's icon, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
// inheriting `currentColor`; sizing and colour come from styles.css (no inline styles: strict CSP).

/** The rail item: a magnifier over a rising line (search performance over time). */
export function GscIcon({ className }: { readonly className?: string }) {
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
      <path d="M3.5 17.5l4.5-4.5 3 2.5 4-5" />
      <path d="M3.5 20.5h17" />
      <circle cx="17" cy="7.5" r="3.5" />
      <path d="M19.6 10.1l1.9 1.9" />
    </svg>
  );
}
