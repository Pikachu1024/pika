export const usage = `pika: terminal client for the Pika Harness

Usage:
  pika [options]                              start the TUI with a bundled local server
  pika --prompt <text> [options]              run one prompt and exit
  pika serve [--port <n>] [--host <addr>] [--dir <path>]
             [--sandbox-backend <backend>]
                                              run the session server only

Client options:
  --url <ws://host:port>        connect to an existing server instead of starting one
  --session <id>                resume a session
  --cwd <path>                  working directory for sessions
  --sandbox-mode <mode>         read-only|workspace-write|danger-full-access
  --network <policy>            none|proxy|full
  --llm-base-url <url>          OpenAI-compatible endpoint
  --llm-model <model>           model id for the endpoint
  --llm-api-key <key>           API key for the endpoint
  --llm-context-window <tokens> context window for compaction
  --llm-max-tokens <tokens>     maximum output tokens
  -h, --help                    show this help

Slash commands: /help, /models, /model, /connect, /config, /status, /usage,
/context, /new, /sessions, /resume, /fork, /handoff, /sandbox, /compact, /btw,
/approve, /deny, /quit.

Without --url, pika starts a server on 127.0.0.1 with an ephemeral port and a
per-run token, then stops it when the client exits.
Run /connect in the TUI to add an endpoint; it saves to the user catalog.
Model presets load from $PIKA_HOME/models.json (~/.pika/models.json), .pika/models.json,
or PIKA_MODELS_FILE; credentials live in $PIKA_HOME/credentials.json.
Sessions default to $PIKA_HOME/sessions (~/.pika/sessions).
Environment: PIKA_HOME, PIKA_SERVER_URL, PIKA_MODELS_FILE, PIKA_CONFIG_DIR, PIKA_LLM_BASE_URL,
PIKA_LLM_MODEL, PIKA_LLM_API_KEY, PIKA_LLM_CONTEXT_WINDOW, PIKA_LLM_MAX_TOKENS,
PIKA_SESSION_DIR, PIKA_SANDBOX_BACKEND.
Sandbox backends: auto (default), none, seatbelt, bwrap, docker.
`;
