export type PackageIdentity = { workId: string; pieceId: string; contentVersion: number };
export type CatalogMetadata = {
  titleZh: string | null; author: string | null; series: string | null; editionLabel: string | null;
  internalContentNumber: string | null; description: string | null; category: "fiction" | "nonfiction" | null;
  level: string | null; pageCount: number | null; wordCount: number | null; durationMs: number | null;
  narrator: string | null; audioSource: string | null; audioSourceUrl: string | null;
};
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function identity(value: Record<string, unknown>, expected: PackageIdentity) {
  if (value.schemaVersion !== 1 || value.workId !== expected.workId || value.pieceId !== expected.pieceId || value.contentVersion !== expected.contentVersion) throw new Error("Package identity or version does not match the declared content");
}
function text(value: unknown, max = 1000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid metadata text");
  return value.trim();
}
function integer(value: unknown, minimum = 0): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2_147_483_647) throw new Error("Invalid metadata number");
  return Number(value);
}
export function validateCatalogMetadata(value: unknown, expected: PackageIdentity): CatalogMetadata {
  if (!object(value)) throw new Error("Metadata must be an object");
  identity(value, expected);
  const category = value.category ?? null;
  if (category !== null && category !== "fiction" && category !== "nonfiction") throw new Error("Invalid category");
  if (value.level != null && typeof value.level !== "string" && (typeof value.level !== "number" || !Number.isFinite(value.level))) throw new Error("Invalid metadata level");
  const level = value.level == null ? null : text(String(value.level), 40);
  const url = text(value.audioSourceUrl, 2048);
  if (url && !/^https:\/\//i.test(url)) throw new Error("Metadata source URL must use HTTPS");
  return {
    titleZh: text(value.titleZh), author: text(value.author), series: text(value.series),
    editionLabel: text(value.editionLabel), internalContentNumber: text(value.internalContentNumber, 128),
    description: text(value.description, 10000), category, level, pageCount: integer(value.pageCount),
    wordCount: integer(object(value.wordCount) ? value.wordCount.value : value.wordCount),
    durationMs: integer(value.durationMs, 1), narrator: text(value.narrator),
    audioSource: text(value.audioSource), audioSourceUrl: url,
  };
}
export type ValidatedQuiz = {
  quizVersion: number; masteryThreshold: number;
  questions: Array<{ id: string; prompt: string; options: string[]; answer: number }>;
};
export function validateQuizPackage(value: unknown, expected: PackageIdentity): ValidatedQuiz {
  if (!object(value)) throw new Error("Quiz must be an object");
  identity(value, expected);
  const quizVersion = integer(value.quizVersion, 1);
  const masteryThreshold = integer(value.masteryFeedbackPercent ?? 80);
  if (!quizVersion || masteryThreshold === null || masteryThreshold > 100 || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 100) throw new Error("Invalid Quiz package");
  const ids = new Set<string>();
  const questions = value.questions.map(item => {
    if (!object(item) || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id) || typeof item.q !== "string" || !item.q.trim() || item.q.length > 10000 || !Array.isArray(item.options) || item.options.length < 2 || item.options.length > 10 || item.options.some(option => typeof option !== "string" || !option.trim() || option.length > 10000) || !Number.isInteger(item.answer) || Number(item.answer) < 0 || Number(item.answer) >= item.options.length) throw new Error("Invalid or duplicate Quiz question");
    ids.add(item.id);
    return { id: item.id, prompt: item.q, options: item.options as string[], answer: Number(item.answer) };
  });
  return { quizVersion, masteryThreshold, questions };
}

export function validateVocabularyPackage(value: unknown): { vocabularyKeys: string[] } {
  if (!object(value)) throw new Error("Vocabulary must be an object");
  for (const [key, entry] of Object.entries(value)) {
    if (!key || !object(entry) || typeof entry.entryId !== "string" || !/^ve-[a-f0-9]{12,64}$/.test(entry.entryId) || typeof entry.lemma !== "string" || !entry.lemma.trim()) throw new Error("Invalid stable vocabulary entry");
  }
  return { vocabularyKeys: Object.keys(value).sort() };
}

export function validateSubtitleReferences(value: unknown): { vocabularyReferences: string[] } {
  if (!Array.isArray(value)) throw new Error("Invalid subtitle array");
  const keys = new Set<string>();
  for (const cue of value) {
    if (!object(cue) || typeof cue.id !== "string" || !cue.id || typeof cue.text !== "string" || !cue.text.trim() || (cue.tokens !== undefined && !Array.isArray(cue.tokens))) throw new Error("Invalid subtitle tokens");
    for (const token of (cue.tokens ?? []) as unknown[]) {
      if (!object(token) || (token.vocabKey != null && (typeof token.vocabKey !== "string" || !token.vocabKey))) throw new Error("Invalid contextual vocabulary key");
      if (typeof token.vocabKey === "string") keys.add(token.vocabKey);
    }
  }
  return { vocabularyReferences: [...keys].sort() };
}
