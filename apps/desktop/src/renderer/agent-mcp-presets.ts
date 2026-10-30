import { filterPresets, mcpPresetCategoriesInUse, mcpPresetCategoryLabel, presetDraft, type McpPreset, type McpPresetCategory } from '@app/specs/agent-mcp-presets.spec';
import { emptyMcpDraft, type McpServerDraft } from './agent-view';

// The MCP server catalogue's view helpers (`agent-mcp-presets.feature.md`, Settings). Presets are
// spec data: nothing here reaches main or the network. Choosing one only gives the add form its
// starting values; the form's own "Add server" saves, as for a server typed by hand.

/** A category chip: `null` is "All". */
export interface McpPresetChip {
  readonly category: McpPresetCategory | null;
  readonly label: string;
  readonly selected: boolean;
}

/** "All", then one chip per category that holds a shipped preset (a category with none shows no chip). */
export function mcpPresetChips(selected: McpPresetCategory | null, allLabel: string): McpPresetChip[] {
  return [{ category: null, label: allLabel, selected: selected === null }, ...mcpPresetCategoriesInUse().map((item) => ({ category: item.id, label: item.label, selected: selected === item.id }))];
}

/** A catalogue row, as the sheet shows it. */
export interface McpPresetRow {
  readonly preset: McpPreset;
  readonly id: string;
  readonly name: string;
  readonly categoryLabel: string;
  readonly description: string;
  readonly tokenHint: string;
  readonly docsUrl: string;
}

export function mcpPresetRows(query: string, category: McpPresetCategory | null): McpPresetRow[] {
  return filterPresets(query, category).map((preset) => ({
    preset,
    id: preset.id,
    name: preset.name,
    categoryLabel: mcpPresetCategoryLabel(preset.category),
    description: preset.description,
    tokenHint: preset.tokenHint,
    docsUrl: preset.docsUrl,
  }));
}

/**
 * The add form's values for a preset (`presetDraft` as the form holds it): arguments one per line,
 * variable rows with empty values. `mcpDraftToInput` of it is `presetDraft(preset)`.
 */
export function presetFormDraft(preset: McpPreset): McpServerDraft {
  const draft = presetDraft(preset);
  if (draft.transport === 'http') return { ...emptyMcpDraft(), name: draft.name, transport: 'http', url: draft.url };
  return {
    ...emptyMcpDraft(),
    name: draft.name,
    transport: 'stdio',
    command: draft.command,
    args: draft.args.join('\n'),
    readPaths: draft.readPaths.join('\n'),
    allowNetwork: draft.allowNetwork,
    env: draft.env.map((item) => ({ name: item.name, value: '' })),
  };
}
