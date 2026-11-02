# Contributing

Read `AGENTS.md` first. It defines the repository layout, dependency rules, coding conventions, security constraints, and OpenSpec workflow.

## Workflow

1. Read the active OpenSpec change in `openspec/changes/`.
2. Keep changes scoped to the change's tasks.
3. Add or update tests with the implementation.
4. Run `pnpm check` before opening a pull request.
5. If the design needs to change, update the OpenSpec artifacts in the same change rather than diverging silently.

## Security

Do not weaken sandbox, path, environment, or approval checks to make a test pass. If a check is wrong, fix the check and add a regression test. Report security issues privately rather than opening a public issue.
