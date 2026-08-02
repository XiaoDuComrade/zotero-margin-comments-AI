import { config } from "../../package.json";
import {
  MARGIN_ANNOTATION_TYPES,
  type MarginAnnotationType,
} from "../core/types";
import { locateAiAnnotations } from "../ai/quote-locator";
import {
  AI_API_PROTOCOLS,
  DEFAULT_AI_ANNOTATION_COLOR,
  type AiAnnotationSuggestion,
  type AiSettings,
} from "../ai/types";
import { AiClient, buildScholarInstructions } from "./ai-client";
import { AnnotationStore } from "./annotation-store";
import { ReaderSession } from "./reader-session";
import { TOOLBAR_STYLES } from "./styles";
import {
  buildWebChatPrompt,
  copyPromptToClipboard,
  createWebChatRequestID,
  waitForWebChatClipboardResult,
} from "./web-chat-clipboard";

const TOOLBAR_STYLE_ID = "zmc-toolbar-styles";
const PREFERENCE_PANE_ROOT_ID = "zotero-prefpane-margincomments";
const COMPACT_NOTE_SETTING_SELECTOR = '[data-zmc-setting="compact-note-icons"]';
const AI_SETTING_SELECTOR = "[data-zmc-ai-setting]";
const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  webChatEnabled: false,
  apiProtocol: "auto",
  apiBase: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1",
  color: DEFAULT_AI_ANNOTATION_COLOR,
  maxAnnotations: 18,
  customInstructions: "",
};

export class PluginController {
  private readonly store = new AnnotationStore();
  private readonly aiClient = new AiClient();
  private readonly sessions = new Map<any, ReaderSession>();
  private readonly aiRuns = new Map<any, AbortController>();
  private readonly aiProgress = new Map<any, string>();
  private readonly preferenceDocuments = new Set<Document>();
  private visibleTypes = new Set<MarginAnnotationType>(MARGIN_ANNOTATION_TYPES);
  private compactNoteIcons = false;
  private aiSettings: AiSettings = { ...DEFAULT_AI_SETTINGS };
  private preferencePaneID?: string;
  private notifierID?: string;
  private enabled = true;
  private started = false;

  private readonly onRenderToolbar = (event: any) => {
    const { reader, doc, append } = event;
    if (!this.isPdfReader(reader)) return;
    append(this.createToolbarGroup(doc, reader));
    void this.ensureSession(reader);
  };

  private readonly onAnnotationContextMenu = (event: any) => {
    const { reader, params, append } = event;
    if (!this.isPdfReader(reader)) return;
    const ids = Array.isArray(params?.ids) ? params.ids.map(String) : [];
    append({
      label: "在页边显示/编辑评论",
      disabled: ids.length === 0,
      onCommand: () => void this.reveal(reader, ids),
    });
  };

  private readonly notifierObserver = {
    notify: (event: string, type: string) => {
      if (type === "tab") {
        this.pruneSessions();
        return;
      }
      if (type !== "item" || !["add", "modify", "delete", "trash"].includes(event)) {
        return;
      }
      this.pruneSessions();
      for (const session of this.sessions.values()) void session.refresh();
    },
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.enabled = this.readEnabledPreference();
    this.visibleTypes = this.readVisibleTypesPreference();
    this.compactNoteIcons = this.readCompactNoteIconsPreference();
    this.aiSettings = this.readAiSettingsPreference();

    await this.registerPreferencePane();

    const readerApi = (Zotero as any).Reader;
    readerApi.registerEventListener(
      "renderToolbar",
      this.onRenderToolbar,
      config.addonID,
    );
    readerApi.registerEventListener(
      "createAnnotationContextMenu",
      this.onAnnotationContextMenu,
      config.addonID,
    );
    this.notifierID = (Zotero.Notifier as any).registerObserver(
      this.notifierObserver,
      ["item", "tab"],
      config.addonID,
    );

    for (const reader of readerApi._readers ?? []) {
      if (!this.isPdfReader(reader)) continue;
      void this.ensureSession(reader);
      setTimeout(() => this.installFallbackToolbarButton(reader), 350);
    }
  }

  registerWindow(_win: Window): void {}

  unregisterWindow(_win: Window): void {}

  async stop(): Promise<void> {
    this.started = false;
    for (const run of this.aiRuns.values()) run.abort();
    this.aiRuns.clear();
    (Zotero as any).Reader?._unregisterEventListenerByPluginID?.(config.addonID);
    if (this.notifierID) {
      (Zotero.Notifier as any).unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }

    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.preferenceDocuments.clear();
    if (this.preferencePaneID) {
      try {
        (Zotero as any).PreferencePanes?.unregister?.(this.preferencePaneID);
      } catch (error) {
        (Zotero as any).logError?.(error);
      }
      this.preferencePaneID = undefined;
    }
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      this.removeToolbarUi(reader?._iframeWindow?.document);
    }
    this.aiProgress.clear();
  }

  registerPreferencePaneWindow(win: Window): void {
    const doc = win.document;
    const root = doc.getElementById(PREFERENCE_PANE_ROOT_ID);
    if (!root) return;
    this.preferenceDocuments.add(doc);

    root.querySelectorAll<HTMLInputElement>("[data-zmc-type]").forEach((checkbox) => {
      const type = checkbox.dataset.zmcType as MarginAnnotationType | undefined;
      if (!type || !MARGIN_ANNOTATION_TYPES.includes(type)) return;
      checkbox.checked = this.visibleTypes.has(type);
      if (checkbox.dataset.zmcBound === "true") return;
      checkbox.dataset.zmcBound = "true";
      checkbox.addEventListener("change", () => {
        this.setTypeVisible(type, checkbox.checked);
      });
    });

    const compactNoteCheckbox = root.querySelector<HTMLInputElement>(
      COMPACT_NOTE_SETTING_SELECTOR,
    );
    if (compactNoteCheckbox) {
      compactNoteCheckbox.checked = this.compactNoteIcons;
      if (compactNoteCheckbox.dataset.zmcBound !== "true") {
        compactNoteCheckbox.dataset.zmcBound = "true";
        compactNoteCheckbox.addEventListener("change", () => {
          this.setCompactNoteIcons(compactNoteCheckbox.checked);
        });
      }
    }
    this.bindAiSettings(root);
  }

  private async ensureSession(reader: any): Promise<ReaderSession | undefined> {
    if (!this.started || !this.isPdfReader(reader)) return undefined;
    const existing = this.sessions.get(reader);
    if (existing) {
      existing.setVisibleTypes(this.visibleTypes);
      existing.setCompactNoteIcons(this.compactNoteIcons);
      await existing.start(this.enabled);
      return existing;
    }

    const session = new ReaderSession(reader, this.store, () => this.updateToolbarButtons());
    session.setVisibleTypes(this.visibleTypes);
    session.setCompactNoteIcons(this.compactNoteIcons);
    this.sessions.set(reader, session);
    try {
      await session.start(this.enabled);
      return session;
    } catch (error) {
      this.sessions.delete(reader);
      session.destroy();
      (Zotero as any).logError?.(error);
      return undefined;
    }
  }

  private async reveal(reader: any, keys: string[]): Promise<void> {
    const session = await this.ensureSession(reader);
    await session?.reveal(keys);
  }

  private toggleEnabled(): void {
    this.enabled = !this.enabled;
    try {
      (Zotero.Prefs as any).set(`${config.prefsPrefix}.enabled`, this.enabled, true);
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) session.setEnabled(this.enabled);
    this.updateToolbarButtons();
  }

  private readEnabledPreference(): boolean {
    try {
      const value = (Zotero.Prefs as any).get(`${config.prefsPrefix}.enabled`, true);
      return value === undefined ? true : Boolean(value);
    } catch {
      return true;
    }
  }

  private readVisibleTypesPreference(): Set<MarginAnnotationType> {
    const result = new Set<MarginAnnotationType>();
    for (const type of MARGIN_ANNOTATION_TYPES) {
      try {
        const value = (Zotero.Prefs as any).get(
          `${config.prefsPrefix}.types.${type}`,
          true,
        );
        if (value === undefined || Boolean(value)) result.add(type);
      } catch {
        result.add(type);
      }
    }
    return result;
  }

  private readCompactNoteIconsPreference(): boolean {
    try {
      const value = (Zotero.Prefs as any).get(
        `${config.prefsPrefix}.compactNoteIcons`,
        true,
      );
      return value === undefined ? false : Boolean(value);
    } catch {
      return false;
    }
  }

  private readAiSettingsPreference(): AiSettings {
    const read = (name: string): unknown => {
      try {
        return (Zotero.Prefs as any).get(`${config.prefsPrefix}.ai.${name}`, true);
      } catch {
        return undefined;
      }
    };
    const apiBase = read("apiBase");
    const apiProtocol = read("apiProtocol");
    const apiKey = read("apiKey");
    const model = read("model");
    const color = read("color");
    const maxAnnotations = read("maxAnnotations");
    const customInstructions = read("customInstructions");
    const aiEnabled = read("enabled");
    const webChatEnabled = read("webChatEnabled");
    return {
      enabled: typeof aiEnabled === "boolean"
        ? aiEnabled
        : DEFAULT_AI_SETTINGS.enabled,
      webChatEnabled: typeof webChatEnabled === "boolean"
        ? webChatEnabled
        : DEFAULT_AI_SETTINGS.webChatEnabled,
      apiProtocol: typeof apiProtocol === "string"
        && AI_API_PROTOCOLS.includes(apiProtocol as AiSettings["apiProtocol"])
        ? apiProtocol as AiSettings["apiProtocol"]
        : DEFAULT_AI_SETTINGS.apiProtocol,
      apiBase: typeof apiBase === "string" ? apiBase : DEFAULT_AI_SETTINGS.apiBase,
      apiKey: typeof apiKey === "string" ? apiKey : DEFAULT_AI_SETTINGS.apiKey,
      model: typeof model === "string" ? model : DEFAULT_AI_SETTINGS.model,
      color: typeof color === "string" && /^#[0-9a-f]{6}$/iu.test(color)
        ? color
        : DEFAULT_AI_SETTINGS.color,
      maxAnnotations: typeof maxAnnotations === "number"
        ? clampAiAnnotationCount(maxAnnotations)
        : DEFAULT_AI_SETTINGS.maxAnnotations,
      customInstructions: typeof customInstructions === "string"
        ? customInstructions
        : DEFAULT_AI_SETTINGS.customInstructions,
    };
  }

  private setTypeVisible(type: MarginAnnotationType, visible: boolean): void {
    if (visible) {
      this.visibleTypes.add(type);
    } else {
      this.visibleTypes.delete(type);
    }
    try {
      (Zotero.Prefs as any).set(
        `${config.prefsPrefix}.types.${type}`,
        visible,
        true,
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) {
      session.setVisibleTypes(this.visibleTypes);
    }
    this.syncPreferenceCheckboxes();
  }

  private setCompactNoteIcons(enabled: boolean): void {
    this.compactNoteIcons = enabled;
    try {
      (Zotero.Prefs as any).set(
        `${config.prefsPrefix}.compactNoteIcons`,
        enabled,
        true,
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) {
      session.setCompactNoteIcons(enabled);
    }
    this.syncPreferenceCheckboxes();
  }

  private bindAiSettings(root: HTMLElement): void {
    const defaultPrompt = root.querySelector<HTMLElement>(
      "[data-zmc-ai-default-prompt]",
    );
    if (defaultPrompt) {
      defaultPrompt.textContent = buildScholarInstructions();
    }

    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      AI_SETTING_SELECTOR,
    ).forEach((input) => {
      const name = input.dataset.zmcAiSetting as keyof AiSettings | undefined;
      if (!name || !(name in this.aiSettings)) return;
      this.syncAiInput(input, name);
      if (input.dataset.zmcBound === "true") return;
      input.dataset.zmcBound = "true";
      const eventName = input.tagName === "INPUT" && input.type === "checkbox"
        ? "change"
        : "input";
      input.addEventListener(eventName, () => {
        this.setAiSetting(name, this.readAiInput(input, name));
      });
    });

    const testButton = root.querySelector<HTMLButtonElement>("[data-zmc-ai-test]");
    if (testButton && testButton.dataset.zmcBound !== "true") {
      testButton.dataset.zmcBound = "true";
      testButton.addEventListener("click", () => void this.testAiConnection(root));
    }
  }

  private readAiInput(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    name: keyof AiSettings,
  ): AiSettings[keyof AiSettings] {
    if (typeof this.aiSettings[name] === "boolean" && input.tagName === "INPUT") {
      return (input as HTMLInputElement).checked;
    }
    if (name === "maxAnnotations") {
      return clampAiAnnotationCount(Number(input.value));
    }
    return input.value;
  }

  private setAiSetting(
    name: keyof AiSettings,
    value: AiSettings[keyof AiSettings],
  ): void {
    this.aiSettings = { ...this.aiSettings, [name]: value } as AiSettings;
    try {
      (Zotero.Prefs as any).set(
        `${config.prefsPrefix}.ai.${name}`,
        value,
        true,
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    if (
      name === "webChatEnabled"
      || (name === "enabled"
        && !this.aiSettings.enabled
        && !this.aiSettings.webChatEnabled)
    ) {
      for (const run of this.aiRuns.values()) run.abort();
    }
    if (name === "enabled" || name === "webChatEnabled") {
      this.syncPreferenceCheckboxes();
      this.updateToolbarButtons();
    }
  }

  private syncAiInput(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    name: keyof AiSettings,
  ): void {
    const value = this.aiSettings[name];
    if (typeof value === "boolean" && input.tagName === "INPUT") {
      (input as HTMLInputElement).checked = Boolean(value);
    } else {
      input.value = String(value);
    }
  }

  private async testAiConnection(root: HTMLElement): Promise<void> {
    const button = root.querySelector<HTMLButtonElement>("[data-zmc-ai-test]");
    const status = root.querySelector<HTMLElement>("[data-zmc-ai-status]");
    if (!button || !status) return;
    button.disabled = true;
    status.dataset.state = "working";
    status.textContent = "正在测试连接…";
    try {
      const reply = await this.aiClient.testConnection(this.aiSettings);
      status.dataset.state = "success";
      status.textContent = `连接成功：${reply.slice(0, 80)}`;
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  }

  private async registerPreferencePane(): Promise<void> {
    const preferencePanes = (Zotero as any).PreferencePanes;
    if (!preferencePanes?.register) return;
    try {
      this.preferencePaneID = await preferencePanes.register({
        pluginID: config.addonID,
        id: "margin-comments-preferences",
        label: "页边批注",
        src: `chrome://${config.addonRef}/content/preferences.xhtml`,
        image: `chrome://${config.addonRef}/content/icons/margin-comments.svg`,
        stylesheets: [
          `chrome://${config.addonRef}/content/preferences.css`,
        ],
      });
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
  }

  private createToolbarButton(doc: Document, reader: any): HTMLButtonElement {
    this.ensureToolbarStyles(doc);
    const button = doc.createElement("button");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const page = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    const line1 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    const line2 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    const card = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    const leader = doc.createElementNS("http://www.w3.org/2000/svg", "path");

    button.type = "button";
    button.className = "toolbar-button zmc-toolbar-toggle";
    button.title = "页边批注：显示划线解释和独立评论";
    button.setAttribute("aria-label", button.title);
    button.dataset.zmcItemID = String(reader?.itemID ?? "");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    page.setAttribute("x", "2.5");
    page.setAttribute("y", "3");
    page.setAttribute("width", "11");
    page.setAttribute("height", "18");
    page.setAttribute("rx", "1.2");
    page.setAttribute("fill", "none");
    page.setAttribute("stroke", "currentColor");
    page.setAttribute("stroke-width", "1.5");
    line1.setAttribute("d", "M5 8h6M5 11h5");
    line2.setAttribute("d", "M5 14h6");
    line1.setAttribute("stroke", "currentColor");
    line2.setAttribute("stroke", "currentColor");
    line1.setAttribute("stroke-width", "1.3");
    line2.setAttribute("stroke-width", "1.3");
    card.setAttribute("x", "17");
    card.setAttribute("y", "7");
    card.setAttribute("width", "5");
    card.setAttribute("height", "8");
    card.setAttribute("rx", "1");
    card.setAttribute("fill", "currentColor");
    leader.setAttribute("d", "M12 11.5h3l2-1.5");
    leader.setAttribute("fill", "none");
    leader.setAttribute("stroke", "currentColor");
    leader.setAttribute("stroke-width", "1.3");
    svg.append(page, line1, line2, leader, card);
    button.append(svg);
    button.addEventListener("click", () => this.toggleEnabled());
    this.syncToolbarButton(button);
    return button;
  }

  private createToolbarGroup(doc: Document, reader: any): HTMLDivElement {
    this.ensureToolbarStyles(doc);
    const group = doc.createElement("div");
    group.className = "zmc-toolbar-group";
    group.append(
      this.createToolbarButton(doc, reader),
      this.createAiToolbarButton(doc, reader),
    );
    return group;
  }

  private createAiToolbarButton(doc: Document, reader: any): HTMLButtonElement {
    this.ensureToolbarStyles(doc);
    const button = doc.createElement("button");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const largeStar = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    const smallStar = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    button.type = "button";
    button.className = "toolbar-button zmc-toolbar-ai";
    button.dataset.zmcItemID = String(reader?.itemID ?? "");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    largeStar.setAttribute(
      "d",
      "M10.2 2.5c.5 4.7 2.6 6.8 7.3 7.3-4.7.5-6.8 2.6-7.3 7.3-.5-4.7-2.6-6.8-7.3-7.3 4.7-.5 6.8-2.6 7.3-7.3Z",
    );
    smallStar.setAttribute(
      "d",
      "M18.1 14.2c.2 2.3 1.3 3.4 3.6 3.6-2.3.2-3.4 1.3-3.6 3.6-.2-2.3-1.3-3.4-3.6-3.6 2.3-.2 3.4-1.3 3.6-3.6Z",
    );
    for (const star of [largeStar, smallStar]) {
      star.setAttribute("fill", "currentColor");
    }
    svg.append(largeStar, smallStar);
    button.append(svg);
    button.addEventListener("click", () => void this.toggleAiAnalysis(reader));
    this.syncAiToolbarButton(button, reader);
    return button;
  }

  private async toggleAiAnalysis(reader: any): Promise<void> {
    const running = this.aiRuns.get(reader);
    if (running) {
      running.abort();
      return;
    }
    if (!this.aiSettings.enabled && !this.aiSettings.webChatEnabled) {
      this.showAlert(reader, "请先在“编辑 → 设置 → 页边批注”中启用 AI 学术标注或“用网页对话”。");
      return;
    }
    const useWebChat = this.aiSettings.webChatEnabled;

    const attachmentID = Number(reader?.itemID);
    const attachment = (Zotero.Items as any).get(attachmentID);
    if (!attachment || !Number.isInteger(attachmentID)) {
      this.showAlert(reader, "没有找到当前 PDF 附件。");
      return;
    }
    if (attachment.isEditable?.() === false) {
      this.showAlert(reader, "当前 PDF 所在文库为只读，无法写入 AI 批注。");
      return;
    }
    const filePath = await attachment.getFilePathAsync?.();
    if (!filePath) {
      this.showAlert(reader, "当前 PDF 文件不在本机，无法发送给大模型。");
      return;
    }
    const fileName = String(
      attachment.attachmentFilename
      || String(filePath).split(/[\\/]/u).at(-1)
      || "article.pdf",
    );
    const approved = this.showConfirm(reader, useWebChat
      ? [
          `把“${fileName}”的学术标注提示词复制为纯文本。`,
          "",
          "插件不会复制 PDF。请自行在网页 AI 中上传当前 PDF，再粘贴提示词并发送；模型完成后复制整段回复，插件会自动识别本次任务并显示写入预览。",
          "",
          "插件将监听剪贴板最多 30 分钟，但只接受带本次任务编号的回复。是否继续？",
        ].join("\n")
      : [
          `将当前 PDF“${fileName}”或其文字层内容发送到：`,
          this.aiSettings.apiBase,
          `模型：${this.aiSettings.model}`,
          `接口协议：${this.aiSettings.apiProtocol}`,
          "",
          "Responses 模式发送 PDF 文件并尝试删除远端临时文件；Chat Completions 模式发送 Zotero 提取的带页码文字。服务商可能按模型用量收费。是否继续？",
        ].join("\n"));
    if (!approved) return;

    let session: ReaderSession | undefined;
    let abortController: AbortController;
    try {
      session = await this.ensureSession(reader);
      if (!session) throw new Error("PDF Reader 尚未就绪，请稍后重试。");
      abortController = createDomAbortController(reader);
    } catch (error) {
      (Zotero as any).logError?.(error);
      this.showAlert(reader, errorMessage(error));
      return;
    }

    this.aiRuns.set(reader, abortController);
    this.setAiProgress(reader, "正在读取 PDF 文字层…");
    this.updateToolbarButtons();
    try {
      const pages = await session.textPages();
      if (!pages.length) {
        throw new Error("没有取得 PDF 文字层；纯扫描 PDF 暂时无法进行 AI 标注或精确定位");
      }
      let suggestions: AiAnnotationSuggestion[];
      if (useWebChat) {
        const requestID = createWebChatRequestID();
        const prompt = buildWebChatPrompt(this.aiSettings, requestID, fileName);
        copyPromptToClipboard(prompt);
        this.setAiProgress(
          reader,
          "提示词文本已复制。请自行上传 PDF，再粘贴提示词并发送；完成后复制整段回复（点击星光按钮可取消）",
        );
        let lastWaitingSecond = -1;
        let detectedClipboardChange = false;
        suggestions = await waitForWebChatClipboardResult({
          requestID,
          maxAnnotations: this.aiSettings.maxAnnotations,
          signal: abortController.signal,
          onClipboardChange: () => {
            detectedClipboardChange = true;
            this.setAiProgress(
              reader,
              "已检测到新的剪贴板文本，但其中还没有本次任务的完整结果；请复制模型的整段回复（点击星光按钮可取消）",
            );
          },
          onWaiting: (elapsedMs) => {
            if (abortController.signal.aborted) return;
            const elapsedSeconds = Math.max(1, Math.ceil(elapsedMs / 1000));
            if (elapsedSeconds === lastWaitingSecond) return;
            lastWaitingSecond = elapsedSeconds;
            this.setAiProgress(
              reader,
              detectedClipboardChange
                ? `已读取剪贴板变化，但尚未识别到本次任务的完整结果……已等待 ${elapsedSeconds} 秒（点击星光按钮可取消）`
                : `等待网页 AI 回复：请复制模型的整段结果……已等待 ${elapsedSeconds} 秒（点击星光按钮可取消）`,
            );
          },
        });
      } else {
        this.setAiProgress(
          reader,
          `已读取 ${pages.length} 页，正在等待 ${this.aiSettings.model} 返回…（点击星光按钮可取消）`,
        );
        suggestions = await this.aiClient.analyzePdf({
          settings: this.aiSettings,
          filePath: String(filePath),
          fileName,
          textPages: pages,
          signal: abortController.signal,
          onProgress: (progress) => {
            if (abortController.signal.aborted) return;
            const elapsedSeconds = Math.max(1, Math.ceil(progress.elapsedMs / 1000));
            const chunkLabel = progress.totalChunks > 1
              ? `第 ${progress.chunkIndex}/${progress.totalChunks} 段，`
              : "";
            const stage = progress.contentChars > 0
              ? "正在接收标注结果"
              : progress.reasoningChars > 0
                ? "模型正在分析论文"
                : "已连接模型，等待开始生成";
            this.setAiProgress(
              reader,
              `已读取 ${pages.length} 页，${chunkLabel}${stage}……已等待 ${elapsedSeconds} 秒（点击星光按钮可取消）`,
            );
          },
        });
      }
      if (abortController.signal.aborted) return;

      this.setAiProgress(reader, `模型已返回 ${suggestions.length} 条建议，正在匹配 PDF 原文…`);
      const result = locateAiAnnotations(suggestions, pages);
      if (!result.located.length) {
        throw new Error(
          `模型返回了 ${suggestions.length} 条建议，但没有一条能与 PDF 原文可靠匹配，因此没有写入批注`,
        );
      }

      const preview = result.located
        .slice(0, 4)
        .map((annotation, index) => `${index + 1}. 第 ${annotation.pageLabel} 页：${annotation.comment.slice(0, 52)}`)
        .join("\n");
      const apply = this.showConfirm(
        reader,
        [
          `模型返回 ${suggestions.length} 条建议，成功定位 ${result.located.length} 条。`,
          result.unmatched.length
            ? `${result.unmatched.length} 条因无法匹配原文或重复而被跳过。`
            : "所有建议均已匹配到原文。",
          "",
          preview,
          "",
          `确定以统一颜色 ${this.aiSettings.color} 写入 Zotero 高亮批注吗？`,
        ].join("\n"),
      );
      if (!apply || abortController.signal.aborted) return;

      this.setAiProgress(reader, `正在写入 ${result.located.length} 条 Zotero 高亮批注…`);
      const created = await this.store.createAiHighlights(
        attachmentID,
        result.located,
        this.aiSettings.color,
      );
      await session.refresh(true);
      this.showAlert(
        reader,
        `已创建 ${created} 条 AI 学术批注。可用 Zotero 的颜色或“AI 学术标注”标签统一筛选、隐藏。`,
      );
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        (Zotero as any).logError?.(error);
        this.showAlert(reader, errorMessage(error));
      }
    } finally {
      if (this.aiRuns.get(reader) === abortController) {
        this.aiRuns.delete(reader);
      }
      this.clearAiProgress(reader);
      this.updateToolbarButtons();
    }
  }

  private syncPreferenceCheckboxes(): void {
    for (const doc of [...this.preferenceDocuments]) {
      const root = doc.getElementById(PREFERENCE_PANE_ROOT_ID);
      if (!root) {
        this.preferenceDocuments.delete(doc);
        continue;
      }
      root.querySelectorAll<HTMLInputElement>("[data-zmc-type]").forEach((checkbox) => {
        const type = checkbox.dataset.zmcType as MarginAnnotationType | undefined;
        if (!type) return;
        checkbox.checked = this.visibleTypes.has(type);
      });
      const compactNoteCheckbox = root.querySelector<HTMLInputElement>(
        COMPACT_NOTE_SETTING_SELECTOR,
      );
      if (compactNoteCheckbox) compactNoteCheckbox.checked = this.compactNoteIcons;
      root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        AI_SETTING_SELECTOR,
      ).forEach((input) => {
        const name = input.dataset.zmcAiSetting as keyof AiSettings | undefined;
        if (name && name in this.aiSettings) this.syncAiInput(input, name);
      });
    }
  }

  private installFallbackToolbarButton(reader: any): void {
    const doc = reader?._iframeWindow?.document as Document | undefined;
    if (!doc || doc.querySelector(".zmc-toolbar-toggle")) return;
    const customSections = doc.querySelector<HTMLElement>(".toolbar .end .custom-sections");
    if (!customSections) return;
    const section = this.createToolbarGroup(doc, reader);
    section.classList.add("section", "zmc-fallback-section");
    customSections.append(section);
  }

  private updateToolbarButtons(): void {
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      const doc = reader?._iframeWindow?.document as Document | undefined;
      doc?.querySelectorAll<HTMLButtonElement>(".zmc-toolbar-toggle").forEach((button) =>
        this.syncToolbarButton(button),
      );
      doc?.querySelectorAll<HTMLButtonElement>(".zmc-toolbar-ai").forEach((button) =>
        this.syncAiToolbarButton(button, reader),
      );
    }
  }

  private syncToolbarButton(button: HTMLButtonElement): void {
    button.classList.toggle("active", this.enabled);
    button.setAttribute("aria-pressed", String(this.enabled));
    button.title = this.enabled
      ? "页边批注已显示（点击隐藏）"
      : "页边批注已隐藏（点击显示）";
  }

  private syncAiToolbarButton(button: HTMLButtonElement, reader: any): void {
    const running = this.aiRuns.has(reader);
    button.hidden = !this.aiSettings.enabled && !this.aiSettings.webChatEnabled;
    button.classList.toggle("zmc-working", running);
    button.setAttribute("aria-busy", String(running));
    button.title = running
      ? this.aiProgress.get(reader) || "AI 正在分析当前 PDF（点击取消）"
      : this.aiSettings.webChatEnabled
        ? "复制网页 AI 提示词，并等待剪贴板回复"
        : "让 AI 以专业学者方式标注当前 PDF";
    button.setAttribute("aria-label", button.title);
  }

  private ensureToolbarStyles(doc: Document): void {
    if (doc.getElementById(TOOLBAR_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = TOOLBAR_STYLE_ID;
    style.textContent = TOOLBAR_STYLES;
    doc.head.append(style);
  }

  private removeToolbarUi(doc?: Document): void {
    if (!doc) return;
    doc.querySelectorAll(
      ".zmc-toolbar-group,.zmc-toolbar-toggle,.zmc-toolbar-ai,.zmc-fallback-section",
    ).forEach((node) => node.remove());
    doc.querySelectorAll(".zmc-ai-progress").forEach((node) => node.remove());
    doc.getElementById(TOOLBAR_STYLE_ID)?.remove();
  }

  private setAiProgress(reader: any, message: string): void {
    this.aiProgress.set(reader, message);
    const doc = reader?._iframeWindow?.document as Document | undefined;
    if (doc?.body) {
      this.ensureToolbarStyles(doc);
      let notice = doc.querySelector<HTMLElement>(".zmc-ai-progress");
      if (!notice) {
        notice = doc.createElement("div");
        notice.className = "zmc-ai-progress";
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        doc.body.append(notice);
      }
      notice.textContent = message;
    }
    this.updateToolbarButtons();
  }

  private clearAiProgress(reader: any): void {
    this.aiProgress.delete(reader);
    const doc = reader?._iframeWindow?.document as Document | undefined;
    doc?.querySelectorAll(".zmc-ai-progress").forEach((node) => node.remove());
  }

  private pruneSessions(): void {
    const live = new Set<any>((Zotero as any).Reader?._readers ?? []);
    for (const [reader, session] of this.sessions) {
      if (live.has(reader)) continue;
      this.aiRuns.get(reader)?.abort();
      this.aiRuns.delete(reader);
      this.clearAiProgress(reader);
      session.destroy();
      this.sessions.delete(reader);
    }
  }

  private showConfirm(reader: any, message: string): boolean {
    const win = (Zotero as any).getMainWindow?.()
      ?? reader?._iframeWindow
      ?? globalThis;
    return typeof win?.confirm === "function"
      ? Boolean(win.confirm(message))
      : false;
  }

  private showAlert(reader: any, message: string): void {
    const win = (Zotero as any).getMainWindow?.()
      ?? reader?._iframeWindow
      ?? globalThis;
    if (typeof win?.alert === "function") win.alert(message);
  }

  private isPdfReader(reader: any): boolean {
    return !!reader && (reader._type === "pdf" || reader.type === "pdf");
  }
}

function clampAiAnnotationCount(value: number): number {
  return Math.max(1, Math.min(40, Math.trunc(Number(value) || 18)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "未知错误");
}

function createDomAbortController(reader?: any): AbortController {
  const candidates = [
    (Zotero as any).getMainWindow?.(),
    reader?._internalReader?._primaryView?._iframeWindow,
    reader?._iframeWindow,
    globalThis,
  ];
  for (const candidate of candidates) {
    try {
      const Constructor = candidate?.AbortController;
      if (typeof Constructor === "function") {
        return new Constructor() as AbortController;
      }
    } catch {
      // Some privileged Gecko window getters throw even when the property exists.
    }
  }
  throw new Error("当前 Zotero 环境没有可用的请求取消控制器");
}
