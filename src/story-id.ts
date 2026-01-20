export interface StoryIdMapping {
  storyPrefix: string;
  idPattern: string;
  cardTitleFormat: string;
}

export class StoryIdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryIdFormatError";
  }
}

export type StoryIdParseResult =
  | { status: "ok"; id: string; title: string }
  | {
      status: "missing" | "ambiguous";
      reason: string;
      matches: string[];
      title: string;
    };

export interface StoryIdCodec {
  formatId(number: number): string;
  formatCardTitle(id: string, title: string): string;
  parseCardTitle(cardTitle: string): StoryIdParseResult;
}

interface IdPatternSpec {
  template: string;
  prefix: string;
  numberToken: string;
  padding: number | null;
  regexSource: string;
}

interface CardTitleSpec {
  template: string;
  regex: RegExp;
  idToken: string;
  titleToken: string;
}

const PREFIX_TOKEN = "{prefix}";
const NUMBER_TOKEN_REGEX = /\{number(?::(\d+))?\}/g;
const CARD_ID_TOKEN = "{id}";
const CARD_TITLE_TOKEN = "{title}";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceAll = (value: string, search: string, replacement: string): string =>
  value.split(search).join(replacement);

const parseIdPattern = (pattern: string, prefix: string): IdPatternSpec => {
  const numberMatches = [...pattern.matchAll(NUMBER_TOKEN_REGEX)];
  if (numberMatches.length === 0) {
    throw new StoryIdFormatError(
      "idPattern must include a {number} token",
    );
  }
  if (numberMatches.length > 1) {
    throw new StoryIdFormatError(
      "idPattern must include only one {number} token",
    );
  }
  if (!pattern.includes(PREFIX_TOKEN)) {
    throw new StoryIdFormatError(
      "idPattern must include a {prefix} token",
    );
  }

  const numberToken = numberMatches[0][0];
  const paddingRaw = numberMatches[0][1];
  const padding =
    paddingRaw !== undefined ? Number.parseInt(paddingRaw, 10) : null;
  if (padding !== null && (!Number.isFinite(padding) || padding <= 0)) {
    throw new StoryIdFormatError(
      "idPattern padding must be a positive integer",
    );
  }

  const placeholderPrefix = "__STORY_PREFIX__";
  const placeholderNumber = "__STORY_NUMBER__";
  const tokenized = replaceAll(
    replaceAll(pattern, PREFIX_TOKEN, placeholderPrefix),
    numberToken,
    placeholderNumber,
  );
  const escaped = escapeRegExp(tokenized);
  const regexSource = replaceAll(
    replaceAll(escaped, placeholderPrefix, escapeRegExp(prefix)),
    placeholderNumber,
    padding === null ? "\\d+" : `\\d{${padding}}`,
  );

  return {
    template: pattern,
    prefix,
    numberToken,
    padding,
    regexSource,
  };
};

const parseCardTitleFormat = (
  format: string,
  idRegexSource: string,
): CardTitleSpec => {
  const idCount = format.split(CARD_ID_TOKEN).length - 1;
  const titleCount = format.split(CARD_TITLE_TOKEN).length - 1;
  if (idCount !== 1 || titleCount !== 1) {
    throw new StoryIdFormatError(
      "cardTitleFormat must include exactly one {id} and one {title} token",
    );
  }

  const placeholderId = "__CARD_ID__";
  const placeholderTitle = "__CARD_TITLE__";
  const tokenized = replaceAll(
    replaceAll(format, CARD_ID_TOKEN, placeholderId),
    CARD_TITLE_TOKEN,
    placeholderTitle,
  );
  const escaped = escapeRegExp(tokenized);
  const regexSource = replaceAll(
    replaceAll(
      escaped,
      placeholderId,
      `(?<id>${idRegexSource})`,
    ),
    placeholderTitle,
    "(?<title>.*?)",
  );
  const regex = new RegExp(`^${regexSource}$`);

  return {
    template: format,
    regex,
    idToken: CARD_ID_TOKEN,
    titleToken: CARD_TITLE_TOKEN,
  };
};

export const createStoryIdCodec = (mapping: StoryIdMapping): StoryIdCodec => {
  const idPattern = parseIdPattern(mapping.idPattern, mapping.storyPrefix);
  const idRegex = new RegExp(`^${idPattern.regexSource}$`);
  const idSearchRegex = new RegExp(idPattern.regexSource, "g");
  const cardTitleSpec = parseCardTitleFormat(
    mapping.cardTitleFormat,
    idPattern.regexSource,
  );

  const formatId = (value: number): string => {
    if (!Number.isInteger(value) || value < 0) {
      throw new StoryIdFormatError(
        "Story number must be a non-negative integer",
      );
    }
    const rawNumber = String(value);
    if (idPattern.padding !== null && rawNumber.length > idPattern.padding) {
      throw new StoryIdFormatError(
        `Story number ${value} exceeds padding length ${idPattern.padding}`,
      );
    }
    const padded =
      idPattern.padding === null
        ? rawNumber
        : rawNumber.padStart(idPattern.padding, "0");
    return replaceAll(
      replaceAll(idPattern.template, PREFIX_TOKEN, idPattern.prefix),
      idPattern.numberToken,
      padded,
    );
  };

  const formatCardTitle = (id: string, title: string): string => {
    if (!idRegex.test(id)) {
      throw new StoryIdFormatError(
        `Story ID '${id}' does not match idPattern`,
      );
    }
    return replaceAll(
      replaceAll(cardTitleSpec.template, cardTitleSpec.idToken, id),
      cardTitleSpec.titleToken,
      title,
    );
  };

  const parseCardTitle = (cardTitle: string): StoryIdParseResult => {
    idSearchRegex.lastIndex = 0;
    const matches = Array.from(cardTitle.matchAll(idSearchRegex), (match) =>
      match[0],
    );
    if (matches.length === 0) {
      return {
        status: "missing",
        reason: "No story ID found in card title",
        matches,
        title: cardTitle,
      };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        reason: "Multiple story IDs found in card title",
        matches,
        title: cardTitle,
      };
    }

    const match = cardTitleSpec.regex.exec(cardTitle);
    const groups = match?.groups;
    if (!groups?.id) {
      return {
        status: "missing",
        reason: "Story ID not in canonical card title format",
        matches,
        title: cardTitle,
      };
    }

    const parsedTitle = groups.title ?? "";
    return {
      status: "ok",
      id: groups.id,
      title: parsedTitle.trim(),
    };
  };

  return {
    formatId,
    formatCardTitle,
    parseCardTitle,
  };
};

export const formatStoryId = (
  value: number,
  mapping: StoryIdMapping,
): string => createStoryIdCodec(mapping).formatId(value);

export const formatCardTitle = (
  id: string,
  title: string,
  mapping: StoryIdMapping,
): string => createStoryIdCodec(mapping).formatCardTitle(id, title);

export const parseStoryIdFromCardTitle = (
  cardTitle: string,
  mapping: StoryIdMapping,
): StoryIdParseResult => createStoryIdCodec(mapping).parseCardTitle(cardTitle);
