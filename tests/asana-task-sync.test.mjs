import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  stableJson,
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

function projectSnapshot(tasks, bindings = []) {
  return snapshot(tasks, { kind: 'project' }, bindings);
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

async function unboundFixture(prefix = 'asana-task-sync-bind-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const planReceiptPath = join(directory, 'bind-plan-receipt.json');
  const controlState = attachRuntime(state());
  const controlledTask = task({
    asana: { ...task().asana, gid: null },
  });
  controlState.tasks = [controlledTask];
  const remote = remoteFromTask(controlState, controlledTask, 'Remote operator note.');
  remote.gid = 'asana-existing';
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([remote]));
  return {
    directory,
    statePath,
    envPath,
    planReceiptPath,
    controlState,
    controlledTask,
    remote,
    snapshotPath,
  };
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

test('push plan still rejects a bound top-level task without a local section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-push-missing-section-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));

  try {
    await assert.rejects(
      main(['push', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /requires an explicit asana\.section_gid and asana\.section_name/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test('first pull plans and applies the Asana section when the bound task has no local baseline section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-section-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask, 'Ręczna notatka operatora.');
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    const plan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.changed_json, false);
    assert.equal(plan.tasks[0].action, 'baseline_required');
    assert.deepEqual(plan.tasks[0].diff.filter((entry) => entry.field.startsWith('section_')), [
      { field: 'section_gid', json: null, asana: 'section-todo' },
      { field: 'section_name', json: null, asana: 'TO DO' },
    ]);
    assert.equal(await readFile(statePath, 'utf8'), before);

    const applied = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.changed_json, true);
    const savedTask = JSON.parse(await readFile(statePath, 'utf8')).tasks[0];
    assert.equal(savedTask.asana.section_gid, 'section-todo');
    assert.equal(savedTask.asana.section_name, 'TO DO');
    assert.match(savedTask.asana.last_synced_plan_sha256, /^[a-f0-9]{64}$/);
    assert.match(savedTask.asana.last_synced_projection_sha256, /^[a-f0-9]{64}$/);
    assert.equal(savedTask.asana.sync_status, 'synchronized');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull refuses an Asana section change after planning and preserves the empty local section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-section-drift-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const plannedRemote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshot([plannedRemote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');
  const changedRemote = {
    ...plannedRemote,
    memberships: [{
      project: { gid: target.project.gid },
      section: { gid: 'section-done', name: 'DONE' },
    }],
  };
  const currentSnapshotPath = join(directory, 'current-mcp-snapshot.json');
  await writeFile(currentSnapshotPath, `${JSON.stringify(snapshot([changedRemote]), null, 2)}\n`, 'utf8');

  try {
    await main([
      'pull', '--plan', '--task', 'asana-1', '--snapshot', planSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--task', 'asana-1', '--snapshot', currentSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'state_changed_after_plan');
    assert.deepEqual(blocked.decision_required_diff.filter((entry) => entry.field.startsWith('section_')), [
      {
        id: 'task-1', source: 'asana', field: 'section_gid',
        planned_asana: 'section-todo', current_asana: 'section-done',
      },
      {
        id: 'task-1', source: 'asana', field: 'section_name',
        planned_asana: 'TO DO', current_asana: 'DONE',
      },
    ]);
    assert.equal(await readFile(statePath, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull refuses a local JSON change after planning and makes no further write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-json-drift-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlledTask.asana.due_on = '2026-08-10';
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'state_changed_after_plan');
    assert.deepEqual(blocked.decision_required_diff.find((entry) => (
      entry.source === 'json' && entry.field === 'asana.due_on'
    )), {
      id: 'task-1', source: 'json', field: 'asana.due_on',
      planned_json: null, current_json: '2026-08-10',
    });
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull refuses a changed local Asana GID even when the replacement task has an identical projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-gid-drift-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const plannedRemote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const planSnapshotPath = await writeSnapshot(directory, snapshot([plannedRemote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--task', 'asana-1', '--snapshot', planSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlledTask.asana.gid = 'asana-2';
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');
    const replacementRemote = { ...plannedRemote, gid: 'asana-2' };
    const currentSnapshotPath = join(directory, 'replacement-mcp-snapshot.json');
    await writeFile(currentSnapshotPath, `${JSON.stringify(snapshot([replacementRemote]), null, 2)}\n`, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--task', 'asana-1', '--snapshot', currentSnapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.changed_json, false);
    assert.deepEqual(blocked.decision_required_diff, [{
      id: 'task-1', source: 'json', field: 'asana.gid',
      planned_json: 'asana-1', current_json: 'asana-2',
    }]);
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull reports stable local ID drift with a planned GID selector and without a selector', async () => {
  const cases = [
    { name: 'gid-selector', selector: ['--task', 'asana-1'] },
    { name: 'full-pull', selector: [] },
  ];

  for (const testCase of cases) {
    const directory = await mkdtemp(join(tmpdir(), `asana-task-sync-first-pull-id-drift-${testCase.name}-`));
    const statePath = join(directory, 'TASK_CONTROL.json');
    const envPath = join(directory, 'TASK_CONTROL.env');
    const controlState = attachRuntime(state());
    const controlledTask = task();
    const remote = remoteFromTask(controlState, controlledTask);
    controlledTask.asana.section_gid = null;
    controlledTask.asana.section_name = null;
    controlState.tasks = [controlledTask];
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
    const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
    const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

    try {
      await main([
        'pull', '--plan', ...testCase.selector, '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      controlledTask.id = 'task-2';
      const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
      await writeFile(statePath, changedJson, 'utf8');

      const blocked = await main([
        'pull', '--apply', '--go', 'GO_PULL', ...testCase.selector, '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(blocked.blocked, true);
      assert.equal(blocked.changed_json, false);
      assert.deepEqual(blocked.decision_required_diff, [{
        id: 'task-1', source: 'json', field: 'id',
        planned_json: 'task-1', current_json: 'task-2',
      }]);
      assert.equal(await readFile(statePath, 'utf8'), changedJson);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('first pull reports JSON task presence drift when neither planned identity resolves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-identity-missing-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--task', 'asana-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlledTask.id = 'task-2';
    controlledTask.asana.gid = 'asana-2';
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--task', 'asana-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.changed_json, false);
    assert.deepEqual(blocked.decision_required_diff, [{
      id: 'task-1', source: 'json', field: 'task_presence',
      planned_json: 'present', current_json: 'missing',
    }]);
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull reports ambiguous JSON task presence when planned GID fallback is not unique', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-identity-ambiguous-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--task', 'asana-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlledTask.id = 'task-2';
    controlState.tasks.push(task({
      id: 'task-3',
      asana: { ...controlledTask.asana },
    }));
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--task', 'asana-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.changed_json, false);
    assert.deepEqual(blocked.decision_required_diff, [{
      id: 'task-1', source: 'json', field: 'task_presence',
      planned_json: 'present', current_json: 'ambiguous_asana_gid',
    }]);
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unscoped first pull reports a bound task added after planning and makes no JSON write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-task-added-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlState.tasks.push(task({
      id: 'task-2',
      asana: { ...task().asana, gid: 'asana-2' },
    }));
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.changed_json, false);
    assert.deepEqual(blocked.decision_required_diff, [{
      id: 'task-2', source: 'json', field: 'task_presence',
      planned_json: 'missing', current_json: 'present',
    }]);
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scoped first pull ignores a bound task added outside the selected receipt scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-scoped-task-added-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--task', 'task-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    const addedTask = task({
      id: 'task-2',
      asana: { ...task().asana, gid: 'asana-2' },
    });
    controlState.tasks.push(addedTask);
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');

    const applied = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--task', 'task-1', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.blocked, undefined);
    assert.equal(applied.changed_json, true);
    const savedTasks = JSON.parse(await readFile(statePath, 'utf8')).tasks;
    assert.equal(savedTasks[0].asana.section_gid, 'section-todo');
    assert.deepEqual(savedTasks[1], addedTask);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unscoped first pull reports a planned task removed after planning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-first-pull-task-removed-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    controlState.tasks = [];
    const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
    await writeFile(statePath, changedJson, 'utf8');

    const blocked = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
      '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.changed_json, false);
    assert.deepEqual(blocked.decision_required_diff, [{
      id: 'task-1', source: 'json', field: 'task_presence',
      planned_json: 'present', current_json: 'missing',
    }]);
    assert.equal(await readFile(statePath, 'utf8'), changedJson);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first pull refuses one-hash and both-hashes baseline drift without overwriting either JSON state', async () => {
  const cases = [
    {
      name: 'one-hash',
      changes: { last_synced_plan_sha256: 'a'.repeat(64) },
      expected: [{
        field: 'asana.last_synced_plan_sha256', planned_json: null, current_json: 'a'.repeat(64),
      }],
    },
    {
      name: 'both-hashes',
      changes: {
        last_synced_plan_sha256: 'a'.repeat(64),
        last_synced_projection_sha256: 'b'.repeat(64),
      },
      expected: [
        { field: 'asana.last_synced_plan_sha256', planned_json: null, current_json: 'a'.repeat(64) },
        { field: 'asana.last_synced_projection_sha256', planned_json: null, current_json: 'b'.repeat(64) },
      ],
    },
  ];

  for (const testCase of cases) {
    const directory = await mkdtemp(join(tmpdir(), `asana-task-sync-first-pull-${testCase.name}-drift-`));
    const statePath = join(directory, 'TASK_CONTROL.json');
    const envPath = join(directory, 'TASK_CONTROL.env');
    const controlState = attachRuntime(state());
    const controlledTask = task();
    const remote = remoteFromTask(controlState, controlledTask);
    controlledTask.asana.section_gid = null;
    controlledTask.asana.section_name = null;
    controlState.tasks = [controlledTask];
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
    const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
    const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

    try {
      await main([
        'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      Object.assign(controlledTask.asana, testCase.changes);
      const changedJson = `${JSON.stringify(controlState, null, 2)}\n`;
      await writeFile(statePath, changedJson, 'utf8');

      const blocked = await main([
        'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(blocked.blocked, true);
      assert.equal(blocked.changed_json, false);
      assert.deepEqual(blocked.decision_required_diff, testCase.expected.map((entry) => ({
        id: 'task-1', source: 'json', ...entry,
      })));
      assert.equal(await readFile(statePath, 'utf8'), changedJson);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('pull apply rejects a receipt created without the canonical JSON task guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-receipt-without-json-guard-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));
  const planReceiptPath = join(directory, 'first-pull-plan-receipt.json');

  try {
    await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', planReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    const receipt = JSON.parse(await readFile(planReceiptPath, 'utf8'));
    delete receipt.tasks[0].planned_json_task;
    await writeFile(planReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    await assert.rejects(
      main([
        'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json')),
      /Pull plan receipt lacks its JSON task guard\. Run a new --plan\./,
    );
    assert.equal(await readFile(statePath, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull rejects a missing local section once a top-level task already has a baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-baseline-missing-section-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);
  controlledTask.asana.section_gid = null;
  controlledTask.asana.section_name = null;
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));

  try {
    await assert.rejects(
      main(['pull', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /requires an explicit asana\.section_gid and asana\.section_name/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pull rejects a top-level snapshot task without a section', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-snapshot-missing-section-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlledTask = task({
    asana: { ...task().asana, section_gid: null, section_name: null },
  });
  await writeFile(statePath, `${JSON.stringify(state([controlledTask]), null, 2)}\n`, 'utf8');
  const invalidSnapshot = snapshot([]);
  invalidSnapshot.tasks = [{
    gid: controlledTask.asana.gid,
    name: `[demo] ${controlledTask.title}`,
    notes: renderNotes(attachRuntime(state()), controlledTask, ''),
    completed: false,
    due_on: null,
    modified_at: '2026-08-04T10:00:00.000Z',
    assignee: { ...target.assignee },
  }];
  const snapshotPath = await writeSnapshot(directory, invalidSnapshot);

  try {
    await assert.rejects(
      main(['pull', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /tasks\[0\]\.section\.gid must be a non-empty string/,
    );
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
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([remote]));
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
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([]));

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
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([]));

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
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([]));

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

test('pull accepts a parent GID without a name and preserves named-snapshot compatibility', async () => {
  const results = [];
  for (const parentName of [undefined, 'Parent task', null, '']) {
    const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-pull-parent-name-'));
    const statePath = join(directory, 'TASK_CONTROL.json');
    const envPath = join(directory, 'TASK_CONTROL.env');
    const controlState = attachRuntime(state());
    const subtask = task({
      id: 'subtask-1',
      title: 'Subtask of the plan',
      asana: {
        ...task().asana,
        section_gid: null,
        section_name: null,
        parent_gid: 'parent-asana-1',
      },
    });
    const remote = {
      gid: subtask.asana.gid,
      name: `[demo] ${subtask.title}`,
      notes: renderNotes(controlState, subtask, ''),
      completed: false,
      due_on: null,
      modified_at: '2026-08-04T10:00:00.000Z',
      parent: {
        gid: 'parent-asana-1',
        ...(parentName !== undefined ? { name: parentName } : {}),
      },
    };
    controlState.tasks = [subtask];
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
    const snapshotPath = await writeSnapshot(directory, snapshotWithParent([remote]));
    const planReceiptPath = join(directory, 'pull-subtask-plan-receipt.json');

    try {
      const plan = await main([
        'pull', '--plan', '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      const applied = await main([
        'pull', '--apply', '--go', 'GO_PULL', '--snapshot', snapshotPath,
        '--plan-receipt', planReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json'));
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(plan.tasks[0].action, 'baseline_required');
      assert.equal(applied.changed_json, true);
      assert.equal(saved.tasks[0].asana.parent_gid, 'parent-asana-1');
      results.push({ plan: plan.tasks, applied: applied.tasks, saved: saved.tasks[0].asana.parent_gid });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});

test('a snapshot parent still requires a non-empty GID', async () => {
  for (const [label, parent] of [['missing', {}], ['empty', { gid: '' }]]) {
    const directory = await mkdtemp(join(tmpdir(), `asana-task-sync-parent-${label}-gid-`));
    const statePath = join(directory, 'TASK_CONTROL.json');
    const envPath = join(directory, 'TASK_CONTROL.env');
    const controlState = attachRuntime(state());
    const subtask = task({
      asana: {
        ...task().asana,
        section_gid: null,
        section_name: null,
        parent_gid: 'parent-asana-1',
      },
    });
    const remote = {
      gid: subtask.asana.gid,
      name: `[demo] ${subtask.title}`,
      notes: renderNotes(controlState, subtask, ''),
      completed: false,
      due_on: null,
      modified_at: '2026-08-04T10:00:00.000Z',
      parent,
    };
    controlState.tasks = [subtask];
    await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
    const snapshotPath = await writeSnapshot(directory, snapshotWithParent([remote]));

    try {
      await assert.rejects(
        main(['pull', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
        /tasks\[0\]\.parent\.gid must be a non-empty string/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('an optional snapshot parent name must be text or null when supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-parent-invalid-name-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const subtask = task({
    asana: {
      ...task().asana,
      section_gid: null,
      section_name: null,
      parent_gid: 'parent-asana-1',
    },
  });
  const remote = {
    gid: subtask.asana.gid,
    name: `[demo] ${subtask.title}`,
    notes: renderNotes(controlState, subtask, ''),
    completed: false,
    due_on: null,
    modified_at: '2026-08-04T10:00:00.000Z',
    parent: { gid: 'parent-asana-1', name: 42 },
  };
  controlState.tasks = [subtask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshotWithParent([remote]));

  try {
    await assert.rejects(
      main(['pull', '--plan', '--snapshot', snapshotPath, '--env', envPath], environment('TASK_CONTROL.json')),
      /tasks\[0\]\.parent\.name must be a string or null/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the machine snapshot contract requires only the parent GID', async () => {
  const schemaPath = fileURLToPath(new URL('../asana-mcp-snapshot.schema.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));

  assert.deepEqual(schema.$defs.parent.required, ['gid']);
  assert.equal(schema.$defs.task.properties.parent.oneOf[0].$ref, '#/$defs/parent');
  assert.equal(schema.$defs.parent.properties.gid.minLength, 1);
  assert.equal(schema.$defs.parent.properties.name.minLength, undefined);
  assert.equal(schema.properties.scope.oneOf.some((entry) => (
    entry.properties?.kind?.const === 'project'
  )), true);
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

test('full pull and push plans report an exact unbound remote without creating a duplicate', async () => {
  const fixture = await unboundFixture('asana-task-sync-remote-unbound-');
  try {
    const before = await readFile(fixture.statePath, 'utf8');
    const pullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.deepEqual(pullPlan.tasks[0], {
      id: 'task-1',
      asana_gid: null,
      action: 'remote_unbound',
      reason: 'controlled_plan_identity_matches',
      candidate_asana_gid: 'asana-existing',
    });

    const pushPlan = await main([
      'push', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'remote_unbound');
    assert.deepEqual(pushPlan.mcp_operations, []);
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('managed-only bind baseline supports later operator and operational pull without a false conflict', async () => {
  const fixture = await unboundFixture('asana-task-sync-managed-only-notes-');
  try {
    fixture.remote.notes = `${renderManagedNotes(fixture.controlState, fixture.controlledTask)}\n`;
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(projectSnapshot([fixture.remote]), null, 2)}\n`, 'utf8',
    );

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullPlan.tasks[0].action, 'remote_unbound');

    const pushPlan = await main([
      'push', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'remote_unbound');
    assert.deepEqual(pushPlan.mcp_operations, []);

    const bindPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'bind_required');

    const bindApply = await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindApply.tasks[0].action, 'bound');

    const pullAfterBind = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', join(fixture.directory, 'first-pull-receipt.json'),
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullAfterBind.tasks[0].action, 'baseline_required');

    const managedOnlySnapshotBeforePull = await readFile(fixture.snapshotPath, 'utf8');
    const firstPull = await main([
      'pull', '--apply', '--go', 'GO_FIRST_PULL', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', join(fixture.directory, 'first-pull-receipt.json'),
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(firstPull.changed_json, true);
    assert.equal(Object.hasOwn(firstPull, 'mcp_operations'), false);
    assert.equal(await readFile(fixture.snapshotPath, 'utf8'), managedOnlySnapshotBeforePull);

    let savedState = attachRuntime(JSON.parse(await readFile(fixture.statePath, 'utf8')));
    let savedTask = savedState.tasks[0];
    assert.equal(savedTask.asana.operator_notes, '');
    assert.equal(
      savedTask.asana.last_synced_projection_sha256,
      sha256(desiredProjection(savedState, savedTask)),
    );

    fixture.remote.notes = renderNotes(
      fixture.controlState, fixture.controlledTask, 'Remote operator note.',
    );
    fixture.remote.completed = true;
    fixture.remote.due_on = '2026-08-10';
    fixture.remote.modified_at = '2026-08-10T12:00:00.000Z';
    fixture.remote.memberships[0].section = { gid: 'section-done', name: 'DONE' };
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(projectSnapshot([fixture.remote]), null, 2)}\n`, 'utf8',
    );
    const laterPullReceiptPath = join(fixture.directory, 'later-pull-receipt.json');
    const laterPullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', laterPullReceiptPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(laterPullPlan.tasks[0].action, 'pull_required');
    assert.equal(laterPullPlan.tasks[0].reason, 'asana_operational_state_changed');
    assert.equal(Object.hasOwn(laterPullPlan, 'mcp_operations'), false);

    const laterPullApply = await main([
      'pull', '--apply', '--go', 'GO_LATER_PULL', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', laterPullReceiptPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(laterPullApply.changed_json, true);
    assert.equal(Object.hasOwn(laterPullApply, 'mcp_operations'), false);
    savedState = attachRuntime(JSON.parse(await readFile(fixture.statePath, 'utf8')));
    savedTask = savedState.tasks[0];
    assert.equal(savedTask.asana.section_gid, 'section-done');
    assert.equal(savedTask.asana.section_name, 'DONE');
    assert.equal(savedTask.asana.completed, true);
    assert.equal(savedTask.asana.due_on, '2026-08-10');
    assert.equal(savedTask.asana.operator_notes, 'Remote operator note.');
    assert.equal(
      savedTask.asana.last_synced_projection_sha256,
      sha256(desiredProjection(savedState, savedTask)),
    );

    const synchronized = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(synchronized.tasks[0].action, 'synchronized');

    const canonicalRemote = JSON.parse(JSON.stringify(fixture.remote));
    const conflictScenarios = [
      {
        name: 'title',
        mutate(remote) { remote.name = '[demo] Changed remote title'; },
      },
      {
        name: 'plan-id',
        mutate(remote) { remote.notes = remote.notes.replace('Plan ID: task-1', 'Plan ID: other'); },
      },
      {
        name: 'managed-notes',
        mutate(remote) { remote.notes = remote.notes.replace('Reconcile both states.', 'Changed remotely.'); },
      },
      {
        name: 'unmarked-suffix',
        mutate(remote) {
          remote.notes = `${renderManagedNotes(savedState, savedTask)}\n\nUnmarked remote text.`;
        },
      },
    ];
    const savedBeforeConflicts = await readFile(fixture.statePath, 'utf8');
    for (const scenario of conflictScenarios) {
      const conflictingRemote = JSON.parse(JSON.stringify(canonicalRemote));
      scenario.mutate(conflictingRemote);
      await writeFile(
        fixture.snapshotPath,
        `${JSON.stringify(projectSnapshot([conflictingRemote]), null, 2)}\n`,
        'utf8',
      );
      const conflict = await main([
        'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(conflict.tasks[0].action, 'conflict', scenario.name);
      assert.equal(Object.hasOwn(conflict, 'mcp_operations'), false, scenario.name);
      assert.equal(await readFile(fixture.statePath, 'utf8'), savedBeforeConflicts, scenario.name);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('unmarked text after managed notes is not a controlled identity and cannot bind', async () => {
  const fixture = await unboundFixture('asana-task-sync-unmarked-notes-suffix-');
  try {
    fixture.remote.notes = `${renderManagedNotes(fixture.controlState, fixture.controlledTask)}\n\nUnmarked remote text.`;
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(projectSnapshot([fixture.remote]), null, 2)}\n`, 'utf8',
    );
    const before = await readFile(fixture.statePath, 'utf8');

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullPlan.tasks[0].action, 'not_exported');

    const bindPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'conflict');
    assert.equal(bindPlan.tasks[0].reason, 'controlled_plan_identity_mismatch');
    assert.equal(bindPlan.plan_receipt_path, undefined);
    await assert.rejects(readFile(fixture.planReceiptPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);

  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy bound databases without a rendered Plan ID remain valid for validate, pull, and push', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-legacy-bound-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  controlState.rendering.managed_fields = managedFields.filter((field) => field.path !== 'id');
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);
  controlState.tasks = [controlledTask];
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const snapshotPath = await writeSnapshot(directory, snapshot([remote]));

  try {
    const validation = await main([
      'validate', '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(validation.tasks, 1);

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullPlan.tasks[0].action, 'synchronized');

    const pushPlan = await main([
      'push', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'synchronized');
    assert.equal(pushPlan.mcp_operations.some((operation) => operation.operation === 'create_task'), false);

    const schemaPath = fileURLToPath(new URL('../task-control.schema.json', import.meta.url));
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    assert.equal(schema.properties.rendering.properties.managed_fields.allOf, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy database-wide reconciliation fields are inert while conflicts and task classifications remain visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-legacy-reconciliation-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const remote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, remote);
  const notExportedTask = task({
    id: 'task-2',
    title: 'Keep the local-only task visible',
    asana: {
      ...task().asana,
      gid: null,
      last_synced_plan_sha256: null,
      last_synced_projection_sha256: null,
      sync_status: 'not_exported',
    },
  });
  const legacySynchronization = {
    last_reconciled_at: null,
    last_reconciled_by: 'manual-bootstrap',
    status: 'stale_global_claim',
    conflicts: [{ id: 'task-2', reason: 'operator_review_required' }],
  };
  controlState.synchronization = JSON.parse(JSON.stringify(legacySynchronization));
  controlState.tasks = [controlledTask, notExportedTask];
  const before = `${JSON.stringify(controlState, null, 2)}\n`;
  await writeFile(statePath, before, 'utf8');
  const snapshotPath = await writeSnapshot(directory, projectSnapshot([remote]));

  try {
    const validation = await main([
      'validate', '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(validation.tasks, 2);

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.deepEqual(pullPlan.tasks.map(({ id, action }) => ({ id, action })), [
      { id: 'task-1', action: 'synchronized' },
      { id: 'task-2', action: 'not_exported' },
    ]);

    const pushPlan = await main([
      'push', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.deepEqual(pushPlan.tasks.map(({ id, action }) => ({ id, action })), [
      { id: 'task-1', action: 'synchronized' },
      { id: 'task-2', action: 'create_required' },
    ]);
    assert.equal(pushPlan.mcp_operations.filter(({ operation }) => operation === 'create_task').length, 1);
    assert.equal(await readFile(statePath, 'utf8'), before);
    assert.deepEqual(JSON.parse(before).synchronization, legacySynchronization);

    const changedRemote = JSON.parse(JSON.stringify(remote));
    changedRemote.completed = true;
    changedRemote.modified_at = '2026-08-11T07:00:00.000Z';
    changedRemote.memberships[0].section = { gid: 'section-done', name: 'DONE' };
    await writeFile(snapshotPath, `${JSON.stringify(projectSnapshot([changedRemote]), null, 2)}\n`, 'utf8');
    const receiptPath = join(directory, 'legacy-pull-plan-receipt.json');
    const changedPlan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--plan-receipt', receiptPath,
      '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(changedPlan.tasks[0].action, 'pull_required');
    assert.equal(changedPlan.tasks[1].action, 'not_exported');
    const changedApply = await main([
      'pull', '--apply', '--go', 'GO_PULL_LEGACY', '--snapshot', snapshotPath,
      '--plan-receipt', receiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(changedApply.changed_json, true);
    const savedLegacyState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(savedLegacyState.synchronization, legacySynchronization);
    assert.equal(savedLegacyState.tasks[0].asana.completed, true);
    assert.equal(savedLegacyState.tasks[0].asana.section_name, 'DONE');
    assert.equal(savedLegacyState.tasks[1].asana.sync_status, 'not_exported');

    const schemaPath = fileURLToPath(new URL('../task-control.schema.json', import.meta.url));
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    assert.deepEqual(Object.keys(schema.properties.synchronization.properties), ['conflicts']);
    assert.equal(schema.properties.synchronization.properties.conflicts.type, 'array');
    assert.equal(schema.properties.synchronization.additionalProperties, true);

    const examplePath = fileURLToPath(new URL('../examples/task-control.example.json', import.meta.url));
    const example = JSON.parse(await readFile(examplePath, 'utf8'));
    assert.deepEqual(example.synchronization, { conflicts: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const bindFixture = await unboundFixture('asana-task-sync-legacy-reconciliation-bind-');
  try {
    const legacyBindState = JSON.parse(await readFile(bindFixture.statePath, 'utf8'));
    legacyBindState.synchronization = JSON.parse(JSON.stringify(legacySynchronization));
    const beforeBind = `${JSON.stringify(legacyBindState, null, 2)}\n`;
    await writeFile(bindFixture.statePath, beforeBind, 'utf8');

    const bindPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', bindFixture.snapshotPath, '--plan-receipt', bindFixture.planReceiptPath,
      '--env', bindFixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'bind_required');
    assert.equal(await readFile(bindFixture.statePath, 'utf8'), beforeBind);
    assert.deepEqual(JSON.parse(beforeBind).synchronization, legacySynchronization);
  } finally {
    await rm(bindFixture.directory, { recursive: true, force: true });
  }
});

test('two host copies reconcile independently only from fresh Asana snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-two-hosts-'));
  const hostA = join(directory, 'host-a');
  const hostB = join(directory, 'host-b');
  const stateAPath = join(hostA, 'TASK_CONTROL.json');
  const stateBPath = join(hostB, 'TASK_CONTROL.json');
  const envAPath = join(hostA, 'TASK_CONTROL.env');
  const envBPath = join(hostB, 'TASK_CONTROL.env');
  const controlState = attachRuntime(state());
  const controlledTask = task();
  const initialRemote = remoteFromTask(controlState, controlledTask);
  establishBaseline(controlState, controlledTask, initialRemote);
  controlState.tasks = [controlledTask];
  const initialJson = `${JSON.stringify(controlState, null, 2)}\n`;
  await mkdir(hostA, { recursive: true });
  await mkdir(hostB, { recursive: true });
  await writeFile(stateAPath, initialJson, 'utf8');
  await writeFile(stateBPath, initialJson, 'utf8');

  const remoteAfterA = JSON.parse(JSON.stringify(initialRemote));
  remoteAfterA.completed = true;
  remoteAfterA.due_on = '2026-08-11';
  remoteAfterA.modified_at = '2026-08-11T08:00:00.000Z';
  remoteAfterA.memberships[0].section = { gid: 'section-done', name: 'DONE' };

  try {
    const snapshotAPath = await writeSnapshot(hostA, snapshot([remoteAfterA]));
    const receiptAPath = join(hostA, 'pull-plan-receipt.json');
    const planA = await main([
      'pull', '--plan', '--snapshot', snapshotAPath, '--plan-receipt', receiptAPath,
      '--env', envAPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(planA.tasks[0].action, 'pull_required');
    const applyA = await main([
      'pull', '--apply', '--go', 'GO_PULL_A', '--snapshot', snapshotAPath,
      '--plan-receipt', receiptAPath, '--env', envAPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applyA.changed_json, true);
    const savedA = JSON.parse(await readFile(stateAPath, 'utf8'));
    assert.equal(savedA.tasks[0].asana.completed, true);
    assert.equal(savedA.tasks[0].asana.section_name, 'DONE');
    assert.equal(Object.hasOwn(savedA, 'synchronization'), false);

    assert.equal(await readFile(stateBPath, 'utf8'), initialJson);
    const staleSnapshotBPath = await writeSnapshot(hostB, snapshot([initialRemote]));
    const stalePlanB = await main([
      'pull', '--plan', '--snapshot', staleSnapshotBPath, '--env', envBPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(stalePlanB.tasks[0].action, 'synchronized');
    assert.equal(await readFile(stateBPath, 'utf8'), initialJson);

    const foreignSnapshot = snapshot([remoteAfterA]);
    foreignSnapshot.target = {
      project: { gid: 'foreign-project', name: 'Foreign project' },
      assignee: { ...target.assignee },
    };
    await writeFile(staleSnapshotBPath, `${JSON.stringify(foreignSnapshot, null, 2)}\n`, 'utf8');
    await assert.rejects(
      main([
        'pull', '--plan', '--snapshot', staleSnapshotBPath, '--env', envBPath,
      ], environment('TASK_CONTROL.json')),
      /MCP snapshot project does not match the configured instance target/,
    );
    assert.equal(await readFile(stateBPath, 'utf8'), initialJson);

    const freshSnapshotBPath = await writeSnapshot(hostB, snapshot([remoteAfterA]));
    const receiptBPath = join(hostB, 'pull-plan-receipt.json');
    const planB = await main([
      'pull', '--plan', '--snapshot', freshSnapshotBPath, '--plan-receipt', receiptBPath,
      '--env', envBPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(planB.tasks[0].action, 'pull_required');

    const remoteAfterB = JSON.parse(JSON.stringify(remoteAfterA));
    remoteAfterB.due_on = '2026-08-12';
    remoteAfterB.modified_at = '2026-08-11T09:00:00.000Z';
    await writeFile(freshSnapshotBPath, `${JSON.stringify(snapshot([remoteAfterB]), null, 2)}\n`, 'utf8');
    const blockedB = await main([
      'pull', '--apply', '--go', 'GO_PULL_B_STALE', '--snapshot', freshSnapshotBPath,
      '--plan-receipt', receiptBPath, '--env', envBPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(blockedB.blocked, true);
    assert.equal(blockedB.reason, 'state_changed_after_plan');
    assert.equal(blockedB.decision_required_diff.some(({ field }) => field === 'due_on'), true);
    assert.equal(await readFile(stateBPath, 'utf8'), initialJson);

    const freshPlanB = await main([
      'pull', '--plan', '--snapshot', freshSnapshotBPath, '--plan-receipt', receiptBPath,
      '--env', envBPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(freshPlanB.tasks[0].action, 'pull_required');
    const applyB = await main([
      'pull', '--apply', '--go', 'GO_PULL_B', '--snapshot', freshSnapshotBPath,
      '--plan-receipt', receiptBPath, '--env', envBPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applyB.changed_json, true);
    const savedB = JSON.parse(await readFile(stateBPath, 'utf8'));
    assert.equal(savedB.tasks[0].asana.completed, true);
    assert.equal(savedB.tasks[0].asana.section_name, 'DONE');
    assert.equal(savedB.tasks[0].asana.due_on, '2026-08-12');
    assert.equal(savedB.tasks[0].asana.last_seen_at, '2026-08-11T09:00:00.000Z');
    assert.equal(Object.hasOwn(savedB, 'synchronization'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bind apply changes only asana.gid and leaves reconciliation to pull', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-apply-');
  try {
    const before = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const plan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'bind_required');
    assert.equal(plan.changed_json, false);
    const bindReceipt = JSON.parse(await readFile(fixture.planReceiptPath, 'utf8'));
    assert.deepEqual(bindReceipt.target_project, target.project);

    const applied = await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.tasks[0].action, 'bound');
    assert.equal(applied.changed_json, true);
    const savedAfterBind = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const expected = JSON.parse(JSON.stringify(before));
    expected.tasks[0].asana.gid = 'asana-existing';
    assert.deepEqual(savedAfterBind, expected);

    const pushPlan = await main([
      'push', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'baseline_required');
    assert.equal(pushPlan.mcp_operations.some((operation) => operation.operation === 'create_task'), false);

    const pullReceiptPath = join(fixture.directory, 'pull-after-bind-receipt.json');
    const pullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', pullReceiptPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullPlan.tasks[0].action, 'baseline_required');
    const pullApply = await main([
      'pull', '--apply', '--go', 'GO_PULL', '--snapshot', fixture.snapshotPath,
      '--plan-receipt', pullReceiptPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullApply.changed_json, true);
    const reconciled = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    assert.equal(reconciled.tasks[0].asana.gid, 'asana-existing');
    assert.equal(reconciled.tasks[0].asana.sync_status, 'synchronized');
    assert.equal(reconciled.tasks[0].asana.operator_notes, 'Remote operator note.');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bind rejects local section states that cannot produce the promised post-bind baseline pull', async () => {
  const scenarios = [
    {
      name: 'null-gid-with-name',
      mutate(asana) {
        asana.section_gid = null;
        asana.section_name = 'TO DO';
      },
    },
    {
      name: 'gid-with-null-name',
      mutate(asana) {
        asana.section_gid = 'section-todo';
        asana.section_name = null;
      },
    },
    {
      name: 'missing-gid',
      mutate(asana) {
        delete asana.section_gid;
      },
    },
    {
      name: 'missing-name',
      mutate(asana) {
        delete asana.section_name;
      },
    },
    {
      name: 'missing-both',
      mutate(asana) {
        delete asana.section_gid;
        delete asana.section_name;
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await unboundFixture(`asana-task-sync-bind-post-pull-${scenario.name}-`);
    try {
      const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      scenario.mutate(persisted.tasks[0].asana);
      await writeFile(fixture.statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      const before = await readFile(fixture.statePath, 'utf8');

      const validation = await main([
        'validate', '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(validation.tasks, 1);

      const plan = await main([
        'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
        '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));

      assert.equal(plan.tasks[0].action, 'conflict');
      assert.equal(plan.tasks[0].reason, 'post_bind_pull_not_baseline_required');
      assert.match(
        plan.tasks[0].post_bind_pull_error,
        /requires an explicit asana\.section_gid and asana\.section_name before push/,
      );
      assert.equal(plan.changed_json, false);
      assert.equal(plan.plan_receipt_path, undefined);
      await assert.rejects(readFile(fixture.planReceiptPath, 'utf8'), { code: 'ENOENT' });
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      assert.equal(JSON.parse(before).tasks[0].asana.gid, null);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('bind rejects a mismatched controlled identity, missing GID, occupied GID, and rebinding', async () => {
  for (const scenario of ['identity', 'title', 'missing', 'occupied', 'rebind']) {
    const fixture = await unboundFixture(`asana-task-sync-bind-${scenario}-`);
    try {
      const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      let requestedGid = 'asana-existing';
      let expectedReason;
      if (scenario === 'identity') {
        const badRemote = { ...fixture.remote, notes: fixture.remote.notes.replace('Plan ID: task-1', 'Plan ID: wrong-id') };
        await writeFile(fixture.snapshotPath, `${JSON.stringify(projectSnapshot([badRemote]), null, 2)}\n`, 'utf8');
        expectedReason = 'controlled_plan_identity_mismatch';
      } else if (scenario === 'title') {
        const badRemote = { ...fixture.remote, name: '[demo] Different title' };
        await writeFile(fixture.snapshotPath, `${JSON.stringify(projectSnapshot([badRemote]), null, 2)}\n`, 'utf8');
        expectedReason = 'controlled_plan_identity_mismatch';
      } else if (scenario === 'missing') {
        requestedGid = 'asana-absent';
        expectedReason = 'asana_gid_not_in_snapshot';
      } else if (scenario === 'occupied') {
        persisted.tasks.push(task({
          id: 'task-2',
          title: 'Other local task',
          asana: { ...task().asana, gid: 'asana-existing' },
        }));
        await writeFile(fixture.statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
        expectedReason = 'asana_gid_already_bound_to_other_local_task';
      } else {
        persisted.tasks[0].asana.gid = 'asana-other';
        await writeFile(fixture.statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
        expectedReason = 'local_task_already_bound_to_different_gid';
      }
      const before = await readFile(fixture.statePath, 'utf8');
      const plan = await main([
        'bind', '--plan', '--task', 'task-1', '--gid', requestedGid,
        '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(plan.tasks[0].action, 'conflict');
      assert.equal(plan.tasks[0].reason, expectedReason);
      assert.equal(plan.changed_json, false);
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('remote discovery never matches by title alone and reports duplicate controlled identities as ambiguous', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-ambiguity-');
  try {
    const wrongIdentity = {
      ...fixture.remote,
      gid: 'asana-wrong-plan-id',
      notes: fixture.remote.notes.replace('Plan ID: task-1', 'Plan ID: wrong-id'),
    };
    let snapshotPath = await writeSnapshot(fixture.directory, projectSnapshot([wrongIdentity]));
    let plan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'not_exported');

    const duplicate = { ...fixture.remote, gid: 'asana-existing-2' };
    snapshotPath = await writeSnapshot(fixture.directory, projectSnapshot([fixture.remote, duplicate]));
    plan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(plan.tasks[0].action, 'conflict');
    assert.equal(plan.tasks[0].reason, 'ambiguous_remote_match');
    assert.deepEqual(plan.tasks[0].candidate_asana_gids, ['asana-existing', 'asana-existing-2']);

    const beforeBind = await readFile(fixture.statePath, 'utf8');
    const bindPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'conflict');
    assert.equal(bindPlan.tasks[0].reason, 'ambiguous_remote_match');
    assert.deepEqual(
      bindPlan.tasks[0].candidate_asana_gids, ['asana-existing', 'asana-existing-2'],
    );
    assert.equal(bindPlan.plan_receipt_path, undefined);
    await assert.rejects(readFile(fixture.planReceiptPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(fixture.statePath, 'utf8'), beforeBind);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bind apply blocks when a second controlled-identity match appears after planning', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-remote-set-drift-');
  try {
    const before = await readFile(fixture.statePath, 'utf8');
    await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    const receipt = JSON.parse(await readFile(fixture.planReceiptPath, 'utf8'));
    assert.deepEqual(receipt.tasks[0].planned_remote_scope, { kind: 'project' });
    assert.deepEqual(receipt.tasks[0].planned_matching_remote_gids, ['asana-existing']);

    const duplicate = { ...fixture.remote, gid: 'asana-existing-2' };
    await writeFile(
      fixture.snapshotPath,
      `${JSON.stringify(projectSnapshot([fixture.remote, duplicate]), null, 2)}\n`,
      'utf8',
    );
    const applied = await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));

    assert.equal(applied.blocked, true);
    assert.equal(applied.reason, 'state_changed_after_plan');
    assert.equal(applied.changed_json, false);
    assert.equal(applied.decision_required_diff.some((entry) => (
      entry.source === 'asana'
        && entry.field === 'controlled_identity_matching_gids'
        && stableJson(entry.planned_asana) === stableJson(['asana-existing'])
        && stableJson(entry.current_asana) === stableJson(['asana-existing', 'asana-existing-2'])
    )), true);
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('remote discovery and bind reject a partial snapshot without writing JSON or a receipt', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-partial-snapshot-');
  try {
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(snapshot([fixture.remote]), null, 2)}\n`, 'utf8',
    );
    const before = await readFile(fixture.statePath, 'utf8');

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pullPlan.tasks[0].action, 'conflict');
    assert.equal(pullPlan.tasks[0].reason, 'full_project_snapshot_required');

    const pushPlan = await main([
      'push', '--plan', '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'conflict');
    assert.equal(pushPlan.tasks[0].reason, 'full_project_snapshot_required');
    assert.deepEqual(pushPlan.mcp_operations, []);

    const bindPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'conflict');
    assert.equal(bindPlan.tasks[0].reason, 'full_project_snapshot_required');
    assert.equal(bindPlan.plan_receipt_path, undefined);
    await assert.rejects(readFile(fixture.planReceiptPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);

    await writeFile(
      fixture.snapshotPath,
      `${JSON.stringify(projectSnapshot([fixture.remote]), null, 2)}\n`,
      'utf8',
    );
    await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(snapshot([fixture.remote]), null, 2)}\n`, 'utf8',
    );
    const applied = await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(applied.blocked, true);
    assert.equal(applied.changed_json, false);
    assert.equal(applied.decision_required_diff.some((entry) => (
      entry.source === 'asana'
        && entry.field === 'snapshot_scope'
        && entry.planned_asana?.kind === 'project'
        && entry.current_asana?.kind === 'tasks'
    )), true);
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a legacy unbound record without canonical Plan ID still creates while explicit bind is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asana-task-sync-legacy-unbound-create-'));
  const statePath = join(directory, 'TASK_CONTROL.json');
  const envPath = join(directory, 'TASK_CONTROL.env');
  const bindReceiptPath = join(directory, 'bind-plan-receipt.json');
  const controlState = attachRuntime(state());
  controlState.sync.plan_fields = ['id', 'title'];
  controlState.rendering.managed_fields = [
    { label: 'Title', path: 'title', style: 'inline', format: 'text' },
  ];
  const controlledTask = task({
    id: 'legacy-task',
    title: 'Legacy new task',
    asana: { ...task().asana, gid: null },
  });
  controlState.tasks = [controlledTask];
  const snapshotPath = await writeSnapshot(directory, snapshot([]));
  await writeFile(statePath, `${JSON.stringify(controlState, null, 2)}\n`, 'utf8');
  const before = await readFile(statePath, 'utf8');
  try {
    const validation = await main([
      'validate', '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(validation.tasks, 1);

    const pullPlan = await main([
      'pull', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.deepEqual(pullPlan.tasks[0], {
      id: 'legacy-task', asana_gid: null, action: 'not_exported', reason: 'no_asana_gid',
    });

    const pushPlan = await main([
      'push', '--plan', '--snapshot', snapshotPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(pushPlan.tasks[0].action, 'create_required');
    assert.equal(pushPlan.tasks[0].reason, 'not_exported');
    assert.equal(pushPlan.mcp_operations.length, 1);
    assert.equal(pushPlan.mcp_operations[0].operation, 'create_task');

    const remote = remoteFromTask(controlState, controlledTask);
    remote.gid = 'remote-1';
    await writeFile(snapshotPath, `${JSON.stringify(snapshot([remote]), null, 2)}\n`, 'utf8');

    const bindPlan = await main([
      'bind', '--plan', '--task', 'legacy-task', '--gid', 'remote-1',
      '--snapshot', snapshotPath, '--plan-receipt', bindReceiptPath, '--env', envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindPlan.tasks[0].action, 'conflict');
    assert.equal(bindPlan.tasks[0].reason, 'noncanonical_controlled_plan_id');
    assert.equal(bindPlan.plan_receipt_path, undefined);
    await assert.rejects(
      main([
        'bind', '--apply', '--go', 'GO_BIND', '--task', 'legacy-task', '--gid', 'remote-1',
        '--snapshot', snapshotPath, '--plan-receipt', bindReceiptPath, '--env', envPath,
      ], environment('TASK_CONTROL.json')),
      /ENOENT/,
    );
    await assert.rejects(readFile(bindReceiptPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(statePath, 'utf8'), before);
    assert.equal(JSON.parse(before).tasks[0].asana.gid, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bind apply blocks local, remote, and GID-owner drift after planning', async () => {
  for (const scenario of ['local', 'remote', 'owner']) {
    const fixture = await unboundFixture(`asana-task-sync-bind-drift-${scenario}-`);
    try {
      await main([
        'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
        '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));
      if (scenario === 'remote') {
        const changedRemote = { ...fixture.remote, name: '[demo] Changed remotely' };
        await writeFile(
          fixture.snapshotPath,
          `${JSON.stringify(projectSnapshot([changedRemote]), null, 2)}\n`,
          'utf8',
        );
      } else {
        const changed = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        if (scenario === 'local') changed.tasks[0].goal = 'Changed after plan.';
        else {
          changed.tasks.push(task({
            id: 'task-2',
            title: 'Other local task',
            asana: { ...task().asana, gid: 'asana-existing' },
          }));
        }
        await writeFile(fixture.statePath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
      }
      const applied = await main([
        'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
        '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));
      assert.equal(applied.blocked, true);
      assert.equal(applied.changed_json, false);
      const saved = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      assert.equal(saved.tasks.find((entry) => entry.id === 'task-1').asana.gid, null);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('bind apply blocks configured-project drift after planning without writing JSON', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-project-drift-');
  try {
    await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    const projectTwo = { gid: 'project-2', name: 'Project Two' };
    const projectTwoSnapshot = projectSnapshot([fixture.remote]);
    projectTwoSnapshot.target = {
      project: projectTwo,
      assignee: { ...target.assignee },
    };
    await writeFile(
      fixture.snapshotPath, `${JSON.stringify(projectTwoSnapshot, null, 2)}\n`, 'utf8',
    );
    const beforeApply = await readFile(fixture.statePath, 'utf8');
    const retargetedEnvironment = {
      ...environment('TASK_CONTROL.json'),
      ASANA_PROJECT_GID: projectTwo.gid,
      ASANA_PROJECT_NAME: projectTwo.name,
    };

    const applied = await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], retargetedEnvironment);

    assert.equal(applied.blocked, true);
    assert.equal(applied.reason, 'state_changed_after_plan');
    assert.equal(applied.changed_json, false);
    assert.equal(applied.decision_required_diff.some((entry) => (
      entry.source === 'configuration'
        && entry.field === 'gid'
        && entry.planned_configuration === target.project.gid
        && entry.current_configuration === projectTwo.gid
    )), true);
    assert.equal(applied.decision_required_diff.some((entry) => (
      entry.source === 'configuration'
        && entry.field === 'name'
        && entry.planned_configuration === target.project.name
        && entry.current_configuration === projectTwo.name
    )), true);
    assert.equal(await readFile(fixture.statePath, 'utf8'), beforeApply);
    const saved = JSON.parse(beforeApply);
    assert.equal(saved.tasks[0].asana.gid, null);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bind rejects every residual synchronization-hash state for an unbound task', async () => {
  const scenarios = [
    { name: 'plan-only', plan: 'a'.repeat(64), projection: null },
    { name: 'projection-only', plan: null, projection: 'b'.repeat(64) },
    { name: 'both', plan: 'a'.repeat(64), projection: 'b'.repeat(64) },
  ];
  for (const scenario of scenarios) {
    const fixture = await unboundFixture(`asana-task-sync-bind-residual-${scenario.name}-`);
    try {
      const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      persisted.tasks[0].asana.last_synced_plan_sha256 = scenario.plan;
      persisted.tasks[0].asana.last_synced_projection_sha256 = scenario.projection;
      await writeFile(fixture.statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      const before = await readFile(fixture.statePath, 'utf8');

      const plan = await main([
        'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json'));

      assert.equal(plan.tasks[0].action, 'conflict');
      assert.equal(plan.tasks[0].reason, 'unbound_task_has_residual_sync_baseline');
      assert.deepEqual(plan.tasks[0].residual_sync_baseline, {
        last_synced_plan_sha256: scenario.plan,
        last_synced_projection_sha256: scenario.projection,
      });
      assert.equal(plan.changed_json, false);
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      assert.equal(JSON.parse(before).tasks[0].asana.gid, null);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('bind is idempotent and noncanonical Plan ID fields are rejected only by bind', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-idempotent-');
  try {
    await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    await main([
      'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', fixture.planReceiptPath,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    const afterFirstBind = await readFile(fixture.statePath, 'utf8');
    const secondReceipt = join(fixture.directory, 'second-bind-receipt.json');
    const secondPlan = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', secondReceipt,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(secondPlan.tasks[0].action, 'already_bound');
    const secondApply = await main([
      'bind', '--apply', '--go', 'GO_BIND_AGAIN', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--plan-receipt', secondReceipt,
      '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(secondApply.changed_json, false);
    assert.equal(await readFile(fixture.statePath, 'utf8'), afterFirstBind);

    const withoutPlanId = JSON.parse(afterFirstBind);
    withoutPlanId.tasks[0].asana.gid = null;
    withoutPlanId.rendering.managed_fields = withoutPlanId.rendering.managed_fields
      .filter((field) => field.path !== 'id');
    await writeFile(fixture.statePath, `${JSON.stringify(withoutPlanId, null, 2)}\n`, 'utf8');
    const validationWithoutPlanId = await main([
      'validate', '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(validationWithoutPlanId.tasks, 1);
    const bindWithoutPlanId = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindWithoutPlanId.tasks[0].reason, 'noncanonical_controlled_plan_id');

    withoutPlanId.rendering.managed_fields.push(
      { label: 'Plan ID', path: 'id', style: 'inline', format: 'text' },
      { label: 'Repeated Plan ID', path: 'id', style: 'inline', format: 'text' },
    );
    await writeFile(fixture.statePath, `${JSON.stringify(withoutPlanId, null, 2)}\n`, 'utf8');
    const validationWithRepeatedPlanId = await main([
      'validate', '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(validationWithRepeatedPlanId.tasks, 1);
    const bindWithRepeatedPlanId = await main([
      'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
      '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
    ], environment('TASK_CONTROL.json'));
    assert.equal(bindWithRepeatedPlanId.tasks[0].reason, 'noncanonical_controlled_plan_id');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bind rejects a snapshot for a foreign project without writing JSON', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-foreign-project-');
  try {
    const foreignSnapshot = projectSnapshot([fixture.remote]);
    foreignSnapshot.target = {
      project: { gid: 'project-foreign', name: 'Foreign project' },
      assignee: { ...target.assignee },
    };
    await writeFile(fixture.snapshotPath, `${JSON.stringify(foreignSnapshot, null, 2)}\n`, 'utf8');
    const before = await readFile(fixture.statePath, 'utf8');
    await assert.rejects(
      main([
        'bind', '--plan', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json')),
      /MCP snapshot project does not match the configured instance target/,
    );
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('bind apply requires both an explicit GO marker and its preceding receipt', async () => {
  const fixture = await unboundFixture('asana-task-sync-bind-gates-');
  try {
    await assert.rejects(
      main([
        'bind', '--apply', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json')),
      /--apply requires --go <explicit-operator-go>/,
    );
    await assert.rejects(
      main([
        'bind', '--apply', '--go', 'GO_BIND', '--task', 'task-1', '--gid', 'asana-existing',
        '--snapshot', fixture.snapshotPath, '--env', fixture.envPath,
      ], environment('TASK_CONTROL.json')),
      /bind --apply requires --plan-receipt PATH created by its preceding --plan/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
