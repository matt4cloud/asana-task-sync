# asana-task-sync

`asana-task-sync` is a portable, agent-operated control plane for reconciling
a durable JSON task database with an Asana project.

It deliberately does **not** contain an Asana token, a REST client, an account
name, a project name, or a fixed filesystem location. The AI agent uses its
already configured Asana MCP server to read or change Asana. The tool validates
and transforms explicit MCP snapshots, detects divergence, and writes only the
local JSON database after the required GO gate.

This division makes one copy usable in unrelated workspaces and by different
agents, without copying credentials into a Node CLI or into task-control JSON.

## What it provides

- a versioned, extensible JSON task-control contract;
- safe import of tasks that exist only in Asana;
- stable local IDs linked to Asana task GIDs;
- read-only `remote_unbound` discovery for exact controlled Plan ID, title, and
  managed-notes matches;
- an explicit receipt-guarded `bind` flow for linking an existing Asana task;
- controlled title and notes rendering from host-defined JSON fields;
- preservation of the separate operator-notes suffix in Asana;
- classification of local changes, operational remote changes, and conflicts;
- read-only state/Asana `--plan` before every local write, with an optional
  plan receipt that guards the later apply;
- an explicit `--apply --go <marker>` gate;
- machine-readable MCP operation manifests for agent-executed Asana writes;
- receipt reconciliation: JSON changes only after an MCP snapshot proves that
  the intended Asana operation has happened.

## Required operating model

The host must provide all of the following before an agent works on tasks:

1. a correctly configured Asana MCP server in that agent's environment;
2. a private `<NAME>_TASK_CONTROL.env` beside the matching JSON database;
3. the JSON database itself, or an explicit name and target directory for a
   first import;
4. an explicit Asana source section for each import.

The tool has no fallback REST or token mode. It never reads credentials from an
environment variable and never contacts Asana directly.

The agent must ask for any missing required value rather than choosing an
account, project, directory, JSON name, section, title prefix, or GO marker.

## MCP snapshot boundary

The agent creates a temporary JSON snapshot from its configured Asana MCP
responses, then passes it with `--snapshot`. The snapshot contains only the
Asana data required for the operation: target project, sections, per-task
assignment, tasks, and—after task creation—the local-to-Asana GID bindings.

The portable contract is documented in
[asana-mcp-snapshot.schema.json](asana-mcp-snapshot.schema.json), with a
neutral example in [examples/asana-mcp-snapshot.example.json](examples/asana-mcp-snapshot.example.json).
Snapshots are host runtime artifacts, not secrets, but may contain task content;
keep them outside a repository or ignore them locally.

`scope.kind: "project"` explicitly proves that `tasks` contains the full
configured project. `scope.kind: "tasks"` remains valid for ordinary limited
pull/push work, and `scope.kind: "section"` remains the import boundary, but
neither partial scope is sufficient for remote discovery or `bind`.

A subtask's `parent.gid` is its stable relationship key. `parent.name` is
optional informational context and is never used to identify the parent.

```text
Agent configured with Asana MCP
        │
        ├── reads Asana → MCP snapshot → asana-task-sync --plan → plan receipt
        │
        └── after explicit GO:
              operation manifest → agent performs MCP writes
              → fresh MCP receipt snapshot → asana-task-sync --apply
              → durable local JSON
```

## Installation and host integration

The host chooses where this directory is stored. It may expose the command
through a `package.json` script, but no particular layout is required:

```json
{
  "scripts": {
    "asana-sync": "node <tool-path>/asana-task-sync.mjs"
  }
}
```

Host `AGENTS.md` should tell agents when task work requires this tool. Host
`TECH_SCOPE.md` should identify the actual task-control database, the meaning
of its domain fields, and the MCP route. Do not copy this generic protocol into
every host document.

Copy `.env.example` next to each database using the same basename:

```text
PROJECT_TASK_CONTROL.json
PROJECT_TASK_CONTROL.env
```

Every command requires that exact file through an explicit `--env` argument.
The tool rejects an environment file, task-control JSON, MCP snapshot, or
import output directory resolved inside its own clone. A clone therefore stays
an immutable tooling boundary during normal task work; all mutable state
belongs to the host-selected external directory.

The environment file configures the target project, title prefix, and sibling
state-file name. It contains no credential or default section. Each task owns
its own explicit `asana.section_gid`, `asana.section_name`, and—when
assignment is controlled—`asana.assignee_gid`.

An instance may optionally set the paired
`ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID` and
`ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL`. They are a fallback only when a brand
new task has no `asana.assignee_gid`; they never filter an import, overwrite an
existing task assignment, or override an explicit `null` assignment. Without
either a per-task assignment or this paired fallback, `push --plan` rejects a
new task before any MCP operation is emitted.

## Typical agent workflows

All commands below require an MCP-generated snapshot for remote context.

### Validate a known database

```bash
node <tool-path>/asana-task-sync.mjs validate \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

### Import one explicit Asana section

The agent first obtains the named section and its tasks through MCP, creates a
section-scoped snapshot, and plans without creating a local database:

```bash
node <tool-path>/asana-task-sync.mjs import --plan \
  --name PROJECT \
  --output-dir <directory> \
  --section "Source board column" \
  --snapshot <temporary-mcp-snapshot.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

Only after a separate operator GO does the same request become `--apply`:

```bash
node <tool-path>/asana-task-sync.mjs import --apply \
  --go GO_IMPORT \
  --name PROJECT \
  --output-dir <directory> \
  --section "Source board column" \
  --snapshot <temporary-mcp-snapshot.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

`--name PROJECT` creates exactly `PROJECT_TASK_CONTROL.json`. The matching
environment file must already exist next to it. The import deduplicates only by
Asana GID, never by task title.

### Discover and bind an existing remote task

A full-project `pull --plan` (and a full-project `push --plan`) reports
`remote_unbound` when an unbound local record has exactly one remote match for
its controlled Plan ID, rendered title, and managed-notes section. It never
writes the mapping and never treats a title-only match as sufficient. A
`push --plan` suppresses
`create_task` for such a match so the agent cannot accidentally duplicate the
known remote task. Exact managed-only notes are also accepted when no operator
note has ever been added and the operator heading is therefore absent. Any
unmarked suffix remains a mismatch. Discovery requires
`scope: { "kind": "project" }`; a partial snapshot returns
`conflict/full_project_snapshot_required` and cannot authorize either a match
or a potentially duplicating `create_task`.

Discovery and bind require exactly one value-preserving Plan ID entry with
`path: "id"` and `format: "text"`. Collapsed formats such as `yes_no`, a
missing Plan ID, or repeated `id` fields disable the additive discovery path:
`pull` retains the legacy `not_exported` / `no_asana_gid` result and `push`
retains `create_required` with its `create_task` operation when no remote was
explicitly detected. An explicit `bind` still rejects such configuration with
`noncanonical_controlled_plan_id`. These cases do not invalidate the existing
v1 database or block ordinary behavior for already-bound records.
Uniqueness is checked in both directions: one local record cannot select
multiple remotes, and one remote cannot be claimed by multiple local records.

Bind the exact stable local ID to the exact Asana GID only after reviewing that
discovery. Planning requires a full configured-project snapshot and validates
that the GID is present, is the sole remote with the exact controlled identity,
and is not used by another local task. It also rejects the GID when that
controlled identity matches another local record, even if the GID itself is
not yet owned. The local record must
have both synchronization hashes set to `null`;
an unbound record with either residual hash is rejected as an inconsistent
baseline. Planning also classifies a cloned record with the requested GID
through the ordinary initial-pull path. If that preflight cannot return
`baseline_required`—for example because a top-level task has an incomplete or
missing local section pair—bind returns
`post_bind_pull_not_baseline_required` without creating a receipt. The receipt
guards the configured project GID and name, the complete local task, the full
project scope, the sorted set of every matching remote GID, the selected remote
controlled identity, and the set of local GID owners:

```bash
node <tool-path>/asana-task-sync.mjs bind --plan \
  --task <stable-local-id> \
  --gid <asana-gid> \
  --snapshot <temporary-mcp-snapshot.json> \
  --plan-receipt <temporary-bind-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

After explicit GO, fetch a fresh snapshot and apply the same receipt:

```bash
node <tool-path>/asana-task-sync.mjs bind --apply \
  --go GO_BIND \
  --task <stable-local-id> \
  --gid <asana-gid> \
  --snapshot <fresh-mcp-snapshot.json> \
  --plan-receipt <temporary-bind-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

Successful bind changes only `asana.gid`. It does not copy operational fields
or write sync hashes. Because bind requires both hashes to be `null` and
preflights the same ordinary initial-pull classifier, the first ordinary fresh
`pull --plan` after a successful bind is guaranteed to report
`baseline_required`; follow it with the corresponding `pull --apply`.

### Pull operational state into JSON

After the agent gathers a target-scoped MCP snapshot, it can intentionally
work on one task only. `--task` accepts either the stable local ID or the Asana
task GID. The optional receipt is a temporary external artifact: it records
the planned JSON and Asana values, not credentials.

```bash
node <tool-path>/asana-task-sync.mjs pull --plan \
  --task <local-id-or-asana-gid> \
  --snapshot <temporary-mcp-snapshot.json> \
  --plan-receipt <temporary-pull-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

After GO, the agent fetches a fresh snapshot and passes it together with the
same receipt:

```bash
node <tool-path>/asana-task-sync.mjs pull --apply \
  --go GO_PULL \
  --task <local-id-or-asana-gid> \
  --snapshot <fresh-mcp-snapshot.json> \
  --plan-receipt <temporary-pull-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

The tool compares both JSON and the fresh Asana observation with the plan
receipt. If either changed after planning, it returns `blocked: true` and a
field-level `decision_required_diff`; JSON is not written. The operator must
resolve the shown difference, after which the agent creates a new plan and
receipt. A conflict or an incomplete snapshot also produces no write.

When a plan reports a controlled-projection conflict and the operator explicitly
decides that JSON is authoritative, the agent records that decision in a new
scoped push plan using `--resolve json`. Only then does the plan emit the MCP
update needed to replace the controlled Asana title, notes, due date, state,
section, or assignment. `--resolve json` is never inferred. If Asana should
win a controlled title or note conflict, the agent first updates the host's
domain fields in JSON according to the operator's decision and then creates a
new ordinary plan; the tool does not attempt to reverse-parse arbitrary notes.

```bash
node <tool-path>/asana-task-sync.mjs push --plan \
  --task <local-id-or-asana-gid> \
  --resolve json \
  --snapshot <fresh-mcp-snapshot.json> \
  --plan-receipt <temporary-json-wins-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

The corresponding `push --apply` repeats `--resolve json` with that receipt.

### Push JSON changes through MCP

`push --plan` does not write to Asana. It emits `mcp_operations` describing
the precise create or update requests that the agent must perform through the
configured MCP server:

```bash
node <tool-path>/asana-task-sync.mjs push --plan \
  --task <local-id-or-asana-gid> \
  --snapshot <temporary-mcp-snapshot.json> \
  --plan-receipt <temporary-push-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

After a separate GO, the agent performs those MCP operations, gathers a fresh
receipt snapshot (including `bindings` for newly created tasks), then runs:

```bash
node <tool-path>/asana-task-sync.mjs push --apply \
  --go GO_PUSH_RECEIPT \
  --task <local-id-or-asana-gid> \
  --snapshot <temporary-mcp-receipt.json> \
  --plan-receipt <temporary-push-plan.json> \
  --env <directory>/PROJECT_TASK_CONTROL.env
```

The tool writes JSON only when the selected receipt task exactly matches the
desired controlled projection and its local plan is unchanged since planning.
It returns a field-level receipt diff instead of writing JSON when the MCP
receipt differs from the planned result. It never assumes that a remote write
succeeded merely because a plan was produced. A newly created task must have
its target section explicitly set in its own `asana` object; there is no
instance-wide fallback section. Its own assignee wins; otherwise the optional
paired new-task fallback from the instance environment is used.

## Task-control JSON

The generic contract is [task-control.schema.json](task-control.schema.json).
Use [examples/task-control.example.json](examples/task-control.example.json)
as a neutral starting point. JSON owns the full plan fields and controlled
Asana projection; Asana owns operational placement, completion, due date, and
the operator-notes suffix.

For an informal checklist, the agent first models only facts supplied by the
operator or host documentation, assigns stable local IDs, validates the JSON,
and then follows the push workflow. It must not invent requirements, dates,
dependencies, or GO gates.

## Documentation and verification

- [TECH_SCOPE.md](TECH_SCOPE.md) — Polish technical contract, safety rules,
  workflows, and agent routing;
- [task-control.schema.json](task-control.schema.json) — JSON database schema;
- [asana-mcp-snapshot.schema.json](asana-mcp-snapshot.schema.json) — snapshot
  hand-off schema between an MCP-enabled agent and this tool;
- [CHANGELOG.md](CHANGELOG.md) — change history.

For changes to this tool:

```bash
npm run verify
```
