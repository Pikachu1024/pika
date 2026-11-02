# context-pipeline Specification

## Purpose

Defines how recorded conversation becomes a provider request: sectioned system prompt assembly, deterministic projection, cache-aware ordering, token estimation, and compaction.

## Requirements

### Requirement: Sectioned system prompt

The context pipeline SHALL assemble the system prompt from named sections for identity, environment, project instructions, skill index, tool guidance, and mode, and SHALL record which tools were added or removed so a recorded prompt can be reconstructed exactly.

#### Scenario: Resume reconstructs prompt

- **WHEN** a session is resumed after a restart
- **THEN** the pipeline reconstructs the same section set and tool set that were recorded for that turn

#### Scenario: Project instructions hierarchy

- **WHEN** AGENTS.md files exist from the repository root to the working directory
- **THEN** their instructions are merged in root-to-leaf order and the environment section reflects the working directory

### Requirement: Deterministic projection

The pipeline SHALL derive provider messages from the active session branch without mutating stored records, and SHALL ensure every tool call is paired with a tool result before a request is sent.

#### Scenario: Orphan tool call

- **WHEN** the active branch contains a tool call without a matching result
- **THEN** projection inserts a synthetic error result for the request while the stored log remains unchanged

#### Scenario: Same log, same projection

- **WHEN** the same log and policy are projected twice
- **THEN** the resulting provider messages and prompt hash are identical

### Requirement: Cache-aware ordering

The context pipeline SHALL place stable content before dynamic content, SHALL avoid volatile values above the cache boundary, and SHALL record cache read/write usage returned by the provider.

#### Scenario: Consecutive requests

- **WHEN** two requests are sent in the same turn without changing tools or system sections
- **THEN** the stable prefix is unchanged and recorded usage includes cache reads when the provider reports them

### Requirement: Compaction policy

The context pipeline SHALL compact when estimated context tokens exceed the model window minus a configurable reserve, SHALL record the summary and replaced range as a compaction event, SHALL preserve recent turns verbatim, and SHALL retry once after an overflow error.

#### Scenario: Threshold compaction

- **WHEN** estimated tokens exceed the model window minus the reserve
- **THEN** a compaction event is recorded with token counts and the next projection uses the summary plus recent turns

#### Scenario: Overflow recovery

- **WHEN** the provider rejects a request because the context is too large
- **THEN** the pipeline compacts, retries once, and emits an error event if the retry still fails

### Requirement: Manual compaction

When a settled session requests compaction, the pipeline SHALL compact even below the threshold when a cut point exists, SHALL preserve recent turns verbatim, and SHALL record `compaction_start` and `compaction_end` with reason `manual` and token counts.

#### Scenario: Manual compaction below threshold

- **WHEN** a client requests manual compaction on a settled session with a cut point
- **THEN** older history is replaced by a summary, recent turns remain, and the recorded token counts match the before and after estimates

#### Scenario: No cut point

- **WHEN** the history has no compactable cut point
- **THEN** no compaction event is recorded and the history is unchanged
