import type {
  BoardAdapter,
  BoardCard,
  BoardCardInput,
  BoardCardUpdate,
  BoardChecklist,
  BoardChecklistInput,
  BoardChecklistItemInput,
  BoardList,
  FormatAdapter,
  IsoTimestamp,
  PrdStory,
  StoryStatus,
} from "./adapters.js";
import type { ConflictPrefer, RalphtaskConfig, SyncDirection } from "./config.js";
import type { Logger } from "./logger.js";
import type { SyncState, SyncStateCardRecord } from "./sync-state.js";
import { createStoryFingerprint } from "./sync-state.js";
import { createStoryIdCodec } from "./story-id.js";

export interface SyncEngineAdapters {
  boardAdapter: BoardAdapter;
  formatAdapter: FormatAdapter;
}

export interface SyncPlanOptions {
  prdPath: string;
  mapping: RalphtaskConfig["mapping"];
  direction?: SyncDirection;
  incremental?: boolean;
  dryRun?: boolean;
  state?: SyncState | null;
  conflict?: Partial<RalphtaskConfig["conflict"]> & {
    prefer?: ConflictPrefer;
  };
  logger?: Logger;
}

export interface SyncCreateTrello {
  target: "trello";
  id: string;
  reason: string;
  story: PrdStory;
  cardInput: BoardCardInput;
  checklist: BoardChecklistInput;
}

export interface SyncCreatePrd {
  target: "prd";
  id: string;
  reason: string;
  story: PrdStory;
  card: BoardCard;
}

export type SyncCreate = SyncCreateTrello | SyncCreatePrd;

export interface SyncUpdateTrello {
  target: "trello";
  id: string;
  reason: string;
  story: PrdStory;
  card: BoardCard;
  cardUpdate: BoardCardUpdate;
  checklist: BoardChecklistInput;
  checklistNeedsUpdate: boolean;
  listMove?: SyncListMove;
}

export interface SyncUpdatePrd {
  target: "prd";
  id: string;
  reason: string;
  story: PrdStory;
  card: BoardCard;
}

export type SyncUpdate = SyncUpdateTrello | SyncUpdatePrd;

export interface SyncConflict {
  id?: string;
  reason: string;
  cards?: BoardCard[];
  story?: PrdStory;
}

export interface SyncListMove {
  fromId: string;
  toId: string;
  fromName?: string;
  toName?: string;
}

export interface SyncNoop {
  id: string;
  reason: string;
}

export interface SyncPlan {
  creates: SyncCreate[];
  updates: SyncUpdate[];
  conflicts: SyncConflict[];
  noop: SyncNoop[];
}

export interface SyncSnapshot {
  stories: PrdStory[];
  cards: SyncStateCardRecord[];
  lastSeenTrelloActivity: IsoTimestamp;
}

export interface SyncResultWithState {
  plan: SyncPlan;
  snapshot: SyncSnapshot;
}

interface CardRecord {
  card: BoardCard;
  storyId: string;
  storyTitle: string;
}

interface SyncContext {
  prdStories: PrdStory[];
  cardRecords: CardRecord[];
}

interface SyncApplyResult {
  updatedStories: PrdStory[];
  updatedCardsByStoryId: Map<string, BoardCard>;
  checklistTouchedCardIds: Set<string>;
}

interface StatusMappingResult {
  statusToListId: Map<StoryStatus, string>;
  listIdToStatus: Map<string, StoryStatus>;
  issues: string[];
}

interface ChecklistSelection {
  checklist?: BoardChecklist;
  issue?: string;
}

interface CardMappingResult {
  cardInput: BoardCardInput;
  cardUpdate: BoardCardUpdate;
  checklist: BoardChecklistInput;
  checklistNeedsUpdate: boolean;
  issues: string[];
  missingLabels: string[];
}

interface StoryMappingResult {
  story: PrdStory;
  issues: string[];
}

const sortStrings = (values: string[]): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const areArraysEqual = <T>(
  left: T[],
  right: T[],
  matcher: (leftItem: T, rightItem: T) => boolean = (leftItem, rightItem) =>
    leftItem === rightItem,
): boolean =>
  left.length === right.length &&
  left.every((value, index) => matcher(value, right[index]));

const areSetsEqual = (left: string[], right: string[]): boolean =>
  areArraysEqual(sortStrings(left), sortStrings(right));

const areChecklistItemsEqual = (
  left: BoardChecklistItemInput[],
  right: BoardChecklistItemInput[],
): boolean =>
  areArraysEqual(left, right, (leftItem, rightItem) =>
    leftItem.name === rightItem.name &&
    leftItem.checked === rightItem.checked);

const compareIsoTimestamps = (
  left: IsoTimestamp,
  right: IsoTimestamp,
): number => {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return 0;
  }
  return leftTime - rightTime;
};

const resolveLatestActivity = (
  records: SyncStateCardRecord[],
): IsoTimestamp => {
  let latest = "";
  for (const record of records) {
    if (
      latest === "" ||
      compareIsoTimestamps(record.card.lastActivityAt, latest) > 0
    ) {
      latest = record.card.lastActivityAt;
    }
  }
  return latest === "" ? new Date().toISOString() : latest;
};

const resolveConflictPrefer = (
  conflict: SyncPlanOptions["conflict"],
): ConflictPrefer => conflict?.prefer ?? conflict?.defaultPrefer ?? "none";

const resolveCreateMissingLabels = (
  conflict: SyncPlanOptions["conflict"],
): boolean => conflict?.createMissingLabels ?? true;

const resolveTimestampComparison = (
  comparison: number,
  prefer: ConflictPrefer,
): number => {
  if (comparison !== 0) {
    return comparison;
  }
  if (prefer === "prd") {
    return 1;
  }
  if (prefer === "trello") {
    return -1;
  }
  return 0;
};

const createStatusMapping = (
  lists: BoardList[],
  statusToList: RalphtaskConfig["mapping"]["statusToList"],
): StatusMappingResult => {
  const statusToListId = new Map<StoryStatus, string>();
  const listIdToStatus = new Map<string, StoryStatus>();
  const issues: string[] = [];
  const statusEntries: [StoryStatus, string][] = [
    ["open", statusToList.open],
    ["in_progress", statusToList.in_progress],
    ["done", statusToList.done],
  ];

  for (const [status, listName] of statusEntries) {
    const openMatches = lists.filter(
      (list) => list.name === listName && !list.closed,
    );
    const matches = openMatches.length > 0
      ? openMatches
      : lists.filter((list) => list.name === listName);
    if (matches.length === 0) {
      issues.push(`No Trello list found for status '${status}' (${listName})`);
      continue;
    }
    const chosen = sortStrings(matches.map((list) => list.id))[0];
    const chosenList = matches.find((list) => list.id === chosen);
    if (matches.length > 1) {
      issues.push(
        `Multiple Trello lists found for status '${status}' (${listName})`,
      );
    }
    if (chosenList) {
      statusToListId.set(status, chosenList.id);
      listIdToStatus.set(chosenList.id, status);
    }
  }

  return { statusToListId, listIdToStatus, issues };
};

const selectChecklist = (
  checklists: BoardChecklist[],
  name: string,
): ChecklistSelection => {
  const matches = checklists.filter((checklist) => checklist.name === name);
  if (matches.length > 1) {
    return {
      issue: `Multiple checklists named '${name}' found`,
    };
  }
  return { checklist: matches[0] };
};

const buildChecklistInput = (
  story: PrdStory,
  checklistName: string,
): BoardChecklistInput => ({
  name: checklistName,
  items: story.acceptanceCriteria.map((criteria) => ({
    name: criteria,
    checked: story.status === "done",
  })),
});

const resolveLabelIds = (
  story: PrdStory,
  mapping: RalphtaskConfig["mapping"],
  labelNameToId: Map<string, string>,
  labelIdToName: Map<string, string>,
  card?: BoardCard,
): { labelIds: string[]; missingLabels: string[] } => {
  const desiredLabelIds: string[] = [];
  const missingLabels = new Set<string>();
  for (const dependency of story.dependsOn) {
    const labelName = `${mapping.dependsOnLabelPrefix}${dependency}`;
    const labelId = labelNameToId.get(labelName);
    if (!labelId) {
      missingLabels.add(labelName);
    } else {
      desiredLabelIds.push(labelId);
    }
  }
  const keepLabelIds = card
    ? card.labelIds.filter((labelId) => {
        const labelName = labelIdToName.get(labelId);
        return !labelName || !labelName.startsWith(mapping.dependsOnLabelPrefix);
      })
    : [];
  const mergedLabelIds = sortStrings([...keepLabelIds, ...desiredLabelIds]);
  return { labelIds: mergedLabelIds, missingLabels: sortStrings([...missingLabels]) };
};

const buildCardMapping = (
  story: PrdStory,
  mapping: RalphtaskConfig["mapping"],
  statusMapping: StatusMappingResult,
  labelNameToId: Map<string, string>,
  labelIdToName: Map<string, string>,
  storyIdCodec = createStoryIdCodec({
    storyPrefix: mapping.storyPrefix,
    idPattern: mapping.idPattern,
    cardTitleFormat: mapping.cardTitleFormat,
  }),
  card?: BoardCard,
  checklists?: BoardChecklist[],
): CardMappingResult => {
  const issues: string[] = [];
  const listId = statusMapping.statusToListId.get(story.status);
  if (!listId) {
    issues.push(`No Trello list mapped for status '${story.status}'`);
  }

  const { labelIds: mergedLabelIds, missingLabels } = resolveLabelIds(
    story,
    mapping,
    labelNameToId,
    labelIdToName,
    card,
  );

  const cardInput: BoardCardInput = {
    name: storyIdCodec.formatCardTitle(story.id, story.title),
    description: story.description,
    listId: listId ?? "",
    labelIds: mergedLabelIds,
  };

  const cardUpdate: BoardCardUpdate = {};
  if (card) {
    if (card.name !== cardInput.name) {
      cardUpdate.name = cardInput.name;
    }
    if (card.description !== cardInput.description) {
      cardUpdate.description = cardInput.description;
    }
    if (listId && card.listId !== listId) {
      cardUpdate.listId = listId;
    }
    if (!areSetsEqual(card.labelIds, mergedLabelIds)) {
      cardUpdate.labelIds = mergedLabelIds;
    }
  }

  const checklist = buildChecklistInput(
    story,
    mapping.acceptanceCriteriaChecklistName,
  );
  let checklistNeedsUpdate = false;
  if (checklists) {
    const selection = selectChecklist(
      checklists,
      mapping.acceptanceCriteriaChecklistName,
    );
    if (selection.issue) {
      issues.push(selection.issue);
    } else {
      const existingItems = (selection.checklist?.items ?? []).map((item) => ({
        name: item.name,
        checked: item.checked,
      }));
      checklistNeedsUpdate = !areChecklistItemsEqual(
        existingItems,
        checklist.items,
      );
      if (
        existingItems.length === 0 &&
        checklist.items.length === 0 &&
        !selection.checklist
      ) {
        checklistNeedsUpdate = false;
      }
    }
  } else if (checklist.items.length > 0) {
    checklistNeedsUpdate = true;
  }

  return {
    cardInput,
    cardUpdate,
    checklist,
    checklistNeedsUpdate,
    issues,
    missingLabels,
  };
};

const buildStoryMapping = (
  record: CardRecord,
  mapping: RalphtaskConfig["mapping"],
  statusMapping: StatusMappingResult,
  labelIdToName: Map<string, string>,
  checklists?: BoardChecklist[],
): StoryMappingResult => {
  const issues: string[] = [];
  const status = statusMapping.listIdToStatus.get(record.card.listId);
  if (!status) {
    issues.push(
      `No PRD status mapped for Trello list '${record.card.listId}'`,
    );
  }
  const dependsOn = sortStrings([
    ...new Set(
      record.card.labelIds
      .map((labelId) => labelIdToName.get(labelId))
      .filter((name): name is string =>
        Boolean(name && name.startsWith(mapping.dependsOnLabelPrefix)),
      )
      .map((name) => name.slice(mapping.dependsOnLabelPrefix.length))
      .filter((name) => name.trim() !== ""),
    ),
  ]);

  let acceptanceCriteria: string[] = [];
  if (checklists) {
    const selection = selectChecklist(
      checklists,
      mapping.acceptanceCriteriaChecklistName,
    );
    if (selection.issue) {
      issues.push(selection.issue);
    } else {
      acceptanceCriteria = (selection.checklist?.items ?? []).map(
        (item) => item.name,
      );
    }
  }

  return {
    story: {
      id: record.storyId,
      title: record.storyTitle,
      status: status ?? "open",
      dependsOn,
      description: record.card.description,
      acceptanceCriteria,
    },
    issues,
  };
};

const hasUpdateFields = (update: BoardCardUpdate): boolean =>
  Object.keys(update).length > 0;

const storiesEquivalent = (left: PrdStory, right: PrdStory): boolean =>
  left.id === right.id &&
  left.title === right.title &&
  left.status === right.status &&
  left.description === right.description &&
  areSetsEqual(left.dependsOn, right.dependsOn) &&
  areArraysEqual(left.acceptanceCriteria, right.acceptanceCriteria);

export class SyncEngine {
  readonly boardAdapter: BoardAdapter;
  readonly formatAdapter: FormatAdapter;

  constructor(adapters: SyncEngineAdapters) {
    this.boardAdapter = adapters.boardAdapter;
    this.formatAdapter = adapters.formatAdapter;
  }

  async createPlan(options: SyncPlanOptions): Promise<SyncPlan> {
    const { plan } = await this.buildPlan(options);
    return plan;
  }

  async sync(options: SyncPlanOptions): Promise<SyncPlan> {
    const { plan, context } = await this.buildPlan(options);
    if (options.dryRun) {
      return plan;
    }
    if (options.conflict?.blockWrites && plan.conflicts.length > 0) {
      return plan;
    }
    await this.applyPlan(plan, context, options);
    return plan;
  }

  async syncWithState(options: SyncPlanOptions): Promise<SyncResultWithState> {
    const { plan, context } = await this.buildPlan(options);
    const shouldSkipApply =
      options.dryRun ||
      (options.conflict?.blockWrites && plan.conflicts.length > 0);
    if (shouldSkipApply) {
      const snapshot = await this.buildSnapshot(context, {
        updatedStories: context.prdStories,
        updatedCardsByStoryId: new Map(),
        checklistTouchedCardIds: new Set(),
      });
      return { plan, snapshot };
    }
    const applyResult = await this.applyPlan(plan, context, options);
    const snapshot = await this.buildSnapshot(context, applyResult);
    return { plan, snapshot };
  }

  private async buildPlan(
    options: SyncPlanOptions,
  ): Promise<{ plan: SyncPlan; context: SyncContext }> {
    const direction = options.direction ?? "two-way";
    const mapping = options.mapping;
    const storyIdCodec = createStoryIdCodec({
      storyPrefix: mapping.storyPrefix,
      idPattern: mapping.idPattern,
      cardTitleFormat: mapping.cardTitleFormat,
    });
    const conflictPrefer = resolveConflictPrefer(options.conflict);
    const createMissingLabels = resolveCreateMissingLabels(options.conflict);
    const incrementalState =
      options.state && options.incremental !== false ? options.state : null;
    const logger = options.logger;
    const logDecision = (
      id: string,
      action: string,
      details: Record<string, unknown> = {},
    ): void => {
      logger?.debug("Sync decision", { storyId: id, action, ...details });
    };
    const applyMissingLabelIssues = (mappingResult: CardMappingResult): void => {
      if (!createMissingLabels && mappingResult.missingLabels.length > 0) {
        mappingResult.issues.push(
          `Missing Trello labels: ${mappingResult.missingLabels.join(", ")}`,
        );
      }
    };

    const [prdResult, lists, cards, labels] = await Promise.all([
      this.formatAdapter.readStories(options.prdPath),
      this.boardAdapter.getLists(),
      this.boardAdapter.getCards(),
      this.boardAdapter.getLabels(),
    ]);

    const statusMapping = createStatusMapping(lists, mapping.statusToList);
    const listIdToName = new Map(lists.map((list) => [list.id, list.name]));
    const labelNameToId = new Map<string, string>();
    const labelIdToName = new Map<string, string>();
    labels.forEach((label) => {
      labelNameToId.set(label.name, label.id);
      labelIdToName.set(label.id, label.name);
    });

    const conflicts: SyncConflict[] = [];
    statusMapping.issues.forEach((issue) => {
      logger?.warn("Status mapping issue", { issue });
      conflicts.push({ reason: issue });
    });
    const prdById = new Map<string, PrdStory>();
    const storyFingerprints = new Map<string, string>();
    const duplicateStoryIds = new Set<string>();
    prdResult.stories.forEach((story) => {
      storyFingerprints.set(story.id, createStoryFingerprint(story));
      if (prdById.has(story.id)) {
        duplicateStoryIds.add(story.id);
        return;
      }
      prdById.set(story.id, story);
    });
    duplicateStoryIds.forEach((id) => {
      conflicts.push({
        id,
        reason: "Duplicate story ID in PRD stories",
      });
      logDecision(id, "conflict", {
        reason: "Duplicate story ID in PRD stories",
      });
    });

    const cardRecords: CardRecord[] = [];
    cards.forEach((card) => {
      const parsed = storyIdCodec.parseCardTitle(card.name);
      if (parsed.status !== "ok") {
        logger?.debug("Card title skipped", {
          cardId: card.id,
          reason: parsed.reason,
        });
        conflicts.push({
          reason: parsed.reason,
          cards: [card],
        });
        return;
      }
      cardRecords.push({
        card,
        storyId: parsed.id,
        storyTitle: parsed.title,
      });
    });

    const cardRecordsById = new Map<string, CardRecord[]>();
    cardRecords.forEach((record) => {
      const bucket = cardRecordsById.get(record.storyId) ?? [];
      bucket.push(record);
      cardRecordsById.set(record.storyId, bucket);
    });

    const conflictedIds = new Set<string>(duplicateStoryIds);
    const uniqueCardRecords: CardRecord[] = [];
    cardRecordsById.forEach((records, id) => {
      if (records.length > 1) {
        conflictedIds.add(id);
        conflicts.push({
          id,
          reason: "Duplicate story ID across Trello cards",
          cards: records.map((record) => record.card),
        });
        logDecision(id, "conflict", {
          reason: "Duplicate story ID across Trello cards",
        });
        return;
      }
      uniqueCardRecords.push(records[0]);
    });

    const isStoryUnchanged = (story: PrdStory): boolean => {
      if (!incrementalState) {
        return false;
      }
      const previous = incrementalState.storyIndex[story.id];
      if (!previous) {
        return false;
      }
      return previous.fingerprint === storyFingerprints.get(story.id);
    };

    const isCardUnchanged = (record: CardRecord): boolean => {
      if (!incrementalState) {
        return false;
      }
      const previous = incrementalState.cardIndex[record.storyId];
      if (!previous) {
        return false;
      }
      return (
        previous.cardId === record.card.id &&
        previous.lastActivityAt === record.card.lastActivityAt
      );
    };

    const checklistByCardId = new Map<string, BoardChecklist[]>();
    const checklistTargets = uniqueCardRecords.filter((record) => {
      const story = prdById.get(record.storyId);
      if (!story) {
        return direction !== "prd-to-trello";
      }
      if (!incrementalState) {
        return true;
      }
      const storyUnchanged = isStoryUnchanged(story);
      const cardUnchanged = isCardUnchanged(record);
      return !(storyUnchanged && cardUnchanged);
    });
    if (checklistTargets.length > 0) {
      const checklistResults = await Promise.all(
        checklistTargets.map((record) =>
          this.boardAdapter.getCardChecklists(record.card.id),
        ),
      );
      checklistTargets.forEach((record, index) => {
        checklistByCardId.set(record.card.id, checklistResults[index]);
      });
    }

    const plan: SyncPlan = {
      creates: [],
      updates: [],
      conflicts,
      noop: [],
    };

    const ids = new Set<string>([
      ...prdById.keys(),
      ...uniqueCardRecords.map((record) => record.storyId),
    ]);
    const sortedIds = sortStrings([...ids]);

    const recordById = new Map<string, CardRecord>();
    uniqueCardRecords.forEach((record) => {
      recordById.set(record.storyId, record);
    });

    const resolveListMove = (
      record: CardRecord,
      cardUpdate: BoardCardUpdate,
    ): SyncListMove | undefined => {
      if (!cardUpdate.listId) {
        return undefined;
      }
      return {
        fromId: record.card.listId,
        toId: cardUpdate.listId,
        fromName: listIdToName.get(record.card.listId),
        toName: listIdToName.get(cardUpdate.listId),
      };
    };

    for (const id of sortedIds) {
      if (conflictedIds.has(id)) {
        continue;
      }
      const story = prdById.get(id);
      const record = recordById.get(id);

      if (story && !record) {
        if (direction === "trello-to-prd") {
          plan.noop.push({ id, reason: "PRD-only story ignored" });
          logDecision(id, "noop", {
            reason: "PRD-only story ignored",
          });
          continue;
        }
        const mappingResult = buildCardMapping(
          story,
          mapping,
          statusMapping,
          labelNameToId,
          labelIdToName,
          storyIdCodec,
        );
        applyMissingLabelIssues(mappingResult);
        if (mappingResult.issues.length > 0) {
          plan.conflicts.push({
            id,
            story,
            reason: mappingResult.issues.join("; "),
          });
          logDecision(id, "conflict", {
            reason: mappingResult.issues.join("; "),
          });
          continue;
        }
        plan.creates.push({
          target: "trello",
          id,
          reason: "PRD story missing in Trello",
          story,
          cardInput: mappingResult.cardInput,
          checklist: mappingResult.checklist,
        });
        logDecision(id, "create", {
          target: "trello",
          reason: "PRD story missing in Trello",
        });
        continue;
      }

      if (!story && record) {
        if (direction === "prd-to-trello") {
          plan.noop.push({ id, reason: "Trello-only card ignored" });
          logDecision(id, "noop", {
            reason: "Trello-only card ignored",
          });
          continue;
        }
        const checklists = checklistByCardId.get(record.card.id);
        const mappingResult = buildStoryMapping(
          record,
          mapping,
          statusMapping,
          labelIdToName,
          checklists,
        );
        if (mappingResult.issues.length > 0) {
          plan.conflicts.push({
            id,
            reason: mappingResult.issues.join("; "),
            cards: [record.card],
          });
          logDecision(id, "conflict", {
            reason: mappingResult.issues.join("; "),
          });
          continue;
        }
        plan.creates.push({
          target: "prd",
          id,
          reason: "Trello card missing in PRD",
          story: mappingResult.story,
          card: record.card,
        });
        logDecision(id, "create", {
          target: "prd",
          reason: "Trello card missing in PRD",
        });
        continue;
      }

      if (!story || !record) {
        continue;
      }

      if (incrementalState) {
        const storyUnchanged = isStoryUnchanged(story);
        const cardUnchanged = isCardUnchanged(record);
        if (storyUnchanged && cardUnchanged) {
          plan.noop.push({ id, reason: "Unchanged since last sync" });
          logDecision(id, "noop", {
            reason: "Unchanged since last sync",
          });
          continue;
        }
      }

      const checklists = checklistByCardId.get(record.card.id);
      const cardMapping = buildCardMapping(
        story,
        mapping,
        statusMapping,
        labelNameToId,
        labelIdToName,
        storyIdCodec,
        record.card,
        checklists,
      );
      applyMissingLabelIssues(cardMapping);
      const storyMapping = buildStoryMapping(
        record,
        mapping,
        statusMapping,
        labelIdToName,
        checklists,
      );

      const shouldCreateMissingLabels =
        createMissingLabels && cardMapping.missingLabels.length > 0;
      if (shouldCreateMissingLabels && cardMapping.cardUpdate.labelIds === undefined) {
        cardMapping.cardUpdate.labelIds = cardMapping.cardInput.labelIds;
      }

      const canUpdateCard = cardMapping.issues.length === 0;
      const canUpdateStory = storyMapping.issues.length === 0;
      const needsCardUpdate =
        canUpdateCard &&
        (hasUpdateFields(cardMapping.cardUpdate) ||
          cardMapping.checklistNeedsUpdate ||
          shouldCreateMissingLabels);
      const needsStoryUpdate =
        canUpdateStory && !storiesEquivalent(story, storyMapping.story);

      if (!needsCardUpdate && !needsStoryUpdate) {
        plan.noop.push({ id, reason: "Story and card in sync" });
        logDecision(id, "noop", {
          reason: "Story and card in sync",
        });
        continue;
      }

      if (direction === "prd-to-trello") {
        if (!canUpdateCard) {
          plan.conflicts.push({
            id,
            story,
            reason: cardMapping.issues.join("; "),
          });
          logDecision(id, "conflict", {
            reason: cardMapping.issues.join("; "),
          });
        } else if (needsCardUpdate) {
          plan.updates.push({
            target: "trello",
            id,
            reason: "PRD update required",
            story,
            card: record.card,
            cardUpdate: cardMapping.cardUpdate,
            checklist: cardMapping.checklist,
            checklistNeedsUpdate: cardMapping.checklistNeedsUpdate,
            listMove: resolveListMove(record, cardMapping.cardUpdate),
          });
          logDecision(id, "update", {
            target: "trello",
            reason: "PRD update required",
          });
        } else {
          plan.noop.push({ id, reason: "No PRD-to-Trello change needed" });
          logDecision(id, "noop", {
            reason: "No PRD-to-Trello change needed",
          });
        }
        continue;
      }

      if (direction === "trello-to-prd") {
        if (!canUpdateStory) {
          plan.conflicts.push({
            id,
            reason: storyMapping.issues.join("; "),
            cards: [record.card],
          });
          logDecision(id, "conflict", {
            reason: storyMapping.issues.join("; "),
          });
        } else if (needsStoryUpdate) {
          plan.updates.push({
            target: "prd",
            id,
            reason: "Trello update required",
            story: storyMapping.story,
            card: record.card,
          });
          logDecision(id, "update", {
            target: "prd",
            reason: "Trello update required",
          });
        } else {
          plan.noop.push({ id, reason: "No Trello-to-PRD change needed" });
          logDecision(id, "noop", {
            reason: "No Trello-to-PRD change needed",
          });
        }
        continue;
      }

      if (needsCardUpdate && !needsStoryUpdate) {
        plan.updates.push({
          target: "trello",
          id,
          reason: "PRD update required",
          story,
          card: record.card,
          cardUpdate: cardMapping.cardUpdate,
          checklist: cardMapping.checklist,
          checklistNeedsUpdate: cardMapping.checklistNeedsUpdate,
          listMove: resolveListMove(record, cardMapping.cardUpdate),
        });
        logDecision(id, "update", {
          target: "trello",
          reason: "PRD update required",
        });
        continue;
      }

      if (needsStoryUpdate && !needsCardUpdate) {
        plan.updates.push({
          target: "prd",
          id,
          reason: "Trello update required",
          story: storyMapping.story,
          card: record.card,
        });
        logDecision(id, "update", {
          target: "prd",
          reason: "Trello update required",
        });
        continue;
      }

      const timestampComparison = compareIsoTimestamps(
        prdResult.lastModifiedAt,
        record.card.lastActivityAt,
      );
      const resolvedComparison = resolveTimestampComparison(
        timestampComparison,
        conflictPrefer,
      );
      if (resolvedComparison === 0) {
        plan.conflicts.push({
          id,
          reason: "PRD and Trello updates conflict (equal timestamps)",
          cards: [record.card],
          story,
        });
        logDecision(id, "conflict", {
          reason: "PRD and Trello updates conflict (equal timestamps)",
        });
        continue;
      }
      const preferPrd = resolvedComparison > 0;
      const reason = timestampComparison === 0
        ? preferPrd
          ? "PRD preferred over Trello (equal timestamps)"
          : "Trello preferred over PRD (equal timestamps)"
        : preferPrd
          ? "PRD newer than Trello"
          : "Trello newer than PRD";
      if (preferPrd) {
        if (!canUpdateCard) {
          plan.conflicts.push({
            id,
            story,
            reason: cardMapping.issues.join("; "),
          });
          logDecision(id, "conflict", {
            reason: cardMapping.issues.join("; "),
          });
        } else {
          plan.updates.push({
            target: "trello",
            id,
            reason,
            story,
            card: record.card,
            cardUpdate: cardMapping.cardUpdate,
            checklist: cardMapping.checklist,
            checklistNeedsUpdate: cardMapping.checklistNeedsUpdate,
            listMove: resolveListMove(record, cardMapping.cardUpdate),
          });
          logDecision(id, "update", {
            target: "trello",
            reason,
          });
        }
      } else if (!canUpdateStory) {
        plan.conflicts.push({
          id,
          reason: storyMapping.issues.join("; "),
          cards: [record.card],
        });
        logDecision(id, "conflict", {
          reason: storyMapping.issues.join("; "),
        });
      } else {
        plan.updates.push({
          target: "prd",
          id,
          reason,
          story: storyMapping.story,
          card: record.card,
        });
        logDecision(id, "update", {
          target: "prd",
          reason,
        });
      }
    }

    plan.creates.sort((left, right) => left.id.localeCompare(right.id));
    plan.updates.sort((left, right) => left.id.localeCompare(right.id));
    plan.noop.sort((left, right) => left.id.localeCompare(right.id));
    plan.conflicts.sort((left, right) =>
      (left.id ?? left.reason).localeCompare(right.id ?? right.reason),
    );
    logger?.info("Sync plan built", {
      creates: plan.creates.length,
      updates: plan.updates.length,
      conflicts: plan.conflicts.length,
      noop: plan.noop.length,
    });

    return {
      plan,
      context: {
        prdStories: prdResult.stories,
        cardRecords: uniqueCardRecords,
      },
    };
  }

  private async applyPlan(
    plan: SyncPlan,
    context: SyncContext,
    options: SyncPlanOptions,
  ): Promise<SyncApplyResult> {
    const trelloCreates = plan.creates.filter(
      (entry): entry is SyncCreateTrello => entry.target === "trello",
    );
    const trelloUpdates = plan.updates.filter(
      (entry): entry is SyncUpdateTrello => entry.target === "trello",
    );
    const prdCreates = plan.creates.filter(
      (entry): entry is SyncCreatePrd => entry.target === "prd",
    );
    const prdUpdates = plan.updates.filter(
      (entry): entry is SyncUpdatePrd => entry.target === "prd",
    );

    const createMissingLabels = resolveCreateMissingLabels(options.conflict);
    if (createMissingLabels && (trelloCreates.length > 0 || trelloUpdates.length > 0)) {
      const labels = await this.boardAdapter.getLabels();
      const labelNameToId = new Map<string, string>();
      const labelIdToName = new Map<string, string>();
      labels.forEach((label) => {
        labelNameToId.set(label.name, label.id);
        labelIdToName.set(label.id, label.name);
      });
      const desiredLabelNames = new Set<string>();
      const collectLabelNames = (story: PrdStory): void => {
        story.dependsOn.forEach((dependency) => {
          desiredLabelNames.add(`${options.mapping.dependsOnLabelPrefix}${dependency}`);
        });
      };
      trelloCreates.forEach((create) => collectLabelNames(create.story));
      trelloUpdates.forEach((update) => collectLabelNames(update.story));

      const missingLabelNames = sortStrings([...desiredLabelNames]).filter(
        (name) => !labelNameToId.has(name),
      );
      for (const labelName of missingLabelNames) {
        const created = await this.boardAdapter.createLabel({
          name: labelName,
          color: null,
        });
        labelNameToId.set(created.name, created.id);
        labelIdToName.set(created.id, created.name);
      }

      trelloCreates.forEach((create) => {
        const { labelIds } = resolveLabelIds(
          create.story,
          options.mapping,
          labelNameToId,
          labelIdToName,
        );
        create.cardInput.labelIds = labelIds;
      });

      trelloUpdates.forEach((update) => {
        const { labelIds } = resolveLabelIds(
          update.story,
          options.mapping,
          labelNameToId,
          labelIdToName,
          update.card,
        );
        if (!areSetsEqual(update.card.labelIds, labelIds)) {
          update.cardUpdate.labelIds = labelIds;
        }
      });
    }

    const updatedCardsByStoryId = new Map<string, BoardCard>();
    const checklistTouchedCardIds = new Set<string>();

    for (const create of trelloCreates) {
      const card = await this.boardAdapter.createCard(create.cardInput);
      updatedCardsByStoryId.set(create.id, card);
      if (create.checklist.items.length > 0) {
        await this.boardAdapter.upsertChecklist(card.id, create.checklist);
        checklistTouchedCardIds.add(card.id);
      }
    }

    for (const update of trelloUpdates) {
      if (hasUpdateFields(update.cardUpdate)) {
        const updated = await this.boardAdapter.updateCard(
          update.card.id,
          update.cardUpdate,
        );
        updatedCardsByStoryId.set(update.id, updated);
      }
      if (update.checklistNeedsUpdate) {
        await this.boardAdapter.upsertChecklist(
          update.card.id,
          update.checklist,
        );
        checklistTouchedCardIds.add(update.card.id);
      }
    }

    const prdChanges = [...prdCreates, ...prdUpdates];
    let updatedStories = context.prdStories;
    if (prdChanges.length > 0) {
      updatedStories = this.applyPrdChanges(
        context.prdStories,
        prdChanges,
      );
      await this.formatAdapter.writeStories(options.prdPath, updatedStories);
    }
    return {
      updatedStories,
      updatedCardsByStoryId,
      checklistTouchedCardIds,
    };
  }

  private async buildSnapshot(
    context: SyncContext,
    applyResult: SyncApplyResult,
  ): Promise<SyncSnapshot> {
    let cards: SyncStateCardRecord[] = context.cardRecords.map((record) => ({
      storyId: record.storyId,
      card: applyResult.updatedCardsByStoryId.get(record.storyId) ?? record.card,
    }));
    const existingStoryIds = new Set(cards.map((record) => record.storyId));
    applyResult.updatedCardsByStoryId.forEach((card, storyId) => {
      if (!existingStoryIds.has(storyId)) {
        cards.push({ storyId, card });
      }
    });

    if (applyResult.checklistTouchedCardIds.size > 0) {
      const refreshedCards = await this.boardAdapter.getCards();
      const refreshedById = new Map(
        refreshedCards.map((card) => [card.id, card]),
      );
      cards = cards.map((record) => ({
        storyId: record.storyId,
        card: refreshedById.get(record.card.id) ?? record.card,
      }));
    }

    return {
      stories: applyResult.updatedStories,
      cards,
      lastSeenTrelloActivity: resolveLatestActivity(cards),
    };
  }

  private applyPrdChanges(
    stories: PrdStory[],
    changes: Array<SyncCreatePrd | SyncUpdatePrd>,
  ): PrdStory[] {
    const updatedById = new Map<string, PrdStory>();
    const created = new Set<string>();
    const existingIds = new Set(stories.map((story) => story.id));
    changes.forEach((change) => {
      updatedById.set(change.story.id, change.story);
      if (!existingIds.has(change.story.id)) {
        created.add(change.story.id);
      }
    });

    const updatedStories = stories.map((story) =>
      updatedById.get(story.id) ?? story,
    );
    const createdStories = sortStrings([...created]).map(
      (id) => updatedById.get(id)!,
    );
    return [...updatedStories, ...createdStories];
  }
}
