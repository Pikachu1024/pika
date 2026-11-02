# Event contract

Every runtime observation is one normalized `AgentEvent`. The same objects flow to three consumers without translation:

```
runtime --emit--> session log (append-only JSONL)
              \--> event sink (in-process client, tests)
              \--> server transport (later: protocol frames)
```

The schema lives in `packages/schema/src/events.ts`. Consumers must validate with `AgentEventSchema`; producers must not invent fields.

## Envelope

```
EventBase      = { sessionId, timestamp }
TurnEventBase  = EventBase + { turnId }
```

`timestamp` is an ISO-8601 string with an offset. `agent_start`, `agent_end`, and `settled` use `EventBase`; every other event uses `TurnEventBase`.

Events are emitted through a single-writer chain. The runtime awaits the session append before invoking the sink, so an event recorded in the log is exactly the event a client observes.

## Lifecycle

```
agent_start
  turn_start              turnNumber and the user input
    user_message          delivery = prompt | steer | follow_up
    message_start         assistant message
      message_delta       text | reasoning | tool_call chunks
    message_end           stopReason + optional usage
    tool_call_start       one per finalized call, after message_end
      tool_execution_start
      tool_execution_update   zero or more chunks
      tool_execution_end      normalized ToolResult
    ...                   the model is called again while tool calls or steering exist
  turn_end                stopReason and the summed turn usage
agent_end
settled
```

`agent_start` and `agent_end` bracket a run of queued turns. `settled` is emitted once the run loop drains every prompt, steer, and follow-up queue.

A provider error produces `error` before `message_end` (when a message started) and `turn_end`, both with `stopReason: "error"`. A tool failure never ends the turn by itself: it becomes a `tool_execution_end` result with `isError: true` and an `error` content part, and the model receives that result on the next call.

## Delivery semantics

| Delivery    | Enqueue point    | Effect                                                                                                                      |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `prompt`    | `prompt(text)`   | Starts a turn when idle; becomes a follow-up turn if a turn is active.                                                      |
| `steer`     | `steer(text)`    | Appended after the current model step; triggers another model call in the same turn. An idle runtime treats it as a prompt. |
| `follow_up` | `followUp(text)` | Runs as a new turn after the current turn ends.                                                                             |

`interrupt(reason)` aborts the active provider stream or tool batch. Drained tool calls receive an `aborted` error result, the turn ends with `stopReason: "aborted"`, and the runtime returns to `idle` so a later prompt succeeds.

## Event types

| Type                    | Payload                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `agent_start`           | none                                                                  |
| `agent_end`             | none                                                                  |
| `turn_start`            | `turnNumber`, `input`                                                 |
| `turn_end`              | `stopReason`, optional `usage`                                        |
| `user_message`          | `messageId`, `delivery`, `message`                                    |
| `message_start`         | `messageId`, `role: "assistant"`                                      |
| `message_delta`         | `messageId`, `delta`                                                  |
| `message_end`           | `messageId`, `stopReason`, optional `usage`                           |
| `tool_call_start`       | `messageId`, `call`                                                   |
| `tool_execution_start`  | `toolCallId`, `name`                                                  |
| `tool_execution_update` | `toolCallId`, `chunk`                                                 |
| `tool_execution_end`    | `toolCallId`, `result`                                                |
| `approval_requested`    | `approval`                                                            |
| `approval_resolved`     | `approvalId`, `resolution`                                            |
| `sandbox_decision`      | `decision`                                                            |
| `compaction_start`      | `reason` (`threshold`, `overflow`, `manual`)                          |
| `compaction_end`        | `summary`, `replacedEntryIds`, `tokensBefore`, `tokensAfter`, `model` |
| `error`                 | `error`                                                               |
| `settled`               | none                                                                  |

`usage` totals input, output, and optional cache-read/cache-write tokens. A turn's usage is the sum of its model steps; a failed or aborted step contributes only usage the provider reported.

## Error normalization

`NormalizedError` is `{ code, message, retryable, details? }`.

| Source                               | Code                                 |
| ------------------------------------ | ------------------------------------ |
| Provider `error` event               | provider-supplied code, preserved    |
| Provider stream ended without `done` | `provider_stream_incomplete`         |
| Provider transport threw             | normalized through `providerFailure` |
| Tool input failed JSON parsing       | `invalid_arguments`                  |
| Tool input failed Zod validation     | `validation_error`                   |
| Unknown tool name                    | `unknown_tool`                       |
| Tool threw                           | `execution_error`                    |
| Aborted tool call                    | `aborted`                            |
| Tool call with no executor           | `no_executor`                        |
| Model-call limit exceeded            | `max_model_calls`                    |

Provider and tool failures are data, not thrown control flow: the runtime turns them into `error` events or error `ToolResult` values, leaves the session `idle`, and accepts a later prompt.

## Fixtures

Recorded sequences with fixed clocks and ids live in `packages/core/test/fixtures/events/`:

- `tool-turn.json`: tool call, execution, second model step, and turn completion.
- `provider-error.json`: provider failure, error turn end, and recovery availability.

`packages/core/test/runtime/events-fixture.test.ts` replays each scripted provider turn and asserts deep equality with the fixture, so any accidental ordering or payload change fails the suite.
