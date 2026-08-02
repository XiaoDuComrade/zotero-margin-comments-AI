import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiAnnotationSuggestion,
  AiSettings,
  PdfTextPage,
} from "../src/ai/types";
import {
  AiClient,
  buildAnalysisRequest,
  buildChatAnalysisRequest,
  buildScholarInstructions,
  extractChatResponseText,
  extractResponseText,
  interleaveSuggestionBatches,
  parseAiSuggestions,
  resolveApiEndpoint,
  splitPdfTextPages,
  trimTrailingBibliographyPages,
} from "../src/zotero/ai-client";

const settings: AiSettings = {
  enabled: true,
  webChatEnabled: false,
  apiProtocol: "auto",
  apiBase: "https://api.openai.com/v1/",
  apiKey: "secret",
  model: "gpt-4.1",
  color: "#a28ae5",
  maxAnnotations: 12,
  customInstructions: "重点看统计方法",
};

afterEach(() => vi.unstubAllGlobals());

describe("AI Responses client helpers", () => {
  it("exposes the shared default scholar prompt without custom instructions", () => {
    const defaultPrompt = buildScholarInstructions();
    expect(defaultPrompt).toContain("严谨的专业学者和同行评审人");
    expect(defaultPrompt).not.toContain("用户补充要求");
    expect(buildScholarInstructions("重点评价研究方法。"))
      .toContain("用户补充要求：重点评价研究方法。");
  });

  it("resolves versioned base URLs without duplicating endpoint paths", () => {
    expect(resolveApiEndpoint(settings.apiBase, "responses")).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(resolveApiEndpoint("https://example.test/v1/responses", "files")).toBe(
      "https://example.test/v1/files",
    );
    expect(resolveApiEndpoint("https://example.test/v1/chat/completions", "chat/completions")).toBe(
      "https://example.test/v1/chat/completions",
    );
    expect(() => resolveApiEndpoint("file:///tmp/api", "responses")).toThrow(
      "http 或 https",
    );
  });

  it("builds and parses Chat Completions requests from numbered PDF text", () => {
    const body = buildChatAnalysisRequest(settings, [{
      pageIndex: 2,
      pageLabel: "1",
      viewBox: [0, 0, 100, 100],
      chars: [
        { c: "Exact", inlineRect: [0, 0, 5, 5], spaceAfter: true },
        { c: "source", inlineRect: [6, 0, 12, 5] },
      ],
    }], 4) as any;
    expect(body.model).toBe("gpt-4.1");
    expect(body.messages[1].content).toContain("[PDF_PAGE 3]");
    expect(body.messages[1].content).toContain("Exact source");
    expect(body.input).toBeUndefined();
    expect(body.stream).toBe(true);
    const longBody = buildChatAnalysisRequest(settings, [{
      pageIndex: 0,
      pageLabel: "1",
      viewBox: [0, 0, 100, 100],
      chars: [{ c: "x".repeat(60_000), inlineRect: [0, 0, 5, 5] }],
    }], 4) as any;
    expect(longBody.max_tokens).toBeGreaterThanOrEqual(7_500);
    expect(extractChatResponseText({
      choices: [{ message: { content: '{"annotations":[]}' } }],
    })).toBe('{"annotations":[]}');
  });

  it("splits a 109-page paper into bounded requests and skips trailing bibliography pages", () => {
    const pages: PdfTextPage[] = Array.from({ length: 109 }, (_, index) => ({
      pageIndex: index,
      pageLabel: String(index + 1),
      viewBox: [0, 0, 100, 100],
      chars: [{
        c: index === 94
          ? `${"x".repeat(4100)}\nReferences\n1. Source`
          : "x".repeat(4200),
        inlineRect: [0, 0, 5, 5],
      }],
    }));

    const prepared = trimTrailingBibliographyPages(pages);
    const chunks = splitPdfTextPages(prepared);

    expect(prepared).toHaveLength(95);
    expect(prepared.at(-1)?.pageIndex).toBe(94);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(8);
    expect(chunks.flat()).toEqual(prepared);
  });

  it("interleaves annotation candidates from all long-document batches", () => {
    const suggestion = (pdfPage: number): AiAnnotationSuggestion => ({
      pdfPage,
      quote: `Quote ${pdfPage}`,
      comment: `Comment ${pdfPage}`,
      category: "evidence",
    });

    expect(interleaveSuggestionBatches([
      [suggestion(1), suggestion(2), suggestion(3)],
      [suggestion(20), suggestion(21)],
      [suggestion(40), suggestion(41)],
    ], 6).map((entry) => entry.pdfPage)).toEqual([1, 20, 40, 2, 21, 41]);
  });

  it("collects streamed reasoning and annotation JSON from Chat Completions", async () => {
    const encoder = new TextEncoder();
    const annotation = {
      pdf_page: 3,
      quote: "Exact source",
      comment: "关键证据。",
      category: "evidence",
    };
    const frames = [
      { choices: [{ delta: { reasoning_content: "Analyzing the paper" } }] },
      { choices: [{ delta: { content: '{"annotations":[' } }] },
      { choices: [{ delta: { content: `${JSON.stringify(annotation)}]}` }, finish_reason: "stop" }] },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const suggestions = await new AiClient().analyzePdf({
      settings: { ...settings, apiProtocol: "chat-completions" },
      filePath: "unused.pdf",
      fileName: "paper.pdf",
      textPages: [{
        pageIndex: 2,
        pageLabel: "1",
        viewBox: [0, 0, 100, 100],
        chars: [
          { c: "Exact", inlineRect: [0, 0, 5, 5], spaceAfter: true },
          { c: "source", inlineRect: [6, 0, 12, 5] },
        ],
      }],
      onProgress,
    });

    expect(suggestions).toEqual([{
      pdfPage: 3,
      quote: "Exact source",
      comment: "关键证据。",
      category: "evidence",
    }]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.some(([progress]) => progress.reasoningChars > 0)).toBe(true);
    expect(onProgress.mock.lastCall?.[0].contentChars).toBeGreaterThan(0);
  });

  it("explains when reasoning exhausts the output budget before JSON begins", async () => {
    const encoder = new TextEncoder();
    const frames = [
      { choices: [{ delta: { reasoning_content: "Long internal reasoning" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));

    await expect(new AiClient().analyzePdf({
      settings: { ...settings, apiProtocol: "chat-completions" },
      filePath: "unused.pdf",
      fileName: "paper.pdf",
      textPages: [{
        pageIndex: 0,
        pageLabel: "1",
        viewBox: [0, 0, 100, 100],
        chars: [{ c: "Source text", inlineRect: [0, 0, 5, 5] }],
      }],
    })).rejects.toThrow("输出 token 上限已耗尽");
  });

  it("continues long-document analysis when one batch returns an empty annotations array", async () => {
    const validAnnotation = {
      pdf_page: 2,
      quote: "Exact source sentence",
      comment: "关键证据。",
      category: "evidence",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"annotations":[]}' }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ annotations: [validAnnotation] }) },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const suggestions = await new AiClient().analyzePdf({
      settings: { ...settings, apiProtocol: "chat-completions" },
      filePath: "unused.pdf",
      fileName: "paper.pdf",
      textPages: [
        {
          pageIndex: 0,
          pageLabel: "1",
          viewBox: [0, 0, 100, 100],
          chars: [{ c: "x".repeat(40_000), inlineRect: [0, 0, 5, 5] }],
        },
        {
          pageIndex: 1,
          pageLabel: "2",
          viewBox: [0, 0, 100, 100],
          chars: [{ c: `Exact source sentence ${"y".repeat(40_000)}`, inlineRect: [0, 0, 5, 5] }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(suggestions).toEqual([{
      pdfPage: 2,
      quote: "Exact source sentence",
      comment: "关键证据。",
      category: "evidence",
    }]);
  });

  it("shows a concise explanation for provider gateway timeouts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      "<html><h1>504 Gateway Time-out</h1></html>",
      { status: 504, statusText: "Gateway Time-out" },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AiClient().analyzePdf({
      settings: { ...settings, apiProtocol: "chat-completions" },
      filePath: "unused.pdf",
      fileName: "paper.pdf",
      textPages: [{
        pageIndex: 0,
        pageLabel: "1",
        viewBox: [0, 0, 100, 100],
        chars: [{ c: "Text", inlineRect: [0, 0, 5, 5] }],
      }],
    })).rejects.toThrow("网关等待模型返回超时（504）");
  });

  it("identifies an SSE input stream interrupted by the provider", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Error in input stream"));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AiClient().analyzePdf({
      settings: { ...settings, apiProtocol: "chat-completions" },
      filePath: "unused.pdf",
      fileName: "paper.pdf",
      textPages: [{
        pageIndex: 0,
        pageLabel: "1",
        viewBox: [0, 0, 100, 100],
        chars: [{ c: "Text", inlineRect: [0, 0, 5, 5] }],
      }],
    })).rejects.toThrow("第 1/1 段的 API 响应流被服务商中途关闭");
  });

  it("automatically falls back when a provider requires messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "field Messages invalid, should be in (0, +∞)" },
      }), { status: 400, statusText: "Bad Request" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await new AiClient().testConnection({
      ...settings,
      apiBase: "https://www.timedigital.cn/v1",
    });

    expect(reply).toBe("OK（Chat Completions）");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.timedigital.cn/v1/responses");
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.timedigital.cn/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toHaveLength(1);
  });

  it("uses an explicitly configured chat completions endpoint directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new AiClient().testConnection({
      ...settings,
      apiBase: "https://www.timedigital.cn/v1/chat/completions",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.timedigital.cn/v1/chat/completions");
  });

  it("does not access hiddenDOMWindow when AbortController is absent globally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
    }), { status: 200 }));
    const appShell = {} as Record<string, unknown>;
    Object.defineProperty(appShell, "hiddenDOMWindow", {
      get: () => {
        throw new Error("NS_ERROR_FAILURE");
      },
    });
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("Zotero", {
      getMainWindow: () => ({}),
    });
    vi.stubGlobal("Services", { appShell });
    vi.stubGlobal("fetch", fetchMock);

    const reply = await new AiClient().testConnection({
      ...settings,
      apiProtocol: "chat-completions",
    });

    expect(reply).toBe("OK（Chat Completions）");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds a structured PDF request with physical-page instructions", () => {
    const body = buildAnalysisRequest(settings, {
      type: "input_file",
      file_id: "file-123",
    }) as any;
    expect(body.model).toBe("gpt-4.1");
    expect(body.store).toBe(false);
    expect(body.input[0].content[0]).toEqual({
      type: "input_file",
      file_id: "file-123",
    });
    expect(body.input[0].content[1].text).toContain("物理页码");
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.schema.properties.annotations.maxItems).toBe(12);
    expect(body.instructions).toContain("重点看统计方法");
  });

  it("extracts and validates model JSON without accepting malformed entries", () => {
    const output = extractResponseText({
      output: [{ content: [{ type: "output_text", text: '{"annotations":[]}' }] }],
    });
    expect(output).toBe('{"annotations":[]}');

    expect(
      parseAiSuggestions(
        '```json\n{"annotations":[{"pdf_page":3,"quote":"Exact source sentence.","comment":"关键证据。","category":"evidence"},{"pdf_page":0,"quote":"bad","comment":"x","category":"other"}]}\n```',
        10,
      ),
    ).toEqual([
      {
        pdfPage: 3,
        quote: "Exact source sentence.",
        comment: "关键证据。",
        category: "evidence",
      },
    ]);
    expect(() => parseAiSuggestions("not json", 10)).toThrow("有效 JSON");
  });
});
