import {
  AI_ANNOTATION_CATEGORIES,
  type AiAnnotationSuggestion,
  type AiSettings,
} from "../ai/types";
import { buildScholarInstructions, parseAiSuggestions } from "./ai-client";

export const WEB_CHAT_REQUEST_MARKER = "ZMC_WEB_CHAT_REQUEST_V1";
export const WEB_CHAT_RESULT_MARKER = "ZMC_WEB_CHAT_RESULT_V1";
const CLIPBOARD_POLL_MS = 900;
const CLIPBOARD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CLIPBOARD_TEXT_CHARS = 2_000_000;
const MAX_CONSECUTIVE_READ_ERRORS = 5;

declare const _zmcClipboard: ClipboardBridge | undefined;

interface ClipboardBridge {
  copyText(value: string): void;
  readText(): string;
}

export function createWebChatRequestID(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildWebChatPrompt(
  settings: AiSettings,
  requestID: string,
  fileName: string,
): string {
  const maxAnnotations = clampAnnotationCount(settings.maxAnnotations);
  const categories = AI_ANNOTATION_CATEGORIES.join(", ");
  return [
    WEB_CHAT_REQUEST_MARKER,
    "这是 Zotero 页边批注插件生成的任务提示词。请把它作为用户指令执行。",
    `任务编号：${requestID}`,
    `论文文件名：${fileName}`,
    "",
    buildScholarInstructions(settings.customInstructions),
    "",
    `请完整阅读用户在当前对话中另行上传的 PDF，选择最多 ${maxAnnotations} 处真正值得学术批注的原文。`,
    "pdf_page 必须是从 PDF 封面开始计数的物理页码，第一页为 1。",
    "quote 必须逐字复制同一页中的连续原文，不得跨页、翻译、改写或添加省略号。",
    "comment 使用简洁、专业的中文，说明该原文的论证作用、方法、证据、局限或学术意义。",
    `category 只能是以下值之一：${categories}。`,
    "",
    "你的全部回复必须严格由下面两部分组成，不要添加 Markdown 代码围栏、解释、标题或致歉：",
    WEB_CHAT_RESULT_MARKER,
    `{"request_id":"${requestID}","annotations":[{"pdf_page":1,"quote":"逐字原文","comment":"专业中文批注","category":"evidence"}]}`,
    "annotations 可以少于要求数量，但每一项必须具有 pdf_page、quote、comment、category。",
  ].join("\n");
}

export function parseWebChatClipboardResult(
  clipboardText: string,
  requestID: string,
  maxAnnotations: number,
): AiAnnotationSuggestion[] | undefined {
  const text = clipboardText.trim();
  if (!text || text.startsWith(WEB_CHAT_REQUEST_MARKER)) return undefined;
  if (text.length > MAX_CLIPBOARD_TEXT_CHARS) return undefined;

  const markerIndex = text.indexOf(WEB_CHAT_RESULT_MARKER);
  const hasMatchingTaskHint = text.includes(requestID) && text.includes("annotations");
  if (markerIndex < 0 && !hasMatchingTaskHint) return undefined;
  const payload = markerIndex >= 0
    ? text.slice(markerIndex + WEB_CHAT_RESULT_MARKER.length)
    : text;
  const jsonStart = payload.indexOf("{");
  const jsonEnd = payload.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error("已识别到网页 AI 回复，但其中没有完整的 JSON 对象");
  }

  const jsonText = payload.slice(jsonStart, jsonEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("已识别到网页 AI 回复，但批注 JSON 不完整或格式错误");
  }
  const returnedID = parsed && typeof parsed === "object"
    ? (parsed as { request_id?: unknown }).request_id
    : undefined;
  if (returnedID !== requestID) return undefined;
  return parseAiSuggestions(jsonText, maxAnnotations);
}

export function copyPromptToClipboard(prompt: string): void {
  const bridge = clipboardBridge();
  if (typeof bridge?.copyText === "function") {
    bridge.copyText(prompt);
    return;
  }
  const copy = (Zotero as any).Utilities?.Internal?.copyTextToClipboard;
  if (typeof copy === "function") {
    copy.call((Zotero as any).Utilities.Internal, prompt);
    return;
  }
  const { classes, interfaces } = xpcom();
  classes["@mozilla.org/widget/clipboardhelper;1"]
    .getService(interfaces.nsIClipboardHelper)
    .copyString(prompt);
}

export function readClipboardText(): string {
  const bridge = clipboardBridge();
  if (typeof bridge?.readText === "function") {
    return String(bridge.readText() ?? "");
  }
  const { classes, interfaces } = xpcom();
  const clipboard = classes["@mozilla.org/widget/clipboard;1"]
    .getService(interfaces.nsIClipboard) as nsIClipboard;
  if (!clipboard.hasDataMatchingFlavors(
    ["text/unicode"],
    interfaces.nsIClipboard.kGlobalClipboard,
  )) return "";

  const transferable = classes["@mozilla.org/widget/transferable;1"]
    .createInstance(interfaces.nsITransferable) as nsITransferable;
  transferable.init(null as unknown as nsILoadContext);
  transferable.addDataFlavor("text/unicode");
  clipboard.getData(transferable, interfaces.nsIClipboard.kGlobalClipboard);
  const output: { value?: nsISupports } = {};
  transferable.getTransferData("text/unicode", output);
  const wrapped = ((output.value as any)?.QueryInterface?.(
    interfaces.nsISupportsString,
  ) ?? output.value) as nsISupportsString | undefined;
  return typeof wrapped?.data === "string" ? wrapped.data : "";
}

export async function waitForWebChatClipboardResult(params: {
  requestID: string;
  maxAnnotations: number;
  signal?: AbortSignal;
  onWaiting?: (elapsedMs: number) => void;
  onClipboardChange?: (textLength: number) => void;
  readText?: () => string;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<AiAnnotationSuggestion[]> {
  const startedAt = Date.now();
  const readText = params.readText ?? readClipboardText;
  const pollMs = Math.max(100, params.pollMs ?? CLIPBOARD_POLL_MS);
  const timeoutMs = Math.max(1_000, params.timeoutMs ?? CLIPBOARD_TIMEOUT_MS);
  let lastText = "";
  let consecutiveReadErrors = 0;
  let lastReadError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(params.signal);
    let text = "";
    try {
      text = readText();
      consecutiveReadErrors = 0;
      lastReadError = undefined;
    } catch (error) {
      // Another application can briefly lock the Windows clipboard while it is
      // being updated. Retry briefly, but do not hide a permanent bridge error.
      consecutiveReadErrors += 1;
      lastReadError = error;
      if (consecutiveReadErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
        throw new Error(
          `连续 ${MAX_CONSECUTIVE_READ_ERRORS} 次无法读取系统剪贴板：${errorMessage(lastReadError)}`,
        );
      }
    }
    if (text && text !== lastText) {
      lastText = text.length <= MAX_CLIPBOARD_TEXT_CHARS ? text : "[oversized]";
      const suggestions = parseWebChatClipboardResult(
        text,
        params.requestID,
        params.maxAnnotations,
      );
      if (suggestions) return suggestions;
      if (!text.trimStart().startsWith(WEB_CHAT_REQUEST_MARKER)) {
        params.onClipboardChange?.(text.length);
      }
    }
    params.onWaiting?.(Date.now() - startedAt);
    await delay(pollMs, params.signal);
  }
  throw new Error("等待网页 AI 回复超过 30 分钟，已停止监听剪贴板");
}

function xpcom(): { classes: any; interfaces: any } {
  const components = (globalThis as any).Components
    ?? (Zotero as any).getMainWindow?.()?.Components;
  const classes = components?.classes ?? (globalThis as any).Cc;
  const interfaces = components?.interfaces ?? (globalThis as any).Ci;
  if (!classes || !interfaces) {
    throw new Error("当前 Zotero 环境无法访问系统剪贴板组件");
  }
  return { classes, interfaces };
}

function clipboardBridge(): ClipboardBridge | undefined {
  // loadSubScript exposes injected context values as direct globals. Using the
  // declared name first is required in Zotero's isolated plugin sandbox;
  // globalThis can refer to a different wrapper there.
  try {
    if (typeof _zmcClipboard !== "undefined") return _zmcClipboard;
  } catch {
    // Fall through to the wrapper lookup for tests and alternate loaders.
  }
  return (globalThis as any)._zmcClipboard as ClipboardBridge | undefined;
}

function clampAnnotationCount(value: number): number {
  return Math.max(1, Math.min(40, Math.trunc(Number(value) || 18)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "未知错误");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("网页 AI 标注已取消");
  error.name = "AbortError";
  throw error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("网页 AI 标注已取消");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
