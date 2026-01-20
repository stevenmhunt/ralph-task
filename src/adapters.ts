export type IsoTimestamp = string;

export type StoryStatus = "open" | "in_progress" | "done";

export interface PrdStory {
  id: string;
  title: string;
  status: StoryStatus;
  dependsOn: string[];
  description: string;
  acceptanceCriteria: string[];
}

export interface FormatReadResult {
  stories: PrdStory[];
  lastModifiedAt: IsoTimestamp;
}

export interface FormatAdapter {
  readStories(path: string): Promise<FormatReadResult>;
  writeStories(path: string, stories: PrdStory[]): Promise<void>;
}

export interface BoardInfo {
  id: string;
  name: string;
  lastActivityAt: IsoTimestamp;
}

export interface BoardList {
  id: string;
  name: string;
  closed: boolean;
}

export interface BoardLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface BoardLabelInput {
  name: string;
  color?: string | null;
}

export interface BoardCard {
  id: string;
  name: string;
  description: string;
  listId: string;
  labelIds: string[];
  closed: boolean;
  lastActivityAt: IsoTimestamp;
}

export interface BoardChecklistItem {
  id: string;
  name: string;
  checked: boolean;
}

export interface BoardChecklist {
  id: string;
  name: string;
  items: BoardChecklistItem[];
}

export interface BoardCardInput {
  name: string;
  description: string;
  listId: string;
  labelIds: string[];
}

export interface BoardCardUpdate {
  name?: string;
  description?: string;
  listId?: string;
  labelIds?: string[];
  closed?: boolean;
}

export interface BoardChecklistItemInput {
  name: string;
  checked: boolean;
}

export interface BoardChecklistInput {
  name: string;
  items: BoardChecklistItemInput[];
}

export interface BoardAdapter {
  getBoardInfo(): Promise<BoardInfo>;
  getLists(): Promise<BoardList[]>;
  getCards(): Promise<BoardCard[]>;
  getLabels(): Promise<BoardLabel[]>;
  getCardChecklists(cardId: string): Promise<BoardChecklist[]>;
  createLabel(input: BoardLabelInput): Promise<BoardLabel>;
  createCard(input: BoardCardInput): Promise<BoardCard>;
  updateCard(cardId: string, update: BoardCardUpdate): Promise<BoardCard>;
  upsertChecklist(
    cardId: string,
    checklist: BoardChecklistInput,
  ): Promise<BoardChecklist>;
  setChecklistItemState(
    cardId: string,
    checklistId: string,
    itemId: string,
    checked: boolean,
  ): Promise<BoardChecklistItem>;
}
