import {
  CHAT_EXPORT_FORMAT_VERSION,
  CHAT_EXPORT_JSON_KIND,
  CHAT_EXPORT_UNTRUSTED_NOTE,
  CHAT_EXPORT_UNTRUSTED_OUTPUT_LABEL,
  type ChatExportFormat,
  type ChatExportMessageV1,
  type ChatExportV1,
} from '@app/specs/agent-data.spec';
import { AGENT_TOOL_STATUS_LABELS } from '@app/specs/agent-panel.spec';
import { toolLabel } from './approvals';
import type { ChatSnapshot, ToolCardSnapshot } from './chat-record';

// A chat as text the user saves (Phase 5 Task 9; spec `specs/agent-data.spec.ts`, Export; acceptance
// `specs/agent-data.feature.md`, Export). Built by main from the chat's display entries only: the
// user's messages, the agent's replies and each tool card's bounded input and output preview. Never
// a chat, call or approval id, an input hash or a key; tool output stays marked untrusted. Main
// writes the text only where the user chose in its own save dialog (`service.ts`).

const iso = (ms: number) => new Date(ms).toISOString();

/** The JSON export (`ChatExportV1`), as an object. */
export function chatExportObject(chat: ChatSnapshot, exportedAt: number): ChatExportV1 {
  const messages: ChatExportMessageV1[] = chat.entries.map((entry) =>
    entry.kind === 'user'
      ? { role: 'user', text: entry.text, ...(entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}) }
      : {
          role: 'assistant',
          text: entry.text,
          tools: entry.tools.map((card) => ({
            tool: card.toolName,
            label: toolLabel(card.toolName),
            status: card.status,
            error: card.code,
            input: card.inputPreview,
            output: card.outputPreview === null ? null : { untrusted: true as const, text: card.outputPreview },
          })),
        },
  );
  return {
    kind: CHAT_EXPORT_JSON_KIND,
    version: CHAT_EXPORT_FORMAT_VERSION,
    exportedAt: iso(exportedAt),
    chat: { title: chat.title, updatedAt: iso(chat.updatedAt), model: chat.modelId, truncated: chat.truncated, messages },
  };
}

/** A fence longer than any run of backticks in `text` (at least three), so the block can't be closed from inside. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function toolBlock(card: ToolCardSnapshot): string {
  const status = AGENT_TOOL_STATUS_LABELS[card.status] ?? card.status;
  const body = [`input: ${card.inputPreview}`, ...(card.outputPreview === null ? [] : [`${CHAT_EXPORT_UNTRUSTED_OUTPUT_LABEL}:`, card.outputPreview])].join('\n');
  const fence = fenceFor(body);
  // The info string names the tool and its status; both are frost's own values.
  return [`${fence}tool ${card.toolName} (${status}${card.code !== null && card.code !== card.status ? `: ${card.code}` : ''})`, body, fence].join('\n');
}

/** The Markdown export: a heading, the untrusted-output note, then each turn; tool cards as fenced blocks. */
export function chatMarkdown(chat: ChatSnapshot, exportedAt: number): string {
  const lines: string[] = [`# ${chat.title.trim() === '' ? 'Untitled chat' : chat.title}`, ''];
  lines.push(`Exported from frost on ${iso(exportedAt)}. Last updated ${iso(chat.updatedAt)}.${chat.modelId !== null ? ` Model: ${chat.modelId}.` : ''}`, '');
  lines.push(`> ${CHAT_EXPORT_UNTRUSTED_NOTE}`, '');
  if (chat.truncated) lines.push('_Earlier messages were not kept._', '');
  for (const entry of chat.entries) {
    if (entry.kind === 'user') {
      lines.push(entry.skill !== undefined ? `## You (skill: ${entry.skill.name})` : '## You', '');
      if (entry.text !== '') lines.push(entry.text, '');
      continue;
    }
    lines.push('## Agent', '');
    if (entry.text !== '') lines.push(entry.text, '');
    for (const card of entry.tools) lines.push(`**${toolLabel(card.toolName)}**`, '', toolBlock(card), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The export's text in `format`. */
export function chatExportText(chat: ChatSnapshot, format: ChatExportFormat, exportedAt: number): string {
  return format === 'json' ? `${JSON.stringify(chatExportObject(chat, exportedAt), null, 2)}\n` : chatMarkdown(chat, exportedAt);
}
