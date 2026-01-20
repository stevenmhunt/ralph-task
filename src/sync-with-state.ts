import type { SyncPlan, SyncPlanOptions } from "./sync-engine.js";
import { SyncEngine } from "./sync-engine.js";
import {
  createMappingSignature,
  createSyncState,
  type SyncState,
} from "./sync-state.js";
import { loadSyncState, saveSyncState } from "./sync-state-store.js";

export interface SyncWithStateFileOptions extends SyncPlanOptions {
  statePath: string;
  boardId: string;
  incremental?: boolean;
  warn?: (message: string) => void;
}

export interface SyncWithStateFileResult {
  plan: SyncPlan;
  state: SyncState;
}

export const syncWithStateFile = async (
  engine: SyncEngine,
  options: SyncWithStateFileOptions,
): Promise<SyncWithStateFileResult> => {
  const {
    statePath,
    boardId,
    warn,
    incremental,
    ...syncOptions
  } = options;
  const shouldUseIncremental = incremental ?? true;
  const mappingSignature = createMappingSignature(syncOptions.mapping);
  const logger = options.logger;

  const priorState = shouldUseIncremental
    ? await loadSyncState(statePath, {
        boardId,
        prdPath: syncOptions.prdPath,
        mappingSignature,
        warn,
        logger,
      })
    : null;

  const { plan, snapshot } = await engine.syncWithState({
    ...syncOptions,
    incremental: shouldUseIncremental,
    state: priorState ?? undefined,
  });

  const nextState = createSyncState({
    boardId,
    prdPath: syncOptions.prdPath,
    mapping: syncOptions.mapping,
    stories: snapshot.stories,
    cards: snapshot.cards,
    lastSeenTrelloActivity: snapshot.lastSeenTrelloActivity,
  });

  if (!syncOptions.dryRun) {
    await saveSyncState(statePath, nextState);
  }

  return { plan, state: nextState };
};
