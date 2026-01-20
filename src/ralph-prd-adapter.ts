import { readFile, stat, writeFile } from "node:fs/promises";

import type {
  FormatAdapter,
  FormatReadResult,
  PrdStory,
  StoryStatus,
} from "./adapters.js";

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class PrdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrdFormatError";
  }
}

const requirePlainObject = (value: unknown, label: string): PlainObject => {
  if (!isPlainObject(value)) {
    throw new PrdFormatError(`${label} must be an object`);
  }
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new PrdFormatError(`${label} must be a string`);
  }
  return value;
};

const requireStoryStatus = (value: unknown, label: string): StoryStatus => {
  if (value === "open" || value === "in_progress" || value === "done") {
    return value;
  }
  throw new PrdFormatError(
    `${label} must be one of: 'open', 'in_progress', 'done'`,
  );
};

const requireStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) {
    throw new PrdFormatError(`${label} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new PrdFormatError(`${label}[${index}] must be a string`);
    }
    return item;
  });
};

const parseStory = (value: unknown, index: number): PrdStory => {
  const story = requirePlainObject(value, `stories[${index}]`);
  return {
    id: requireString(story.id, `stories[${index}].id`),
    title: requireString(story.title, `stories[${index}].title`),
    status: requireStoryStatus(story.status, `stories[${index}].status`),
    dependsOn: requireStringArray(
      story.dependsOn,
      `stories[${index}].dependsOn`,
    ),
    description: requireString(
      story.description,
      `stories[${index}].description`,
    ),
    acceptanceCriteria: requireStringArray(
      story.acceptanceCriteria,
      `stories[${index}].acceptanceCriteria`,
    ),
  };
};

const parsePrdJson = (raw: string, source: string): PlainObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new PrdFormatError(`Invalid JSON in PRD at ${source}: ${message}`);
  }
  return requirePlainObject(parsed, `PRD (${source})`);
};

const parseStories = (root: PlainObject, source: string): PrdStory[] => {
  const storiesValue = root.stories;
  if (!Array.isArray(storiesValue)) {
    throw new PrdFormatError(`PRD stories in ${source} must be an array`);
  }
  return storiesValue.map((story, index) => parseStory(story, index));
};

const mapExistingStories = (
  root: PlainObject,
  source: string,
): Map<string, PlainObject> => {
  const storiesValue = root.stories;
  if (!Array.isArray(storiesValue)) {
    throw new PrdFormatError(`PRD stories in ${source} must be an array`);
  }
  const map = new Map<string, PlainObject>();
  storiesValue.forEach((story, index) => {
    const storyObject = requirePlainObject(story, `stories[${index}]`);
    const id = requireString(storyObject.id, `stories[${index}].id`);
    map.set(id, storyObject);
  });
  return map;
};

const mergeStory = (existing: PlainObject | undefined, story: PrdStory) => {
  const merged: PlainObject = existing ? { ...existing } : {};
  merged.id = story.id;
  merged.title = story.title;
  merged.status = story.status;
  merged.dependsOn = [...story.dependsOn];
  merged.description = story.description;
  merged.acceptanceCriteria = [...story.acceptanceCriteria];
  return merged;
};

const readPrdFile = async (
  filePath: string,
): Promise<{ root: PlainObject; lastModifiedAt: string }> => {
  let raw: string;
  let lastModifiedAt: string;
  try {
    const [contents, stats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    raw = contents;
    lastModifiedAt = stats.mtime.toISOString();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown file system error";
    throw new PrdFormatError(`Failed to read PRD at ${filePath}: ${message}`);
  }

  const root = parsePrdJson(raw, filePath);
  return { root, lastModifiedAt };
};

const loadPrdRoot = async (filePath: string): Promise<PlainObject> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown file system error";
    throw new PrdFormatError(`Failed to read PRD at ${filePath}: ${message}`);
  }
  return parsePrdJson(raw, filePath);
};

export class RalphPrdFormatAdapter implements FormatAdapter {
  async readStories(path: string): Promise<FormatReadResult> {
    const { root, lastModifiedAt } = await readPrdFile(path);
    const stories = parseStories(root, path);
    return { stories, lastModifiedAt };
  }

  async writeStories(path: string, stories: PrdStory[]): Promise<void> {
    const root = await loadPrdRoot(path);
    const existingStories = mapExistingStories(root, path);
    const updatedStories = stories.map((story) =>
      mergeStory(existingStories.get(story.id), story),
    );
    root.stories = updatedStories;
    const serialized = `${JSON.stringify(root, null, 2)}\n`;
    await writeFile(path, serialized, "utf8");
  }
}
