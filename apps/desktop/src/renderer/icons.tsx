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
