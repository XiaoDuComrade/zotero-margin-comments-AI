import { describe, expect, it } from "vitest";
import { locateAiAnnotations, normalizeText } from "../src/ai/quote-locator";
import type { AiAnnotationSuggestion, PdfTextPage } from "../src/ai/types";

function page(pageIndex: number, text: string): PdfTextPage {
  return {
    pageIndex,
    pageLabel: String(pageIndex + 1),
    viewBox: [0, 0, 600, 800],
    chars: Array.from(text).map((c, index, values) => ({
      c,
      inlineRect: [40 + index * 5, 700, 45 + index * 5, 712],
      lineBreakAfter: index === values.length - 1,
    })),
  };
}

function suggestion(overrides: Partial<AiAnnotationSuggestion> = {}): AiAnnotationSuggestion {
  return {
    pdfPage: 2,
    quote: "A rigorous method improves the result.",
    comment: "这是全文方法论的关键步骤。",
    category: "method",
    ...overrides,
  };
}

describe("AI quote locator", () => {
  it("locates a verbatim quote and creates Zotero highlight geometry", () => {
    const result = locateAiAnnotations(
      [suggestion()],
      [page(0, "Cover"), page(1, "A rigorous method improves the result.")],
    );

    expect(result.unmatched).toEqual([]);
    expect(result.located).toHaveLength(1);
    expect(result.located[0]).toMatchObject({
      pageIndex: 1,
      pageLabel: "2",
      text: "A rigorous method improves the result.",
      category: "method",
      position: { pageIndex: 1 },
    });
    expect(result.located[0].position.rects).toHaveLength(1);
    expect(result.located[0].sortIndex).toMatch(/^00001\|/u);
  });

  it("normalizes typography and searches other pages when the model page is off", () => {
    const result = locateAiAnnotations(
      [suggestion({ pdfPage: 9, quote: "The “main” claim—carefully tested." })],
      [page(2, 'The "main" claim-carefully tested.')],
    );
    expect(result.located[0]?.pageIndex).toBe(2);
    expect(normalizeText("  A\u00a0  B—C  ")).toBe("A B-C");
  });

  it("skips duplicate and unmatchable suggestions instead of guessing positions", () => {
    const source = page(1, "A rigorous method improves the result.");
    const result = locateAiAnnotations(
      [
        suggestion(),
        suggestion({ comment: "重复评论" }),
        suggestion({ quote: "This sentence is not in the PDF." }),
      ],
      [source],
    );
    expect(result.located).toHaveLength(1);
    expect(result.unmatched.map((item) => item.reason)).toEqual([
      "与另一条 AI 批注指向同一段原文",
      "未在 PDF 文字层中找到对应原文",
    ]);
  });
});
