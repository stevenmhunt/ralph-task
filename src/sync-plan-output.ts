import type {
  SyncConflict,
  SyncCreate,
  SyncCreatePrd,
  SyncCreateTrello,
  SyncListMove,
  SyncNoop,
  SyncPlan,
  SyncUpdate,
  SyncUpdatePrd,
  SyncUpdateTrello,
} from "./sync-engine.js";

export interface SyncPlanOutputOptions {
  includeConflicts?: boolean;
  includeNoop?: boolean;
}

const singleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const quote = (value: string): string => `"${singleLine(value)}"`;

const formatIdList = (values: string[]): string => values.join(", ");

const describeListMove = (move?: SyncListMove): string | null => {
  if (!move) {
    return null;
  }
  const from = move.fromName ?? move.fromId;
  const to = move.toName ?? move.toId;
  return `list move: ${from} -> ${to}`;
};

const describeLabelChange = (
  before: string[],
  after?: string[],
): string | null => {
  if (!after) {
    return null;
  }
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = [...afterSet].filter((id) => !beforeSet.has(id)).sort();
  const removed = [...beforeSet].filter((id) => !afterSet.has(id)).sort();
  if (added.length === 0 && removed.length === 0) {
    return "labels: updated";
  }
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added ${formatIdList(added)}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${formatIdList(removed)}`);
  }
  return `labels: ${parts.join("; ")}`;
};

const describeCreateTrello = (create: SyncCreateTrello): string => {
  const details = [
    `card: ${quote(create.cardInput.name)}`,
    `list: ${create.cardInput.listId}`,
  ];
  if (create.checklist.items.length > 0) {
    details.push(`checklist: ${create.checklist.items.length} items`);
  }
  return `[${create.id}] Trello create: ${details.join("; ")} (${create.reason})`;
};

const describeCreatePrd = (create: SyncCreatePrd): string =>
  `[${create.id}] PRD create: ${quote(create.story.title)} ` +
  `(status: ${create.story.status}) (${create.reason})`;

const describeUpdateTrello = (update: SyncUpdateTrello): string => {
  const parts: string[] = [];
  if (update.cardUpdate.name) {
    parts.push(
      `name: ${quote(update.card.name)} -> ${quote(update.cardUpdate.name)}`,
    );
  }
  if (update.cardUpdate.description) {
    parts.push(
      `description: ${quote(update.card.description)} -> ` +
        `${quote(update.cardUpdate.description)}`,
    );
  }
  const listMove = describeListMove(update.listMove);
  if (listMove) {
    parts.push(listMove);
  }
  const labelChange = describeLabelChange(
    update.card.labelIds,
    update.cardUpdate.labelIds,
  );
  if (labelChange) {
    parts.push(labelChange);
  }
  if (update.checklistNeedsUpdate) {
    parts.push(`checklist update: ${update.checklist.items.length} items`);
  }
  const details = parts.length > 0 ? parts.join("; ") : "card update";
  return `[${update.id}] Trello update: ${details} (${update.reason})`;
};

const describeUpdatePrd = (update: SyncUpdatePrd): string =>
  `[${update.id}] PRD update: ${quote(update.story.title)} ` +
  `(status: ${update.story.status}) (${update.reason})`;

const describeCreate = (create: SyncCreate): string =>
  create.target === "trello"
    ? describeCreateTrello(create)
    : describeCreatePrd(create);

const describeUpdate = (update: SyncUpdate): string =>
  update.target === "trello"
    ? describeUpdateTrello(update)
    : describeUpdatePrd(update);

const describeConflict = (conflict: SyncConflict): string => {
  if (conflict.id) {
    return `[${conflict.id}] Conflict: ${conflict.reason}`;
  }
  return `Conflict: ${conflict.reason}`;
};

const describeNoop = (noop: SyncNoop): string =>
  `[${noop.id}] No-op: ${noop.reason}`;

export const formatSyncPlan = (
  plan: SyncPlan,
  options: SyncPlanOutputOptions = {},
): string => {
  const includeConflicts = options.includeConflicts ?? true;
  const includeNoop = options.includeNoop ?? false;

  const lines: string[] = [];
  lines.push("Sync plan");
  lines.push(
    `Creates: ${plan.creates.length}, Updates: ${plan.updates.length}, ` +
      `Conflicts: ${plan.conflicts.length}, No-op: ${plan.noop.length}`,
  );

  if (plan.creates.length > 0) {
    lines.push("");
    lines.push("Creates");
    plan.creates.forEach((create) => {
      lines.push(`- ${describeCreate(create)}`);
    });
  }

  if (plan.updates.length > 0) {
    lines.push("");
    lines.push("Updates");
    plan.updates.forEach((update) => {
      lines.push(`- ${describeUpdate(update)}`);
    });
  }

  if (includeConflicts && plan.conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts");
    plan.conflicts.forEach((conflict) => {
      lines.push(`- ${describeConflict(conflict)}`);
    });
  }

  if (includeNoop && plan.noop.length > 0) {
    lines.push("");
    lines.push("No-op");
    plan.noop.forEach((noop) => {
      lines.push(`- ${describeNoop(noop)}`);
    });
  }

  return `${lines.join("\n")}\n`;
};
