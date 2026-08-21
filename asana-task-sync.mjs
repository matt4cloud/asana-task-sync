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
export const SNAPSHOT_MAX_AGE_SECONDS = 300;
export const SNAPSHOT_MAX_FUTURE_SKEW_SECONDS = 60;

function snapshotTimeError(capturedAt, problem, allowedLimit) {
  return new Error(
    `Invalid MCP snapshot captured_at ${JSON.stringify(capturedAt)}: ${problem}. `
    + `Allowed limit: ${allowedLimit}. Fetch a new snapshot from Asana and retry.`,
  );
}

function normalizedFraction(fraction) {
  return fraction.replace(/0+$/, '');
}

function compareSnapshotTimes(left, right) {
  if (left.epoch_seconds < right.epoch_seconds) return -1;
  if (left.epoch_seconds > right.epoch_seconds) return 1;
  const length = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(length, '0');
  const rightFraction = right.fraction.padEnd(length, '0');
  if (leftFraction < rightFraction) return -1;
  if (leftFraction > rightFraction) return 1;
  return 0;
}

function timeFromEpochMilliseconds(epochMilliseconds) {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new Error('The process clock must provide a finite integer millisecond epoch.');
  }
  const epochSeconds = Math.floor(epochMilliseconds / 1000);
  const milliseconds = epochMilliseconds - epochSeconds * 1000;
  return {
    epoch_seconds: BigInt(epochSeconds),
    fraction: String(milliseconds).padStart(3, '0').replace(/0+$/, ''),
  };
}

function parseSnapshotDateTime(capturedAt) {
  if (typeof capturedAt !== 'string' || capturedAt === '') {
    throw snapshotTimeError(
      capturedAt,
      'captured_at must be a non-empty RFC 3339 date-time with an explicit timezone',
      `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(capturedAt);
  if (!match) {
    throw snapshotTimeError(
      capturedAt,
      'captured_at must be an unambiguous RFC 3339 date-time with an explicit timezone',
      `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
    );
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) {
    throw snapshotTimeError(
      capturedAt,
      'captured_at is not a valid calendar date-time',
      `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
    );
  }
  let offsetMinutes = 0;
  if (!/^[Zz]$/.test(zone)) {
    if (zone === '-00:00') {
      throw snapshotTimeError(
        capturedAt,
        'captured_at uses -00:00, which declares an unknown local timezone offset and cannot identify an unambiguous instant',
        `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
      );
    }
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw snapshotTimeError(
        capturedAt,
        'captured_at contains an invalid timezone offset',
        `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
      );
    }
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const epochMilliseconds = calendar.getTime() - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw snapshotTimeError(
      capturedAt,
      'captured_at cannot be converted to a finite time',
      `${SNAPSHOT_MAX_AGE_SECONDS} seconds old and ${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds in the future`,
    );
  }
  return {
    epoch_seconds: BigInt(Math.floor(epochMilliseconds / 1000)),
    fraction: normalizedFraction(fraction),
  };
}

export function validateSnapshotCapturedAt(capturedAt, nowMilliseconds = Date.now()) {
  const capturedAtTime = parseSnapshotDateTime(capturedAt);
  const now = timeFromEpochMilliseconds(nowMilliseconds);
  const oldestAllowed = {
    epoch_seconds: now.epoch_seconds - BigInt(SNAPSHOT_MAX_AGE_SECONDS),
    fraction: now.fraction,
  };
  if (compareSnapshotTimes(capturedAtTime, oldestAllowed) < 0) {
    throw snapshotTimeError(
      capturedAt,
      'the snapshot is too old',
      `${SNAPSHOT_MAX_AGE_SECONDS} seconds maximum age`,
    );
  }
  const newestAllowed = {
    epoch_seconds: now.epoch_seconds + BigInt(SNAPSHOT_MAX_FUTURE_SKEW_SECONDS),
    fraction: now.fraction,
  };
  if (compareSnapshotTimes(capturedAtTime, newestAllowed) > 0) {
    throw snapshotTimeError(
      capturedAt,
      'the snapshot time is too far in the future',
      `${SNAPSHOT_MAX_FUTURE_SKEW_SECONDS} seconds maximum future clock skew`,
    );
  }
  return capturedAtTime;
}

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

export function desiredProjection(state, task, { allowInitialPullWithoutSection = false } = {}) {
  const tracksParent = Object.hasOwn(task.asana, 'parent_gid');
  const parentGid = tracksParent ? (task.asana.parent_gid ?? null) : null;
  const isSubtask = Boolean(parentGid);
  const sectionGid = task.asana.section_gid;
  const sectionName = task.asana.section_name;
  const missingBaseline = !task.asana.last_synced_plan_sha256
    || !task.asana.last_synced_projection_sha256;
  const canPullInitialSection = allowInitialPullWithoutSection
    && Boolean(task.asana.gid)
    && missingBaseline
    && sectionGid === null
    && sectionName === null;
  if (!isSubtask && (!sectionGid || !sectionName) && !canPullInitialSection) {
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
    && controlledNotesMatch(state, task, observed);
}

function hasCanonicalControlledPlanId(state) {
  const planIdFields = state.rendering.managed_fields.filter((field) => field.path === 'id');
  return planIdFields.length === 1 && planIdFields[0].format === 'text';
}

function controlledNotesMatch(state, task, observed) {
  const expected = renderManagedNotes(state, task);
  if (observed.has_operator_heading) return observed.controlled_notes === expected;
  return observed.notes.trim() === expected;
}

function controlledBindIdentity(state, task, remote) {
  const observed = remoteProjection(state, task, remote);
  const managedOnlyNotes = !observed.has_operator_heading
    && observed.notes.trim() === renderManagedNotes(state, task);
  const expected = {
    name: renderedTitle(state, task),
    controlled_notes: renderManagedNotes(state, task),
    has_operator_heading: observed.has_operator_heading,
  };
  const actual = {
    name: observed.name,
    controlled_notes: managedOnlyNotes ? observed.notes.trim() : observed.controlled_notes,
    has_operator_heading: observed.has_operator_heading,
  };
  return {
    expected,
    actual,
    matches: hasCanonicalControlledPlanId(state)
      && (observed.has_operator_heading || managedOnlyNotes)
      && stableJson(expected) === stableJson(actual),
    diff: projectionDiff(expected, actual, 'json', 'asana'),
  };
}

function localControlledIdentityMatches(state, remote, onlyUnbound = false) {
  return state.tasks.filter((candidate) => (
    (!onlyUnbound || !candidate.asana.gid)
      && controlledBindIdentity(state, candidate, remote).matches
  ));
}

function gidOwners(state, remoteGid) {
  return state.tasks
    .filter((task) => task.asana.gid === remoteGid)
    .map((task) => task.id)
    .sort();
}

function isFullProjectSnapshot(snapshot) {
  return stableJson(snapshot.scope) === stableJson({ kind: 'project' });
}

function matchingRemoteGids(state, task, snapshot) {
  return snapshot.remotes
    .filter((remote) => controlledBindIdentity(state, task, remote).matches)
    .map((remote) => remote.gid)
    .sort();
}

function classifyRemoteUnbound(state, task, snapshot) {
  if (!hasCanonicalControlledPlanId(state)) {
    return { id: task.id, asana_gid: null, action: 'not_exported', reason: 'no_asana_gid' };
  }
  if (!isFullProjectSnapshot(snapshot)) {
    return {
      id: task.id,
      asana_gid: null,
      action: 'conflict',
      reason: 'full_project_snapshot_required',
      required_scope: { kind: 'project' },
      actual_scope: snapshot.scope,
    };
  }
  const matchingGids = matchingRemoteGids(state, task, snapshot);
  if (matchingGids.length === 0) {
    return { id: task.id, asana_gid: null, action: 'not_exported', reason: 'no_asana_gid' };
  }
  if (matchingGids.length > 1) {
    return {
      id: task.id,
      asana_gid: null,
      action: 'conflict',
      reason: 'ambiguous_remote_match',
      candidate_asana_gids: matchingGids,
    };
  }
  const [matchingGid] = matchingGids;
  const remote = snapshot.remotes.find((candidate) => candidate.gid === matchingGid);
  const matchingLocalIds = localControlledIdentityMatches(state, remote, true)
    .map((candidate) => candidate.id)
    .sort();
  if (matchingLocalIds.length > 1) {
    return {
      id: task.id,
      asana_gid: null,
      action: 'conflict',
      reason: 'ambiguous_local_match',
      candidate_asana_gid: remote.gid,
      candidate_local_ids: matchingLocalIds,
    };
  }
  const owners = gidOwners(state, remote.gid);
  if (owners.length > 0) {
    return {
      id: task.id,
      asana_gid: null,
      action: 'conflict',
      reason: 'matching_remote_gid_already_bound',
      candidate_asana_gid: remote.gid,
      bound_local_ids: owners,
    };
  }
  return {
    id: task.id,
    asana_gid: null,
    action: 'remote_unbound',
    reason: 'controlled_plan_identity_matches',
    candidate_asana_gid: remote.gid,
  };
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

function synchronizationObservedHash(
  state, task, observed, tracksAssignee = false, tracksParent = false,
) {
  const managedOnlyNotes = !observed.has_operator_heading
    && observed.notes.trim() === renderManagedNotes(state, task);
  const projection = managedOnlyNotes
    ? { ...observed, notes: renderNotes(state, task, '') }
    : observed;
  return observedHash(projection, tracksAssignee, tracksParent);
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

function jsonTaskDiff(expected, actual, path = '') {
  if (stableJson(expected) === stableJson(actual)) return [];
  const expectedIsObject = expected !== null && typeof expected === 'object' && !Array.isArray(expected);
  const actualIsObject = actual !== null && typeof actual === 'object' && !Array.isArray(actual);
  if (expectedIsObject && actualIsObject) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].sort().flatMap((key) => (
      jsonTaskDiff(expected[key], actual[key], path ? `${path}.${key}` : key)
    ));
  }
  return [{
    field: path,
    planned_json: expected ?? null,
    current_json: actual ?? null,
  }];
}

export function classifyKnownTask(state, task, remote, projectionOptions = {}) {
  const desired = desiredProjection(state, task, projectionOptions);
  const observed = remoteProjection(state, task, remote);
  const planHash = sha256(planPayload(state, task));
  const desiredHash = projectionHash(desired);
  const remoteHash = synchronizationObservedHash(
    state, task, observed,
    Object.hasOwn(task.asana, 'assignee_gid'), Object.hasOwn(task.asana, 'parent_gid'),
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
    if (!localPlanChanged && desiredHash === remoteHash) {
      return {
        kind: 'pull_required', reason: 'baseline_stale_but_projections_match',
        planHash, desiredHash, remoteHash, desired, observed,
      };
    }
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

function applyObservedAsanaState(state, task, result) {
  const { observed, planHash } = result;
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
  task.asana.last_synced_projection_sha256 = synchronizationObservedHash(
    state, task, observed, true, true,
  );
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
    parent: task.parent ? {
      gid: task.parent.gid,
      ...(Object.hasOwn(task.parent, 'name') ? { name: task.parent.name } : {}),
    } : null,
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
  const capturedAtTime = validateSnapshotCapturedAt(snapshot.captured_at);
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
      if (task.parent.name !== null && task.parent.name !== undefined
        && typeof task.parent.name !== 'string') {
        throw new Error(`Invalid MCP snapshot: tasks[${index}].parent.name must be a string or null.`);
      }
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
  return {
    sections,
    remotes,
    bindings: snapshot.bindings ?? [],
    scope: snapshot.scope ?? null,
    captured_at: snapshot.captured_at,
    captured_at_time: capturedAtTime,
  };
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
    if (typeof task.id !== 'string' || !task.id || !task.title || !task.asana) {
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
  const selectors = taskSelector.split(',').map((value) => value.trim()).filter(Boolean);
  if (selectors.length === 0) {
    throw new Error('--task requires at least one non-empty, comma-separated local id or Asana GID.');
  }
  const selected = [];
  const seenIds = new Set();
  for (const selector of selectors) {
    const matches = state.tasks.filter((task) => (
      task.id === selector || task.asana.gid === selector
    ));
    if (matches.length === 0) {
      throw new Error(`No task matches --task ${selector}. Use its stable local id or Asana GID.`);
    }
    if (matches.length > 1) {
      throw new Error(`--task ${selector} is ambiguous. Use the stable local id.`);
    }
    const [task] = matches;
    if (!seenIds.has(task.id)) {
      seenIds.add(task.id);
      selected.push(task);
    }
  }
  return selected;
}

function resolvePlannedPullTask(state, planned) {
  const idMatches = state.tasks.filter((task) => task.id === planned.id);
  if (idMatches.length === 1) return { task: idMatches[0], issue: null, candidates: idMatches };
  if (idMatches.length > 1) return { task: null, issue: 'ambiguous_local_id', candidates: idMatches };
  const gidMatches = planned.asana_gid
    ? state.tasks.filter((task) => task.asana.gid === planned.asana_gid)
    : [];
  if (gidMatches.length === 1) return { task: gidMatches[0], issue: null, candidates: gidMatches };
  if (gidMatches.length > 1) return { task: null, issue: 'ambiguous_asana_gid', candidates: gidMatches };
  return { task: null, issue: 'missing', candidates: [] };
}

function receiptTask(state, task, result) {
  const tracksAssignee = Object.hasOwn(task.asana, 'assignee_gid');
  const tracksParent = Object.hasOwn(task.asana, 'parent_gid');
  return {
    id: task.id,
    asana_gid: task.asana.gid,
    action: result.kind,
    planned_json_task: JSON.parse(JSON.stringify(task)),
    plan_payload: planPayload(state, task),
    desired: comparableDesiredProjection(result.desired),
    observed: comparableObservedProjection(result.observed, tracksAssignee, tracksParent),
  };
}

function selectBindTask(state, taskSelector) {
  if (!taskSelector || taskSelector.includes(',')) {
    throw new Error('bind requires exactly one stable local id through --task.');
  }
  const matches = state.tasks.filter((task) => task.id === taskSelector);
  if (matches.length !== 1) {
    throw new Error(`No unique local task matches bind --task ${taskSelector}. Use its stable local id.`);
  }
  return matches[0];
}

function bindConflict(state, task, remoteGid, snapshot) {
  if (!hasCanonicalControlledPlanId(state)) {
    return {
      reason: 'noncanonical_controlled_plan_id',
      requirement: 'rendering.managed_fields must contain exactly one Plan ID field with path "id" and format "text" for remote discovery or bind.',
    };
  }
  if (!isFullProjectSnapshot(snapshot)) {
    return {
      reason: 'full_project_snapshot_required',
      required_scope: { kind: 'project' },
      actual_scope: snapshot.scope,
    };
  }
  if (task.asana.gid && task.asana.gid !== remoteGid) {
    return {
      reason: 'local_task_already_bound_to_different_gid',
      current_asana_gid: task.asana.gid,
      requested_asana_gid: remoteGid,
    };
  }
  if (!task.asana.gid && (
    task.asana.last_synced_plan_sha256 != null
    || task.asana.last_synced_projection_sha256 != null
  )) {
    return {
      reason: 'unbound_task_has_residual_sync_baseline',
      residual_sync_baseline: {
        last_synced_plan_sha256: task.asana.last_synced_plan_sha256,
        last_synced_projection_sha256: task.asana.last_synced_projection_sha256,
      },
    };
  }
  const owners = gidOwners(state, remoteGid);
  const otherOwners = owners.filter((id) => id !== task.id);
  if (otherOwners.length > 0) {
    return {
      reason: 'asana_gid_already_bound_to_other_local_task',
      requested_asana_gid: remoteGid,
      bound_local_ids: otherOwners,
    };
  }
  const remote = snapshot.remotes.find((candidate) => candidate.gid === remoteGid);
  if (!remote) {
    return { reason: 'asana_gid_not_in_snapshot', requested_asana_gid: remoteGid };
  }
  const matchingGids = matchingRemoteGids(state, task, snapshot);
  if (matchingGids.length > 1) {
    return {
      reason: 'ambiguous_remote_match',
      requested_asana_gid: remoteGid,
      candidate_asana_gids: matchingGids,
    };
  }
  const identity = controlledBindIdentity(state, task, remote);
  if (!identity.matches || matchingGids.length !== 1 || matchingGids[0] !== remoteGid) {
    return {
      reason: 'controlled_plan_identity_mismatch',
      requested_asana_gid: remoteGid,
      diff: identity.diff,
    };
  }
  const matchingOtherLocalIds = localControlledIdentityMatches(state, remote)
    .filter((candidate) => candidate !== task)
    .map((candidate) => candidate.id)
    .sort();
  if (matchingOtherLocalIds.length > 0) {
    return {
      reason: 'ambiguous_local_match',
      requested_asana_gid: remoteGid,
      candidate_local_ids: [task.id, ...matchingOtherLocalIds].sort(),
    };
  }
  if (!task.asana.gid) {
    const postBindTask = JSON.parse(JSON.stringify(task));
    postBindTask.asana.gid = remoteGid;
    try {
      const postBindPull = classifyKnownTask(state, postBindTask, remote, {
        allowInitialPullWithoutSection: true,
      });
      if (postBindPull.kind !== 'baseline_required') {
        return {
          reason: 'post_bind_pull_not_baseline_required',
          requested_asana_gid: remoteGid,
          post_bind_pull_action: postBindPull.kind,
          post_bind_pull_reason: postBindPull.reason,
        };
      }
    } catch (error) {
      return {
        reason: 'post_bind_pull_not_baseline_required',
        requested_asana_gid: remoteGid,
        post_bind_pull_error: error.message,
      };
    }
  }
  return null;
}

function bindReceiptTask(state, task, remoteGid, remote, snapshot, action) {
  const identity = controlledBindIdentity(state, task, remote);
  return {
    id: task.id,
    asana_gid: remoteGid,
    action,
    planned_json_task: JSON.parse(JSON.stringify(task)),
    planned_gid_owners: gidOwners(state, remoteGid),
    planned_remote_scope: JSON.parse(JSON.stringify(snapshot.scope)),
    planned_matching_remote_gids: matchingRemoteGids(state, task, snapshot),
    observed_identity: identity.actual,
  };
}

function bind(state, snapshot, apply, task, remoteGid) {
  const conflict = bindConflict(state, task, remoteGid, snapshot);
  if (conflict) {
    return {
      report: [{
        id: task.id,
        asana_gid: task.asana.gid,
        action: 'conflict',
        ...conflict,
      }],
      changed: false,
      receipt_tasks: [],
    };
  }
  const remote = snapshot.remotes.find((candidate) => candidate.gid === remoteGid);
  const action = task.asana.gid === remoteGid ? 'already_bound' : 'bind_required';
  const receiptTasks = [bindReceiptTask(state, task, remoteGid, remote, snapshot, action)];
  if (apply && action === 'bind_required') task.asana.gid = remoteGid;
  return {
    report: [{
      id: task.id,
      asana_gid: remoteGid,
      action: apply && action === 'bind_required' ? 'bound' : action,
      reason: action === 'already_bound'
        ? 'local_task_already_has_requested_gid'
        : 'controlled_plan_identity_matches',
    }],
    changed: apply && action === 'bind_required',
    receipt_tasks: receiptTasks,
  };
}

async function pull(state, snapshot, apply, tasks) {
  const remoteByGid = new Map(snapshot.remotes.map((remote) => [remote.gid, remote]));
  const report = [];
  let changed = false;
  const receiptTasks = [];
  for (const task of tasks) {
    if (!task.asana.gid) {
      report.push(classifyRemoteUnbound(state, task, snapshot));
      continue;
    }
    const remote = remoteByGid.get(task.asana.gid);
    if (!remote) {
      report.push({ id: task.id, asana_gid: task.asana.gid, action: 'snapshot_missing', reason: 'tracked_task_not_in_mcp_snapshot' });
      continue;
    }
    const result = classifyKnownTask(state, task, remote, { allowInitialPullWithoutSection: true });
    report.push(reportEntry(task, result));
    receiptTasks.push(receiptTask(state, task, result));
    if (!apply) continue;
    if (result.kind === 'baseline_required' || result.kind === 'pull_required') {
      applyObservedAsanaState(state, task, result);
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
      ...(desired.due_on === null ? {} : { due_on: desired.due_on }),
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
      const discovery = classifyRemoteUnbound(state, task, snapshot);
      if (discovery.action !== 'not_exported') {
        report.push(discovery);
        continue;
      }
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

async function writePlanReceipt(receiptPath, statePath, state, snapshot, options, receiptTasks) {
  const receipt = {
    schema_version: 'asana-task-sync-plan-receipt/v1',
    operation: options.operation,
    state_path: statePath,
    task_selector: options.taskSelector,
    resolution: options.resolution,
    snapshot_captured_at: snapshot.captured_at,
    ...(options.operation === 'bind' ? {
      remote_gid: options.remoteGid,
      target_project: {
        gid: state.asana_target.project_gid,
        name: state.asana_target.project,
      },
    } : {}),
    tasks: receiptTasks,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

async function readPlanReceipt(receiptPath, statePath, options, tasks, loadedReceipt = null) {
  const receipt = loadedReceipt ?? JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt?.schema_version !== 'asana-task-sync-plan-receipt/v1'
    || receipt.operation !== options.operation
    || receipt.state_path !== statePath
    || receipt.task_selector !== options.taskSelector
    || receipt.resolution !== options.resolution
    || (options.operation === 'bind' && receipt.remote_gid !== options.remoteGid)
    || !Array.isArray(receipt.tasks)) {
    throw new Error('Plan receipt does not match this operation, state file, or selected task scope. Run a new --plan.');
  }
  if (!Object.hasOwn(receipt, 'snapshot_captured_at')) {
    throw new Error(
      'Plan receipt lacks snapshot_captured_at and cannot prove snapshot freshness. '
      + 'Run a new --plan with a fresh snapshot from Asana.',
    );
  }
  try {
    parseSnapshotDateTime(receipt.snapshot_captured_at);
  } catch {
    throw new Error(
      `Plan receipt has invalid snapshot_captured_at ${JSON.stringify(receipt.snapshot_captured_at)} `
      + 'and cannot prove snapshot freshness. Run a new --plan with a fresh snapshot from Asana.',
    );
  }
  if (['pull', 'bind'].includes(options.operation)
    && receipt.tasks.some((task) => !Object.hasOwn(task, 'planned_json_task'))) {
    const operationLabel = options.operation === 'pull' ? 'Pull' : 'Bind';
    throw new Error(`${operationLabel} plan receipt lacks its JSON task guard. Run a new --plan.`);
  }
  if (options.operation === 'pull') {
    if (new Set(receipt.tasks.map((task) => task.id)).size !== receipt.tasks.length) {
      throw new Error('Pull plan receipt contains duplicate planned task IDs. Run a new --plan.');
    }
    if (options.taskSelector) {
      const selectors = options.taskSelector.split(',').map((value) => value.trim()).filter(Boolean);
      const selectedIds = new Set();
      for (const selector of selectors) {
        const matches = receipt.tasks.filter((task) => task.id === selector || task.asana_gid === selector);
        if (matches.length !== 1) {
          throw new Error('Plan receipt task scope does not match the selected pull task. Run a new --plan.');
        }
        selectedIds.add(matches[0].id);
      }
      if (selectedIds.size !== receipt.tasks.length) {
        throw new Error('Plan receipt task scope does not match the selected pull task. Run a new --plan.');
      }
    }
    return receipt;
  }
  if (options.operation === 'bind') {
    if (receipt.tasks.length !== 1
      || receipt.tasks[0].id !== options.taskSelector
      || receipt.tasks[0].asana_gid !== options.remoteGid
      || typeof receipt.target_project?.gid !== 'string'
      || typeof receipt.target_project?.name !== 'string'
      || !Array.isArray(receipt.tasks[0].planned_gid_owners)
      || stableJson(receipt.tasks[0].planned_remote_scope) !== stableJson({ kind: 'project' })
      || stableJson(receipt.tasks[0].planned_matching_remote_gids) !== stableJson([options.remoteGid])
      || !receipt.tasks[0].observed_identity) {
      throw new Error('Bind plan receipt does not match the selected local task and remote GID. Run a new --plan.');
    }
    return receipt;
  }
  const receiptIds = new Set(receipt.tasks.map((task) => task.id));
  const eligibleTasks = tasks;
  const expectedIds = new Set(eligibleTasks.map((task) => task.id));
  if (receipt.tasks.length !== expectedIds.size
    || receipt.tasks.some((task) => !expectedIds.has(task.id))) {
    throw new Error('Plan receipt task scope does not match the current selection. Run a new --plan.');
  }
  return receipt;
}

function assertApplySnapshotIsNewer(snapshot, receipt) {
  const plannedTime = parseSnapshotDateTime(receipt.snapshot_captured_at);
  if (compareSnapshotTimes(snapshot.captured_at_time, plannedTime) <= 0) {
    throw new Error(
      `Apply snapshot captured_at ${JSON.stringify(snapshot.captured_at)} must be strictly later than `
      + `the plan receipt snapshot_captured_at ${JSON.stringify(receipt.snapshot_captured_at)}. `
      + `The snapshot maximum age remains ${SNAPSHOT_MAX_AGE_SECONDS} seconds. `
      + 'Fetch a new snapshot from Asana and retry apply with the same receipt while its other guards remain valid.',
    );
  }
}

function planReceiptDiff(state, snapshot, options, tasks, receipt) {
  const receiptById = new Map(receipt.tasks.map((task) => [task.id, task]));
  const remoteByGid = new Map(snapshot.remotes.map((remote) => [remote.gid, remote]));
  const diff = [];
  if (options.operation === 'bind') {
    const [planned] = receipt.tasks;
    const currentProject = {
      gid: state.asana_target.project_gid,
      name: state.asana_target.project,
    };
    diff.push(...projectionDiff(
      receipt.target_project, currentProject, 'planned_configuration', 'current_configuration',
    ).map((entry) => ({ id: planned.id, source: 'configuration', ...entry })));
    const task = state.tasks.find((candidate) => candidate.id === planned.id);
    if (!task) {
      return [{
        id: planned.id,
        source: 'json',
        field: 'task_presence',
        planned_json: 'present',
        current_json: 'missing',
      }];
    }
    diff.push(...jsonTaskDiff(planned.planned_json_task, task)
      .map((entry) => ({ id: planned.id, source: 'json', ...entry })));
    if (!isFullProjectSnapshot(snapshot)) {
      diff.push({
        id: planned.id,
        source: 'asana',
        field: 'snapshot_scope',
        planned_asana: planned.planned_remote_scope,
        current_asana: snapshot.scope,
      });
    }
    const currentOwners = gidOwners(state, options.remoteGid);
    if (stableJson(planned.planned_gid_owners) !== stableJson(currentOwners)) {
      diff.push({
        id: planned.id,
        source: 'json',
        field: 'asana_gid_owners',
        planned_json: planned.planned_gid_owners,
        current_json: currentOwners,
      });
    }
    const currentMatchingGids = matchingRemoteGids(state, task, snapshot);
    if (stableJson(planned.planned_matching_remote_gids) !== stableJson(currentMatchingGids)) {
      diff.push({
        id: planned.id,
        source: 'asana',
        field: 'controlled_identity_matching_gids',
        planned_asana: planned.planned_matching_remote_gids,
        current_asana: currentMatchingGids,
      });
    }
    const remote = remoteByGid.get(options.remoteGid);
    if (!remote) {
      diff.push({
        id: planned.id,
        source: 'asana',
        field: 'task_presence',
        planned_asana: 'present',
        current_asana: 'missing',
      });
      return diff;
    }
    const currentIdentity = controlledBindIdentity(state, task, remote).actual;
    diff.push(...projectionDiff(
      planned.observed_identity, currentIdentity, 'planned_asana', 'current_asana',
    ).map((entry) => ({ id: planned.id, source: 'asana', ...entry })));
    return diff;
  }
  if (options.operation === 'pull') {
    const accountedTasks = new Set();
    for (const planned of receipt.tasks) {
      const resolved = resolvePlannedPullTask(state, planned);
      for (const candidate of resolved.candidates) accountedTasks.add(candidate);
      if (!resolved.task) {
        diff.push({
          id: planned.id,
          source: 'json',
          field: 'task_presence',
          planned_json: 'present',
          current_json: resolved.issue,
        });
        continue;
      }
      const task = resolved.task;
      const taskDiff = jsonTaskDiff(planned.planned_json_task, task)
        .map((entry) => ({ id: planned.id, source: 'json', ...entry }));
      diff.push(...taskDiff);
      if (taskDiff.length > 0) continue;
      const currentPlan = planPayload(state, task);
      diff.push(...projectionDiff(planned.plan_payload, currentPlan, 'planned_json', 'current_json')
        .map((entry) => ({ id: planned.id, source: 'json', ...entry })));
      const currentDesired = comparableDesiredProjection(desiredProjection(state, task, {
        allowInitialPullWithoutSection: true,
      }));
      diff.push(...projectionDiff(planned.desired, currentDesired, 'planned_json_projection', 'current_json_projection')
        .map((entry) => ({ id: planned.id, source: 'json', ...entry })));
      const remote = planned.asana_gid ? remoteByGid.get(planned.asana_gid) : null;
      if (!remote) {
        diff.push({
          id: planned.id,
          source: 'asana',
          field: 'task_presence',
          planned_asana: 'present',
          current_asana: 'missing',
        });
        continue;
      }
      const currentObserved = comparableObservedProjection(
        remoteProjection(state, task, remote),
        Object.hasOwn(task.asana, 'assignee_gid'),
        Object.hasOwn(task.asana, 'parent_gid'),
      );
      diff.push(...projectionDiff(planned.observed, currentObserved, 'planned_asana', 'current_asana')
        .map((entry) => ({ id: planned.id, source: 'asana', ...entry })));
    }
    if (!options.taskSelector) {
      for (const task of state.tasks) {
        if (!task.asana.gid || accountedTasks.has(task)) continue;
        diff.push({
          id: task.id,
          source: 'json',
          field: 'task_presence',
          planned_json: 'missing',
          current_json: 'present',
        });
      }
    }
    return diff;
  }
  for (const task of tasks) {
    const planned = receiptById.get(task.id);
    const currentPlan = planPayload(state, task);
    diff.push(...projectionDiff(planned.plan_payload, currentPlan, 'planned_json', 'current_json')
      .map((entry) => ({ id: task.id, source: 'json', ...entry })));
    const currentDesired = comparableDesiredProjection(desiredProjection(state, task));
    diff.push(...projectionDiff(planned.desired, currentDesired, 'planned_json_projection', 'current_json_projection')
      .map((entry) => ({ id: task.id, source: 'json', ...entry })));
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
  if (!['bind', 'pull', 'push', 'import'].includes(operation) || !['--plan', '--apply'].includes(mode)) {
    throw new Error('Usage: asana-task-sync <bind|import|pull|push> <--plan|--apply> [options]');
  }
  return parseOptions({ operation, apply: mode === '--apply', mode: mode.slice(2) }, rest);
}

function parseOptions(options, args) {
  Object.assign(options, {
    statePath: null, envPath: null, snapshotPath: null, go: null,
    name: null, outputDir: null, sectionName: null, taskSelector: null, planReceiptPath: null,
    resolution: null, remoteGid: null,
  });
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--go', '--state', '--env', '--snapshot', '--name', '--output-dir', '--section', '--task', '--gid', '--plan-receipt', '--resolve'].includes(flag) || !value) {
      throw new Error('Invalid option. Use --go, --state, --env, --snapshot, --name, --output-dir, --section, --task, --gid, --plan-receipt, or --resolve with a value.');
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
    if (flag === '--gid') options.remoteGid = value;
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
      || options.taskSelector || options.remoteGid || options.planReceiptPath || options.resolution) {
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
    if (options.statePath || options.taskSelector || options.remoteGid || options.planReceiptPath || options.resolution) {
      throw new Error('import derives its state path from --name and --output-dir; it does not accept --state, --task, --gid, --plan-receipt, or --resolve.');
    }
  } else if (!options.snapshotPath) {
    throw new Error(`${options.operation} requires --snapshot PATH created from the configured Asana MCP.`);
  } else if (options.name || options.outputDir || options.sectionName) {
    throw new Error('--name, --output-dir, and --section are valid only for import.');
  }
  if (options.operation === 'bind') {
    if (!options.taskSelector || !options.remoteGid) {
      throw new Error('bind requires --task STABLE_LOCAL_ID and --gid ASANA_GID.');
    }
    if (options.resolution) {
      throw new Error('--resolve is not supported for bind.');
    }
  } else if (options.remoteGid) {
    throw new Error('--gid is valid only for bind.');
  }
  if (options.apply && ['bind', 'pull', 'push'].includes(options.operation) && !options.planReceiptPath) {
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
    process.stdout.write('Świeżość snapshotu:\n  captured_at musi być poprawnym date-time, nie starszym niż 300 s i nie dalszym niż 60 s w przyszłości.\n  bind/pull/push --apply wymagają snapshotu z captured_at ściśle późniejszym niż w receipcie planu.\n\n');
    process.stdout.write(`Użycie:\n  asana-task-sync validate [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync import <--plan|--apply> --name NAME --output-dir PATH --section SECTION_NAME --snapshot SNAPSHOT.json [--go GO] --env NAME_TASK_CONTROL.env\n  asana-task-sync bind --plan --task STABLE_LOCAL_ID --gid ASANA_GID --snapshot SNAPSHOT.json [--plan-receipt PLAN.json] [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync bind --apply --go GO --task STABLE_LOCAL_ID --gid ASANA_GID --snapshot SNAPSHOT.json --plan-receipt PLAN.json [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync <pull|push> --plan --snapshot SNAPSHOT.json [--task LOCAL_ID_OR_ASANA_GID[,LOCAL_ID_OR_ASANA_GID...]] [--plan-receipt PLAN.json] [--resolve json] [--state PATH] --env NAME_TASK_CONTROL.env\n  asana-task-sync <pull|push> --apply --go GO --snapshot SNAPSHOT.json --plan-receipt PLAN.json [--task LOCAL_ID_OR_ASANA_GID[,LOCAL_ID_OR_ASANA_GID...]] [--resolve json] [--state PATH] --env NAME_TASK_CONTROL.env\n\nTryby:\n  validate       waliduje bazę JSON bez zrzutu Asany\n  import --plan  wykrywa zadania istniejące w zrzucie MCP bez zapisu\n  import --apply tworzy lub uzupełnia NAME_TASK_CONTROL.json po GO\n  bind --plan    waliduje jawne wiązanie stabilnego lokalnego ID z istniejącym GID bez zapisu\n  bind --apply   ustawia wyłącznie asana.gid po GO i weryfikacji świeżego receipt-u\n  pull --plan    klasyfikuje różnice z MCP snapshot bez zapisu; opcjonalnie zapisuje receipt\n  pull --apply   porównuje świeży snapshot z receipt; przy różnicy zwraca diff i nie zapisuje JSON-a\n  push --plan    generuje manifest operacji MCP wymaganych w Asanie; opcjonalnie zapisuje receipt\n  push --apply   potwierdza w JSON-ie operacje już wykonane przez MCP i sprawdza niezmienność lokalnego planu\n\nKonfiguracja:\n  NAME jest prefiksem bez _TASK_CONTROL, np. PROJECT albo PROJECT_X.\n  --env jest wymagany i musi wskazywać sąsiedni plik NAME_TASK_CONTROL.env poza katalogiem narzędzia.\n  bind wymaga jednego stabilnego lokalnego ID w --task i istniejącego GID Asany w --gid; nie dopasowuje po tytule.\n  --task ogranicza pull lub push do jednego lub kilku stabilnych lokalnych ID albo GID Asany, rozdzielonych przecinkiem.\n  --plan-receipt jest opcjonalnym artefaktem --plan i wymaganym wejściem późniejszego bind/pull/push --apply.\n  --resolve json jest jawną decyzją operatora, że JSON wygrywa wcześniej wykryty konflikt kontrolowanej projekcji.\n  --section jest wymaganą, jawną nazwą źródłowej tablicy Asany dla importu.\n  --snapshot pochodzi z MCP Asany skonfigurowanego dla bieżącego agenta i leży poza katalogiem narzędzia.\n`);
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
  let receipt = null;
  if (options.apply && ['bind', 'pull', 'push'].includes(options.operation)) {
    receipt = JSON.parse(await readFile(options.planReceiptPath, 'utf8'));
  }
  const tasks = options.operation === 'import'
    ? null
    : options.operation === 'bind'
      ? [selectBindTask(state, options.taskSelector)]
      : options.operation === 'pull' && options.apply && Array.isArray(receipt?.tasks)
        ? receipt.tasks.flatMap((planned) => {
          const resolved = resolvePlannedPullTask(state, planned);
          return resolved.task ? [resolved.task] : [];
        })
        : selectTasks(state, options.taskSelector);
  if (options.apply && ['bind', 'pull', 'push'].includes(options.operation)) {
    receipt = await readPlanReceipt(options.planReceiptPath, statePath, options, tasks, receipt);
    assertApplySnapshotIsNewer(snapshot, receipt);
    const decisionRequiredDiff = planReceiptDiff(state, snapshot, options, tasks, receipt);
    if (decisionRequiredDiff.length > 0) {
      const report = {
        operation: options.operation,
        mode: 'apply',
        state_path: statePath,
        changed_json: false,
        blocked: true,
        reason: 'state_changed_after_plan',
        snapshot_captured_at: snapshot.captured_at,
        snapshot_max_age_seconds: SNAPSHOT_MAX_AGE_SECONDS,
        decision_required_diff: decisionRequiredDiff,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
  }
  const outcome = options.operation === 'bind'
    ? bind(state, snapshot, options.apply, tasks[0], options.remoteGid)
    : options.operation === 'pull'
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
    snapshot_captured_at: snapshot.captured_at,
    snapshot_max_age_seconds: SNAPSHOT_MAX_AGE_SECONDS,
    tasks: outcome.report,
  };
  if (outcome.import_scope) report.import_scope = outcome.import_scope;
  if (outcome.mcp_operations) report.mcp_operations = outcome.mcp_operations;
  if (!options.apply && options.planReceiptPath
    && (options.operation !== 'bind' || outcome.receipt_tasks?.length === 1)) {
    await writePlanReceipt(
      options.planReceiptPath, statePath, state, snapshot, options, outcome.receipt_tasks ?? [],
    );
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
