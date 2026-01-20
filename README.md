# ralph-task

Synchronize a Trello board with a Ralph PRD `stories[]` array using a
deterministic two-way sync engine.

## Install

CLI (global):
```
npm install -g ralph-task
```

Library or local CLI usage:
```
npm install ralph-task
npx ralph-task sync --help
```

## Configuration (.ralphtask.json)

The CLI defaults to `.ralphtask.json`. Use `--config <path>` to override. Paths
inside the file are resolved relative to the config file location.

Example:
```json
{
  "version": 1,
  "paths": {
    "prdFile": ".agents/tasks/ralph-task-prd.json",
    "stateFile": ".ralph-task/state.json"
  },
  "trello": {
    "apiKey": "YOUR_KEY",
    "token": "YOUR_TOKEN",
    "boardId": "YOUR_BOARD_ID"
  },
  "mapping": {
    "storyPrefix": "US",
    "idPattern": "{prefix}-{number:3}",
    "cardTitleFormat": "[{id}] {title}",
    "dependsOnLabelPrefix": "s:",
    "statusToList": {
      "open": "To Do",
      "in_progress": "In Progress",
      "done": "Done"
    },
    "acceptanceCriteriaChecklistName": "Acceptance Criteria"
  },
  "sync": {
    "direction": "two-way",
    "incremental": true,
    "dryRun": false,
    "maxConcurrency": 4,
    "retry": {
      "maxRetries": 5,
      "baseDelayMs": 500
    }
  },
  "conflict": {
    "strategy": "last-write-wins",
    "defaultPrefer": "none",
    "blockWrites": false,
    "createMissingLabels": true
  },
  "logging": {
    "level": "info",
    "format": "text"
  }
}
```

Key fields:
- `paths.prdFile` (required): Ralph PRD JSON containing `stories[]`.
- `paths.stateFile` (optional): incremental sync state (default
  `.ralph-task/state.json`).
- `trello.*` (required): API credentials and target board ID.
- `mapping`: story ID format, card title format, label prefixes, and list names
  for status mapping.
- `sync.direction`: `two-way`, `trello-to-prd`, or `prd-to-trello`.
- `sync.dryRun`: if true, prints the plan and makes no writes.
- `conflict.defaultPrefer`: preference on equal timestamps (`none`, `trello`,
  `prd`).
- `conflict.createMissingLabels`: create missing dependency labels in Trello
  (default `true`).
- `logging.format`: `text` (human) or `json` (automation).

## Sync workflow

1) Run `ralph-task sync` (optionally `--config <path>` and `--prefer trello|prd`).
2) The config is loaded and validated, then the PRD stories and Trello board
   lists/cards/labels/checklists are read.
3) A sync plan is generated (creates, updates, conflicts, no-ops).
4) If `sync.dryRun` is true, the plan is printed and no writes happen.
5) Otherwise, Trello and PRD updates are applied and the state file is updated
   (when `sync.incremental` is enabled).

Output is human-readable by default. Set `logging.format` to `json` for
machine-readable plans.

## Extension points

Ralphtask exposes adapter interfaces so new boards or PRD formats can be added
without changing the sync engine. See `src/adapters.ts` for the full contracts.

`FormatAdapter` responsibilities:
- `readStories(path)` returns `{ stories, lastModifiedAt }` where
  `lastModifiedAt` is an ISO timestamp for conflict resolution.
- `writeStories(path, stories)` persists updates while preserving non-story PRD
  fields (the shipped Ralph adapter only mutates `stories[]`).

`BoardAdapter` responsibilities:
- Read: `getBoardInfo`, `getLists`, `getCards`, `getLabels`,
  `getCardChecklists`.
- Write: `createCard`, `updateCard`, `upsertChecklist`,
  `setChecklistItemState`, `createLabel`.
- Provide ISO timestamps (`lastActivityAt`) for conflict resolution.

Programmatic usage:
```ts
import {
  SyncEngine,
  RalphPrdFormatAdapter,
  TrelloBoardAdapter,
} from "ralph-task";

const engine = new SyncEngine({
  boardAdapter: new TrelloBoardAdapter({ apiKey, token, boardId, retry }),
  formatAdapter: new RalphPrdFormatAdapter(),
});
```

## Non-goals

- Syncing non-story PRD fields (overview, stack, routes, etc.)
- Supporting Jira or other task boards in v1
- Field-level merge resolution within a story
- Any graphical user interface

## Design intent and tests

Ralphtask keeps sync deterministic by scoping to story-level data and by
requiring adapters to provide stable IDs and timestamps. The core tests cover
story ID parsing, mapping behavior, and conflict resolution to reinforce that
intent. Run `npm test` after adapter changes to validate behavior.
