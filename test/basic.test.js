import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import {
  createLogger,
  createStoryIdCodec,
  formatStoryId,
  formatSyncPlan,
  loadRalphtaskConfig,
  parseStoryIdFromCardTitle,
  RalphPrdFormatAdapter,
  TrelloBoardAdapter,
  SyncEngine,
  syncWithStateFile,
} from "../dist/index.js";

const originalFetch = globalThis.fetch;

const createJsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const withTempDir = async (callback) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ralph-task-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const createCaptureStream = () => {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, getOutput: () => chunks.join("") };
};

const mapping = {
  storyPrefix: "US",
  idPattern: "{prefix}-{number:3}",
  cardTitleFormat: "[{id}] {title}",
  dependsOnLabelPrefix: "s:",
  statusToList: {
    open: "To Do",
    in_progress: "In Progress",
    done: "Done",
  },
  acceptanceCriteriaChecklistName: "Acceptance Criteria",
};

describe("loadRalphtaskConfig", () => {
  it("loads config from an explicit path and applies defaults", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, ".ralphtask.json");
      const config = {
        paths: {
          prdFile: "prd.json",
        },
        trello: {
          apiKey: "key",
          token: "token",
          boardId: "board",
        },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const result = await loadRalphtaskConfig(configPath);
      assert.equal(result.paths.prdFile, "prd.json");
      assert.equal(result.paths.stateFile, ".ralph-task/state.json");
      assert.equal(result.mapping.storyPrefix, "US");
      assert.equal(result.sync.direction, "two-way");
      assert.equal(result.trello.boardId, "board");
      assert.equal(result.conflict.createMissingLabels, true);
    });
  });

  it("defaults to .ralphtask.json when no path is provided", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, ".ralphtask.json");
      const config = {
        paths: {
          prdFile: "prd.json",
        },
        trello: {
          apiKey: "key",
          token: "token",
          boardId: "board",
        },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const result = await loadRalphtaskConfig(undefined, { cwd: dir });
      assert.equal(result.paths.prdFile, "prd.json");
    });
  });

  it("throws a clear error when Trello credentials are missing", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, ".ralphtask.json");
      const config = {
        paths: {
          prdFile: "prd.json",
        },
        trello: {
          boardId: "board",
        },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2));

      await assert.rejects(
        () => loadRalphtaskConfig(configPath),
        /Missing required Trello credentials/,
      );
    });
  });
});

describe("createLogger", () => {
  it("emits JSON entries with data when enabled", () => {
    const { stream, getOutput } = createCaptureStream();
    const logger = createLogger({
      level: "debug",
      format: "json",
      output: stream,
      errorOutput: stream,
      time: () => "2026-01-20T00:00:00Z",
    });

    logger.info("Sync plan built", { creates: 1 });

    const output = getOutput().trim().split("\n");
    assert.equal(output.length, 1);
    const parsed = JSON.parse(output[0]);
    assert.equal(parsed.level, "info");
    assert.equal(parsed.message, "Sync plan built");
    assert.equal(parsed.timestamp, "2026-01-20T00:00:00Z");
    assert.deepEqual(parsed.data, { creates: 1 });
  });

  it("suppresses non-fatal output in silent mode", () => {
    const { stream, getOutput } = createCaptureStream();
    const logger = createLogger({
      level: "silent",
      format: "text",
      output: stream,
      errorOutput: stream,
      time: () => "2026-01-20T00:00:00Z",
    });

    logger.info("Ignored");
    logger.warn("Ignored");
    logger.error("Keep");

    const output = getOutput().trim().split("\n").filter(Boolean);
    assert.equal(output.length, 1);
    assert.match(output[0], /ERROR Keep/);
  });
});

describe("RalphPrdFormatAdapter", () => {
  it("reads stories and returns lastModifiedAt", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      const prd = {
        project: "ralph-task",
        stories: [
          {
            id: "US-001",
            title: "Story One",
            status: "open",
            dependsOn: [],
            description: "Description",
            acceptanceCriteria: ["Criteria A"],
            startedAt: "2026-01-20T00:00:00Z",
          },
        ],
      };
      await writeFile(prdPath, JSON.stringify(prd, null, 2));

      const adapter = new RalphPrdFormatAdapter();
      const result = await adapter.readStories(prdPath);

      assert.equal(result.stories.length, 1);
      assert.equal(result.stories[0].id, "US-001");
      assert.equal(result.stories[0].status, "open");
      assert.ok(!Number.isNaN(Date.parse(result.lastModifiedAt)));
    });
  });

  it("writes stories while preserving other fields", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      const prd = {
        version: 1,
        project: "ralph-task",
        meta: {
          owner: "ralph",
        },
        stories: [
          {
            id: "US-001",
            title: "Story One",
            status: "open",
            dependsOn: [],
            description: "Description",
            acceptanceCriteria: ["Criteria A"],
            startedAt: "2026-01-20T00:00:00Z",
          },
        ],
      };
      await writeFile(prdPath, JSON.stringify(prd, null, 2));

      const adapter = new RalphPrdFormatAdapter();
      const stories = [
        {
          id: "US-001",
          title: "Story One Updated",
          status: "done",
          dependsOn: ["US-000"],
          description: "Updated description",
          acceptanceCriteria: ["Criteria A", "Criteria B"],
        },
        {
          id: "US-002",
          title: "Story Two",
          status: "open",
          dependsOn: [],
          description: "Second story",
          acceptanceCriteria: [],
        },
      ];

      await adapter.writeStories(prdPath, stories);

      const updated = JSON.parse(await readFile(prdPath, "utf8"));
      assert.equal(updated.project, "ralph-task");
      assert.deepEqual(updated.meta, { owner: "ralph" });
      assert.equal(updated.stories.length, 2);
      const updatedStory = updated.stories.find((story) => story.id === "US-001");
      assert.ok(updatedStory);
      assert.equal(updatedStory.title, "Story One Updated");
      assert.equal(updatedStory.startedAt, "2026-01-20T00:00:00Z");
    });
  });

  it("throws on invalid PRD JSON", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      await writeFile(prdPath, "{ invalid");

      const adapter = new RalphPrdFormatAdapter();

      await assert.rejects(
        adapter.readStories(prdPath),
        /Invalid JSON in PRD/,
      );
    });
  });
});

describe("TrelloBoardAdapter", () => {
  it("fetches lists with Trello mapping", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return createJsonResponse([
        { id: "list-1", name: "To Do", closed: false },
      ]);
    };

    const adapter = new TrelloBoardAdapter({
      apiKey: "key",
      token: "token",
      boardId: "board",
      baseUrl: "https://api.trello.com/1",
    });

    const lists = await adapter.getLists();

    assert.equal(lists.length, 1);
    assert.equal(lists[0].id, "list-1");
    assert.equal(lists[0].name, "To Do");

    const url = new URL(calls[0].input);
    assert.equal(url.pathname, "/1/boards/board/lists");
    assert.equal(url.searchParams.get("fields"), "id,name,closed");
    assert.equal(url.searchParams.get("filter"), "all");
    assert.equal(url.searchParams.get("key"), "key");
    assert.equal(url.searchParams.get("token"), "token");
    assert.equal(calls[0].init?.method, "GET");
  });

  it("creates Acceptance Criteria checklists with items", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });

      if (calls.length === 1) {
        return createJsonResponse([]);
      }
      if (calls.length === 2) {
        return createJsonResponse({
          id: "checklist-1",
          name: "Acceptance Criteria",
          checkItems: [],
        });
      }
      if (calls.length === 3) {
        return createJsonResponse({
          id: "item-1",
          name: "First criterion",
          state: "incomplete",
        });
      }
      if (calls.length === 4) {
        return createJsonResponse({
          id: "item-2",
          name: "Second criterion",
          state: "complete",
        });
      }
      throw new Error("Unexpected fetch call");
    };

    const adapter = new TrelloBoardAdapter({
      apiKey: "key",
      token: "token",
      boardId: "board",
      baseUrl: "https://api.trello.com/1",
    });

    const checklist = await adapter.upsertChecklist("card-1", {
      name: "Acceptance Criteria",
      items: [
        { name: "First criterion", checked: false },
        { name: "Second criterion", checked: true },
      ],
    });

    assert.equal(checklist.id, "checklist-1");
    assert.equal(checklist.items.length, 2);
    assert.equal(checklist.items[0].name, "First criterion");
    assert.equal(checklist.items[0].checked, false);
    assert.equal(checklist.items[1].checked, true);

    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[1].init?.method, "POST");
    assert.equal(calls[2].init?.method, "POST");
  });

  it("fails fast when Trello token is invalid", async () => {
    globalThis.fetch = async () =>
      new Response("unauthorized", { status: 401 });

    const adapter = new TrelloBoardAdapter({
      apiKey: "key",
      token: "bad-token",
      boardId: "board",
      baseUrl: "https://api.trello.com/1",
    });

    await assert.rejects(
      () => adapter.getBoardInfo(),
      /Invalid Trello token/,
    );
  });

  it("retries on rate limits and transient errors", async () => {
    const delays = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      delays.push(delay);
      return originalSetTimeout(callback, 0, ...args);
    };

    let attempt = 0;
    globalThis.fetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("rate limit", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      if (attempt === 2) {
        return new Response("bad gateway", { status: 502 });
      }
      return createJsonResponse({
        id: "board",
        name: "Board",
        dateLastActivity: "2026-01-20T00:00:00.000Z",
      });
    };

    const adapter = new TrelloBoardAdapter({
      apiKey: "key",
      token: "token",
      boardId: "board",
      baseUrl: "https://api.trello.com/1",
      retry: { maxRetries: 3, baseDelayMs: 10 },
    });

    try {
      const board = await adapter.getBoardInfo();
      assert.equal(board.id, "board");
      assert.equal(attempt, 3);
      assert.equal(delays.length, 2);
      assert.ok(delays[0] >= 1000);
      assert.equal(delays[1], 20);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("throws a clear error after retry limits are exceeded", async () => {
    let attempt = 0;
    globalThis.fetch = async () => {
      attempt += 1;
      return new Response("service unavailable", { status: 503 });
    };

    const adapter = new TrelloBoardAdapter({
      apiKey: "key",
      token: "token",
      boardId: "board",
      baseUrl: "https://api.trello.com/1",
      retry: { maxRetries: 2, baseDelayMs: 1 },
    });

    await assert.rejects(
      () => adapter.getBoardInfo(),
      /after 2 retries/,
    );
    assert.equal(attempt, 3);
  });
});

describe("story ID parsing and formatting", () => {
  const mapping = {
    storyPrefix: "US",
    idPattern: "{prefix}-{number:3}",
    cardTitleFormat: "[{id}] {title}",
  };

  it("formats and parses canonical story IDs", () => {
    assert.equal(formatStoryId(7, mapping), "US-007");

    const result = parseStoryIdFromCardTitle("[US-007] Title", mapping);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.id, "US-007");
      assert.equal(result.title, "Title");
    }
  });

  it("supports configurable prefix and padding", () => {
    const customMapping = {
      storyPrefix: "RFC",
      idPattern: "{prefix}-{number:2}",
      cardTitleFormat: "[{id}] {title}",
    };
    const codec = createStoryIdCodec(customMapping);
    assert.equal(codec.formatId(4), "RFC-04");

    const parsed = codec.parseCardTitle("[RFC-04] Review");
    assert.equal(parsed.status, "ok");
    if (parsed.status === "ok") {
      assert.equal(parsed.id, "RFC-04");
      assert.equal(parsed.title, "Review");
    }
  });

  it("reports missing IDs", () => {
    const result = parseStoryIdFromCardTitle("Title only", mapping);
    assert.equal(result.status, "missing");
  });

  it("reports ambiguous IDs", () => {
    const result = parseStoryIdFromCardTitle(
      "[US-001] Title with US-002",
      mapping,
    );
    assert.equal(result.status, "ambiguous");
    if (result.status === "ambiguous") {
      assert.deepEqual(result.matches, ["US-001", "US-002"]);
    }
  });
});

describe("SyncEngine", () => {
  it("plans PRD edits to update Trello", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-007",
            title: "New Title",
            status: "open",
            dependsOn: [],
            description: "Updated description",
            acceptanceCriteria: ["First criterion"],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-007] Old Title",
          description: "Old description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [
        {
          id: "checklist-1",
          name: "Acceptance Criteria",
          items: [
            { id: "item-1", name: "Old criterion", checked: false },
          ],
        },
      ],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
    });

    assert.equal(plan.updates.length, 1);
    const update = plan.updates[0];
    assert.equal(update.target, "trello");
    if (update.target === "trello") {
      assert.equal(update.cardUpdate.name, "[US-007] New Title");
      assert.equal(update.cardUpdate.description, "Updated description");
      assert.equal(update.checklistNeedsUpdate, true);
    }
  });

  it("maps status and dependency labels into Trello updates", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-003",
            title: "Story Three",
            status: "done",
            dependsOn: ["US-001", "US-002"],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-003] Old Title",
          description: "Old description",
          listId: "list-open",
          labelIds: ["label-keep", "label-old-dep"],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
      ],
      getLabels: async () => [
        { id: "label-001", name: "s:US-001" },
        { id: "label-002", name: "s:US-002" },
        { id: "label-old-dep", name: "s:US-999" },
        { id: "label-keep", name: "priority" },
      ],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "prd-to-trello",
    });

    assert.equal(plan.updates.length, 1);
    const update = plan.updates[0];
    assert.equal(update.target, "trello");
    if (update.target === "trello") {
      assert.equal(update.cardUpdate.listId, "list-done");
      assert.equal(update.cardUpdate.name, "[US-003] Story Three");
      assert.deepEqual(update.cardUpdate.labelIds, [
        "label-001",
        "label-002",
        "label-keep",
      ]);
    }
  });

  it("creates missing Trello labels when configured", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-010",
            title: "Story Ten",
            status: "open",
            dependsOn: ["US-001"],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const createdLabels = [];
    let updatedLabels = [];
    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-010] Story Ten",
          description: "PRD description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
      createLabel: async (input) => {
        createdLabels.push(input);
        return { id: "label-001", name: input.name, color: null };
      },
      createCard: async () => {
        throw new Error("Unexpected createCard call");
      },
      updateCard: async (_cardId, update) => {
        updatedLabels = update.labelIds ?? [];
        return {
          id: "card-1",
          name: "[US-010] Story Ten",
          description: "PRD description",
          listId: "list-open",
          labelIds: update.labelIds ?? [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        };
      },
      upsertChecklist: async () => {
        throw new Error("Unexpected upsertChecklist call");
      },
      setChecklistItemState: async () => {
        throw new Error("Unexpected setChecklistItemState call");
      },
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.sync({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
      conflict: {
        createMissingLabels: true,
      },
    });

    assert.equal(plan.conflicts.length, 0);
    assert.deepEqual(createdLabels, [{ name: "s:US-001", color: null }]);
    assert.deepEqual(updatedLabels, ["label-001"]);
  });

  it("flags missing labels as conflicts when auto-create is disabled", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-011",
            title: "Story Eleven",
            status: "open",
            dependsOn: ["US-004"],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [],
      getLabels: async () => [],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "prd-to-trello",
      conflict: {
        createMissingLabels: false,
      },
    });

    assert.equal(plan.conflicts.length, 1);
    assert.match(plan.conflicts[0].reason, /Missing Trello labels/);
  });

  it("uses last-write-wins when both sides changed", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-009",
            title: "PRD Title",
            status: "open",
            dependsOn: [],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-21T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-009] Trello Title",
          description: "Trello description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
    });

    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0].target, "trello");
    assert.equal(plan.updates[0].reason, "PRD newer than Trello");
  });

  it("prefers PRD on equal timestamps when configured", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-001",
            title: "PRD Title",
            status: "open",
            dependsOn: [],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-001] Trello Title",
          description: "Trello description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
      conflict: {
        prefer: "prd",
      },
    });

    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0].target, "trello");
  });

  it("prefers Trello on equal timestamps when configured", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-001",
            title: "PRD Title",
            status: "open",
            dependsOn: [],
            description: "PRD description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-001] Trello Title",
          description: "Trello description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
      conflict: {
        prefer: "trello",
      },
    });

    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0].target, "prd");
  });

  it("blocks writes when conflicts exist and blockWrites is set", async () => {
    let updateCardCalls = 0;
    let writeStoriesCalls = 0;
    const formatAdapter = {
      readStories: async () => ({
        stories: [
          {
            id: "US-001",
            title: "PRD Title",
            status: "open",
            dependsOn: [],
            description: "PRD description",
            acceptanceCriteria: [],
          },
          {
            id: "US-002",
            title: "PRD Two",
            status: "open",
            dependsOn: [],
            description: "PRD two description",
            acceptanceCriteria: [],
          },
        ],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {
        writeStoriesCalls += 1;
      },
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-001] Trello Title",
          description: "Trello description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        },
        {
          id: "card-2",
          name: "[US-002] Old Title",
          description: "Old description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
      createCard: async () => {
        throw new Error("Unexpected createCard call");
      },
      updateCard: async () => {
        updateCardCalls += 1;
        return {
          id: "card-2",
          name: "[US-002] PRD Two",
          description: "PRD two description",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-20T00:00:00Z",
        };
      },
      upsertChecklist: async () => {
        throw new Error("Unexpected upsertChecklist call");
      },
      setChecklistItemState: async () => {
        throw new Error("Unexpected setChecklistItemState call");
      },
      getBoardInfo: async () => ({
        id: "board",
        name: "Board",
        lastActivityAt: "2026-01-20T00:00:00Z",
      }),
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.sync({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
      conflict: {
        blockWrites: true,
      },
    });

    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.updates.length, 1);
    assert.equal(updateCardCalls, 0);
    assert.equal(writeStoriesCalls, 0);
  });

  it("flags duplicate story IDs across cards as conflicts", async () => {
    const formatAdapter = {
      readStories: async () => ({
        stories: [],
        lastModifiedAt: "2026-01-20T00:00:00Z",
      }),
      writeStories: async () => {},
    };

    const boardAdapter = {
      getLists: async () => [
        { id: "list-open", name: "To Do", closed: false },
        { id: "list-progress", name: "In Progress", closed: false },
        { id: "list-done", name: "Done", closed: false },
      ],
      getCards: async () => [
        {
          id: "card-1",
          name: "[US-001] First",
          description: "",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
        {
          id: "card-2",
          name: "[US-001] Second",
          description: "",
          listId: "list-open",
          labelIds: [],
          closed: false,
          lastActivityAt: "2026-01-19T00:00:00Z",
        },
      ],
      getLabels: async () => [],
      getCardChecklists: async () => [],
    };

    const engine = new SyncEngine({ boardAdapter, formatAdapter });
    const plan = await engine.createPlan({
      prdPath: "prd.json",
      mapping,
      direction: "two-way",
    });

    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].id, "US-001");
    assert.match(
      plan.conflicts[0].reason,
      /Duplicate story ID across Trello cards/,
    );
  });
});

describe("Incremental sync state", () => {
  it("persists state and skips unchanged cards on subsequent runs", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      const statePath = path.join(dir, "state.json");
      const prd = {
        project: "ralph-task",
        stories: [
          {
            id: "US-001",
            title: "Story One",
            status: "open",
            dependsOn: [],
            description: "Description",
            acceptanceCriteria: ["Criteria A"],
          },
        ],
      };
      await writeFile(prdPath, JSON.stringify(prd, null, 2));

      let checklistCalls = 0;
      const boardAdapter = {
        getLists: async () => [
          { id: "list-open", name: "To Do", closed: false },
          { id: "list-progress", name: "In Progress", closed: false },
          { id: "list-done", name: "Done", closed: false },
        ],
        getCards: async () => [
          {
            id: "card-1",
            name: "[US-001] Story One",
            description: "Description",
            listId: "list-open",
            labelIds: [],
            closed: false,
            lastActivityAt: "2026-01-20T00:00:00Z",
          },
        ],
        getLabels: async () => [],
        getCardChecklists: async () => {
          checklistCalls += 1;
          return [
            {
              id: "checklist-1",
              name: "Acceptance Criteria",
              items: [
                { id: "item-1", name: "Criteria A", checked: false },
              ],
            },
          ];
        },
        createCard: async () => {
          throw new Error("Unexpected createCard call");
        },
        updateCard: async () => {
          throw new Error("Unexpected updateCard call");
        },
        upsertChecklist: async () => {
          throw new Error("Unexpected upsertChecklist call");
        },
        setChecklistItemState: async () => {
          throw new Error("Unexpected setChecklistItemState call");
        },
      };

      const engine = new SyncEngine({
        boardAdapter,
        formatAdapter: new RalphPrdFormatAdapter(),
      });

      const first = await syncWithStateFile(engine, {
        prdPath,
        statePath,
        boardId: "board",
        mapping,
        direction: "two-way",
      });

      assert.equal(first.plan.creates.length, 0);
      assert.equal(first.plan.updates.length, 0);
      assert.equal(first.plan.conflicts.length, 0);
      assert.equal(first.plan.noop.length, 1);
      assert.ok(checklistCalls > 0);

      const savedState = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(savedState.boardId, "board");
      assert.ok(savedState.storyIndex["US-001"]);

      const previousChecklistCalls = checklistCalls;
      const second = await syncWithStateFile(engine, {
        prdPath,
        statePath,
        boardId: "board",
        mapping,
        direction: "two-way",
      });

      assert.equal(second.plan.creates.length, 0);
      assert.equal(second.plan.updates.length, 0);
      assert.equal(second.plan.conflicts.length, 0);
      assert.equal(second.plan.noop.length, 1);
      assert.equal(checklistCalls, previousChecklistCalls);
    });
  });

  it("falls back to full sync when state is corrupted", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      const statePath = path.join(dir, "state.json");
      const prd = {
        project: "ralph-task",
        stories: [
          {
            id: "US-001",
            title: "Story One",
            status: "open",
            dependsOn: [],
            description: "Description",
            acceptanceCriteria: ["Criteria A"],
          },
        ],
      };
      await writeFile(prdPath, JSON.stringify(prd, null, 2));
      await writeFile(statePath, "{ invalid");

      let checklistCalls = 0;
      let warning = "";
      const boardAdapter = {
        getLists: async () => [
          { id: "list-open", name: "To Do", closed: false },
          { id: "list-progress", name: "In Progress", closed: false },
          { id: "list-done", name: "Done", closed: false },
        ],
        getCards: async () => [
          {
            id: "card-1",
            name: "[US-001] Story One",
            description: "Description",
            listId: "list-open",
            labelIds: [],
            closed: false,
            lastActivityAt: "2026-01-20T00:00:00Z",
          },
        ],
        getLabels: async () => [],
        getCardChecklists: async () => {
          checklistCalls += 1;
          return [
            {
              id: "checklist-1",
              name: "Acceptance Criteria",
              items: [
                { id: "item-1", name: "Criteria A", checked: false },
              ],
            },
          ];
        },
        createCard: async () => {
          throw new Error("Unexpected createCard call");
        },
        updateCard: async () => {
          throw new Error("Unexpected updateCard call");
        },
        upsertChecklist: async () => {
          throw new Error("Unexpected upsertChecklist call");
        },
        setChecklistItemState: async () => {
          throw new Error("Unexpected setChecklistItemState call");
        },
      };

      const engine = new SyncEngine({
        boardAdapter,
        formatAdapter: new RalphPrdFormatAdapter(),
      });

      const result = await syncWithStateFile(engine, {
        prdPath,
        statePath,
        boardId: "board",
        mapping,
        direction: "two-way",
        warn: (message) => {
          warning = message;
        },
      });

      assert.equal(result.plan.conflicts.length, 0);
      assert.match(warning, /Ignoring sync state/);
      assert.equal(checklistCalls, 1);
    });
  });

  it("supports dry-run planning with detailed output and no writes", async () => {
    await withTempDir(async (dir) => {
      const prdPath = path.join(dir, "prd.json");
      const statePath = path.join(dir, "state.json");
      const prd = {
        project: "ralph-task",
        stories: [
          {
            id: "US-010",
            title: "Dry Run Story",
            status: "done",
            dependsOn: [],
            description: "Description",
            acceptanceCriteria: ["Criteria A"],
          },
        ],
      };
      await writeFile(prdPath, JSON.stringify(prd, null, 2));

      const formatAdapter = {
        readStories: async () => ({
          stories: prd.stories,
          lastModifiedAt: "2026-01-21T00:00:00Z",
        }),
        writeStories: async () => {
          throw new Error("Unexpected writeStories call");
        },
      };

      const boardAdapter = {
        getLists: async () => [
          { id: "list-open", name: "To Do", closed: false },
          { id: "list-done", name: "Done", closed: false },
        ],
        getCards: async () => [
          {
            id: "card-1",
            name: "[US-010] Dry Run Story",
            description: "Description",
            listId: "list-open",
            labelIds: [],
            closed: false,
            lastActivityAt: "2026-01-20T00:00:00Z",
          },
        ],
        getLabels: async () => [],
        getCardChecklists: async () => [
          {
            id: "checklist-1",
            name: "Acceptance Criteria",
            items: [
              { id: "item-1", name: "Criteria A", checked: false },
            ],
          },
        ],
        createCard: async () => {
          throw new Error("Unexpected createCard call");
        },
        updateCard: async () => {
          throw new Error("Unexpected updateCard call");
        },
        upsertChecklist: async () => {
          throw new Error("Unexpected upsertChecklist call");
        },
        setChecklistItemState: async () => {
          throw new Error("Unexpected setChecklistItemState call");
        },
      };

      const engine = new SyncEngine({ boardAdapter, formatAdapter });
      const result = await syncWithStateFile(engine, {
        prdPath,
        statePath,
        boardId: "board",
        mapping,
        direction: "two-way",
        dryRun: true,
      });

      assert.equal(result.plan.updates.length, 1);
      const output = formatSyncPlan(result.plan);
      assert.match(output, /list move: To Do -> Done/);
      assert.match(output, /checklist update: 1 items/);

      await assert.rejects(
        () => readFile(statePath, "utf8"),
        /ENOENT/,
      );
    });
  });
});
