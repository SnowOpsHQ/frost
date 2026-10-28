import type { ReactNode } from 'react';
import type { PaletteGroupId } from '@app/specs/command-palette.spec';
import {
  BackIcon,
  CodeIcon,
  ComplianceIcon,
  CopyIcon,
  ForwardIcon,
  HighlightIcon,
  ImagesIcon,
  IndexabilityIcon,
  LinksIcon,
  OnPageIcon,
  OverviewIcon,
  ReloadIcon,
  RobotIcon,
  SchemaIcon,
  SidebarIcon,
  SitemapIcon,
  SocialIcon,
  SpeedIcon,
  StopIcon,
} from '../icons';
import { RenderProfileIcon } from '../components/RenderProfile';
import { ContentIcon } from '../components/seo/content-icons';
import { JavascriptIcon } from '../components/seo/javascript-icons';
import type { PaletteIconName } from './registry';
import { ChangesIcon } from '../components/changes/changes-icons';
import { InspectorIcon } from '../components/changes/changes-icons';

// The command palette's glyphs: frost's own stroked shapes on the same 24×24 grid as `icons.tsx`
// (inherit `currentColor`; sized by styles.css, no inline styles). The ones the toolbar and the SEO
// sidebar already draw are reused.

interface GlyphProps {
  readonly className?: string;
}

function Glyph({ className, children }: GlyphProps & { readonly children: ReactNode }) {
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

/** The palette's own mark: a prompt chevron and a cursor bar inside a rounded frame. */
export function PaletteMark(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3.2" />
      <path d="M7.6 9.6l2.8 2.4-2.8 2.4" />
      <path d="M12.6 15h3.8" />
    </Glyph>
  );
}

/** A plain magnifier for the search box. */
export function SearchGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="M15.2 15.2l4.3 4.3" />
    </Glyph>
  );
}

function ZoomGlyph({ mode, ...props }: GlyphProps & { readonly mode: 'in' | 'out' | 'reset' }) {
  return (
    <Glyph {...props}>
      <circle cx="10.6" cy="10.6" r="6.1" />
      <path d="M15.1 15.1l4.4 4.4" />
      {mode === 'reset' ? <path d="M8.2 9.4h4.8M8.2 11.8h4.8" /> : <path d="M8 10.6h5.2" />}
      {mode === 'in' ? <path d="M10.6 8v5.2" /> : null}
    </Glyph>
  );
}

/** A tab shape with a plus. */
function TabNewGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 19.5V8.2a2 2 0 0 1 2-2h5.2l1.8 2.3h6a2 2 0 0 1 2 2v9" />
      <path d="M3.5 19.5h17" />
      <path d="M12 11.6v5M9.5 14.1h5" />
    </Glyph>
  );
}

/** A tab shape with a cross. */
function TabCloseGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 19.5V8.2a2 2 0 0 1 2-2h5.2l1.8 2.3h6a2 2 0 0 1 2 2v9" />
      <path d="M3.5 19.5h17" />
      <path d="M10.2 12.3l3.6 3.6M13.8 12.3l-3.6 3.6" />
    </Glyph>
  );
}

/** Two stacked tabs with a turning arrow. */
function TabSwitchGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="8" width="12.5" height="11" rx="2" />
      <path d="M7.5 8V6.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H16" />
      <path d="M7 13.6h5.6M10.6 11.4l2.2 2.2-2.2 2.2" />
    </Glyph>
  );
}

/** An eraser wiping a line clean. */
function ClearGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M13.8 4.8l5.4 5.4a1.6 1.6 0 0 1 0 2.3l-6.7 6.7H8.3l-3.5-3.5a1.6 1.6 0 0 1 0-2.3l6.7-8.6a1.6 1.6 0 0 1 2.3 0z" />
      <path d="M9.4 10.2l5.4 5.4" />
      <path d="M12.5 19.2h7" />
    </Glyph>
  );
}

/** An arrow leaving a frame: the page is sent to another site. */
function ExternalGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M13.5 4.5h6v6" />
      <path d="M19.5 4.5l-8.2 8.2" />
      <path d="M17.5 13.8v3.7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3.7" />
      <circle cx="8.6" cy="15.4" r="0.6" />
    </Glyph>
  );
}

/** A person with open arms in a circle. */
function AccessibilityGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="7.9" r="1.2" />
      <path d="M7.8 10.2l4.2 1 4.2-1" />
      <path d="M12 11.2v2.6l-2.1 3.6M12 13.8l2.1 3.6" />
    </Glyph>
  );
}

/** A clipboard with a check: run the audit. */
function AuditGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="5" y="4.8" width="14" height="15.4" rx="2.2" />
      <path d="M9.2 4.8V3.9h5.6v.9" />
      <path d="M8.6 12.8l2.2 2.2 4.6-4.6" />
    </Glyph>
  );
}

/** A generic panel: a frame with a sidebar strip. */
function PanelGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
      <path d="M13.5 4.5v15M15.9 8.5h2.2M15.9 11.5h2.2" />
    </Glyph>
  );
}

const ICONS: Readonly<Record<PaletteIconName, (props: GlyphProps) => ReactNode>> = {
  panel: PanelGlyph,
  'panel-overview': OverviewIcon,
  'panel-on-page': OnPageIcon,
  'panel-content': ContentIcon,
  'render-profile': RenderProfileIcon,
  'panel-links': LinksIcon,
  'panel-images': ImagesIcon,
  'panel-social': SocialIcon,
  'panel-schema': SchemaIcon,
  'panel-indexability': IndexabilityIcon,
  'panel-speed': SpeedIcon,
  'panel-compliance': ComplianceIcon,
  'panel-javascript': JavascriptIcon,
  sidebar: SidebarIcon,
  highlight: HighlightIcon,
  audit: AuditGlyph,
  accessibility: AccessibilityGlyph,
  copy: CopyIcon,
  code: CodeIcon,
  external: ExternalGlyph,
  robot: RobotIcon,
  sitemap: SitemapIcon,
  reload: ReloadIcon,
  stop: StopIcon,
  back: BackIcon,
  forward: ForwardIcon,
  'zoom-in': (props) => <ZoomGlyph {...props} mode="in" />,
  'zoom-out': (props) => <ZoomGlyph {...props} mode="out" />,
  'zoom-reset': (props) => <ZoomGlyph {...props} mode="reset" />,
  'tab-new': TabNewGlyph,
  'tab-close': TabCloseGlyph,
  'tab-switch': TabSwitchGlyph,
  clear: ClearGlyph,
  'panel-changes': ChangesIcon,
  'panel-inspector': InspectorIcon,
};

/** Each group's glyph, for an action without its own. */
const GROUP_ICONS: Readonly<Record<PaletteGroupId, PaletteIconName>> = {
  panels: 'panel',
  audit: 'audit',
  copy: 'copy',
  'open-in': 'external',
  page: 'reload',
  tabs: 'tab-switch',
  browser: 'clear',
};

export function PaletteIcon({ name, group, className }: { readonly name: PaletteIconName | undefined; readonly group: PaletteGroupId; readonly className?: string }) {
  const Icon = ICONS[name ?? GROUP_ICONS[group]] ?? PanelGlyph;
  return <Icon className={className} />;
}
