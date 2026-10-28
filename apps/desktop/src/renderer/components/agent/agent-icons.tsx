import type { ReactNode } from 'react';

// The agent panel's icons, drawn for frost: stroked shapes on a 24×24 grid like `icons.tsx`,
// inheriting `currentColor`; sizing and colour come from agent.css (no inline styles: strict CSP).

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

/** The agent: a four-pointed spark with a small one beside it. */
export function AgentSparkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" />
      <path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </Icon>
  );
}

/** Send: an arrow pointing up. */
export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V6" />
      <path d="M6.5 11.5L12 6l5.5 5.5" />
    </Icon>
  );
}

/** Stop: a rounded square. */
export function StopSquareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </Icon>
  );
}

/** Settings: sliders. */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 7h9" />
      <path d="M18 7h1" />
      <circle cx="16" cy="7" r="2" />
      <path d="M5 17h2" />
      <path d="M11 17h8" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

/** The chat list: stacked speech lines. */
export function ChatsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 6.5h14v8.5H11l-4 3v-3H5z" />
      <path d="M8.5 10h7" />
      <path d="M8.5 12.5h4" />
    </Icon>
  );
}

/** Delete: a bin. */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 7h14" />
      <path d="M10 4h4" />
      <path d="M7 7l.8 12h8.4L17 7" />
    </Icon>
  );
}
