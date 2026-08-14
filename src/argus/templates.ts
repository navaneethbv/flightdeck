export type MissionTemplateKind = 'feature' | 'refactor' | 'audit' | 'bugfix';

export const MISSION_TEMPLATES: Record<MissionTemplateKind, (title: string) => string> = {
  feature: (title: string) => `# Mission: ${title}

## Overview
Implement the requested feature: ${title}.

## Objectives
- [ ] Implement core logic and helper utilities in targeted worktrees
- [ ] Add comprehensive unit and integration tests
- [ ] Update documentation and type definitions
- [ ] Validate end-to-end functionality

## Architecture & Guardrails
- Maintain modular structure and strict TypeScript types.
- Ensure all existing and new tests pass without regressions.
- Isolate distinct subtasks into dedicated worktrees.

## Tasks
- Implement backend data structures and core services
- Implement CLI commands and user-facing MCP tools
- Write unit tests and verify complete test suite
`,

  refactor: (title: string) => `# Mission: ${title}

## Overview
Refactor and optimize code for: ${title}.

## Objectives
- [ ] Audit existing implementation for bottlenecks or duplications
- [ ] Perform non-breaking structural refactoring
- [ ] Preserve full public API compatibility and behavior
- [ ] Verify test suite passes with zero regressions

## Guardrails
- Do not introduce breaking API changes.
- Ensure all existing tests continue to pass.

## Tasks
- Analyze current implementation and identify duplication
- Extract reusable components and simplify complex modules
- Run complete test suite and benchmarks
`,

  audit: (title: string) => `# Mission: ${title}

## Overview
Security, performance, and code quality audit for: ${title}.

## Objectives
- [ ] Inspect codebase for potential vulnerabilities and edge cases
- [ ] Audit dependency versions and security advisories
- [ ] Generate structured audit summary note in project notes store

## Guardrails
- Read-only analysis; do not mutate production files without explicit approval.

## Tasks
- Scan permissions, authentication tokens, and keychain access
- Check input validation and boundary conditions
- Record findings into audit report note
`,

  bugfix: (title: string) => `# Mission: ${title}

## Overview
Investigate and resolve bug: ${title}.

## Objectives
- [ ] Reproduce the reported issue with a failing test case
- [ ] Identify root cause in session or orchestrator state
- [ ] Apply minimal, clean patch
- [ ] Verify reproduction test passes

## Tasks
- Create reproduction test case
- Apply bugfix to resolve the issue
- Verify all unit and integration tests pass
`,
};

export function renderMissionTemplate(kind: MissionTemplateKind, title: string): string {
  const tmpl = MISSION_TEMPLATES[kind] ?? MISSION_TEMPLATES.feature;
  return tmpl(title);
}
