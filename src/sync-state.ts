import { createHash } from "node:crypto";

import type { BoardCard, IsoTimestamp, PrdStory } from "./adapters.js";
import type { RalphtaskConfig } from "./config.js";

export interface SyncStateStoryEntry {
  fingerprint: string;
}

export interface SyncStateCardEntry {
  cardId: string;
  lastActivityAt: IsoTimestamp;
}

export interface SyncState {
  version: 1;
  lastRunAt: IsoTimestamp;
  boardId: string;
  prdPath: string;
  mappingSignature: string;
  lastSeenTrelloActivity: IsoTimestamp;
  storyIndex: Record<string, SyncStateStoryEntry>;
  cardIndex: Record<string, SyncStateCardEntry>;
}

export interface SyncStateCardRecord {
  storyId: string;
  card: BoardCard;
}

const hashText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

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

export const createStoryFingerprint = (story: PrdStory): string => {
  const normalized = {
    id: story.id,
    title: story.title,
    status: story.status,
    description: story.description,
    dependsOn: [...story.dependsOn].sort((left, right) =>
      left.localeCompare(right),
    ),
    acceptanceCriteria: [...story.acceptanceCriteria],
  };
  return hashText(JSON.stringify(normalized));
};

export const createMappingSignature = (
  mapping: RalphtaskConfig["mapping"],
): string => {
  const normalized = {
    storyPrefix: mapping.storyPrefix,
    idPattern: mapping.idPattern,
    cardTitleFormat: mapping.cardTitleFormat,
    dependsOnLabelPrefix: mapping.dependsOnLabelPrefix,
    statusToList: {
      open: mapping.statusToList.open,
      in_progress: mapping.statusToList.in_progress,
      done: mapping.statusToList.done,
    },
    acceptanceCriteriaChecklistName: mapping.acceptanceCriteriaChecklistName,
  };
  return hashText(JSON.stringify(normalized));
};

const resolveLastSeenActivity = (
  cards: SyncStateCardRecord[],
  fallback?: IsoTimestamp,
): IsoTimestamp => {
  let latest = fallback ?? "";
  for (const record of cards) {
    if (
      latest === "" ||
      compareIsoTimestamps(record.card.lastActivityAt, latest) > 0
    ) {
      latest = record.card.lastActivityAt;
    }
  }
  return latest === "" ? new Date().toISOString() : latest;
};

export const createSyncState = (input: {
  boardId: string;
  prdPath: string;
  mapping: RalphtaskConfig["mapping"];
  stories: PrdStory[];
  cards: SyncStateCardRecord[];
  lastSeenTrelloActivity?: IsoTimestamp;
  lastRunAt?: IsoTimestamp;
}): SyncState => {
  const storyIndex: Record<string, SyncStateStoryEntry> = {};
  input.stories.forEach((story) => {
    storyIndex[story.id] = { fingerprint: createStoryFingerprint(story) };
  });

  const cardIndex: Record<string, SyncStateCardEntry> = {};
  input.cards.forEach((record) => {
    cardIndex[record.storyId] = {
      cardId: record.card.id,
      lastActivityAt: record.card.lastActivityAt,
    };
  });

  return {
    version: 1,
    lastRunAt: input.lastRunAt ?? new Date().toISOString(),
    boardId: input.boardId,
    prdPath: input.prdPath,
    mappingSignature: createMappingSignature(input.mapping),
    lastSeenTrelloActivity: resolveLastSeenActivity(
      input.cards,
      input.lastSeenTrelloActivity,
    ),
    storyIndex,
    cardIndex,
  };
};
