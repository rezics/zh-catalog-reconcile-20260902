import type { BookEvidence } from "./contracts.ts";

const punctuation = /[\p{P}\p{S}\s]+/gu;
const queryPhrases = ["最新", "新书", "免费阅读", "全文", "的身份", "是谁", "结局"];

export function preferredChineseTitle(book: BookEvidence): string {
	return book.localizations.find((localization) => localization.language === "zh")?.title ?? "";
}

export function normalizeTitle(title: string): string {
	return title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(punctuation, "");
}

export function normalizedPrefix(title: string): string {
	return Array.from(normalizeTitle(title)).slice(0, 4).join("");
}

function hasDescription(book: BookEvidence): boolean {
	return book.localizations.some((localization) => localization.description !== null);
}

export function suspiciousSignals(book: BookEvidence): string[] {
	const title = preferredChineseTitle(book).trim();
	const signals: string[] = [];
	if (!title) signals.push("empty_title");
	if (queryPhrases.some((phrase) => title.includes(phrase))) signals.push("query_phrase");
	if (/[?？]/u.test(title)) signals.push("question_title");
	if (/[<_]|[a-z]$/iu.test(title)) signals.push("trailing_noise");
	if (Array.from(title).length > 40) signals.push("very_long_title");
	if (book.attributions.length === 0) signals.push("no_attribution");
	if (
		book.details.isbn13 === null &&
		book.details.publicationDate === null &&
		book.localizations.every((localization) => localization.summary === null) &&
		!hasDescription(book)
	)
		signals.push("sparse_metadata");
	return signals;
}

export function candidateQuality(book: BookEvidence): number {
	const languageScore = book.localizationLanguages.includes("ja")
		? 1_000
		: book.localizationLanguages.length * 100;
	const identifierScore = book.details.isbn13 ? 80 : 0;
	const dateScore = book.details.publicationDate ? 30 : 0;
	const metadataScore = book.localizations.reduce(
		(score, localization) =>
			score +
			(localization.title ? 10 : 0) +
			(localization.summary ? 10 : 0) +
			(localization.description ? 20 : 0),
		0,
	);
	const creditScore = Math.min(book.attributions.length, 5) * 10;
	return languageScore + identifierScore + dateScore + metadataScore + creditScore;
}
