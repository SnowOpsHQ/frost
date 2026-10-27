import type { ReactNode } from 'react';

// The Content panel's icons, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
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

/** The rail item: a page of text lines with a pen nib at its corner. */
export function ContentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 20.5H6.8a1.8 1.8 0 0 1-1.8-1.8V5.3a1.8 1.8 0 0 1 1.8-1.8h8.4a1.8 1.8 0 0 1 1.8 1.8v4.2" />
      <path d="M8.2 8h5.6M8.2 11.3h4.2M8.2 14.6h2.6" />
      <path d="M15.6 20.6l.5-2.4 3.9-3.9a1.3 1.3 0 0 1 1.9 1.9l-3.9 3.9z" />
    </Icon>
  );
}

/** A desktop screen. */
export function DesktopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.2" y="4.5" width="17.6" height="11.5" rx="1.8" />
      <path d="M9 19.6h6M12 16v3.6" />
    </Icon>
  );
}

/** A phone. */
export function MobileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7" y="3" width="10" height="18" rx="2.2" />
      <path d="M10.8 17.9h2.4" />
    </Icon>
  );
}

/** A target: concentric rings and a centre dot. */
export function TargetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="4.4" />
      <path d="M12 12h.01" strokeWidth="3" />
    </Icon>
  );
}

/** An open book: readability. */
export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 6.6c-1.8-1.4-4.4-2-7.5-1.8v12.8c3.1-.2 5.7.4 7.5 1.8 1.8-1.4 4.4-2 7.5-1.8V4.8c-3.1-.2-5.7.4-7.5 1.8z" />
      <path d="M12 6.6v12.8" />
    </Icon>
  );
}

/** Stacked bars of different lengths: word counts. */
export function BarsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 6.5h15M4.5 12h10M4.5 17.5h6" />
    </Icon>
  );
}

/** A tick in a circle: present. */
export function PresentGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M8.4 12.3l2.4 2.4 4.8-5" />
    </Icon>
  );
}

/** A half-filled circle: some terms present. */
export function PartialGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** A dashed circle: absent. */
export function AbsentGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" strokeDasharray="2.6 2.6" />
      <path d="M9 12h6" />
    </Icon>
  );
}

/** A pencil: drafts. */
export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 19.5l.9-3.9L15.8 5.2a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7L8.4 18.6z" />
      <path d="M13.9 7.1l3 3" />
    </Icon>
  );
}

/** A bin: delete. */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.8 7h14.4M9.6 7V5.2h4.8V7" />
      <path d="M6.6 7l.8 11.7a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.4 7" />
      <path d="M10.2 10.8v5.6M13.8 10.8v5.6" />
    </Icon>
  );
}

/** Angle brackets: HTML. */
export function TagsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.4 5.5l-2.8 13" />
    </Icon>
  );
}

/**
 * The neutral site glyph the previews show instead of a favicon (none is fetched into the chrome):
 * a filled disc with a simple globe drawn over it.
 */
export function SiteGlyph({ className }: IconProps) {
  return (
    <svg className={className ? `seo-serp-glyph ${className}` : 'seo-serp-glyph'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle className="seo-serp-glyph-disc" cx="12" cy="12" r="12" />
      <g className="seo-serp-glyph-mark" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="6.2" />
        <path d="M5.8 12h12.4M12 5.8c-2.3 2.4-2.3 10 0 12.4M12 5.8c2.3 2.4 2.3 10 0 12.4" />
      </g>
    </svg>
  );
}
