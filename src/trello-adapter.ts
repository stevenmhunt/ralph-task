import type {
  BoardAdapter,
  BoardCard,
  BoardCardInput,
  BoardCardUpdate,
  BoardChecklist,
  BoardChecklistInput,
  BoardChecklistItem,
  BoardChecklistItemInput,
  BoardInfo,
  BoardLabel,
  BoardLabelInput,
  BoardList,
} from "./adapters.js";

export interface TrelloAdapterConfig {
  apiKey: string;
  token: string;
  boardId: string;
  baseUrl?: string;
  retry?: Partial<TrelloRetryConfig>;
}

export class TrelloApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TrelloApiError";
    this.status = status;
  }
}

type QueryValue = string | number | boolean | null | undefined | string[];

interface TrelloBoardInfo {
  id: string;
  name: string;
  dateLastActivity: string;
}

interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}

interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  closed: boolean;
  dateLastActivity: string;
}

interface TrelloChecklistItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
}

interface TrelloChecklist {
  id: string;
  name: string;
  checkItems?: TrelloChecklistItem[];
}

interface TrelloRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_BASE_URL = "https://api.trello.com/1";
const DEFAULT_RETRY: TrelloRetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
};

const normalizeQueryValue = (value: QueryValue): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
};

const buildSearchParams = (params: Record<string, QueryValue>): URLSearchParams => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    const normalized = normalizeQueryValue(value);
    if (normalized !== undefined) {
      search.set(key, normalized);
    }
  });
  return search;
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const isRetryableStatus = (status: number): boolean =>
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

const parseRetryAfterMs = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return null;
};

const mapChecklistItem = (item: TrelloChecklistItem): BoardChecklistItem => ({
  id: item.id,
  name: item.name,
  checked: item.state === "complete",
});

const mapChecklist = (checklist: TrelloChecklist): BoardChecklist => ({
  id: checklist.id,
  name: checklist.name,
  items: (checklist.checkItems ?? []).map(mapChecklistItem),
});

const mapCard = (card: TrelloCard): BoardCard => ({
  id: card.id,
  name: card.name,
  description: card.desc,
  listId: card.idList,
  labelIds: card.idLabels ?? [],
  closed: card.closed,
  lastActivityAt: card.dateLastActivity,
});

const mapLabel = (label: TrelloLabel): BoardLabel => ({
  id: label.id,
  name: label.name,
  color: label.color ?? null,
});

const mapList = (list: TrelloList): BoardList => ({
  id: list.id,
  name: list.name,
  closed: list.closed,
});

export class TrelloBoardAdapter implements BoardAdapter {
  private readonly apiKey: string;
  private readonly token: string;
  private readonly boardId: string;
  private readonly baseUrl: string;
  private readonly retry: TrelloRetryConfig;

  constructor(config: TrelloAdapterConfig) {
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.boardId = config.boardId;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.retry = {
      maxRetries: config.retry?.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseDelayMs: config.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    };
  }

  async getBoardInfo(): Promise<BoardInfo> {
    const board = await this.request<TrelloBoardInfo>(`boards/${this.boardId}`, {
      params: { fields: "id,name,dateLastActivity" },
    });
    return {
      id: board.id,
      name: board.name,
      lastActivityAt: board.dateLastActivity,
    };
  }

  async getLists(): Promise<BoardList[]> {
    const lists = await this.request<TrelloList[]>(
      `boards/${this.boardId}/lists`,
      {
        params: { fields: "id,name,closed", filter: "all" },
      },
    );
    return lists.map(mapList);
  }

  async getCards(): Promise<BoardCard[]> {
    const cards = await this.request<TrelloCard[]>(
      `boards/${this.boardId}/cards`,
      {
        params: {
          fields: "id,name,desc,idList,idLabels,closed,dateLastActivity",
          filter: "all",
        },
      },
    );
    return cards.map(mapCard);
  }

  async getLabels(): Promise<BoardLabel[]> {
    const labels = await this.request<TrelloLabel[]>(
      `boards/${this.boardId}/labels`,
      {
        params: { fields: "id,name,color" },
      },
    );
    return labels.map(mapLabel);
  }

  async getCardChecklists(cardId: string): Promise<BoardChecklist[]> {
    const checklists = await this.request<TrelloChecklist[]>(
      `cards/${cardId}/checklists`,
      {
        params: {
          fields: "id,name",
          checkItems: "all",
          checkItem_fields: "id,name,state",
        },
      },
    );
    return checklists.map(mapChecklist);
  }

  async createLabel(input: BoardLabelInput): Promise<BoardLabel> {
    const label = await this.request<TrelloLabel>("labels", {
      method: "POST",
      params: {
        idBoard: this.boardId,
        name: input.name,
        color: input.color ?? "orange",
      },
    });
    return mapLabel(label);
  }

  async createCard(input: BoardCardInput): Promise<BoardCard> {
    const params: Record<string, QueryValue> = {
      name: input.name,
      desc: input.description,
      idList: input.listId,
    };
    if (input.labelIds.length > 0) {
      params.idLabels = input.labelIds;
    }
    const card = await this.request<TrelloCard>("cards", {
      method: "POST",
      params,
    });
    return mapCard(card);
  }

  async updateCard(cardId: string, update: BoardCardUpdate): Promise<BoardCard> {
    const params: Record<string, QueryValue> = {};
    if (update.name !== undefined) {
      params.name = update.name;
    }
    if (update.description !== undefined) {
      params.desc = update.description;
    }
    if (update.listId !== undefined) {
      params.idList = update.listId;
    }
    if (update.labelIds !== undefined) {
      params.idLabels = update.labelIds;
    }
    if (update.closed !== undefined) {
      params.closed = update.closed;
    }
    const card = await this.request<TrelloCard>(`cards/${cardId}`, {
      method: "PUT",
      params,
    });
    return mapCard(card);
  }

  async upsertChecklist(
    cardId: string,
    checklist: BoardChecklistInput,
  ): Promise<BoardChecklist> {
    const existingChecklists = await this.getCardChecklists(cardId);
    let targetChecklist = existingChecklists.find(
      (item) => item.name === checklist.name,
    );

    if (!targetChecklist) {
      const created = await this.request<TrelloChecklist>("checklists", {
        method: "POST",
        params: {
          idCard: cardId,
          name: checklist.name,
        },
      });
      targetChecklist = mapChecklist(created);
    }

    const items = await this.syncChecklistItems(
      cardId,
      targetChecklist.id,
      targetChecklist.items,
      checklist.items,
    );

    return {
      ...targetChecklist,
      items,
    };
  }

  async setChecklistItemState(
    cardId: string,
    checklistId: string,
    itemId: string,
    checked: boolean,
  ): Promise<BoardChecklistItem> {
    const item = await this.request<TrelloChecklistItem>(
      `cards/${cardId}/checkItem/${itemId}`,
      {
        method: "PUT",
        params: {
          state: checked ? "complete" : "incomplete",
          idChecklist: checklistId,
        },
      },
    );
    return mapChecklistItem(item);
  }

  private async syncChecklistItems(
    cardId: string,
    checklistId: string,
    existingItems: BoardChecklistItem[],
    desiredItems: BoardChecklistItemInput[],
  ): Promise<BoardChecklistItem[]> {
    const byName = new Map<string, BoardChecklistItem[]>();
    existingItems.forEach((item) => {
      const bucket = byName.get(item.name) ?? [];
      bucket.push(item);
      byName.set(item.name, bucket);
    });

    const usedIds = new Set<string>();
    const updatedItems: BoardChecklistItem[] = [];

    for (const desired of desiredItems) {
      const bucket = byName.get(desired.name);
      const existing = bucket?.shift();
      if (existing) {
        usedIds.add(existing.id);
        if (existing.checked !== desired.checked) {
          const updated = await this.setChecklistItemState(
            cardId,
            checklistId,
            existing.id,
            desired.checked,
          );
          updatedItems.push(updated);
        } else {
          updatedItems.push(existing);
        }
      } else {
        const created = await this.createChecklistItem(
          checklistId,
          desired,
        );
        usedIds.add(created.id);
        updatedItems.push(created);
      }
    }

    for (const item of existingItems) {
      if (!usedIds.has(item.id)) {
        await this.deleteChecklistItem(checklistId, item.id);
      }
    }

    return updatedItems;
  }

  private async createChecklistItem(
    checklistId: string,
    item: BoardChecklistItemInput,
  ): Promise<BoardChecklistItem> {
    const created = await this.request<TrelloChecklistItem>(
      `checklists/${checklistId}/checkItems`,
      {
        method: "POST",
        params: {
          name: item.name,
          checked: item.checked,
        },
      },
    );
    return mapChecklistItem(created);
  }

  private async deleteChecklistItem(
    checklistId: string,
    itemId: string,
  ): Promise<void> {
    await this.request<void>(
      `checklists/${checklistId}/checkItems/${itemId}`,
      {
        method: "DELETE",
      },
    );
  }

  private async request<T>(
    path: string,
    options?: { method?: string; params?: Record<string, QueryValue> },
  ): Promise<T> {
    const method = options?.method ?? "GET";
    const params = {
      ...(options?.params ?? {}),
      key: this.apiKey,
      token: this.token,
    };
    const url = new URL(`${this.baseUrl}/${path}`);
    let body: URLSearchParams | undefined;
    if (method === "GET" || method === "DELETE") {
      url.search = buildSearchParams(params).toString();
    } else {
      body = buildSearchParams(params);
    }
    const { maxRetries, baseDelayMs } = this.retry;
    let attempts = 0;

    while (attempts <= maxRetries) {
      try {
        const response = await fetch(url.toString(), {
          method,
          body,
        });

        if (!response.ok) {
          const status = response.status;
          if (status === 401 || status === 403) {
            throw new TrelloApiError("Invalid Trello token", status);
          }
          let detail = "";
          try {
            detail = await response.text();
          } catch {
            detail = "";
          }
          const message = detail.trim()
            ? `Trello API error (${status}): ${detail.trim()}`
            : `Trello API error (${status})`;

          if (isRetryableStatus(status) && attempts < maxRetries) {
            const retryAfterMs =
              status === 429
                ? parseRetryAfterMs(response.headers.get("retry-after"))
                : null;
            const backoffMs = baseDelayMs * 2 ** attempts;
            const delayMs = retryAfterMs
              ? Math.max(backoffMs, retryAfterMs)
              : backoffMs;
            await sleep(delayMs);
            attempts += 1;
            continue;
          }

          if (attempts > 0 && isRetryableStatus(status)) {
            throw new TrelloApiError(
              `${message} after ${attempts} ${attempts === 1 ? "retry" : "retries"}`,
              status,
            );
          }
          throw new TrelloApiError(message, status);
        }

        if (response.status === 204) {
          return undefined as T;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof TrelloApiError) {
          throw error;
        }
        if (attempts < maxRetries) {
          const delayMs = baseDelayMs * 2 ** attempts;
          await sleep(delayMs);
          attempts += 1;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        const suffix =
          attempts > 0
            ? ` after ${attempts} ${attempts === 1 ? "retry" : "retries"}`
            : "";
        throw new Error(`Trello request failed${suffix}: ${message}`);
      }
    }

    throw new Error("Trello request failed: retry loop exited unexpectedly");
  }
}
