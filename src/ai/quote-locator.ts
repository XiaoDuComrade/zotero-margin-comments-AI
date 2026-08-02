import type {
  AiAnnotationSuggestion,
  AiLocationResult,
  LocatedAiAnnotation,
  PdfTextChar,
  PdfTextPage,
} from "./types";

interface NormalizedPageText {
  text: string;
  lowerText: string;
  charIndexes: number[];
}

interface QuoteMatch {
  page: PdfTextPage;
  startChar: number;
  endChar: number;
}

export function locateAiAnnotations(
  suggestions: readonly AiAnnotationSuggestion[],
  pages: readonly PdfTextPage[],
): AiLocationResult {
  const located: LocatedAiAnnotation[] = [];
  const unmatched: AiLocationResult["unmatched"] = [];
  const normalizedPages = new Map<number, NormalizedPageText>();
  const usedRanges = new Set<string>();

  for (const suggestion of suggestions) {
    const quote = normalizeText(suggestion.quote);
    if (quote.length < 6) {
      unmatched.push({ suggestion, reason: "原文引文过短" });
      continue;
    }

    const match = findQuoteMatch(
      suggestion,
      quote,
      pages,
      normalizedPages,
    );
    if (!match) {
      unmatched.push({ suggestion, reason: "未在 PDF 文字层中找到对应原文" });
      continue;
    }

    const rangeKey = `${match.page.pageIndex}:${match.startChar}:${match.endChar}`;
    if (usedRanges.has(rangeKey)) {
      unmatched.push({ suggestion, reason: "与另一条 AI 批注指向同一段原文" });
      continue;
    }

    const rangeChars = match.page.chars.slice(match.startChar, match.endChar + 1);
    const rects = rectsFromChars(rangeChars);
    if (!rects.length) {
      unmatched.push({ suggestion, reason: "原文存在，但无法取得有效文字坐标" });
      continue;
    }

    usedRanges.add(rangeKey);
    const position = { pageIndex: match.page.pageIndex, rects };
    located.push({
      ...suggestion,
      pageIndex: match.page.pageIndex,
      pageLabel: match.page.pageLabel || String(match.page.pageIndex + 1),
      text: textFromChars(rangeChars),
      position,
      sortIndex: buildSortIndex(
        match.page,
        match.startChar,
        rects,
      ),
    });
  }

  return { located, unmatched };
}

function findQuoteMatch(
  suggestion: AiAnnotationSuggestion,
  normalizedQuote: string,
  pages: readonly PdfTextPage[],
  cache: Map<number, NormalizedPageText>,
): QuoteMatch | undefined {
  const preferredPageIndex = Math.max(0, Math.trunc(suggestion.pdfPage) - 1);
  const orderedPages = [
    ...pages.filter((page) => page.pageIndex === preferredPageIndex),
    ...pages.filter((page) => page.pageIndex !== preferredPageIndex),
  ];

  for (const page of orderedPages) {
    let normalized = cache.get(page.pageIndex);
    if (!normalized) {
      normalized = normalizePage(page.chars);
      cache.set(page.pageIndex, normalized);
    }
    const offset = normalized.text.indexOf(normalizedQuote);
    const lowerOffset = offset >= 0
      ? offset
      : normalized.lowerText.indexOf(normalizedQuote.toLocaleLowerCase());
    if (lowerOffset < 0) continue;

    const startChar = normalized.charIndexes[lowerOffset];
    const endChar = normalized.charIndexes[
      lowerOffset + normalizedQuote.length - 1
    ];
    if (!Number.isInteger(startChar) || !Number.isInteger(endChar)) continue;
    return { page, startChar, endChar };
  }
  return undefined;
}

function normalizePage(chars: readonly PdfTextChar[]): NormalizedPageText {
  const output: string[] = [];
  const charIndexes: number[] = [];

  const append = (value: string, charIndex: number) => {
    for (const codePoint of Array.from(canonicalize(value))) {
      if (/\s/u.test(codePoint)) {
        if (!output.length || output.at(-1) === " ") continue;
        output.push(" ");
        charIndexes.push(charIndex);
      } else {
        output.push(codePoint);
        charIndexes.push(charIndex);
      }
    }
  };

  chars.forEach((char, index) => {
    if (!char?.ignorable) append(String(char?.c ?? ""), index);
    if (
      !char?.ignorable
      && (char?.spaceAfter || char?.lineBreakAfter || char?.paragraphBreakAfter)
    ) {
      append(" ", index);
    }
  });

  while (output.at(-1) === " ") {
    output.pop();
    charIndexes.pop();
  }
  const text = output.join("");
  return { text, lowerText: text.toLocaleLowerCase(), charIndexes };
}

export function normalizeText(value: string): string {
  return canonicalize(String(value ?? ""))
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00ad\u200b\ufeff]/gu, "")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/\u00a0/gu, " ");
}

function rectsFromChars(chars: readonly PdfTextChar[]): number[][] {
  const rects: number[][] = [];
  let current: number[] | undefined;
  for (const char of chars) {
    const rect = validRect(char?.inlineRect);
    if (rect) {
      current = current
        ? [
            Math.min(current[0], rect[0]),
            Math.min(current[1], rect[1]),
            Math.max(current[2], rect[2]),
            Math.max(current[3], rect[3]),
          ]
        : rect.slice();
    }
    if (char?.lineBreakAfter && current) {
      rects.push(roundRect(current));
      current = undefined;
    }
  }
  if (current) rects.push(roundRect(current));
  return rects.slice(0, 64);
}

function validRect(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const rect = value.slice(0, 4).map(Number);
  if (!rect.every(Number.isFinite)) return undefined;
  if (!(rect[2] > rect[0]) || !(rect[3] > rect[1])) return undefined;
  return rect;
}

function roundRect(rect: readonly number[]): number[] {
  return rect.map((value) => Number(value.toFixed(3)));
}

function textFromChars(chars: readonly PdfTextChar[]): string {
  const text: string[] = [];
  for (const char of chars) {
    if (!char?.ignorable) {
      text.push(String(char?.c ?? ""));
      if (char?.spaceAfter || char?.lineBreakAfter) text.push(" ");
    }
    if (!char?.ignorable && char?.paragraphBreakAfter) text.push(" ");
  }
  return text.join("").replace(/\s+/gu, " ").trim();
}

function buildSortIndex(
  page: PdfTextPage,
  startChar: number,
  rects: readonly number[][],
): string {
  const pageIndex = Math.max(0, Math.trunc(page.pageIndex));
  const topRect = [...rects].sort((a, b) => b[3] - a[3])[0];
  const viewBox = page.viewBox;
  const pageHeight = Array.isArray(viewBox) && viewBox.length >= 4
    ? Number(viewBox[3]) - Number(viewBox[1])
    : 0;
  const top = Math.max(0, Math.floor(pageHeight - Number(topRect?.[3] ?? 0)));
  return [
    String(pageIndex).slice(0, 5).padStart(5, "0"),
    String(Math.max(0, startChar)).slice(0, 6).padStart(6, "0"),
    String(top).slice(0, 5).padStart(5, "0"),
  ].join("|");
}
