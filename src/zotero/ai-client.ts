import {
  AI_ANNOTATION_CATEGORIES,
  type AiAnnotationCategory,
  type AiAnnotationSuggestion,
  type AiSettings,
  type PdfTextPage,
} from "../ai/types";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const CHAT_CHUNK_MAX_CHARS = 64_000;
const MAX_CHAT_REQUESTS = 8;
const CONNECTION_TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 240_000;

class AiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AiStreamProgress {
  chunkIndex: number;
  totalChunks: number;
  elapsedMs: number;
  eventCount: number;
  reasoningChars: number;
  contentChars: number;
}

interface ChatCompletionResult {
  content: string;
  finishReason: string;
  reasoningChars: number;
}

export class AiClient {
  async testConnection(settings: AiSettings, signal?: AbortSignal): Promise<string> {
    validateSettings(settings);
    if (settings.apiProtocol === "chat-completions") {
      return testChatConnection(settings, signal);
    }
    if (settings.apiProtocol === "responses") {
      return testResponsesConnection(settings, signal);
    }
    if (hasExplicitChatCompletionsPath(settings.apiBase)) {
      return testChatConnection(settings, signal);
    }
    try {
      return await testResponsesConnection(settings, signal);
    } catch (error) {
      if (!shouldFallbackToChat(error)) throw error;
      return testChatConnection(settings, signal);
    }
  }

  async analyzePdf(params: {
    settings: AiSettings;
    filePath: string;
    fileName: string;
    textPages: PdfTextPage[];
    signal?: AbortSignal;
    onProgress?: (progress: AiStreamProgress) => void;
  }): Promise<AiAnnotationSuggestion[]> {
    const { settings, signal } = params;
    validateSettings(settings);
    throwIfAborted(signal);

    if (settings.apiProtocol === "chat-completions") {
      return analyzeWithChatCompletions(
        settings,
        params.textPages,
        signal,
        params.onProgress,
      );
    }
    if (settings.apiProtocol === "auto") {
      if (hasExplicitChatCompletionsPath(settings.apiBase)) {
        return analyzeWithChatCompletions(
          settings,
          params.textPages,
          signal,
          params.onProgress,
        );
      }
      try {
        return await this.analyzeWithResponses(params);
      } catch (error) {
        if (!shouldFallbackToChat(error)) throw error;
        return analyzeWithChatCompletions(
          settings,
          params.textPages,
          signal,
          params.onProgress,
        );
      }
    }
    return this.analyzeWithResponses(params);
  }

  private async analyzeWithResponses(params: {
    settings: AiSettings;
    filePath: string;
    fileName: string;
    signal?: AbortSignal;
  }): Promise<AiAnnotationSuggestion[]> {
    const { settings, filePath, signal } = params;
    throwIfAborted(signal);

    const bytes = await readLocalFile(filePath);
    if (!bytes.length) throw new Error("PDF 文件为空或无法读取");
    if (bytes.byteLength >= MAX_PDF_BYTES) {
      throw new Error("PDF 文件必须小于 50 MB，当前接口无法直接处理此文件");
    }
    throwIfAborted(signal);

    let uploadedFileID = "";
    let inputFile: Record<string, unknown>;
    try {
      uploadedFileID = await uploadPdf(
        settings,
        bytes,
        params.fileName,
        signal,
      );
      inputFile = { type: "input_file", file_id: uploadedFileID };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      inputFile = {
        type: "input_file",
        filename: params.fileName || "article.pdf",
        file_data: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
      };
    }

    const requestBody = buildAnalysisRequest(settings, inputFile);
    try {
      let response: unknown;
      try {
        response = await postJson(
          resolveApiEndpoint(settings.apiBase, "responses"),
          settings.apiKey,
          requestBody,
          signal,
        );
      } catch (error) {
        if (!(error instanceof AiHttpError) || !isFormatCompatibilityError(error)) {
          throw error;
        }
        const fallbackBody = { ...requestBody } as Record<string, unknown>;
        delete fallbackBody.text;
        response = await postJson(
          resolveApiEndpoint(settings.apiBase, "responses"),
          settings.apiKey,
          fallbackBody,
          signal,
        );
      }

      return parseAiSuggestions(
        extractResponseText(response),
        settings.maxAnnotations,
      );
    } finally {
      if (uploadedFileID) {
        await deleteUploadedFile(settings, uploadedFileID);
      }
    }
  }
}

async function testResponsesConnection(
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<string> {
  const data = await postJson(
    resolveApiEndpoint(settings.apiBase, "responses"),
    settings.apiKey,
    {
      model: settings.model.trim(),
      input: "Reply with exactly: OK",
      max_output_tokens: 16,
      store: false,
    },
    signal,
    CONNECTION_TIMEOUT_MS,
  );
  const reply = extractResponseText(data).trim();
  return `${reply || "OK"}（Responses API）`;
}

async function testChatConnection(
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<string> {
  const data = await postJson(
    resolveApiEndpoint(settings.apiBase, "chat/completions"),
    settings.apiKey,
    {
      model: settings.model.trim(),
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 128,
      stream: false,
    },
    signal,
    CONNECTION_TIMEOUT_MS,
  );
  const reply = extractChatResponseText(data).trim();
  if (!reply) {
    throw new Error("API 已连接，但模型没有返回正文；请检查模型的推理与输出 token 设置");
  }
  return `${reply}（Chat Completions）`;
}

async function analyzeWithChatCompletions(
  settings: AiSettings,
  textPages: readonly PdfTextPage[],
  signal?: AbortSignal,
  onProgress?: (progress: AiStreamProgress) => void,
): Promise<AiAnnotationSuggestion[]> {
  const preparedPages = trimTrailingBibliographyPages(textPages);
  const chunks = splitPdfTextPages(preparedPages, CHAT_CHUNK_MAX_CHARS);
  if (!chunks.length) {
    throw new Error("没有取得可发送给 Chat Completions 的 PDF 文字层");
  }
  if (chunks.length > MAX_CHAT_REQUESTS) {
    throw new Error(
      `PDF 文字内容过长，需要 ${chunks.length} 次 Chat Completions 请求；为避免意外费用，当前最多允许 ${MAX_CHAT_REQUESTS} 次`,
    );
  }

  const maxAnnotations = clampAnnotationCount(settings.maxAnnotations);
  const perChunkLimit = Math.min(
    40,
    Math.max(1, Math.ceil(maxAnnotations / chunks.length) + (chunks.length > 1 ? 1 : 0)),
  );
  const suggestionBatches: AiAnnotationSuggestion[][] = [];
  const seen = new Set<string>();

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const pages = chunks[chunkIndex];
    throwIfAborted(signal);
    const requestBody = buildChatAnalysisRequest(settings, pages, perChunkLimit);
    let completion: ChatCompletionResult;
    try {
      completion = await postChatCompletionsStream(
        resolveApiEndpoint(settings.apiBase, "chat/completions"),
        settings.apiKey,
        requestBody,
        signal,
        ANALYSIS_TIMEOUT_MS,
        {
          chunkIndex: chunkIndex + 1,
          totalChunks: chunks.length,
          onProgress,
        },
      );
    } catch (error) {
      if (isInterruptedInputStreamError(error)) {
        throw new Error(
          `第 ${chunkIndex + 1}/${chunks.length} 段的 API 响应流被服务商中途关闭。长论文已按较小批次发送；请稍后重试，或减少“每篇最多批注数”`,
        );
      }
      if (!isStreamingCompatibilityError(error)) throw error;
      const fallbackBody = { ...requestBody, stream: false };
      const data = await postJson(
        resolveApiEndpoint(settings.apiBase, "chat/completions"),
        settings.apiKey,
        fallbackBody,
        signal,
        ANALYSIS_TIMEOUT_MS,
      );
      completion = extractChatCompletionResult(data);
    }
    if (!completion.content.trim()) {
      const prefix = `第 ${chunkIndex + 1}/${chunks.length} 段`;
      if (completion.finishReason === "length") {
        throw new Error(
          `${prefix}的输出 token 上限已耗尽；模型只完成了推理，尚未生成批注 JSON。插件已按分段文字量提高输出额度，若仍出现此提示，请减少“每篇最多批注数”或换用推理更短的模型`,
        );
      }
      if (completion.reasoningChars > 0) {
        throw new Error(
          `${prefix}只返回了推理过程，没有返回可解析的批注 JSON；请换用能够返回正文的模型`,
        );
      }
      throw new Error(`${prefix}没有返回任何批注正文`);
    }
    let chunkSuggestions: AiAnnotationSuggestion[];
    try {
      chunkSuggestions = parseAiSuggestions(
        completion.content,
        perChunkLimit,
        { allowEmpty: true },
      );
    } catch (error) {
      if (completion.finishReason === "length") {
        throw new Error(
          `第 ${chunkIndex + 1}/${chunks.length} 段的批注 JSON 因输出 token 上限而被截断；请减少“每篇最多批注数”或换用推理更短的模型`,
        );
      }
      throw error;
    }
    const uniqueChunkSuggestions: AiAnnotationSuggestion[] = [];
    for (const suggestion of chunkSuggestions) {
      const key = `${suggestion.pdfPage}:${suggestion.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueChunkSuggestions.push(suggestion);
    }
    suggestionBatches.push(uniqueChunkSuggestions);
  }

  const suggestions = interleaveSuggestionBatches(
    suggestionBatches,
    maxAnnotations,
  );
  if (!suggestions.length) {
    throw new Error("大模型没有返回能够定位的有效批注建议");
  }
  return suggestions;
}

export function resolveApiEndpoint(
  apiBase: string,
  resource: "files" | "responses" | "chat/completions",
): string {
  const value = apiBase.trim().replace(/\/+$/u, "");
  if (!value) throw new Error("请填写 API 地址");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API 地址格式无效");
  }
  if (!/^https?:$/u.test(url.protocol)) {
    throw new Error("API 地址必须使用 http 或 https");
  }
  url.pathname = url.pathname
    .replace(/\/(?:responses|files|chat\/completions)\/?$/iu, "")
    .replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return `${url.toString().replace(/\/+$/u, "")}/${resource}`;
}

export function buildAnalysisRequest(
  settings: AiSettings,
  inputFile: Record<string, unknown>,
): Record<string, unknown> {
  const maxAnnotations = clampAnnotationCount(settings.maxAnnotations);
  return {
    model: settings.model.trim(),
    instructions: buildScholarInstructions(settings.customInstructions),
    input: [
      {
        role: "user",
        content: [
          inputFile,
          {
            type: "input_text",
            text: [
              `请通读这篇论文并选择最多 ${maxAnnotations} 处真正值得学术批注的原文。`,
              "pdf_page 必须是从 PDF 封面开始计数的物理页码（第一页为 1），不是论文印刷页码。",
              "quote 必须逐字复制该页连续原文，保留足够上下文以便软件精确定位。",
              "comment 使用简洁、专业的中文，解释其论证作用、方法、证据、局限或学术意义。",
              "只输出符合约定结构的 JSON，不要输出 Markdown。",
            ].join("\n"),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "zotero_scholarly_annotations",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            annotations: {
              type: "array",
              maxItems: maxAnnotations,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  pdf_page: { type: "integer", minimum: 1 },
                  quote: { type: "string" },
                  comment: { type: "string" },
                  category: {
                    type: "string",
                    enum: [...AI_ANNOTATION_CATEGORIES],
                  },
                },
                required: ["pdf_page", "quote", "comment", "category"],
              },
            },
          },
          required: ["annotations"],
        },
      },
    },
    max_output_tokens: Math.min(12000, Math.max(3000, maxAnnotations * 450)),
    store: false,
  };
}

export function buildChatAnalysisRequest(
  settings: AiSettings,
  pages: readonly PdfTextPage[],
  requestedMaxAnnotations = settings.maxAnnotations,
): Record<string, unknown> {
  const maxAnnotations = clampAnnotationCount(requestedMaxAnnotations);
  const categories = AI_ANNOTATION_CATEGORIES.join(", ");
  const documentText = pages.map(formatPdfTextPage).join("\n\n");
  // Reasoning models consume the same output-token budget for hidden reasoning and
  // visible JSON. Long chunks therefore need a budget based on input size as well
  // as on the requested number of annotations.
  const maxTokens = Math.min(
    12000,
    Math.max(3000, maxAnnotations * 450, Math.ceil(documentText.length / 8)),
  );
  return {
    model: settings.model.trim(),
    messages: [
      {
        role: "system",
        content: [
          buildScholarInstructions(settings.customInstructions),
          "只返回一个 JSON 对象，不要输出 Markdown 或额外说明。",
          "JSON 格式必须为：{\"annotations\":[{\"pdf_page\":1,\"quote\":\"逐字原文\",\"comment\":\"专业中文批注\",\"category\":\"evidence\"}]}。",
          `category 只能是以下值之一：${categories}。`,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `请从下面带物理页码的 PDF 文字中选择最多 ${maxAnnotations} 处真正值得学术批注的原文。`,
          "pdf_page 必须使用 [PDF_PAGE N] 中的 N。",
          "quote 必须逐字复制同一页中的连续原文，不得跨页、改写或翻译。",
          "comment 使用简洁、专业的中文，解释其论证作用、方法、证据、局限或学术意义。",
          "",
          documentText,
        ].join("\n"),
      },
    ],
    max_tokens: maxTokens,
    stream: true,
  };
}

export function splitPdfTextPages(
  pages: readonly PdfTextPage[],
  maxChars = CHAT_CHUNK_MAX_CHARS,
): PdfTextPage[][] {
  const limit = Math.max(10_000, Math.trunc(maxChars));
  const chunks: PdfTextPage[][] = [];
  let current: PdfTextPage[] = [];
  let currentLength = 0;

  for (const page of pages) {
    const text = formatPdfTextPage(page);
    if (!text.replace(/^\[PDF_PAGE[^\n]*\]\s*/u, "").trim()) continue;
    if (current.length && currentLength + text.length + 2 > limit) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(page);
    currentLength += text.length + 2;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function trimTrailingBibliographyPages(
  pages: readonly PdfTextPage[],
): PdfTextPage[] {
  if (pages.length < 3) return [...pages];
  const earliestHeadingIndex = Math.max(1, Math.floor(pages.length * 0.4));
  for (let index = earliestHeadingIndex; index < pages.length; index += 1) {
    const lines = formatPdfTextPage(pages[index])
      .replace(/^\[PDF_PAGE[^\n]*\]\s*/u, "")
      .split(/\r?\n/u)
      .map((line) => line.trim().toLocaleLowerCase())
      .filter(Boolean);
    if (lines.some((line) => /^(?:references|bibliography|参考文献)$/iu.test(line))) {
      return pages.slice(0, index + 1);
    }
  }
  return [...pages];
}

export function interleaveSuggestionBatches(
  batches: readonly (readonly AiAnnotationSuggestion[])[],
  requestedLimit: number,
): AiAnnotationSuggestion[] {
  const limit = clampAnnotationCount(requestedLimit);
  const selected: AiAnnotationSuggestion[] = [];
  const longestBatch = batches.reduce(
    (max, batch) => Math.max(max, batch.length),
    0,
  );
  for (let row = 0; row < longestBatch && selected.length < limit; row += 1) {
    for (const batch of batches) {
      const suggestion = batch[row];
      if (!suggestion) continue;
      selected.push(suggestion);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function formatPdfTextPage(page: PdfTextPage): string {
  const output: string[] = [];
  for (const char of page.chars) {
    if (char?.ignorable) continue;
    output.push(String(char?.c ?? ""));
    if (char?.paragraphBreakAfter) output.push("\n\n");
    else if (char?.lineBreakAfter) output.push("\n");
    else if (char?.spaceAfter) output.push(" ");
  }
  const physicalPage = Math.max(1, Math.trunc(Number(page.pageIndex) || 0) + 1);
  return `[PDF_PAGE ${physicalPage}]\n${output.join("").trim()}`;
}

export function extractResponseText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const row = data as {
    output_text?: unknown;
    output?: unknown;
  };
  if (typeof row.output_text === "string") return row.output_text;
  if (!Array.isArray(row.output)) return "";
  return row.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      });
    })
    .filter(Boolean)
    .join("");
}

export function extractChatResponseText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

export function parseAiSuggestions(
  rawText: string,
  maxAnnotations: number,
  options: { allowEmpty?: boolean } = {},
): AiAnnotationSuggestion[] {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  if (!cleaned) throw new Error("大模型没有返回可用的批注结果");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("大模型返回的批注不是有效 JSON，请换用支持结构化输出的模型");
  }
  const source = Array.isArray(parsed)
    ? parsed
    : (parsed as { annotations?: unknown })?.annotations;
  if (!Array.isArray(source)) throw new Error("大模型返回结果中缺少 annotations 数组");
  if (!source.length && options.allowEmpty) return [];

  const allowed = new Set<string>(AI_ANNOTATION_CATEGORIES);
  const result: AiAnnotationSuggestion[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pdfPage = Math.trunc(Number(row.pdf_page ?? row.pdfPage));
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    const comment = typeof row.comment === "string" ? row.comment.trim() : "";
    const category = typeof row.category === "string" && allowed.has(row.category)
      ? row.category as AiAnnotationCategory
      : "evidence";
    if (!(pdfPage >= 1) || quote.length < 6 || !comment) continue;
    result.push({ pdfPage, quote, comment, category });
    if (result.length >= clampAnnotationCount(maxAnnotations)) break;
  }
  if (!result.length) throw new Error("大模型没有返回能够定位的有效批注建议");
  return result;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function buildScholarInstructions(customInstructions = ""): string {
  const base = [
    "你是一名严谨的专业学者和同行评审人。",
    "你的任务不是摘要全文，而是在关键原文处给出少量、高价值、可核验的学术批注。",
    "优先识别核心论点、原创贡献、关键方法、重要证据、局限、理论或实践意义，以及理解全文所需术语。",
    "不得杜撰引文、页码、数据或作者没有提出的结论。",
    "每条 quote 必须来自单个 PDF 页面上的连续原文，建议为一至三句且不要跨页。",
  ];
  const custom = customInstructions.trim();
  if (custom) base.push(`用户补充要求：${custom}`);
  return base.join("\n");
}

async function uploadPdf(
  settings: AiSettings,
  bytes: Uint8Array,
  fileName: string,
  signal?: AbortSignal,
): Promise<string> {
  let lastError: unknown;
  for (const purpose of ["user_data", "assistants"]) {
    const multipart = buildMultipartBody(bytes, fileName, purpose);
    try {
      const response = await getFetch()(resolveApiEndpoint(settings.apiBase, "files"), {
        method: "POST",
        headers: {
          ...authorizationHeader(settings.apiKey),
          "Content-Type": multipart.contentType,
        },
        body: multipart.body.buffer.slice(
          multipart.body.byteOffset,
          multipart.body.byteOffset + multipart.body.byteLength,
        ) as ArrayBuffer,
        signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new AiHttpError(
          response.status,
          bodyText,
          readableHttpError(response.status, response.statusText, bodyText, settings.apiKey),
        );
      }
      const data = JSON.parse(bodyText) as { id?: unknown; file_id?: unknown };
      const id = typeof data.id === "string"
        ? data.id.trim()
        : typeof data.file_id === "string"
          ? data.file_id.trim()
          : "";
      if (!id) throw new Error("PDF 上传成功，但服务端没有返回 file_id");
      return id;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof AiHttpError)
        || ![400, 422].includes(error.status)
        || !/purpose/iu.test(error.bodyText)
      ) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PDF 上传失败");
}

function buildMultipartBody(
  bytes: Uint8Array,
  fileName: string,
  purpose: string,
): { body: Uint8Array; contentType: string } {
  const boundary = `zmc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const safeName = (fileName || "article.pdf").replace(/["\r\n]/gu, "_");
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n`
    + "Content-Type: application/pdf\r\n\r\n",
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);
  body.set(suffix, prefix.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function deleteUploadedFile(settings: AiSettings, fileID: string): Promise<void> {
  try {
    const filesEndpoint = resolveApiEndpoint(settings.apiBase, "files");
    await getFetch()(`${filesEndpoint}/${encodeURIComponent(fileID)}`, {
      method: "DELETE",
      headers: authorizationHeader(settings.apiKey),
    });
  } catch {
    // Cleanup failure must not discard annotations that were already generated.
  }
}

async function postChatCompletionsStream(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  progress: {
    chunkIndex: number;
    totalChunks: number;
    onProgress?: (progress: AiStreamProgress) => void;
  },
): Promise<ChatCompletionResult> {
  const startedAt = Date.now();
  const response = await promiseWithTimeout(
    getFetch()(url, {
      method: "POST",
      headers: {
        ...authorizationHeader(apiKey),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    }),
    timeoutMs,
    `API 请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待`,
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new AiHttpError(
      response.status,
      bodyText,
      readableHttpError(response.status, response.statusText, bodyText, apiKey),
    );
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (!/text\/event-stream/iu.test(contentType)) {
    const bodyText = await response.text();
    try {
      return extractChatCompletionResult(bodyText ? JSON.parse(bodyText) : {});
    } catch {
      throw new Error("API 返回了无法解析的 Chat Completions 响应");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("API 已返回流式响应，但当前 Zotero 环境无法读取响应流");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningChars = 0;
  let finishReason = "";
  let eventCount = 0;
  let lastProgressAt = 0;
  let streamDone = false;

  const reportProgress = (force = false) => {
    if (!progress.onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 400) return;
    lastProgressAt = now;
    progress.onProgress({
      chunkIndex: progress.chunkIndex,
      totalChunks: progress.totalChunks,
      elapsedMs: Math.max(0, now - startedAt),
      eventCount,
      reasoningChars,
      contentChars: content.length,
    });
  };

  const consumeEvent = (block: string) => {
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      streamDone = true;
      return;
    }

    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      throw new Error("API 返回了无法解析的 SSE 数据");
    }
    if (event?.error) {
      const message = typeof event.error?.message === "string"
        ? event.error.message
        : JSON.stringify(event.error);
      throw new Error(`API 流式响应失败：${message}`);
    }

    eventCount += 1;
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      const delta = choice?.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        reasoningChars += delta.reasoning_content.length;
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
    }
    reportProgress();
  };

  reportProgress(true);
  try {
    while (!streamDone) {
      throwIfAborted(signal);
      const result = await promiseWithTimeout<ReadableStreamReadResult<Uint8Array>>(
        reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>,
        timeoutMs,
        `API 流式响应超过 ${Math.round(timeoutMs / 1000)} 秒没有新数据，已停止等待`,
      );
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replace(/\r\n?/gu, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        consumeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cancellation only.
    }
    throw error;
  } finally {
    reportProgress(true);
  }

  return { content, finishReason, reasoningChars };
}

function extractChatCompletionResult(data: unknown): ChatCompletionResult {
  const choice = data && typeof data === "object"
    ? (data as { choices?: unknown }).choices
    : undefined;
  const firstChoice = Array.isArray(choice) && choice[0] && typeof choice[0] === "object"
    ? choice[0] as Record<string, unknown>
    : undefined;
  const message = firstChoice?.message && typeof firstChoice.message === "object"
    ? firstChoice.message as Record<string, unknown>
    : undefined;
  const reasoning = typeof message?.reasoning_content === "string"
    ? message.reasoning_content
    : "";
  return {
    content: extractChatResponseText(data),
    finishReason: typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : "",
    reasoningChars: reasoning.length,
  };
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1_000, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = ANALYSIS_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = getFetch()(url, {
    method: "POST",
    headers: {
      ...authorizationHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const timeout = new Promise<Response>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`API 请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待`));
    }, Math.max(1_000, timeoutMs));
  });

  let response: Response;
  try {
    response = await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const bodyText = await response.text();
  if (!response.ok) {
    throw new AiHttpError(
      response.status,
      bodyText,
      readableHttpError(response.status, response.statusText, bodyText, apiKey),
    );
  }
  try {
    return bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error("API 返回了无法解析的响应");
  }
}

function authorizationHeader(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function readableHttpError(
  status: number,
  statusText: string,
  bodyText: string,
  apiKey: string,
): string {
  if (status === 504) {
    return "API 服务商网关等待模型返回超时（504）。请减少最大批注数量后重试；若流式请求仍出现此错误，请联系服务商调整网关超时";
  }
  if ([502, 503].includes(status)) {
    return `API 服务商网关暂时不可用（${status}），请稍后重试`;
  }
  let detail = bodyText.trim().slice(0, 800);
  if (apiKey) detail = detail.split(apiKey).join("[已隐藏]");
  return `API 请求失败（${status} ${statusText || "HTTP error"}）${detail ? `：${detail}` : ""}`;
}

function isStreamingCompatibilityError(error: unknown): boolean {
  return error instanceof AiHttpError
    && [400, 415, 422, 501].includes(error.status)
    && /(?:stream|streaming|server.sent|event.stream|sse)/iu.test(error.bodyText);
}

function isInterruptedInputStreamError(error: unknown): boolean {
  if (error instanceof AiHttpError) return false;
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:error in input stream|input stream.*(?:closed|failed)|networkerror|partial transfer|NS_ERROR_NET_PARTIAL_TRANSFER)/iu
    .test(message);
}

function isFormatCompatibilityError(error: AiHttpError): boolean {
  return error.status === 400
    && /(?:json_schema|text\.format|response.?format|structured)/iu.test(error.bodyText);
}

function shouldFallbackToChat(error: unknown): boolean {
  if (!(error instanceof AiHttpError)) return false;
  if ([404, 405].includes(error.status)) return true;
  return [400, 422].includes(error.status)
    && /(?:messages?|chat.?completions?|unknown\s+(?:field|parameter)\s+["']?input|field\s+Messages\s+invalid)/iu
      .test(error.bodyText);
}

function hasExplicitChatCompletionsPath(apiBase: string): boolean {
  try {
    return /\/chat\/completions\/?$/iu.test(new URL(apiBase.trim()).pathname);
  } catch {
    return false;
  }
}

function getFetch(): typeof fetch {
  const own = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof own === "function") return own.bind(globalThis);
  const win = (Zotero as any).getMainWindow?.();
  if (typeof win?.fetch === "function") return win.fetch.bind(win);
  throw new Error("当前 Zotero 环境不支持网络请求");
}

async function readLocalFile(path: string): Promise<Uint8Array> {
  const ioUtils = (globalThis as any).IOUtils;
  if (typeof ioUtils?.read !== "function") {
    throw new Error("当前 Zotero 环境无法读取 PDF 文件");
  }
  return ioUtils.read(path) as Promise<Uint8Array>;
}

function validateSettings(settings: AiSettings): void {
  resolveApiEndpoint(settings.apiBase, "responses");
  if (!settings.model.trim()) throw new Error("请填写模型名称");
}

function clampAnnotationCount(value: number): number {
  return Math.max(1, Math.min(40, Math.trunc(Number(value) || 18)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("AI 标注已取消");
  error.name = "AbortError";
  return error;
}
