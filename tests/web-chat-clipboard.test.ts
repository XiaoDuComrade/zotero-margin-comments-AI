import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSettings } from "../src/ai/types";
import {
  buildWebChatPrompt,
  copyPromptToClipboard,
  parseWebChatClipboardResult,
  readClipboardText,
  waitForWebChatClipboardResult,
  WEB_CHAT_REQUEST_MARKER,
  WEB_CHAT_RESULT_MARKER,
} from "../src/zotero/web-chat-clipboard";

const settings: AiSettings = {
  enabled: true,
  webChatEnabled: true,
  apiProtocol: "auto",
  apiBase: "https://api.example.test/v1",
  apiKey: "",
  model: "unused",
  color: "#a28ae5",
  maxAnnotations: 12,
  customInstructions: "重点检查统计证据。",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web chat clipboard exchange", () => {
  it("builds a self-identifying prompt with a strict annotation schema", () => {
    const prompt = buildWebChatPrompt(settings, "request-123", "paper.pdf");

    expect(prompt.startsWith(WEB_CHAT_REQUEST_MARKER)).toBe(true);
    expect(prompt).toContain("任务编号：request-123");
    expect(prompt).toContain("论文文件名：paper.pdf");
    expect(prompt).toContain("另行上传的 PDF");
    expect(prompt).toContain("重点检查统计证据");
    expect(prompt).toContain("最多 12 处");
    expect(prompt).toContain(WEB_CHAT_RESULT_MARKER);
    expect(prompt).toContain('"request_id":"request-123"');
  });

  it("copies only prompt text through the privileged clipboard bridge", () => {
    const copyText = vi.fn();
    vi.stubGlobal("_zmcClipboard", { copyText, readText: () => "copied result" });

    copyPromptToClipboard("Prompt text");

    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith("Prompt text");
    expect(readClipboardText()).toBe("copied result");
  });

  it("accepts only the matching task result and parses its annotations", () => {
    const response = [
      WEB_CHAT_RESULT_MARKER,
      JSON.stringify({
        request_id: "request-123",
        annotations: [{
          pdf_page: 5,
          quote: "Exact source sentence.",
          comment: "这是关键证据。",
          category: "evidence",
        }],
      }),
    ].join("\n");

    expect(parseWebChatClipboardResult(response, "other-request", 12)).toBeUndefined();
    expect(parseWebChatClipboardResult(response, "request-123", 12)).toEqual([{
      pdfPage: 5,
      quote: "Exact source sentence.",
      comment: "这是关键证据。",
      category: "evidence",
    }]);
    expect(() => parseWebChatClipboardResult(
      `${WEB_CHAT_RESULT_MARKER}\n{"request_id":"request-123"`,
      "request-123",
      12,
    )).toThrow("没有完整的 JSON");
  });

  it("accepts matching plain JSON even if the model omits the result marker", () => {
    const response = `模型结果如下：\n\`\`\`json\n${JSON.stringify({
      request_id: "request-123",
      annotations: [{
        pdf_page: 3,
        quote: "A copied source sentence.",
        comment: "论证说明。",
        category: "argument",
      }],
    })}\n\`\`\``;

    expect(parseWebChatClipboardResult(response, "request-123", 12)).toHaveLength(1);
    expect(parseWebChatClipboardResult(response, "another-request", 12)).toBeUndefined();
  });

  it("polls until a matching copied reply appears", async () => {
    vi.useFakeTimers();
    const response = [
      WEB_CHAT_RESULT_MARKER,
      JSON.stringify({
        request_id: "request-123",
        annotations: [{
          pdf_page: 2,
          quote: "Another exact sentence.",
          comment: "方法说明。",
          category: "method",
        }],
      }),
    ].join("\n");
    const readText = vi.fn()
      .mockReturnValueOnce(`${WEB_CHAT_REQUEST_MARKER}\ninitial prompt`)
      .mockReturnValue(response);

    const pending = waitForWebChatClipboardResult({
      requestID: "request-123",
      maxAnnotations: 12,
      readText,
      pollMs: 100,
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toHaveLength(1);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("reports permanent clipboard read failures instead of waiting silently", async () => {
    vi.useFakeTimers();
    const pending = waitForWebChatClipboardResult({
      requestID: "request-123",
      maxAnnotations: 12,
      readText: () => {
        throw new Error("clipboard bridge unavailable");
      },
      pollMs: 100,
      timeoutMs: 5_000,
    });
    const rejection = expect(pending).rejects.toThrow("连续 5 次无法读取系统剪贴板");
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });
});
