import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyKnownTask,
  desiredProjection,
  main,
  parseDotEnv,
  planPayload,
  renderManagedNotes,
  renderNotes,
  sha256,
} from '../asana-task-sync.mjs';

const target = {
  project: { gid: 'project-1', name: 'Example project' },
  assignee: { gid: 'user-1', email: 'technical@example.com' },
};

const sections = [
  { gid: 'section-todo', name: 'TO DO' },
  { gid: 'section-done', name: 'DONE' },
];

const managedFields = [
  { label: 'Plan ID', path: 'id', style: 'inline', format: 'text' },
  { label: 'Goal', path: 'goal', style: 'block', format: 'text', blank_before: true },
  { label: 'Steps', path: 'steps', style: 'block', format: 'list', blank_before: true },
  { label: 'Acceptance', path: 'acceptance', style: 'block', format: 'list', blank_before: true },
];

function attachRuntime(state) {
  Object.defineProperties(state, {
    runtime: { value: { title_prefix: '[demo] ' }, enumerable: false },
    asana_target: {
      value: {
        project: target.project.name,
        project_gid: target.project.gid,
        new_task_default_assignee: { ...target.assignee },
      },
      enumerable: false,
    },
  });
  return state;
}

function state(tasks = []) {
  return {
    schema_version: 'asana-task-sync/v1',
    status: 'active',
    sync: { plan_fields: ['id', 'title', 'goal', 'steps', 'acceptance'] },
    rendering: {
      managed_notes_heading: 'Plan controlled by JSON',
      operator_notes_heading: 'Operator notes',
      managed_fields: managedFields,
    },
    tasks,
  };
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Synchronize the plan',
    goal: 'Reconcile both states.',
    steps: ['read both states'],
    acceptance: ['differences are explicit'],
    asana: {
      gid: 'asana-1', section_gid: 'section-todo', section_name: 'TO DO',
      completed: false, due_on: null, operator_notes: '', last_seen_at: null,
      last_synced_plan_sha256: null, last_synced_projection_sha256: null,
      sync_status: 'exported_pending_tool_baseline',
    },
    ...overrides,
  };
}

function remoteFromTask(controlState, controlledTask, operatorNotes = '') {
  return {
    gid: controlledTask.asana.gid,
    name: `[demo] ${controlledTask.title}`,
    notes: renderNotes(controlState, controlledTask, operatorNotes),
    completed: controlledTask.asana.completed,
    due_on: controlledTask.asana.due_on,
    modified_at: '2026-08-04T10:00:00.000Z',
    memberships: [{
      project: { gid: target.project.gid },
      section: { gid: controlledTask.asana.section_gid, name: controlledTask.asana.section_name },
    }],
  };
}

function snapshotTask(remote) {
  const membership = remote.memberships[0];
  return {
    gid: remote.gid,
    name: remote.name,
    notes: remote.notes,
    completed: remote.completed,
    due_on: remote.due_on,
    modified_at: remote.modified_at,
    assignee: { ...target.assignee },
    section: { ...membership.section },
  };
}

function snapshot(tasks, scope = { kind: 'tasks' }, bindings = []) {
  return {
    schema_version: 'asana-mcp-snapshot/v1',
    captured_at: '2026-08-04T10:00:00.000Z',
    target,
    sections,
    scope,
    tasks: tasks.map(snapshotTask),
    bindings,
  };
}

function snapshotSubtask(remote) {
  return {
    gid: remote.gid,
    name: remote.name,
    notes: remote.notes,
    completed: remote.completed,
    due_on: remote.due_on,
    modified_at: remote.modified_at,
    assignee: { ...target.assignee },
    parent: { ...remote.parent },
  };
}

function snapshotWithParent(tasks, scope = { kind: 'tasks' }, bindings = []) {
  return {
    schema_version: 'asana-mcp-snapshot/v1',
    captured_at: '2026-08-04T10:00:00.000Z',
    target,
    sections,
    scope,
    tasks: tasks.map(snapshotSubtask),
    bindings,
  };
}

function environment(stateFile) {
  return {
    ASANA_PROJECT_NAME: target.project.name,
    ASANA_PROJECT_GID: target.project.gid,
    ASANA_TITLE_PREFIX: '[demo] ',
    ASANA_STATE_FILE: stateFile,
    ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID: target.assignee.gid,
    ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL: target.assignee.email,
  };
}

async function writeSnapshot(directory, snapshotValue) {
  const path = join(directory, 'asana-mcp-snapshot.json');
  await writeFile(path, `${JSON.stringify(snapshotValue, null, 2)}\n`, 'utf8');
  return path;
}

function establishBaseline(controlState, controlledTask, remote) {
  const result = classifyKnownTask(controlState, controlledTask, remote);
  assert.equal(result.kind, 'baseline_required');
  controlledTask.asana.last_synced_plan_sha256 = result.planHash;
  controlledTask.asana.last_synced_projection_sha256 = result.remoteHash;
  controlledTask.asana.operator_notes = result.observed.operator_notes;
}

test('renderer keeps the operator-notes boundary outside controlled notes', () => {
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const notes = renderNotes(controlState, controlledTask, 'Ręczna notatka operatora.');

  assert.match(notes, /\nOperator notes\nRęczna notatka operatora\.\n$/);
  assert.equal(renderManagedNotes(controlState, controlledTask).includes('Plan ID: task-1'), true);
});

test('host env parser preserves a quoted title-prefix trailing space', () => {
  const parsed = parseDotEnv('ASANA_TITLE_PREFIX="[demo] "\n');
  assert.equal(parsed.ASANA_TITLE_PREFIX, '[demo] ');
});

test('every command requires an explicit external instance environment', async () => {
  const toolDirectory = dirname(fileURLToPath(new URL('../asana-task-sync.mjs', import.meta.url)));
  const toolEnvPath = join(toolDirectory, 'EXAMPLE_TASK_CONTROL.env');
  const toolStatePath = join(toolDirectory, 'EXAMPLE_TASK_CONTROL.json');
  const toolSnapshotPath = join(toolDirectory, 'EXAMPLE_ASANA_SNAPSHOT.json');

  await assert.rejects(
    main(['validate', '--state', toolStatePath], environment('TASK_CONTROL.json')),
    /requires an explicit --env NAME_TASK_CONTROL\.env/,
  );
  await assert.rejects(
    main(['validate', '--state', toolStatePath, '--env', toolEnvPath], environment('TASK_CONTROL.json')),
    /Instance environment must be outside the asana-task-sync tool directory/,
  );

  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-external-state-'));
  const envPath = join(directory, 'EXAMPLE_TASK_CONTROL.env');
  const snapshotPath = await writeSnapshot(directory, snapshot([], {
    kind: 'section', section: { gid: 'section-todo', name: 'TO DO' },
  }));
  try {
    await assert.rejects(
      main([
        'import', '--plan', '--name', 'EXAMPLE', '--output-dir', toolDirectory,
        '--section', 'TO DO', '--snapshot', snapshotPath, '--env', envPath,
      ], environment('unused.json')),
      /Import --output-dir must be outside the asana-task-sync tool directory/,
    );
    await assert.rejects(
      main([
        'import', '--plan', '--name', 'EXAMPLE', '--output-dir', directory,
        '--section', 'TO DO', '--snapshot', toolSnapshotPath, '--env', envPath,
      ], environment('unused.json')),
      /MCP snapshot must be outside the asana-task-sync tool directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a task without an explicit section cannot be prepared for push', () => {
  const controlState = attachRuntime(state());
  const controlledTask = task({
    asana: { ...task().asana, section_gid: null, section_name: null },
  });
  assert.throws(
    () => desiredProjection(controlState, controlledTask),
    /requires an explicit asana\.section_gid and asana\.section_name/,
  );
});

test('validate is local and does not require an MCP snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-validate-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = state();
  controlState.tasks = [task()];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  try {
    const report = await main(['validate', '--env', envPath], environment('TASK_CONTROL.json'));
    assert.equal(report.operation, 'validate');
    assert.equal(report.tasks, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('classification detects one-sided and simultaneous changes', () => {
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);

  controlledTask.title = 'Locally changed plan';
  assert.equal(classifyKnownTask(controlState, controlledTask, remote).kind, 'push_required');

  remote.due_on = '2026-08-05';
  assert.equal(classifyKnownTask(controlState, controlledTask, remote).kind, 'conflict');
  assert.equal(sha256(planPayload(controlState, controlledTask)).length, 64);
});

test('classification treats a stale baseline with matching projections as a pull', () => {
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);

  controlledTask.asana.completed = true;
  controlledTask.asana.section_gid = 'section-done';
  controlledTask.asana.section_name = 'DONE';
  remote.completed = true;
  remote.memberships[0].section = { gid: 'section-done', name: 'DONE' };

  const matching = classifyKnownTask(controlState, controlledTask, remote);
  assert.equal(matching.kind, 'pull_required');
  assert.equal(matching.reason, 'baseline_stale_but_projections_match');

  remote.due_on = '2026-08-05';
  const diverging = classifyKnownTask(controlState, controlledTask, remote);
  assert.equal(diverging.kind, 'conflict');
  assert.equal(diverging.reason, 'both_sides_changed_since_baseline');
});

test('classification keeps a locally changed plan a conflict even when projections match', () => {
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);

  controlledTask.title = 'Locally changed plan';
  remote.name = '[demo] Locally changed plan';

  const result = classifyKnownTask(controlState, controlledTask, remote);
  assert.equal(result.desiredHash, result.remoteHash);
  assert.equal(result.kind, 'conflict');
  assert.equal(result.reason, 'both_sides_changed_since_baseline');
});

test('import plan uses a section-scoped MCP snapshot without creating JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-import-plan-'));
  const statePath = join(directory, 'GENERAL_TASK_CONTROL.json');
  const envPath = join(directory, 'GENERAL_TASK_CONTROL.env');
  const remote = {
    gid: 'asana-99', name: '[demo] Existing Asana task', notes: 'Original notes',
    completed: false, due_on: '2026-08-04', modified_at: '2026-08-04T10:00:00.000Z',
    memberships: [{ project: { gid: target.project.gid }, section: { gid: 'section-todo', name: 'TO DO' } }],
  };
  const snapshotPath = await writeSnapshot(directory, snapshot(
    [remote], { kind: 'section', section: { gid: 'section-todo', name: 'TO DO' } },
  ));

  try {
    const report = await main([
      'import', '--plan', '--name', 'GENERAL', '--output-dir', directory,
      '--section', 'TO DO', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('unused.json'));
    assert.equal(report.state_path, statePath);
    assert.equal(report.state_created, false);
    assert.equal(report.tasks[0].action, 'import_required');
    assert.equal(report.import_scope.remote_tasks_selected, 1);
    await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('import apply writes an MCP-derived database with safe permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-import-apply-'));
  const statePath = join(directory, 'GENERAL_TASK_CONTROL.json');
  const envPath = join(directory, 'GENERAL_TASK_CONTROL.env');
  const remote = {
    gid: 'asana-99', name: '[demo] Existing Asana task', notes: 'Original notes',
    completed: true, due_on: '2026-08-04', modified_at: '2026-08-04T10:00:00.000Z',
    memberships: [{ project: { gid: target.project.gid }, section: { gid: 'section-done', name: 'DONE' } }],
  };
  const snapshotPath = await writeSnapshot(directory, snapshot(
    [remote], { kind: 'section', section: { gid: 'section-done', name: 'DONE' } },
  ));

  try {
    const report = await main([
      'import', '--apply', '--go', 'GO_IMPORT', '--name', 'GENERAL', '--output-dir', directory,
      '--section', 'DONE', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('unused.json'));
    assert.equal(report.state_created, true);
    const imported = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(imported.tasks[0].id, 'asana-asana-99');
    assert.equal(imported.tasks[0].asana.section_name, 'DONE');
    assert.equal(imported.tasks[0].asana.assignee_gid, target.assignee.gid);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('import requires a matching explicit section and MCP scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-import-section-'));
  const envPath = join(directory, 'GENERAL_TASK_CONTROL.env');
  const snapshotPath = await writeSnapshot(directory, snapshot([], { kind: 'section', section: { gid: 'section-todo', name: 'TO DO' } }));
  try {
    await assert.rejects(
      main([
        'import', '--plan', '--name', 'GENERAL', '--output-dir', directory,
        '--snapshot', snapshotPath, '--env', envPath,
      ], environment('unused.json')),
      /--section SECTION_NAME/,
    );
    await assert.rejects(
      main([
        'import', '--plan', '--name', 'GENERAL', '--output-dir', directory,
        '--section', 'DONE', '--snapshot', snapshotPath, '--env', envPath,
      ], environment('unused.json')),
      /scope must explicitly match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull plan does not write JSON and pull apply accepts an MCP snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask, 'Ręczna notatka operatora.');
  establishBaseline(controlState, controlledTask, remote);
  controlState.tasks = [controlledTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'pull-plan-receipt.json');

  try {
    const plan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.changed_json, false);
    assert.equal(await readFile(statePath, 'utf8'), before);

    const apply = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(apply.changed_json, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull apply on a mixed base does not reject the receipt over not-yet-exported tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-mixed-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask, 'Ręczna notatka operatora.');
  establishBaseline(controlState, controlledTask, remote);
  const notExportedTask = task({
    id: 'task-2',
    asana: {
      gid: null, section_gid: null, section_name: null,
      completed: false, due_on: null, operator_notes: '', last_seen_at: null,
      last_synced_plan_sha256: null, last_synced_projection_sha256: null,
      sync_status: 'not_exported',
    },
  });
  controlState.tasks = [controlledTask, notExportedTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'pull-plan-receipt.json');

  try {
    const plan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.changed_json, false);
    assert.equal(plan.tasks.some((entry) => entry.id === 'task-2' && entry.action === 'not_exported'), true);

    const apply = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(apply.changed_json, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull and push apply require their preceding plan receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-receipt-required-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));

  try {
    await assert.rejects(
      main(['pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /pull --apply requires --plan-receipt PATH/,
    );
    await assert.rejects(
      main(['push', '--apply', '--go', 'GO_PUSH', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /push --apply requires --plan-receipt PATH/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('push plan emits MCP operations and push apply only reconciles an MCP receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-push-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const baselineRemote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, baselineRemote);
  controlledTask.title = 'Synchronize the revised plan';
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshot([baselineRemote]));
  const planReceiptPath = join(directory, 'push-plan-receipt.json');

  try {
    const plan = await main([
      'push', '--plan', '--snapshot', planSnapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'push_required');
    assert.equal(plan.mcp_operations[0].operation, 'update_task');

    const updatedRemote = remoteFromTask(controlState, controlledTask);
    const receiptPath = await writeSnapshot(directory, snapshot([updatedRemote]));
    const applied = await main([
      'push', '--apply', '--go', 'GO_PUSH', '--snapshot', receiptPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.changed_json, true);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).tasks[0].asana.sync_status, 'synchronized');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an explicit JSON-wins resolution turns a controlled conflict into one scoped MCP update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-json-resolution-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const staleRemote = remoteFromTask(controlState, controlledTask);
  staleRemote.notes = 'Legacy uncontrolled description';
  staleRemote.due_on = '2026-08-05';
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshot([staleRemote]));
  const planReceiptPath = join(directory, 'json-resolution-plan-receipt.json');

  try {
    const plan = await main([
      'push', '--plan', '--task', 'task-1', '--resolve', 'json', '--snapshot', planSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'push_required');
    assert.equal(plan.tasks[0].reason, 'operator_resolution_json_wins');
    assert.equal(plan.mcp_operations.length, 1);
    assert.equal(plan.mcp_operations[0].operation, 'update_task');

    const receiptRemote = remoteFromTask(controlState, controlledTask);
    const receiptPath = join(directory, 'json-resolution-receipt.json');
    await writeFile(receiptPath, `${JSON.stringify(snapshot([receiptRemote]), null, 2)}\n`, 'utf8');
    const applied = await main([
      'push', '--apply', '--go', 'GO_JSON_WINS', '--task', 'task-1', '--resolve', 'json',
      '--snapshot', receiptPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.changed_json, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a task selector scopes a plan to one task and accepts a matching partial snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-single-task-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const selected = task();
  const unrelated = task({ id: 'task-2', asana: { ...task().asana, gid: 'asana-2' } });
  const remote = remoteFromTask(controlState, selected);
  establishBaseline(controlState, selected, remote);
  controlState.tasks = [selected, unrelated];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'selected-plan-receipt.json');

  try {
    const report = await main([
      'pull', '--plan', '--task', 'task-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].id, 'task-1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a comma-separated task selector scopes a plan to exactly that subset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-multi-task-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const first = task();
  const second = task({ id: 'task-2', asana: { ...task().asana, gid: 'asana-2' } });
  const third = task({ id: 'task-3', asana: { ...task().asana, gid: 'asana-3' } });
  const firstRemote = remoteFromTask(controlState, first);
  const secondRemote = remoteFromTask(controlState, second);
  const thirdRemote = remoteFromTask(controlState, third);
  establishBaseline(controlState, first, firstRemote);
  establishBaseline(controlState, second, secondRemote);
  establishBaseline(controlState, third, thirdRemote);
  controlState.tasks = [first, second, third];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([firstRemote, secondRemote, thirdRemote]));
  const planReceiptPath = join(directory, 'multi-task-plan-receipt.json');

  try {
    const report = await main([
      'pull', '--plan', '--task', 'task-1,task-3', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(report.tasks.length, 2);
    assert.deepEqual(report.tasks.map((entry) => entry.id).sort(), ['task-1', 'task-3']);

    await assert.rejects(
      main([
        'pull', '--plan', '--task', 'task-1,task-unknown', '--snapshot', snapshotPath, '--env', envPath,
      ], environment('TASK_CONTROL.json')),
      /No task matches --task task-unknown/,
    );

    const deduped = await main([
      'pull', '--plan', '--task', 'task-1,task-1,asana-1', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(deduped.tasks.length, 1);
    assert.equal(deduped.tasks[0].id, 'task-1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull apply stops with a decision diff when Asana changed after the plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-plan-drift-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const plannedRemote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, plannedRemote);
  controlState.tasks = [controlledTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshot([plannedRemote]));
  const planReceiptPath = join(directory, 'plan-receipt.json');
  const changedRemote = { ...plannedRemote, due_on: '2026-08-05' };
  const currentSnapshotPath = join(directory, 'current-mcp-snapshot.json');
  await writeFile(currentSnapshotPath, `${JSON.stringify(snapshot([changedRemote]), null, 2)}\n`, 'utf8');

  try {
    await main([
      'pull', '--plan', '--snapshot', planSnapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', currentSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'state_changed_after_plan');
    assert.deepEqual(blocked.decision_required_diff.find((entry) => entry.field === 'due_on'), {
      id: 'task-1', source: 'asana', field: 'due_on', planned_asana: null, current_asana: '2026-08-05',
    });
    assert.equal(await readFile(statePath, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new task uses the instance default assignee only when its own assignment is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-create-default-assignee-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = state([task({
    asana: { ...task().asana, gid: null, last_synced_plan_sha256: null, last_synced_projection_sha256: null },
  })]);
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([]));

  try {
    const plan = await main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'create_required');
    assert.equal(plan.mcp_operations[0].task.assignee, target.assignee.gid);

    const withoutDefault = environment('TASK_CONTROL.json');
    delete withoutDefault.ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID;
    delete withoutDefault.ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL;
    await assert.rejects(
      main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], withoutDefault),
      /requires an explicit asana\.assignee_gid or paired ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new task own assignment overrides the fallback and an explicit null stays unassigned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-create-explicit-assignee-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const explicitAssigneeTask = task({
    asana: {
      ...task().asana,
      gid: null,
      assignee_gid: 'user-2',
      assignee_email: 'owner@example.com',
    },
  });
  const controlState = state([explicitAssigneeTask]);
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([]));

  try {
    const explicitPlan = await main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json'));
    assert.equal(explicitPlan.mcp_operations[0].task.assignee, 'user-2');

    explicitAssigneeTask.asana.assignee_gid = null;
    explicitAssigneeTask.asana.assignee_email = null;
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
    const unassignedPlan = await main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json'));
    assert.equal(unassignedPlan.mcp_operations[0].task.assignee, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new subtask is created under its parent instead of a project section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-create-subtask-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const subtask = task({
    id: 'subtask-1',
    title: 'Subtask of the plan',
    asana: {
      ...task().asana,
      gid: null,
      section_gid: null,
      section_name: null,
      parent_gid: 'parent-asana-1',
    },
  });
  const controlState = state([subtask]);
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([]));

  try {
    const plan = await main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'create_required');
    assert.equal(plan.mcp_operations[0].task.parent, 'parent-asana-1');
    assert.equal(plan.mcp_operations[0].task.project_id, undefined);
    assert.equal(plan.mcp_operations[0].task.section_id, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('push plan and apply reconcile an existing subtask through its parent, not a section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-push-subtask-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const subtask = task({
    id: 'subtask-1',
    title: 'Subtask of the plan',
    asana: { ...task().asana, section_gid: null, section_name: null, parent_gid: 'parent-asana-1' },
  });
  const baselineRemote = {
    gid: subtask.asana.gid,
    name: `[demo] ${subtask.title}`,
    notes: renderNotes(controlState, subtask, ''),
    completed: false,
    due_on: null,
    modified_at: '2026-08-04T10:00:00.000Z',
    parent: { gid: 'parent-asana-1', name: 'Parent task' },
  };
  subtask.asana.last_synced_plan_sha256 = sha256(planPayload(controlState, subtask));
  subtask.asana.last_synced_projection_sha256 = sha256({
    name: baselineRemote.name,
    notes: baselineRemote.notes,
    due_on: baselineRemote.due_on,
    completed: baselineRemote.completed,
    section_gid: null,
    section_name: null,
    parent_gid: 'parent-asana-1',
  });
  subtask.title = 'Synchronize the revised subtask plan';
  controlState.tasks = [subtask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshotWithParent([baselineRemote]));
  const planReceiptPath = join(directory, 'push-subtask-plan-receipt.json');

  try {
    const plan = await main([
      'push', '--plan', '--snapshot', planSnapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'push_required');
    assert.equal(plan.mcp_operations[0].changes.parent, 'parent-asana-1');
    assert.equal(plan.mcp_operations[0].changes.section_id, undefined);

    const updatedRemote = {
      ...baselineRemote,
      name: `[demo] ${subtask.title}`,
      notes: renderNotes(controlState, subtask, ''),
    };
    const receiptPath = await writeSnapshot(directory, snapshotWithParent([updatedRemote]));
    const applied = await main([
      'push', '--apply', '--go', 'GO_PUSH', '--snapshot', receiptPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.changed_json, true);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.tasks[0].asana.parent_gid, 'parent-asana-1');
    assert.equal(saved.tasks[0].asana.sync_status, 'synchronized');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
