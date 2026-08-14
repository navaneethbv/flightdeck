export const BUILTIN_PLAYBOOKS: Record<string, string> = {
  'ci-check': `name: ci-check
description: Run typecheck, lint, and tests in parallel
steps:
  - id: checks
    type: parallel
    branches:
      - - id: typecheck
          type: bash
          command: "npm run typecheck"
      - - id: lint
          type: bash
          command: "npm run lint"
      - - id: test
          type: bash
          command: "npm test"
`,
  'code-review': `name: code-review
description: Review changes in a worktree and record a summary note
inputs:
  - name: worktree
    required: true
steps:
  - id: diff
    type: mcp
    tool: worktree_diff
    arguments:
      name: "{{ inputs.worktree }}"
  - id: summary
    type: note
    action: create
    title: "Code Review: {{ inputs.worktree }}"
    body: "Automated review for worktree {{ inputs.worktree }}.\\nDiff files changed: {{ steps.diff.output.filesChanged }}"
`,
  'sync-tasks': `name: sync-tasks
description: Synchronize Jira and GitHub tasks into project tables
steps:
  - id: sync_jira
    type: mcp
    tool: sync_integration_to_table
    arguments:
      kind: jira
    on_error: continue
  - id: sync_github
    type: mcp
    tool: sync_integration_to_table
    arguments:
      kind: github
    on_error: continue
`,
};
