#!/usr/bin/env node

/**
 * Portable JSON task-control synchronizer for Asana.
 *
 * The JSON file owns the plan and the controlled Asana title/notes. Asana owns
 * operational state and the operator-notes suffix. `--plan` is read-only;
 * every write needs `--apply --go <explicit-operator-go>`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)));

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function valueAtPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

export function planPayload(state, task) {
  return Object.fromEntries(state.sync.plan_fields.map((key) => [key, valueAtPath(task, key)]));
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

export function renderedTitle(state, task) {
  return `${state.runtime.title_prefix}${task.title}`;
}

export function renderManagedNotes(state, task) {
  const lines = [state.rendering.managed_notes_heading, ''];
  for (const field of state.rendering.managed_fields) {
    const raw = valueAtPath(task, field.path);
    const empty = raw === null || raw === undefined || raw === ''
      || (Array.isArray(raw) && raw.length === 0);
    if (empty && field.omit_if_empty) continue;
    let rendered;
    if (empty) rendered = field.empty_text ?? '';
    else if (field.format === 'list') rendered = bulletList(raw);
    else if (field.format === 'yes_no') rendered = raw ? field.yes_text : field.no_text;
    else rendered = String(raw);
    if (field.blank_before && lines.at(-1) !== '') lines.push('');
    if (field.style === 'block') lines.push(field.label, rendered);
    else lines.push(`${field.label}: ${rendered}`);
    if (field.blank_after) lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

export function renderNotes(state, task, operatorNotes = '') {
  const suffix = operatorNotes === '' ? '' : `\n${operatorNotes}`;
  return `${renderManagedNotes(state, task)}\n\n${state.rendering.operator_notes_heading}${suffix}\n`;
}

export function splitNotes(state, notes) {
  const marker = `\n${state.rendering.operator_notes_heading}\n`;
  const index = notes.lastIndexOf(marker);
  if (index < 0) {
    return { managed: notes.replace(/\s+$/, ''), operatorNotes: '', hasOperatorHeading: false };
  }
  return {
    managed: notes.slice(0, index).replace(/\s+$/, ''),
    operatorNotes: notes.slice(index + marker.length).replace(/\s+$/, ''),
    hasOperatorHeading: true,
  };
}

function taskSection(remote, projectGid) {
  const membership = (remote.memberships ?? []).find((item) => (
    item.project?.gid === projectGid
  ));
  return {
    gid: membership?.section?.gid ?? null,
    name: membership?.section?.name ?? null,
  };
}

export function desiredProjection(state, task) {
  const tracksParent = Object.hasOwn(task.asana, 'parent_gid');
  const parentGid = tracksParent ? (task.asana.parent_gid ?? null) : null;
  const isSubtask = Boolean(parentGid);
  const sectionGid = task.asana.section_gid;
  const sectionName = task.asana.section_name;
  if (!isSubtask && (!sectionGid || !sectionName)) {
    throw new Error(`Task ${task.id} requires an explicit asana.section_gid and asana.section_name before push.`);
  }
  const projection = {
    name: renderedTitle(state, task),
    notes: renderNotes(state, task, task.asana.operator_notes ?? ''),
    due_on: task.asana.due_on ?? null,
    completed: Boolean(task.asana.completed),
    section_gid: isSubtask ? null : sectionGid,
    section_name: isSubtask ? null : sectionName,
  };
  if (Object.hasOwn(task.asana, 'assignee_gid')) {
    projection.assignee_gid = task.asana.assignee_gid ?? null;
  }
  if (tracksParent) {
    projection.parent_gid = parentGid;
  }
  return projection;
}

export function remoteProjection(state, task, remote) {
  const section = taskSection(remote, state.asana_target.project_gid);
  const notes = splitNotes(state, remote.notes ?? '');
  return {
    name: remote.name ?? '',
    notes: remote.notes ?? '',
    due_on: remote.due_on ?? null,
    completed: Boolean(remote.completed),
    section_gid: section.gid,
    section_name: section.name,
    parent_gid: remote.parent?.gid ?? null,
    assignee_gid: remote.assignee?.gid ?? null,
    assignee_email: remote.assignee?.email ?? null,
    operator_notes: notes.operatorNotes,
    controlled_notes: notes.managed,
    has_operator_heading: notes.hasOperatorHeading,
    modified_at: remote.modified_at ?? null,
  };
}

export function controlledProjectionMatches(state, task, observed) {
  return observed.name === renderedTitle(state, task)
    && observed.has_operator_heading
    && observed.controlled_notes === renderManagedNotes(state, task);
}

function projectionHash(projection) {
  const value = {
    name: projection.name,
    notes: projection.notes,
    due_on: projection.due_on,
    completed: projection.completed,
    section_gid: projection.section_gid,
    section_name: projection.section_name,
  };
  if (Object.hasOwn(projection, 'assignee_gid')) value.assignee_gid = projection.assignee_gid;
  if (Object.hasOwn(projection, 'parent_gid')) value.parent_gid = projection.parent_gid;
  return sha256(value);
}

function observedHash(observed, tracksAssignee = false, tracksParent = false) {
  const value = {
    name: observed.name,
    notes: observed.notes,
    due_on: observed.due_on,
    completed: observed.completed,
    section_gid: observed.section_gid,
    section_name: observed.section_name,
  };
  if (tracksAssignee) value.assignee_gid = observed.assignee_gid;
  if (tracksParent) value.parent_gid = observed.parent_gid;
  return sha256(value);
}

function comparableDesiredProjection(desired) {
  return {
    name: desired.name,
    notes: desired.notes,
    due_on: desired.due_on,
    completed: desired.completed,
    section_gid: desired.section_gid,
    section_name: desired.section_name,
    ...(Object.hasOwn(desired, 'assignee_gid') ? { assignee_gid: desired.assignee_gid } : {}),
    ...(Object.hasOwn(desired, 'parent_gid') ? { parent_gid: desired.parent_gid } : {}),
  };
}

function comparableObservedProjection(observed, tracksAssignee = false, tracksParent = false) {
  return {
    name: observed.name,
    notes: observed.notes,
    due_on: observed.due_on,
    completed: observed.completed,
    section_gid: observed.section_gid,
    section_name: observed.section_name,
    ...(tracksAssignee ? { assignee_gid: observed.assignee_gid } : {}),
    ...(tracksParent ? { parent_gid: observed.parent_gid } : {}),
  };
}

function projectionDiff(expected, actual, expectedLabel, actualLabel) {
  const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...fields].sort().flatMap((field) => (
    stableJson(expected[field]) === stableJson(actual[field]) ? [] : [{
      field,
      [expectedLabel]: expected[field] ?? null,
      [actualLabel]: actual[field] ?? null,
    }]
  ));
}

export function classifyKnownTask(state, task, remote) {
  const desired = desiredProjection(state, task);
  const observed = remoteProjection(state, task, remote);
  const planHash = sha256(planPayload(state, task));
  const desiredHash = projectionHash(desired);
  const remoteHash = observedHash(
    observed, Object.hasOwn(task.asana, 'assignee_gid'), Object.hasOwn(task.asana, 'parent_gid'),
  );
  const baselinePlan = task.asana.last_synced_plan_sha256;
  const baselineProjection = task.asana.last_synced_projection_sha256;
  const controlledMatches = controlledProjectionMatches(state, task, observed);

  if (!baselinePlan || !baselineProjection) {
    return {
      kind: controlledMatches ? 'baseline_required' : 'conflict',
      reason: controlledMatches ? 'missing_baseline' : 'controlled_projection_differs_before_baseline',
      planHash, desiredHash, remoteHash, desired, observed,
    };
  }

  const localPlanChanged = planHash !== baselinePlan;
  const localProjectionChanged = desiredHash !== baselineProjection;
  const remoteProjectionChanged = remoteHash !== baselineProjection;

  if ((localPlanChanged || localProjectionChanged) && remoteProjectionChanged) {
    return {
      kind: 'conflict', reason: 'both_sides_changed_since_baseline',
      planHash, desiredHash, remoteHash, desired, observed,
    };
  }
  if (remoteProjectionChanged && !controlledMatches) {
    return {
      kind: 'conflict', reason: 'asana_changed_controlled_title_or_notes',
      planHash, desiredHash, remoteHash, desired, observed,
    };
  }
  if (remoteProjectionChanged) {
    return {
      kind: 'pull_required', reason: 'asana_operational_state_changed',
      planHash, desiredHash, remoteHash, desired, observed,
    };
  }
  if (localPlanChanged || localProjectionChanged) {
    return {
      kind: 'push_required', reason: 'json_changed_since_baseline',
      planHash, desiredHash, remoteHash, desired, observed,
    };
  }
  return {
    kind: 'synchronized', reason: 'hashes_match',
    planHash, desiredHash, remoteHash, desired, observed,
  };
}

function applyObservedAsanaState(task, result) {
  const { observed, planHash, remoteHash } = result;
  task.asana.section_gid = observed.section_gid;
  task.asana.section_name = observed.section_name;
  task.asana.parent_gid = observed.parent_gid;
  task.asana.completed = observed.completed;
  task.asana.due_on = observed.due_on;
  task.asana.operator_notes = observed.operator_notes;
  task.asana.assignee_gid = observed.assignee_gid;
  task.asana.assignee_email = observed.assignee_email;
  task.asana.last_seen_at = observed.modified_at;
  task.asana.last_synced_plan_sha256 = planHash;
  task.asana.last_synced_projection_sha256 = observedHash(observed, true, true);
  task.asana.sync_status = 'synchronized';
}

function applyDesiredAsanaState(state, task, result, remote) {
  const desired = result.desired;
  task.asana.section_gid = desired.section_gid;
  task.asana.section_name = desired.section_name;
  task.asana.parent_gid = remote.parent?.gid ?? null;
  task.asana.completed = desired.completed;
  task.asana.due_on = desired.due_on;
  task.asana.operator_notes = splitNotes(state, remote.notes ?? '').operatorNotes;
  task.asana.assignee_gid = remote.assignee?.gid ?? null;
  task.asana.assignee_email = remote.assignee?.email ?? null;
  task.asana.last_seen_at = remote.modified_at ?? null;
  task.asana.last_synced_plan_sha256 = sha256(planPayload(state, task));
  task.asana.last_synced_projection_sha256 = projectionHash(desiredProjection(state, task));
  task.asana.sync_status = 'synchronized';
}

function snapshotRemoteTask(task, projectGid) {
  return {
    gid: task.gid,
    name: task.name,
    notes: task.notes ?? '',
    completed: Boolean(task.completed),
    due_on: task.due_on ?? null,
    modified_at: task.modified_at ?? null,
    assignee: {
      gid: task.assignee?.gid ?? null,
      email: task.assignee?.email ?? null,
    },
    memberships: task.section
      ? [{ project: { gid: projectGid }, section: { gid: task.section.gid, name: task.section.name } }]
      : [],
    parent: task.parent ? { gid: task.parent.gid, name: task.parent.name } : null,
  };
}

function requireSnapshotText(value, path) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Invalid MCP snapshot: ${path} must be a non-empty string.`);
  }
  return value;
}

function validateMcpSnapshot(snapshot, state) {
  if (snapshot?.schema_version !== 'asana-mcp-snapshot/v1' || !Array.isArray(snapshot.tasks)
    || !Array.isArray(snapshot.sections)
    || (snapshot.bindings !== undefined && !Array.isArray(snapshot.bindings))) {
    throw new Error('Unsupported MCP snapshot; expected asana-mcp-snapshot/v1.');
  }
  const project = snapshot.target?.project;
  if (project?.gid !== state.asana_target.project_gid || project?.name !== state.asana_target.project) {
    throw new Error('MCP snapshot project does not match the configured instance target.');
  }
  const sections = snapshot.sections.map((section, index) => ({
    gid: requireSnapshotText(section?.gid, `sections[${index}].gid`),
    name: requireSnapshotText(section?.name, `sections[${index}].name`),
  }));
  const sectionGids = new Set(sections.map((section) => section.gid));
  const remotes = snapshot.tasks.map((task, index) => {
    requireSnapshotText(task?.gid, `tasks[${index}].gid`);
    requireSnapshotText(task?.name, `tasks[${index}].name`);
    if (task?.assignee !== null && task?.assignee !== undefined) {
      if (typeof task.assignee !== 'object') {
        throw new Error(`Invalid MCP snapshot: tasks[${index}].assignee must be an object or null.`);
      }
      if (task.assignee.gid !== null && task.assignee.gid !== undefined) {
        requireSnapshotText(task.assignee.gid, `tasks[${index}].assignee.gid`);
      }
      if (task.assignee.email !== null && task.assignee.email !== undefined) {
        requireSnapshotText(task.assignee.email, `tasks[${index}].assignee.email`);
      }
    }
    const hasParent = task?.parent !== null && task?.parent !== undefined;
    if (hasParent) {
      requireSnapshotText(task.parent.gid, `tasks[${index}].parent.gid`);
      requireSnapshotText(task.parent.name, `tasks[${index}].parent.name`);
    } else {
      requireSnapshotText(task?.section?.gid, `tasks[${index}].section.gid`);
      requireSnapshotText(task?.section?.name, `tasks[${index}].section.name`);
      if (!sectionGids.has(task.section.gid)) {
        throw new Error(`MCP snapshot task ${task.gid} references a section outside the snapshot.`);
      }
    }
    return snapshotRemoteTask(task, state.asana_target.project_gid);
  });
  if (new Set(remotes.map((task) => task.gid)).size !== remotes.length) {
    throw new Error('MCP snapshot contains duplicate Asana task GIDs.');
  }
  return { sections, remotes, bindings: snapshot.bindings ?? [], scope: snapshot.scope ?? null };
}

async function readMcpSnapshot(snapshotPath, state) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  return validateMcpSnapshot(snapshot, state);
}

export function validateState(state) {
  if (state.schema_version !== 'asana-task-sync/v1' || !Array.isArray(state.tasks)) {
    throw new Error('Unsupported task-control schema; expected asana-task-sync/v1.');
  }
  if (!state.sync || !Array.isArray(state.sync.plan_fields)
    || !state.sync.plan_fields.includes('id') || !state.sync.plan_fields.includes('title')) {
    throw new Error('sync.plan_fields must contain at least id and title.');
  }
  if (!state.rendering || typeof state.rendering.managed_notes_heading !== 'string'
    || typeof state.rendering.operator_notes_heading !== 'string'
    || !Array.isArray(state.rendering.managed_fields)) {
    throw new Error('rendering must define both headings and managed_fields.');
  }
  for (const field of state.rendering.managed_fields) {
    if (!field.path || !field.label || !['inline', 'block'].includes(field.style)
      || !['text', 'list', 'yes_no'].includes(field.format)) {
      throw new Error('Each managed field requires path, label, style and supported format.');
    }
  }
  const ids = state.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new Error('Task IDs must be unique.');
  for (const task of state.tasks) {
    if (!task.id || !task.title || !task.asana) {
      throw new Error(`Task ${task.id} has an incomplete control-state object.`);
    }
    for (const field of state.rendering.managed_fields) {
      const value = valueAtPath(task, field.path);
      if (field.format === 'list' && value !== null && value !== undefined
        && !Array.isArray(value)) {
        throw new Error(`Task ${task.id} field ${field.path} must be an array.`);
      }
    }
  }
  return state;
}

async function readState(statePath) {
  const text = await readFile(statePath, 'utf8');
  const state = JSON.parse(text);
  validateState(state);
  return state;
}

async function writeStateAtomically(statePath, state) {
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  const original = await stat(statePath);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: original.mode & 0o777,
  });
  await rename(temporaryPath, statePath);
}

async function writeNewState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

function newImportedState() {
  return {
    schema_version: 'asana-task-sync/v1',
    status: 'imported_from_asana',
    sync: { plan_fields: ['id', 'title'] },
    rendering: {
      managed_notes_heading: 'Plan controlled by JSON',
      operator_notes_heading: 'Operator notes',
      managed_fields: [
        { label: 'Plan ID', path: 'id', style: 'inline', format: 'text' },
      ],
    },
    tasks: [],
  };
}

function importedTitle(remoteName, titlePrefix) {
  if (titlePrefix && remoteName.startsWith(titlePrefix)) {
    return remoteName.slice(titlePrefix.length);
  }
  return remoteName;
}

export function importedTask(state, remote) {
  const title = importedTitle(remote.name ?? '', state.runtime.title_prefix);
  if (!title) throw new Error(`Asana task ${remote.gid} has no usable title.`);
  const section = taskSection(remote, state.asana_target.project_gid);
  const task = {
    id: `asana-${remote.gid}`,
    title,
    asana: {
      gid: remote.gid,
      section_gid: section.gid,
      section_name: section.name,
      completed: Boolean(remote.completed),
      due_on: remote.due_on ?? null,
      operator_notes: (remote.notes ?? '').replace(/\s+$/, ''),
      assignee_gid: remote.assignee?.gid ?? null,
      assignee_email: remote.assignee?.email ?? null,
      last_seen_at: remote.modified_at ?? null,
      last_synced_plan_sha256: null,
      last_synced_projection_sha256: null,
      sync_status: 'imported_pending_normalization',
    },
  };
  task.asana.last_synced_plan_sha256 = sha256(planPayload(state, task));
  task.asana.last_synced_projection_sha256 = observedHash(remoteProjection(state, task, remote), true);
  return task;
}

function resolveImportSection(snapshot, importSectionName) {
  if (snapshot.scope?.kind !== 'section'
    || snapshot.scope.section?.name !== importSectionName) {
    throw new Error('MCP snapshot scope must explicitly match the requested import section.');
  }
  const matchingSections = snapshot.sections.filter((section) => section.name === importSectionName);
  if (matchingSections.length === 0) {
    throw new Error(`Requested import section was not found in the MCP snapshot: ${importSectionName}.`);
  }
  if (matchingSections.length > 1) {
    throw new Error(`Requested import section name is ambiguous in the MCP snapshot: ${importSectionName}.`);
  }
  const section = matchingSections[0];
  if (snapshot.scope.section.gid !== section.gid) {
    throw new Error('MCP snapshot import-section GID does not match its named section.');
  }
  return section;
}

function taskMatchesImportScope(state, remote, importSection) {
  const section = taskSection(remote, state.asana_target.project_gid);
  return section.gid === importSection.gid && section.name === importSection.name;
}

function importTasks(state, snapshot, apply, importSectionName) {
  if (state.sync.plan_fields.some((field) => !['id', 'title'].includes(field))) {
    throw new Error('Import into an existing domain-specific database is unsafe; create a separate TASK_CONTROL database.');
  }
  const importSection = resolveImportSection(snapshot, importSectionName);
  const allRemoteTasks = snapshot.remotes;
  const remoteTasks = allRemoteTasks.filter((remote) => taskMatchesImportScope(state, remote, importSection));
  if (remoteTasks.length !== allRemoteTasks.length) {
    throw new Error('MCP import snapshot contains tasks outside its declared source section.');
  }
  const knownByGid = new Map(state.tasks
    .filter((task) => task.asana.gid)
    .map((task) => [task.asana.gid, task.id]));
  const knownIds = new Set(state.tasks.map((task) => task.id));
  const report = [];
  const candidates = [];
  for (const remote of remoteTasks) {
    if (knownByGid.has(remote.gid)) {
      report.push({
        id: knownByGid.get(remote.gid), asana_gid: remote.gid,
        action: 'already_imported', reason: 'asana_gid_exists',
      });
      continue;
    }
    const task = importedTask(state, remote);
    if (knownIds.has(task.id)) {
      report.push({
        id: task.id, asana_gid: remote.gid,
        action: 'conflict', reason: 'generated_local_id_already_exists',
      });
      continue;
    }
    knownIds.add(task.id);
    knownByGid.set(remote.gid, task.id);
    report.push({ id: task.id, asana_gid: remote.gid, action: 'import_required', reason: 'asana_only_task' });
    candidates.push(task);
  }
  if (apply && report.some((entry) => entry.action === 'conflict')) {
    throw new Error('Import conflicts detected. No JSON write was made.');
  }
  if (apply) {
    state.tasks.push(...candidates);
  }
  return {
    report,
    changed: apply && candidates.length > 0,
    import_scope: {
      project_gid: state.asana_target.project_gid,
      section_gid: importSection.gid,
      section_name: importSection.name,
      remote_tasks_scanned: allRemoteTasks.length,
      remote_tasks_selected: remoteTasks.length,
    },
  };
}

function reportEntry(task, result) {
  return {
    id: task.id,
    asana_gid: task.asana.gid,
    action: result.kind,
    reason: result.reason,
    diff: projectionDiff(
      comparableDesiredProjection(result.desired),
      comparableObservedProjection(
        result.observed,
        Object.hasOwn(task.asana, 'assignee_gid'),
        Object.hasOwn(task.asana, 'parent_gid'),
      ),
      'json', 'asana',
    ),
  };
}

function selectTasks(state, taskSelector) {
  if (!taskSelector) return state.tasks;
  const matches = state.tasks.filter((task) => (
    task.id === taskSelector || task.asana.gid === taskSelector
  ));
  if (matches.length === 0) {
    throw new Error(`No task matches --task ${taskSelector}. Use its stable local id or Asana GID.`);
  }
  if (matches.length > 1) {
    throw new Error(`--task ${taskSelector} is ambiguous. Use the stable local id.`);
  }
  return matches;
}

function receiptTask(state, task, result) {
  const tracksAssignee = Object.hasOwn(task.asana, 'assignee_gid');
  const tracksParent = Object.hasOwn(task.asana, 'parent_gid');
  return {
    id: task.id,
    asana_gid: task.asana.gid,
    action: result.kind,
    plan_payload: planPayload(state, task),
    desired: comparableDesiredProjection(result.desired),
    observed: comparableObservedProjection(result.observed, tracksAssignee, tracksParent),
  };
}

async function pull(state, snapshot, apply, tasks) {
  const remoteByGid = new Map(snapshot.remotes.map((remote) => [remote.gid, remote]));
  const report = [];
  let changed = false;
  const receiptTasks = [];
  for (const task of tasks) {
    if (!task.asana.gid) {
      report.push({ id: task.id, asana_gid: null, action: 'not_exported', reason: 'no_asana_gid' });
      continue;
    }
    const remote = remoteByGid.get(task.asana.gid);
    if (!remote) {
      report.push({ id: task.id, asana_gid: task.asana.gid, action: 'snapshot_missing', reason: 'tracked_task_not_in_mcp_snapshot' });
      continue;
    }
    const result = classifyKnownTask(state, task, remote);
    report.push(reportEntry(task, result));
    receiptTasks.push(receiptTask(state, task, result));
    if (!apply) continue;
    if (result.kind === 'baseline_required' || result.kind === 'pull_required') {
      applyObservedAsanaState(task, result);
      changed = true;
    }
  }
  if (apply && report.some((entry) => entry.action === 'snapshot_missing' || entry.action === 'conflict')) {
    throw new Error('MCP snapshot is incomplete or contains conflicts. No JSON write was made.');
  }
  return { report, changed, receipt_tasks: receiptTasks };
}

function plannedMcpCreate(state, task) {
  const desired = desiredProjection(state, task);
  const assignee = Object.hasOwn(desired, 'assignee_gid')
    ? desired.assignee_gid
    : state.asana_target.new_task_default_assignee?.gid;
  if (assignee === undefined) {
    throw new Error(
      `Task ${task.id} requires an explicit asana.assignee_gid or paired ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID and ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL before creation.`,
    );
  }
  const isSubtask = Object.hasOwn(desired, 'parent_gid') && Boolean(desired.parent_gid);
  return {
    local_id: task.id,
    operation: 'create_task',
    task: {
      name: desired.name,
      notes: desired.notes,
      due_on: desired.due_on,
      completed: desired.completed,
      assignee,
      ...(isSubtask
        ? { parent: desired.parent_gid }
        : { project_id: state.asana_target.project_gid, section_id: desired.section_gid }),
    },
  };
}

function plannedMcpUpdate(state, task, result) {
  const remoteNotes = result.observed.has_operator_heading
    ? splitNotes(state, result.observed.notes ?? '').operatorNotes
    : (task.asana.operator_notes ?? '');
  const desired = { ...result.desired, notes: renderNotes(state, task, remoteNotes) };
  const isSubtask = Object.hasOwn(desired, 'parent_gid') && Boolean(desired.parent_gid);
  return {
    local_id: task.id,
    operation: 'update_task',
    task: task.asana.gid,
    changes: {
      name: desired.name,
      notes: desired.notes,
      due_on: desired.due_on,
      completed: desired.completed,
      ...(isSubtask ? {} : { section_id: desired.section_gid }),
      ...(Object.hasOwn(desired, 'assignee_gid') ? { assignee: desired.assignee_gid } : {}),
      ...(Object.hasOwn(desired, 'parent_gid') ? { parent: desired.parent_gid } : {}),
    },
  };
}

function resolvePushBindings(state, snapshot) {
  const remoteByGid = new Map(snapshot.remotes.map((remote) => [remote.gid, remote]));
  const bindings = new Map();
  for (const binding of snapshot.bindings) {
    requireSnapshotText(binding?.local_id, 'bindings[].local_id');
    requireSnapshotText(binding?.asana_gid, 'bindings[].asana_gid');
    if (!state.tasks.some((task) => task.id === binding.local_id)) {
      throw new Error(`MCP snapshot binding references an unknown local task: ${binding.local_id}.`);
    }
    if (!remoteByGid.has(binding.asana_gid)) {
      throw new Error(`MCP snapshot binding references a task absent from the snapshot: ${binding.asana_gid}.`);
    }
    if (bindings.has(binding.local_id)) {
      throw new Error(`MCP snapshot contains duplicate binding for local task: ${binding.local_id}.`);
    }
    bindings.set(binding.local_id, binding.asana_gid);
  }
  return { remoteByGid, bindings };
}

function mcpReceiptMatchesDesired(state, task, remote) {
  const desired = desiredProjection(state, task);
  const observed = remoteProjection(state, task, remote);
  return observed.name === desired.name
    && observed.has_operator_heading
    && observed.controlled_notes === renderManagedNotes(state, task)
    && observed.due_on === desired.due_on
    && observed.completed === desired.completed
    && observed.section_gid === desired.section_gid
    && observed.section_name === desired.section_name
    && (!Object.hasOwn(desired, 'assignee_gid') || observed.assignee_gid === desired.assignee_gid)
    && (!Object.hasOwn(desired, 'parent_gid') || observed.parent_gid === desired.parent_gid);
}

function push(state, snapshot, apply, tasks, resolution) {
  const { remoteByGid, bindings } = resolvePushBindings(state, snapshot);
  const report = [];
  const mcpOperations = [];
  let changed = false;
  const receiptTasks = [];
  for (const task of tasks) {
    let remoteGid = task.asana.gid;
    if (!remoteGid && apply) remoteGid = bindings.get(task.id) ?? null;
    if (!remoteGid) {
      report.push({ id: task.id, asana_gid: null, action: 'create_required', reason: 'not_exported' });
      mcpOperations.push(plannedMcpCreate(state, task));
      if (!apply) {
        receiptTasks.push({
          id: task.id,
          asana_gid: null,
          action: 'create_required',
          plan_payload: planPayload(state, task),
          desired: comparableDesiredProjection(desiredProjection(state, task)),
          observed: null,
        });
      }
      continue;
    }
    const remote = remoteByGid.get(remoteGid);
    if (!remote) {
      report.push({ id: task.id, asana_gid: remoteGid, action: 'snapshot_missing', reason: 'tracked_task_not_in_mcp_snapshot' });
      continue;
    }
    const taskForComparison = remoteGid === task.asana.gid ? task : { ...task, asana: { ...task.asana, gid: remoteGid } };
    const result = classifyKnownTask(state, taskForComparison, remote);
    if (!apply) {
      if (result.kind === 'conflict' && resolution === 'json') {
        report.push({
          ...reportEntry(taskForComparison, result),
          action: 'push_required',
          reason: 'operator_resolution_json_wins',
        });
        receiptTasks.push(receiptTask(state, taskForComparison, result));
        mcpOperations.push(plannedMcpUpdate(state, taskForComparison, result));
        continue;
      }
      report.push(reportEntry(taskForComparison, result));
      receiptTasks.push(receiptTask(state, taskForComparison, result));
      if (result.kind === 'push_required') mcpOperations.push(plannedMcpUpdate(state, taskForComparison, result));
      continue;
    }
    if (!mcpReceiptMatchesDesired(state, taskForComparison, remote)) {
      const desired = desiredProjection(state, taskForComparison);
      const observed = remoteProjection(state, taskForComparison, remote);
      report.push({
        id: task.id, asana_gid: remoteGid, action: 'receipt_mismatch',
        reason: 'mcp_snapshot_does_not_match_the_desired_controlled_projection',
        diff: projectionDiff(comparableDesiredProjection(desired), comparableObservedProjection(
          observed,
          Object.hasOwn(taskForComparison.asana, 'assignee_gid'),
          Object.hasOwn(taskForComparison.asana, 'parent_gid'),
        ), 'planned', 'asana'),
      });
      continue;
    }
    if (!task.asana.gid) task.asana.gid = remoteGid;
    applyDesiredAsanaState(state, task, { desired: desiredProjection(state, task) }, remote);
    report.push({
      id: task.id, asana_gid: remoteGid, action: 'reconciled',
      reason: 'mcp_receipt_matches_desired_controlled_projection',
    });
    changed = true;
  }
  if (apply && report.some((entry) => entry.action !== 'reconciled')) {
    throw new Error('MCP operations are not fully reflected in the snapshot. No JSON write was made.');
  }
  return { report, changed, mcp_operations: mcpOperations, receipt_tasks: receiptTasks };
}

async function writePlanReceipt(receiptPath, statePath, options, receiptTasks) {
  const receipt = {
    schema_version: 'asana-task-sync-plan-receipt/v1',
    operation: options.operation,
    state_path: statePath,
    task_selector: options.taskSelector,
    resolution: options.resolution,
    tasks: receiptTasks,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

async function readPlanReceipt(receiptPath, statePath, options, tasks) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt?.schema_version !== 'asana-task-sync-plan-receipt/v1'
    || receipt.operation !== options.operation
    || receipt.state_path !== statePath
    || receipt.task_selector !== options.taskSelector
    || receipt.resolution !== options.resolution
    || !Array.isArray(receipt.tasks)) {
    throw new Error('Plan receipt does not match this operation, state file, or selected task scope. Run a new --plan.');
  }
  const expectedIds = new Set(tasks.map((task) => task.id));
  if (receipt.tasks.length !== expectedIds.size
    || receipt.tasks.some((task) => !expectedIds.has(task.id))) {
    throw new Error('Plan receipt task scope does not match the current selection. Run a new --plan.');
  }
  return receipt;
}

function planReceiptDiff(state, snapshot, options, tasks, receipt) {
  const receiptById = new Map(receipt.tasks.map((task) => [task.id, task]));
  const remoteByGid = new Map(snapshot.remotes.map((remote) => [remote.gid, remote]));
  const diff = [];
  for (const task of tasks) {
    const planned = receiptById.get(task.id);
    const currentPlan = planPayload(state, task);
    diff.push(...projectionDiff(planned.plan_payload, currentPlan, 'planned_json', 'current_json')
      .map((entry) => ({ id: task.id, source: 'json', ...entry })));
    const currentDesired = comparableDesiredProjection(desiredProjection(state, task));
    diff.push(...projectionDiff(planned.desired, currentDesired, 'planned_json_projection', 'current_json_projection')
      .map((entry) => ({ id: task.id, source: 'json', ...entry })));
    if (options.operation !== 'pull') continue;
    const remote = task.asana.gid ? remoteByGid.get(task.asana.gid) : null;
    if (!remote) {
      diff.push({ id: task.id, source: 'asana', field: 'task_presence', planned_asana: 'present', current_asana: 'missing' });
      continue;
    }
    const currentObserved = comparableObservedProjection(
      remoteProjection(state, task, remote),
      Object.hasOwn(task.asana, 'assignee_gid'),
      Object.hasOwn(task.asana, 'parent_gid'),
    );
    diff.push(...projectionDiff(planned.observed, currentObserved, 'planned_asana', 'current_asana')
      .map((entry) => ({ id: task.id, source: 'asana', ...entry })));
  }
  return diff;
}

function parseArguments(argv) {
  if (argv.length === 1 && ['-h', '--help'].includes(argv[0])) {
    return { help: true };
  }
  const [operation, mode, ...rest] = argv;
  if (operation === 'validate') {
    if (mode?.startsWith('--') && !['--state', '--env'].includes(mode)) {
      throw new Error('Usage: asana-task-sync validate [--state PATH] [--env PATH]');
    }
    const validateArgs = mode ? [mode, ...rest] : rest;
    return parseOptions({ operation, apply: false, mode: 'validate' }, validateArgs);
  }
  if (!['pull', 'push', 'import'].includes(operation) || !['--plan', '--apply'].includes(mode)) {
    throw new Error('Usage: asana-task-sync <import|pull|push> <--plan|--apply> [options]');
  }
  return parseOptions({ operation, apply: mode === '--apply', mode: mode.slice(2) }, rest);
}

function parseOptions(options, args) {
  Object.assign(options, {
    statePath: null, envPath: null, snapshotPath: null, go: null,
    name: null, outputDir: null, sectionName: null, taskSelector: null, planReceiptPath: null, resolution: null,
  });
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--go', '--state', '--env', '--snapshot', '--name', '--output-dir', '--section', '--task', '--plan-receipt', '--resolve'].includes(flag) || !value) {
      throw new Error('Invalid option. Use --go, --state, --env, --snapshot, --name, --output-dir, --section, --task, --plan-receipt, or --resolve with a value.');
    }
    index += 1;
    if (flag === '--go') options.go = value;
    if (flag === '--state') options.statePath = resolve(value);
    if (flag === '--env') options.envPath = resolve(value);
    if (flag === '--snapshot') options.snapshotPath = resolve(value);
    if (flag === '--name') options.name = value;
    if (flag === '--output-dir') options.outputDir = resolve(value);
    if (flag === '--section') options.sectionName = value;
    if (flag === '--task') options.taskSelector = value;
    if (flag === '--plan-receipt') options.planReceiptPath = resolve(value);
    if (flag === '--resolve') options.resolution = value;
  }
  if (options.apply && !options.go) {
    throw new Error('--apply requires --go <explicit-operator-go>.');
  }
  if (!options.envPath) {
    throw new Error('Every command requires an explicit --env NAME_TASK_CONTROL.env outside the tool directory.');
  }
  if (options.operation === 'validate') {
    if (options.name || options.outputDir || options.sectionName || options.snapshotPath
      || options.taskSelector || options.planReceiptPath || options.resolution) {
      throw new Error('validate accepts only --state and --env.');
    }
    return options;
  }
  if (options.operation === 'import') {
    if (!options.name || !options.outputDir || !options.sectionName || !options.snapshotPath) {
      throw new Error('import requires --name NAME, --output-dir PATH, --section SECTION_NAME, and --snapshot PATH.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.name)
      || options.name.endsWith('_TASK_CONTROL')) {
      throw new Error('--name must be a safe technical name without the _TASK_CONTROL suffix.');
    }
    if (options.statePath || options.taskSelector || options.planReceiptPath || options.resolution) {
      throw new Error('import derives its state path from --name and --output-dir; it does not accept --state, --task, --plan-receipt, or --resolve.');
    }
  } else if (!options.snapshotPath) {
    throw new Error(`${options.operation} requires --snapshot PATH created from the configured Asana MCP.`);
  } else if (options.name || options.outputDir || options.sectionName) {
    throw new Error('--name, --output-dir, and --section are valid only for import.');
  }
  if (options.apply && ['pull', 'push'].includes(options.operation) && !options.planReceiptPath) {
    throw new Error(`${options.operation} --apply requires --plan-receipt PATH created by its preceding --plan.`);
  }
  if (options.resolution !== null) {
    if (options.operation !== 'push' || options.resolution !== 'json') {
      throw new Error('--resolve is supported only as --resolve json for a controlled push where the operator explicitly chooses JSON.');
    }
  }
  return options;
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env line: ${rawLine}`);
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.trim();
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadEnvironment(envPath, baseEnvironment) {
  let fileValues = {};
  try {
    fileValues = parseDotEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...fileValues, ...baseEnvironment };
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`Missing ${name}. Configure it in the host .env or process environment.`);
  return value;
}

function requiredEnvironmentEntry(environment, name) {
  if (!Object.prototype.hasOwnProperty.call(environment, name)
    || environment[name] === undefined || environment[name] === null) {
    throw new Error(`Missing ${name}. Configure it explicitly in the host .env or process environment.`);
  }
  return environment[name];
}

function optionalNewTaskDefaultAssignee(environment) {
  const gid = environment.ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID;
  const email = environment.ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL;
  const hasGid = gid !== undefined && gid !== null && gid !== '';
  const hasEmail = email !== undefined && email !== null && email !== '';
  if (!hasGid && !hasEmail) return null;
  if (!hasGid || !hasEmail) {
    throw new Error(
      'Configure ASANA_NEW_TASK_DEFAULT_ASSIGNEE_GID and ASANA_NEW_TASK_DEFAULT_ASSIGNEE_EMAIL together, or omit both.',
    );
  }
  return { gid, email };
}

function configureState(state, environment) {
  const target = {
    project: requiredEnvironment(environment, 'ASANA_PROJECT_NAME'),
    project_gid: requiredEnvironment(environment, 'ASANA_PROJECT_GID'),
    new_task_default_assignee: optionalNewTaskDefaultAssignee(environment),
  };
  Object.defineProperties(state, {
    asana_target: { value: target, enumerable: false },
    runtime: {
      value: { title_prefix: requiredEnvironmentEntry(environment, 'ASANA_TITLE_PREFIX') },
      enumerable: false,
    },
  });
  return state;
}

function resolveStatePath(options, environment) {
  if (options.operation === 'import') {
    return join(options.outputDir, `${options.name}_TASK_CONTROL.json`);
  }
  if (options.statePath) return options.statePath;
  const configured = requiredEnvironment(environment, 'ASANA_STATE_FILE');
  return resolve(dirname(options.envPath), configured);
}

function expectedInstanceEnvPath(statePath) {
  if (!statePath.endsWith('.json')) {
    throw new Error(`Task-control state must use the .json extension: ${statePath}`);
  }
  return `${statePath.slice(0, -'.json'.length)}.env`;
}

function isInsideToolDirectory(path) {
  const candidate = resolve(path);
  const relativePath = relative(TOOL_DIRECTORY, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function assertOutsideToolDirectory(path, label) {
  if (isInsideToolDirectory(path)) {
    throw new Error(`${label} must be outside the asana-task-sync tool directory: ${TOOL_DIRECTORY}`);
  }
}

function assertInstancePair(statePath, envPath) {
  const expected = expectedInstanceEnvPath(statePath);
  if (resolve(envPath) !== expected) {
    throw new Error(
      `The instance environment must be adjacent to its JSON database: ${expected}.`,
    );
  }
}

export async function main(argv = process.argv.slice(2), baseEnvironment = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`Użycie:\n  asana-task-sync validate [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync import <--plan|--apply> --name NAME --output-dir PATH --section SECTION_NAME --snapshot SNAPSHOT.json [--go GO] --env NAME_TASK_CONTROL.env\n  asana-task-sync <pull|push> --plan --snapshot SNAPSHOT.json [--task LOCAL_ID_OR_ASANA_GID] [--plan-receipt PLAN.json] [--resolve json] [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync <pull|push> --apply --go GO --snapshot SNAPSHOT.json --plan-receipt PLAN.json [--task LOCAL_ID_OR_ASANA_GID] [--resolve json] [--state PATH] --env NAME_TASK_CONTROL.env\n\nTryby:\n  validate       waliduje bazę JSON bez zrzutu Asany\n  import --plan  wykrywa zadania istniejące w zrzucie MCP bez zapisu\n  import --apply tworzy lub uzupełnia NAME_TASK_CONTROL.json po GO\n  pull --plan    klasyfikuje różnice z MCP snapshot bez zapisu; opcjonalnie zapisuje receipt\n  pull --apply   porównuje świeży snapshot z receipt; przy różnicy zwraca diff i nie zapisuje JSON-a\n  push --plan    generuje manifest operacji MCP wymaganych w Asanie; opcjonalnie zapisuje receipt\n  push --apply   potwierdza w JSON-ie operacje już wykonane przez MCP i sprawdza niezmienność lokalnego planu\n\nKonfiguracja:\n  NAME jest prefiksem bez _TASK_CONTROL, np. PROJECT albo PROJECT_X.\n  --env jest wymagany i musi wskazywać sąsiedni plik NAME_TASK_CONTROL.env poza katalogiem narzędzia.\n  --task ogranicza pull lub push do dokładnie jednego stabilnego lokalnego ID albo GID Asany.\n  --plan-receipt jest opcjonalnym artefaktem --plan i wymaganym wejściem późniejszego pull/push --apply.\n  --resolve json jest jawną decyzją operatora, że JSON wygrywa wcześniej wykryty konflikt kontrolowanej projekcji.\n  --section jest wymaganą, jawną nazwą źródłowej tablicy Asany dla importu.\n  --snapshot pochodzi z MCP Asany skonfigurowanego dla bieżącego agenta i leży poza katalogiem narzędzia.\n`);
    return { help: true };
  }
  assertOutsideToolDirectory(options.envPath, 'Instance environment');
  if (options.operation === 'import') {
    assertOutsideToolDirectory(options.outputDir, 'Import --output-dir');
  }
  if (options.snapshotPath) {
    assertOutsideToolDirectory(options.snapshotPath, 'MCP snapshot');
  }
  if (options.planReceiptPath) {
    assertOutsideToolDirectory(options.planReceiptPath, 'Plan receipt');
  }
  const environment = await loadEnvironment(options.envPath, baseEnvironment);
  const statePath = resolveStatePath(options, environment);
  assertOutsideToolDirectory(statePath, 'Task-control state');
  if (options.operation !== 'validate') assertInstancePair(statePath, options.envPath);
  let state;
  let stateExisted = true;
  try {
    state = await readState(statePath);
  } catch (error) {
    if (options.operation !== 'import' || error.code !== 'ENOENT') throw error;
    state = newImportedState();
    stateExisted = false;
  }
  if (options.operation === 'validate') {
    const report = {
      operation: 'validate', mode: 'read-only', state_path: statePath,
      schema_version: state.schema_version, tasks: state.tasks.length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  configureState(state, environment);
  const snapshot = await readMcpSnapshot(options.snapshotPath, state);
  const tasks = options.operation === 'import' ? null : selectTasks(state, options.taskSelector);
  if (options.apply && ['pull', 'push'].includes(options.operation)) {
    const receipt = await readPlanReceipt(options.planReceiptPath, statePath, options, tasks);
    const decisionRequiredDiff = planReceiptDiff(state, snapshot, options, tasks, receipt);
    if (decisionRequiredDiff.length > 0) {
      const report = {
        operation: options.operation,
        mode: 'apply',
        state_path: statePath,
        changed_json: false,
        blocked: true,
        reason: 'state_changed_after_plan',
        decision_required_diff: decisionRequiredDiff,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
  }
  const outcome = options.operation === 'pull'
    ? await pull(state, snapshot, options.apply, tasks)
    : options.operation === 'push'
      ? await push(state, snapshot, options.apply, tasks, options.resolution)
      : importTasks(state, snapshot, options.apply, options.sectionName);
  const shouldWriteState = options.apply
    && (outcome.changed || (options.operation === 'import' && !stateExisted));
  if (shouldWriteState) {
    validateState(state);
    if (stateExisted) await writeStateAtomically(statePath, state);
    else await writeNewState(statePath, state);
  }
  const conflicts = outcome.report.filter((entry) => entry.action === 'conflict');
  const report = {
    operation: options.operation,
    mode: options.apply ? 'apply' : 'plan',
    state_path: statePath,
    changed_json: shouldWriteState,
    state_created: shouldWriteState && !stateExisted,
    conflicts: conflicts.length,
    tasks: outcome.report,
  };
  if (outcome.import_scope) report.import_scope = outcome.import_scope;
  if (outcome.mcp_operations) report.mcp_operations = outcome.mcp_operations;
  if (!options.apply && options.planReceiptPath) {
    await writePlanReceipt(options.planReceiptPath, statePath, options, outcome.receipt_tasks ?? []);
    report.plan_receipt_path = options.planReceiptPath;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((report) => {
    if (report?.blocked) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`BŁĄD: ${error.message}\n`);
    process.exitCode = 1;
  });
}
