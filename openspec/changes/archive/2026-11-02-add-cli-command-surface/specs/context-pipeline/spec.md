# Spec Delta

## ADDED Requirements

### Requirement: Manual compaction

When a settled session requests compaction, the pipeline SHALL compact even below the threshold when a cut point exists, SHALL preserve recent turns verbatim, and SHALL record `compaction_start` and `compaction_end` with reason `manual` and token counts.

#### Scenario: Manual compaction below threshold

- **WHEN** a client requests manual compaction on a settled session with a cut point
- **THEN** older history is replaced by a summary, recent turns remain, and the recorded token counts match the before and after estimates

#### Scenario: No cut point

- **WHEN** the history has no compactable cut point
- **THEN** no compaction event is recorded and the history is unchanged
