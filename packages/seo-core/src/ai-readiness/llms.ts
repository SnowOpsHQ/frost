import { LLMS_TXT_PARSE_LIMITS, type LlmsTxtFinding } from '@app/specs/ai-readiness.spec';

// `/llms.txt` read against llmstxt.org's proposal (spec `ai-readiness.spec.ts`, llms.txt; acceptance
// `ai-readiness.feature.md`). Pure and bounded (`LLMS_TXT_PARSE_LIMITS`); it runs in the probes' SERP
// worker (an `llms-txt` job), never on main's thread. The file is untrusted text: only counts, the
// findings and a capped, control-free title come out of it.

/** What the file says. */
export interface LlmsTxtParse {
  /** The H1's text (capped, control characters dropped); `null`: no H1. */
  readonly title: string | null;
  /** H2 sections. */
  readonly sections: number;
  /** List items under H2 sections written `[name](url)` (optionally followed by `: notes`). */
  readonly links: number;
  /** Where it departs from the proposal (`LLMS_TXT_FINDINGS` order). */
  readonly findings: readonly LlmsTxtFinding[];
  /** The parse stopped at `maxChars` or `maxLines`. */
  readonly partial: boolean;
}

const H1 = /^#[ \t]+(\S.*)$/;
const H2 = /^##[ \t]+\S/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const LIST_ITEM = /^[ \t]*[-*+][ \t]+(.*)$/;
/** `[name](url)`, then nothing or `: notes` (the proposal's file-list entry). */
const LINK_ITEM = /^\[[^\]\n]+\]\([^\s()]+\)(?:[ \t]*:.*)?[ \t]*$/;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

const cleanTitle = (text: string): string => {
  const clean = text.replace(CONTROLS, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
  return clean.length > LLMS_TXT_PARSE_LIMITS.maxTitleChars ? clean.slice(0, LLMS_TXT_PARSE_LIMITS.maxTitleChars) : clean;
};

/** Reads an `llms.txt` (already decoded). Never throws. */
export function parseLlmsTxt(text: string): LlmsTxtParse {
  const L = LLMS_TXT_PARSE_LIMITS;
  let partial = text.length > L.maxChars;
  const lines = (partial ? text.slice(0, L.maxChars) : text).split(/\r\n|\r|\n/);
  if (lines.length > L.maxLines) {
    partial = true;
    lines.length = L.maxLines;
  }
  let title: string | null = null;
  let h1First = false;
  let seenContent = false;
  let inFence = false;
  let inSection = false;
  let sections = 0;
  let links = 0;
  let otherItems = 0;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      seenContent = true;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') continue;
    const h1 = H1.exec(line);
    if (h1 && title === null) {
      title = cleanTitle(h1[1]!);
      h1First = !seenContent;
      seenContent = true;
      continue;
    }
    seenContent = true;
    if (H2.test(line)) {
      sections += 1;
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    if (LINK_ITEM.test(item[1]!.trim())) links += 1;
    else otherItems += 1;
  }
  const findings: LlmsTxtFinding[] = [];
  if (title === null) findings.push('no-h1');
  else if (!h1First) findings.push('h1-not-first');
  if (links === 0) findings.push('no-links');
  if (otherItems > 0) findings.push('links-not-markdown');
  return { title, sections: Math.min(sections, L.maxLines), links: Math.min(links, L.maxLines), findings, partial };
}
