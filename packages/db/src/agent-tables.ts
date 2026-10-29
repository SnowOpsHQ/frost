import { AGENT_GRANT_TABLES } from '@app/specs/agent-approvals.spec';
import { AGENT_CHAT_TABLES, AGENT_SKILL_TABLES } from '@app/specs/agent-data.spec';
import { AGENT_MCP_TABLES } from '@app/specs/agent-mcp.spec';

// Every table Phase 5's migrations (`0030`–`0039`) create, in one list, so shared tests check them
// by appending one name (`migrations.test.ts`) rather than listing each agent table themselves.
export const AGENT_TABLES = [...AGENT_GRANT_TABLES, ...AGENT_CHAT_TABLES, ...AGENT_SKILL_TABLES, ...AGENT_MCP_TABLES] as const;
