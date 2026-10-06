# Durable subagents

This project now includes a genuine **Pi CLI extension** at `index.ts`, adapting Pi tools and its configured credential/model registry to `@earendil-works/pi-durable` with persistent SQLite. The original standalone Harness examples remain available below.

Adapted directly from upstream examples [22](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts) and [23](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts). The original downloaded examples and full durable README are retained in `upstream/`; these were fetched with curl and read before implementation. Runtime dependencies are pinned, including durable **1.0.4**; upstream main can evolve independently. The upstream package is experimental and MIT licensed.

## Run

Use Node **22.13+** (tested with 22.22.2), which supplies `node:sqlite`. SQLite may print an experimental warning. No native addon is required.

```sh
npm ci
npm run typecheck
npm test
npm run demo:foreground
npm run demo:background
```

Demos use an offline scripted faux provider by default, even if an API key is present. Foreground prints a delegated primes answer. Background spawns a reader, sends work, stops it, lists status, then closes/reopens the same SQLite database while work is pending and prints its recovered answer. Its database is temporary and removed at the end: copy the host setup and use your own permanent path for a long-lived application.

Optional real OpenAI (requires a model that supports tools):

```sh
PI_REAL=1 OPENAI_API_KEY=... OPENAI_MODEL=your-model-id npm run demo:foreground
PI_REAL=1 OPENAI_API_KEY=... OPENAI_MODEL=your-model-id npm run demo:background
```

No model ID is hardcoded for OpenAI. Real calls incur provider costs and were not tested here. The background demo's 10-second polling deadline is intended for the faux scenario; slow real models can exceed it, and model-driven tool behavior is not deterministic.

## Reuse

```ts
import { ForegroundSubagent } from './src/index.js';
import { createRegistry } from '@earendil-works/pi-durable';
const registry = createRegistry();
registry.install(ForegroundSubagent);
// Pass registry and your models to Harness.open(storage, options, context).
```

Install `BackgroundSubagents` instead for persistent named agents. Both offer a tool named `subagent`; **do not select both in the same conversation** (the later extension wins). Sources are TypeScript, run through tsx or compiled by a consuming application. `Subagents` exports the durable background document for host inspection/waits.

Foreground accepts `{task}`. Background accepts `{action: 'spawn'|'send'|'stop'|'status', name?, message?, followUp?}`. Spawn/send require a name and message; stop requires a name; status without a name lists all. Missing required action-specific fields return explanatory tool text. Schemas validate types and string lengths; blank tasks/messages throw tool errors. Names must contain 1–64 ASCII letters, digits, underscores or hyphens and cannot be Object.prototype property names (including `__proto__`, `constructor`, `toString`). Unknown agents and duplicate spawns return explanatory text.

## Ownership, replay and guarantees

- Foreground children inherit the parent agent but have this extension removed. Ownership is the tool task; aborting/failing that task reaches its child, and parent idle waits include it. `replay: 'safe'` reuses the ownership-indexed child and `subagent:${taskId}` submission on retry. The tool publishes child conversation ID in running and final details.
- Background children inherit the parent agent but cannot spawn children. A completed **background anchor** owns each child. Parent abort/idle does not cross this boundary; a host can use `root.abort(context, {background: true})` to reach background work. Stop aborts current/queued child work but preserves its conversation for later sends.
- Each message creates a background reporter with durable deliver/report phases. Delivery uses `subagent:${reporter.id}`; reports use `subagent-report:${reporter.id}`. Answer-entry IDs are recorded atomically with the report checkpoint, suppressing duplicate reports when multiple steers share an answer. Reinstall the same extension on reopen; submitting/waiting starts recovery, or call `harness.resume()` explicitly.
- Send normally steers at the next step; `followUp: true` queues after the child's answer. Reports enter the main conversation as follow-ups and cause a model turn. Parent Esc can drop a queued report; reports arriving after Esc can start a new turn. This is upstream behavior, not guaranteed user notification.
- Background tool replay remains **unsafe**: rerunning stop after a crash could stop newer work. Interrupted tool calls are reported to the model instead of rerun; committed reporters still recover. This is not universal exactly-once execution: request IDs deduplicate durable admissions, not arbitrary external side effects or provider requests.

## Limits and verification

One process must own a database at a time; durable provides no cross-process locking. SQLite uses WAL and synchronous NORMAL: process-crash recovery is supported, but recent commits can be lost on power/host failure. Closing/reopening is tested; hard-kill and power-failure injection are not. Partial model output can be retried. No sandbox, quotas, agent deletion, registry pruning, retry policy customization, or production UI is included. Names, reporter IDs and reported answer IDs accumulate as upstream does. Child transcripts have normal model/context limits and provider costs. Faux streams demonstrate scheduling, not reasoning quality.

Automated tests cover foreground answer, rejected prototype/malformed names, and a pending SQLite background child recovered on reopen, with identical root request ID and one reported answer/parent report. Demo coverage also exercises send, stop and status. Event printers are illustrative, not a reliable notification service.

The initial workspace was empty and not a Git repository (no branch/base commit). No commit was requested or made.

## Pi CLI adapter (review before switching)

**Recommended extension path:** `/Users/zayar/code/durable-subagent/index.ts`.
The old extension and global settings have not been modified. This workspace is not a Git repository; there is no branch/base commit.

Install dependencies with `npm ci` (Node 22.13+), then `npm run typecheck && npm test`.
After review, replace only `/Users/zayar/code/pi-durable-subagent/index.ts` in the global `extensions` array with the recommended path, and run `/reload` or restart Pi. **Do not load both**: their tool names conflict. For a one-off test without editing settings, use:

```sh
pi --no-extensions --extension /Users/zayar/code/durable-subagent/index.ts
```

That isolated invocation does not load the other extensions providing `fffind`, `ffgrep`, or `fetch_content`; an agent declaring them will correctly be refused. A normal installation needs those host tools available and callable. Host-provided Pi packages are peer dependencies with pinned local dev installs; durable/chord are pinned to 1.0.4. SDK `DefaultResourceLoader` successfully loads this actual TypeScript entry point with no errors (automated). Authenticated live-provider calls and full interactive tool execution have **not** been tested.

### Tool API

| Tool | Arguments | Behavior |
|---|---|---|
| `subagents_list` | `{}` | Configured definitions/loadouts and parse errors |
| `subagent` | `{agent, task, model?, role?, nonblocking?, timeoutMinutes?: null}` | Creates a child and a durable delivery task atomically; returns `spawn:<tool-call-id>` |
| `subagent_status` | `{run}` | Retained state and answer; explicitly resumes unfinished work |
| `subagent_wait` | `{run, waitSeconds?: 60}` | Bounded wait, max 3600s; stopping the wait never stops work |
| `subagent_steer` | `{run, guidance}` | Active-child guidance at a tool-round boundary, max 8000 chars |
| `subagent_followup` | `{run, task}` | Completed-child retained-context task under `followup:<tool-call-id>` |
| `subagent_cancel` | `{run}` | Stops delivery, current child work and queued inputs; completed handles are no-ops |

Spawn defaults to background. `nonblocking:false` waits at most 60 seconds and then returns the still-running handle. This intentionally differs from the old blocking default. Results are retrieved only: **no reporters, custom-message injection, or unsolicited parent model turns**. Answers are truncated at 30,000 characters in tool text, with the full answer retained in SQLite/doc details.

Agent YAML parsing, definition directories, and model pins/pools were copied into this project from the inspected old implementation (no runtime dependency on it). `PI_SUBAGENT_CONFIG`, `PI_SUBAGENT_AGENTS`, `agentDirectories`, `models.agents`, and `models.pools` retain their meaning. Selection: explicit model or `inherit-parent`, then role / `task:<pool>`, agent pin, definition model, Pi `subagents.defaultModel`, parent model. Pi defaults are read from `pi.getSettings()` on each new launch (effective global + trusted project settings and runtime overrides), never on follow-up. Qualified `provider/model` defaults use the embedded provider; bare defaults use `subagents.defaultProvider`, falling back explicitly to the current parent provider if omitted. Without either provider a bare default fails. Malformed defaults and unavailable selected models fail rather than substituting the parent. Higher-priority choices do not consult defaults. Manual settings-file edits require Pi `/reload` or restart to refresh its effective settings; runtime settings changes apply to subsequent launches immediately. Reload the extension once after installing this code. Existing follow-ups retain their frozen model. Pools prefer a model different from the parent. An unknown pool now fails rather than silently substituting. `thinking` inherits from Pi unless declared in the definition. Unsupported/missing declared tools fail closed. Nesting and codemode/tool_search bridging are not supported. Agent body and definition source/workspace locations are supplied as child instructions; host Pi skill/context discovery is not recreated in the child.

**Execution allowances are a deliberate gap.** Definitions with `timeoutMinutes` are rejected unless the caller explicitly passes `timeoutMinutes:null`, waiving that deadline. Numeric deadlines, allowance handoff/pause/resume, and retry-policy overrides are not implemented. Your current `worker` definition declares 30 minutes: it requires an explicit waiver, not a silent loss of its limit. Review that policy before switching.

### Persistence, ownership, and recovery

Storage base is `PI_DURABLE_SUBAGENT_STORAGE` or `<agent-dir>/sessions/pi-durable-subagent`. Each database directory is SHA-256 of JSON `[Pi session ID, resolved cwd]`, containing `session.sqlite` and an `owner.lock` directory with PID. It is intentionally separate from the old storage; old handles/state are not migrated. Branches in the same Pi session/workspace share jobs; a new session or different cwd gets a different root. Paths are lexical, not symlink-canonicalized.

Child conversations are ownerless, not owned by a transient Pi tool turn. Their delivery tasks are background tasks on a durable root used only for metadata, never prompting. Parent Esc and root abort cannot accidentally cascade into children. Cancelling a wait only stops polling. `session_shutdown` closes the Harness and removes its lock; close signals current invocations and checkpoints **without settling them as aborted**. Work pauses when the Pi process/session closes; it does not run in an external daemon. On reopening, a spawn/status/wait/steer/followup operation explicitly starts the scheduler; all pending jobs in that database may resume, not just the named job. Merely loading the extension does not resume work. Review uncertain prior effects before making that operation.

The lock prevents simultaneous adapter owners, including reload overlap. A hard kill leaves the lock behind: inspect its PID, confirm **no process owns the database**, then remove only that database's `owner.lock` directory manually. Never remove a live lock. No automatic PID-based reclamation is attempted (PID reuse/race hazards). Orderly close/reopen is tested; hard-kill, host/power failure, symlink attacks, or lock-reclamation injection are not. Durable itself supplies no cross-process locking; other applications opening the database directly bypass this guard. SQLite WAL/NORMAL can lose recent commits on power failure.

Delivery request IDs deduplicate restart admissions. Interrupted model streams may be **retried from a request boundary**, not continued token-for-token; retries can spend again and produce different answers. External provider calls and filesystem/tool effects are not exactly once. Bridged host tools use `replay:'unsafe'`: interrupted calls produce an interrupted result on recovery rather than blindly replaying arbitrary effects. New model decisions can still repeat side effects. Reopen requires the same extension/task definitions and host tools; missing tools needed by pending jobs block recovery. Tool code/schema implementations come from the currently loaded host, not a persisted binary snapshot. Pi credentials/custom endpoints/provider extensions are used through `ctx.modelRegistry.streamSimple`; no keys are copied to SQLite, and durable's per-child provider session identity is preserved.

Tools execute through the live owning Pi runtime's `ctx.executeTool`, preserving host validation and permission hooks, with durable cancellation signals rather than the original parent-turn signal. There is no sandbox, worktree isolation, parent-writer exclusion, concurrency quota, or safety guarantee for concurrent filesystem writers. Use only nonconflicting workspaces/tasks. Steering admission is not proof of obedience; a completion racing a steer can make it a new child input. Follow-ups freeze model/prompt/workspace/tool names and retain context; fresh context means a new spawn. No compaction tool, multi-step tasks/chain/groups, model-pool write tool, old resume protocol, nested agents, sticky UI, partial progress UI, migration, pruning, or separate Pi usage accounting is included. Durable stores usage, but adapter tool results currently do not bill it into the parent Pi totals; consult SQLite/durable usage for spend. These gaps are not claimed as compatibility.

### Verification and sources

Automated tests cover the credential/model bridge path and provider identity, session/workspace path separation, SQLite close/reopen recovery, deduplicated admission, parent abort isolation, wait cancellation isolation, follow-up conversation reuse, explicit cancellation, absence of parent transcript reports, and actual Pi SDK extension loading. The original standalone tests still pass.

Read the installed Pi 1.0.4 `docs/extensions.md` and `docs/sdk.md` completely, plus relevant linked model/provider/configuration/package docs and SDK model/tools/credentials and extension hello examples. Inspected exported SDK context/runtime declarations and implementation for nested tool lifecycle. Read the installed durable README completely and the upstream foreground/background examples before adapter implementation. Docs refer to live API evolution; pinned installed declarations and successful package-loading tests are the interoperability baseline.
