import {
  annotationAnchor,
  compactNoteAnchor,
  shouldDisplayAnnotation,
} from "../core/annotation-model";
import {
  layoutCollapsibleMargin,
  type PositionedLayoutItem,
} from "../core/margin-layout";
import {
  MARGIN_ANNOTATION_TYPES,
  type MarginAnnotation,
  type MarginAnnotationType,
  type PageAnchor,
} from "../core/types";
import type { PdfTextPage } from "../ai/types";
import { AnnotationStore } from "./annotation-store";
import {
  readStoredComment,
  renderStoredComment,
  selectEditorContents,
} from "./rich-text-editor";
import {
  type PdfPageHandle,
  Zotero9ReaderAdapter,
} from "./reader-adapter";
import { PDF_STYLES } from "./styles";

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "zmc-pdf-styles";
const CARD_WIDTH = 264;
const CARD_GAP_FROM_PAGE = 24;
const MARGIN_EXTENT = CARD_WIDTH + CARD_GAP_FROM_PAGE;
const COLLAPSE_SCALE_THRESHOLD = 0.8;
const LAYOUT_PADDING = 8;
const CARD_GAP = 8;
const SUMMARY_HEIGHT = 34;
const EXPANDED_TOP_PADDING = 48;
const FILTER_UI_SETTLE_MS = 80;

type MarginSide = PageAnchor["side"];

interface CardRuntime {
  annotation: MarginAnnotation;
  anchor: PageAnchor;
  card: HTMLElement;
  preview: HTMLButtonElement;
  editor: HTMLElement;
  state: HTMLElement;
  originalValue: string;
  currentValue: string;
  dirty: boolean;
  saving: boolean;
  measuredHeight?: number;
  heightMode?: string;
  timer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setTimeout>;
}

interface MountedPage {
  handle: PdfPageHandle;
  overlay: HTMLElement;
  lines: SVGSVGElement;
  cards: HTMLElement;
  columns: Record<MarginSide, MarginColumnRuntime>;
  runtimes: CardRuntime[];
  positions: Map<string, PositionedLayoutItem>;
}

interface MarginColumnRuntime {
  side: MarginSide;
  root: HTMLElement;
  scrollport: HTMLElement;
  content: HTMLElement;
  toggle: HTMLButtonElement;
}

export class ReaderSession {
  private readonly adapter: Zotero9ReaderAdapter;
  private readonly forcedKeys = new Set<string>();
  private readonly mountedPages = new Map<number, MountedPage>();
  private readonly expandedMargins = new Set<string>();
  private visibleTypes = new Set<MarginAnnotationType>(MARGIN_ANNOTATION_TYPES);
  private annotations: MarginAnnotation[] = [];
  private nativeVisibleIDs?: ReadonlySet<string>;
  private activeKey?: string;
  private hoveredKey?: string;
  private compactNoteIcons = false;
  private enabled = true;
  private started = false;
  private adapterReady = false;
  private destroyed = false;
  private initializePromise?: Promise<void>;
  private pendingRefresh = false;
  private cancelRenderFrame?: () => void;
  private cancelVisibilityFrame?: () => void;
  private visibilityTimer?: ReturnType<typeof setTimeout>;
  private pendingVisibilityPages: MountedPage[] = [];
  private renderFramesRemaining = 0;
  private centerFramesRemaining = 0;
  private overlayRoot?: HTMLElement;

  constructor(
    readonly reader: any,
    private readonly store: AnnotationStore,
    private readonly onStateChange: () => void,
  ) {
    this.adapter = new Zotero9ReaderAdapter(reader);
  }

  get attachmentID(): number {
    return Number(this.reader?.itemID);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async textPages(): Promise<PdfTextPage[]> {
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
    if (!this.adapterReady) throw new Error("PDF Reader 尚未就绪");
    return this.adapter.textPages();
  }

  async start(enabled: boolean): Promise<void> {
    if (this.destroyed) return;
    this.enabled = enabled;
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled && this.adapterReady) {
      this.render();
    } else {
      this.removeUi();
    }
    this.onStateChange();
  }

  setVisibleTypes(types: ReadonlySet<MarginAnnotationType>): void {
    if (
      this.visibleTypes.size === types.size
      && [...types].every((type) => this.visibleTypes.has(type))
    ) {
      return;
    }
    this.visibleTypes = new Set(types);
    if (!this.enabled || !this.adapterReady) return;
    if (this.hasBlockingEditor()) {
      this.pendingRefresh = true;
      return;
    }
    this.render();
  }

  setCompactNoteIcons(enabled: boolean): void {
    if (this.compactNoteIcons === enabled) return;
    this.compactNoteIcons = enabled;
    if (this.adapterReady) {
      this.syncCompactNoteIcons();
      if (this.enabled) this.render();
    }
  }

  async reveal(keys: readonly string[]): Promise<void> {
    keys.forEach((key) => this.forcedKeys.add(String(key)));
    if (!this.enabled) this.setEnabled(true);
    await this.refresh(true);
    const first = keys[0] && String(keys[0]);
    if (!first) return;

    this.setActive(first);
    setTimeout(() => {
      const runtime = this.cardRuntimes().find(
        (candidate) => candidate.annotation.key === first,
      );
      if (runtime) this.openEditor(runtime, true);
    }, 0);
  }

  async refresh(force = false): Promise<void> {
    if (this.destroyed || !Number.isInteger(this.attachmentID)) return;
    if (!force && this.hasBlockingEditor()) {
      this.pendingRefresh = true;
      return;
    }

    this.pendingRefresh = false;
    this.annotations = this.store.list(this.attachmentID);
    if (this.adapterReady) this.syncCompactNoteIcons();
    if (this.enabled && this.adapterReady) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.adapterReady = false;
    this.cancelRenderFrame?.();
    this.cancelRenderFrame = undefined;
    this.cancelVisibilityFrame?.();
    this.cancelVisibilityFrame = undefined;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.visibilityTimer = undefined;
    this.pendingVisibilityPages = [];
    this.renderFramesRemaining = 0;
    this.centerFramesRemaining = 0;
    this.removeUi();
    this.adapter.destroy();
  }

  private scheduleRender(frames = 4): void {
    if (this.destroyed || !this.enabled || !this.adapterReady) return;
    this.renderFramesRemaining = Math.max(this.renderFramesRemaining, frames);
    if (this.cancelRenderFrame) return;
    this.cancelRenderFrame = this.adapter.scheduleAnimationFrame(() => {
      this.cancelRenderFrame = undefined;
      if (this.hasBlockingEditor()) {
        this.pendingRefresh = true;
        this.renderFramesRemaining = 0;
        return;
      }
      this.render();
      if (this.centerFramesRemaining) {
        this.adapter.centerCurrentPageHorizontally();
        this.centerFramesRemaining = Math.max(0, this.centerFramesRemaining - 1);
      }
      this.renderFramesRemaining = Math.max(0, this.renderFramesRemaining - 1);
      if (this.renderFramesRemaining) this.scheduleRender(0);
    });
  }

  private render(): void {
    if (!this.started || !this.adapterReady || this.destroyed || !this.enabled) return;
    const doc = this.adapter.document();
    const viewer = this.adapter.viewerElement();
    this.ensureStyles(doc);

    const displayable = this.annotations.filter(
      (annotation) =>
        this.visibleTypes.has(annotation.type)
        && shouldDisplayAnnotation(annotation, this.forcedKeys),
    );
    const hasDisplayableAnnotations = displayable.length > 0;
    viewer.classList.toggle("zmc-viewer", hasDisplayableAnnotations);
    if (hasDisplayableAnnotations) {
      this.ensureOverlayRoot(doc, viewer);
    } else {
      for (const pageIndex of [...this.mountedPages.keys()]) {
        this.unmountPage(pageIndex);
      }
      this.overlayRoot?.remove();
      this.overlayRoot = undefined;
      return;
    }
    const pageIndexes = new Set(
      displayable.map((annotation) => annotation.position.pageIndex),
    );

    for (const pageIndex of [...this.mountedPages.keys()]) {
      if (!pageIndexes.has(pageIndex)) this.unmountPage(pageIndex);
    }

    let waitingForPage = false;
    for (const pageIndex of pageIndexes) {
      const handle = this.adapter.page(pageIndex);
      if (!handle) {
        const mounted = this.mountedPages.get(pageIndex);
        if (mounted && !mounted.handle.element.isConnected) {
          this.unmountPage(pageIndex);
        }
        if (pageIndex < this.adapter.pageCount()) waitingForPage = true;
        continue;
      }
      const pageAnnotations = displayable.filter(
        (annotation) => annotation.position.pageIndex === pageIndex,
      );
      this.renderPage(handle, pageAnnotations);
    }
    this.syncActiveCards();
    if (waitingForPage) this.scheduleRender(1);
  }

  private async initialize(): Promise<void> {
    await this.adapter.ready();
    if (this.destroyed) return;

    this.adapterReady = true;
    this.started = true;
    this.nativeVisibleIDs = this.adapter.visibleAnnotationIDs();
    this.adapter.onLayoutChange((reason) => {
      if (reason === "scalechanging") {
        this.centerFramesRemaining = Math.max(this.centerFramesRemaining, 4);
      }
      this.scheduleRender();
    });
    this.adapter.onAnnotationVisibilityChange(() => {
      this.scheduleVisibilityUpdate();
    });
    this.adapter.onNativeSelectionChange((ids) => {
      if (ids.length === 1) this.setActive(ids[0]);
    });
    await this.refresh(true);
    this.onStateChange();
  }

  private renderPage(
    handle: PdfPageHandle,
    annotations: MarginAnnotation[],
  ): void {
    const existing = this.mountedPages.get(handle.pageIndex);
    if (
      existing?.handle.element === handle.element &&
      this.updateMountedPage(existing, handle, annotations)
    ) {
      return;
    }

    this.unmountPage(handle.pageIndex);
    const doc = handle.element.ownerDocument;
    const overlay = doc.createElement("div");
    const lines = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const cards = doc.createElement("div");
    const columns = {
      left: this.createMarginColumn(doc, "left"),
      right: this.createMarginColumn(doc, "right"),
    };
    overlay.className = "zmc-page-overlay";
    overlay.classList.toggle("zmc-low-zoom", handle.scale < COLLAPSE_SCALE_THRESHOLD);
    lines.classList.add("zmc-line-layer");
    cards.className = "zmc-card-layer";
    cards.append(columns.left.root, columns.right.root);
    overlay.append(lines, cards);
    handle.element.classList.add("zmc-page");
    this.overlayRoot?.append(overlay);

    const mounted: MountedPage = {
      handle,
      overlay,
      lines,
      cards,
      columns,
      runtimes: [],
      positions: new Map(),
    };
    this.mountedPages.set(handle.pageIndex, mounted);
    for (const column of [columns.left, columns.right]) {
      column.toggle.addEventListener("click", () => {
        this.toggleMargin(mounted, column.side);
      });
      column.scrollport.addEventListener("scroll", () => {
        this.redrawLeaderLines(mounted);
      });
    }

    for (const annotation of annotations) {
      const anchor = this.annotationAnchorForHandle(annotation, handle);
      if (!anchor) continue;
      const runtime = this.createCard(doc, annotation, anchor, handle.pageIndex);
      runtime.card.classList.toggle(
        "zmc-filtered",
        !this.isNativeAnnotationVisible(annotation.key),
      );
      mounted.runtimes.push(runtime);
      columns[anchor.side].content.append(runtime.card);
      this.resizeEditor(runtime.editor);
    }
    this.layoutPage(mounted);
  }

  private updateMountedPage(
    mounted: MountedPage,
    handle: PdfPageHandle,
    annotations: MarginAnnotation[],
  ): boolean {
    const prepared = annotations
      .map((annotation) => ({
        annotation,
        anchor: this.annotationAnchorForHandle(annotation, handle),
      }))
      .filter(
        (entry): entry is { annotation: MarginAnnotation; anchor: PageAnchor } =>
          Boolean(entry.anchor),
      );
    if (prepared.length !== mounted.runtimes.length) return false;
    const byKey = new Map(
      prepared.map((entry) => [entry.annotation.key, entry] as const),
    );
    if (
      mounted.runtimes.some(
        (runtime) => !byKey.has(runtime.annotation.key),
      )
    ) {
      return false;
    }

    mounted.handle = handle;
    mounted.overlay.classList.toggle(
      "zmc-low-zoom",
      handle.scale < COLLAPSE_SCALE_THRESHOLD,
    );
    for (const runtime of mounted.runtimes) {
      const entry = byKey.get(runtime.annotation.key)!;
      const annotationChanged = runtime.annotation !== entry.annotation;
      const wasReadOnly = runtime.annotation.readOnly;
      const previousSide = runtime.anchor.side;
      runtime.annotation = entry.annotation;
      runtime.anchor = entry.anchor;
      if (previousSide !== entry.anchor.side) {
        runtime.card.classList.toggle("zmc-card-left", entry.anchor.side === "left");
        runtime.card.classList.toggle("zmc-card-right", entry.anchor.side === "right");
        mounted.columns[entry.anchor.side].content.append(runtime.card);
      }

      if (annotationChanged) {
        runtime.card.style.setProperty("--zmc-color", entry.annotation.color);
        runtime.editor.contentEditable = String(!entry.annotation.readOnly);
        runtime.editor.dataset.placeholder =
          entry.annotation.type === "note"
            ? "点击输入独立评论…"
            : "点击输入划线解释…";
        runtime.editor.setAttribute(
          "aria-readonly",
          String(entry.annotation.readOnly),
        );
        const annotationLabel = typeLabel(entry.annotation.type);
        const pageLabel = entry.annotation.pageLabel || handle.pageIndex + 1;
        runtime.preview.setAttribute(
          "aria-label",
          `${entry.annotation.readOnly ? "查看" : "编辑"}${annotationLabel}，第 ${pageLabel} 页`,
        );
        runtime.editor.setAttribute(
          "aria-label",
          `${annotationLabel}，第 ${pageLabel} 页`,
        );
      }

      if (!runtime.dirty && runtime.currentValue !== entry.annotation.comment) {
        runtime.currentValue = entry.annotation.comment;
        this.renderComment(runtime.editor, entry.annotation.comment);
        runtime.originalValue = entry.annotation.comment;
        this.updatePreview(runtime);
        this.resizeEditor(runtime.editor);
        runtime.measuredHeight = undefined;
      }
      if (wasReadOnly !== entry.annotation.readOnly) {
        runtime.state.textContent = entry.annotation.readOnly ? "只读" : "";
        runtime.measuredHeight = undefined;
      }
    }
    this.layoutPage(mounted);
    return true;
  }

  private createMarginColumn(
    doc: Document,
    side: MarginSide,
  ): MarginColumnRuntime {
    const root = doc.createElement("section");
    const scrollport = doc.createElement("div");
    const content = doc.createElement("div");
    const toggle = doc.createElement("button");
    root.className = `zmc-margin-column zmc-margin-column-${side}`;
    scrollport.className = "zmc-margin-scrollport";
    content.className = "zmc-margin-content";
    toggle.type = "button";
    toggle.className = "zmc-margin-toggle";
    toggle.hidden = true;
    scrollport.append(content);
    root.append(scrollport, toggle);
    return { side, root, scrollport, content, toggle };
  }

  private toggleMargin(mounted: MountedPage, side: MarginSide): void {
    const key = this.marginStateKey(mounted.handle.pageIndex, side);
    const column = mounted.columns[side];
    if (column.root.classList.contains("zmc-margin-expanded")) {
      this.expandedMargins.delete(key);
      const activeEditor = mounted.runtimes.find(
        (runtime) =>
          runtime.anchor.side === side &&
          runtime.editor.ownerDocument.activeElement === runtime.editor,
      );
      activeEditor?.editor.blur();
      column.scrollport.scrollTop = 0;
    } else {
      this.expandedMargins.add(key);
    }
    this.layoutPage(mounted);
  }

  private marginStateKey(pageIndex: number, side: MarginSide): string {
    return `${pageIndex}:${side}`;
  }

  private createCard(
    doc: Document,
    annotation: MarginAnnotation,
    anchor: PageAnchor,
    pageIndex: number,
  ): CardRuntime {
    const card = doc.createElement("article");
    const preview = doc.createElement("button");
    const editor = doc.createElement("div");
    const footer = doc.createElement("footer");
    const state = doc.createElement("span");

    card.className = `zmc-card zmc-card-${anchor.side}`;
    card.dataset.annotationKey = annotation.key;
    card.style.setProperty("--zmc-color", annotation.color);
    const annotationLabel = typeLabel(annotation.type);
    preview.type = "button";
    preview.className = "zmc-card-preview";
    preview.setAttribute(
      "aria-label",
      `${annotation.readOnly ? "查看" : "编辑"}${annotationLabel}，第 ${annotation.pageLabel || pageIndex + 1} 页`,
    );
    editor.className = "zmc-card-editor zmc-editor-hidden";
    editor.contentEditable = String(!annotation.readOnly);
    editor.dataset.placeholder = annotation.type === "note" ? "点击输入独立评论…" : "点击输入划线解释…";
    editor.spellcheck = false;
    editor.dir = "auto";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-readonly", String(annotation.readOnly));
    editor.setAttribute("aria-label", `${annotationLabel}，第 ${annotation.pageLabel || pageIndex + 1} 页`);
    this.renderComment(editor, annotation.comment);
    footer.className = "zmc-card-footer";
    state.className = "zmc-save-state";
    state.textContent = annotation.readOnly ? "只读" : "";

    footer.append(state);
    card.append(preview, editor, footer);

    const runtime: CardRuntime = {
      annotation,
      anchor,
      card,
      preview,
      editor,
      state,
      originalValue: annotation.comment,
      currentValue: annotation.comment,
      dirty: false,
      saving: false,
    };
    this.updatePreview(runtime);
    card.classList.toggle("zmc-hovered", this.hoveredKey === annotation.key);

    card.addEventListener("pointerenter", () =>
      this.setHovered(runtime.annotation.key),
    );
    card.addEventListener("pointerleave", () => this.setHovered());
    card.addEventListener("pointerdown", () => {
      this.setActive(runtime.annotation.key);
      this.adapter.selectAnnotation(runtime.annotation.key);
    });
    preview.addEventListener("click", () => {
      if (!runtime.annotation.readOnly) this.openEditor(runtime);
    });
    editor.addEventListener("focus", () => {
      this.setActive(runtime.annotation.key);
      (doc as any).execCommand?.("defaultParagraphSeparator", false, "br");
    });
    // Keep text editing inside the card. Letting these events bubble to the
    // card would call selectAnnotation(), which navigates the PDF on every
    // drag start and collapses a mouse selection back to a single caret.
    // Do not preventDefault(): native selection and the clipboard context
    // menu still need their normal browser behaviour.
    for (const eventName of [
      "pointerdown",
      "mousedown",
      "click",
      "dblclick",
      "contextmenu",
    ]) {
      editor.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const editorSelection = (): Selection | undefined => {
      const selection = doc.defaultView?.getSelection();
      if (
        !selection
        || selection.isCollapsed
        || !selection.anchorNode
        || !selection.focusNode
        || !editor.contains(selection.anchorNode)
        || !editor.contains(selection.focusNode)
      ) {
        return undefined;
      }
      return selection;
    };
    editor.addEventListener("copy", (event) => {
      const selection = editorSelection();
      if (!selection) return;
      event.stopPropagation();
      const text = selection.toString();
      const copied = this.copyTextToClipboard(text);
      if (event.clipboardData) {
        event.clipboardData.setData("text/plain", text);
      }
      if (copied || event.clipboardData) event.preventDefault();
    });
    editor.addEventListener("cut", (event) => event.stopPropagation());
    editor.addEventListener("paste", (event) => event.stopPropagation());
    editor.addEventListener("input", () => {
      if (runtime.annotation.readOnly) return;
      runtime.currentValue = this.readComment(editor);
      runtime.dirty = runtime.currentValue !== runtime.originalValue;
      if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
      runtime.statusTimer = undefined;
      runtime.state.dataset.error = "false";
      runtime.state.textContent = runtime.dirty ? "未保存" : "";
      this.updatePreview(runtime);
      this.resizeEditor(editor);
      runtime.measuredHeight = undefined;
      const mounted = this.mountedPages.get(pageIndex);
      if (mounted) this.layoutPage(mounted);
      this.queueSave(runtime);
    });
    editor.addEventListener("keydown", (event) => {
      const modifier = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      const formatCommand = event.key.toLowerCase() === "b"
        ? "bold"
        : event.key.toLowerCase() === "i"
          ? "italic"
          : undefined;
      if (modifier && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        selectEditorContents(editor);
      } else if (modifier && key === "c") {
        event.preventDefault();
        event.stopPropagation();
        const selection = editorSelection();
        if (selection && !this.copyTextToClipboard(selection.toString())) {
          (doc as any).execCommand?.("copy", false, null);
        }
      } else if (modifier && key === "x") {
        event.stopPropagation();
        if (editorSelection() && (doc as any).execCommand?.("cut", false, null)) {
          event.preventDefault();
        }
      } else if (modifier && ["v", "z", "y"].includes(key)) {
        // Keep native paste/undo/redo, but do not let the PDF reader treat
        // the shortcut as a document command.
        event.stopPropagation();
      } else if (modifier && formatCommand) {
        event.preventDefault();
        event.stopPropagation();
        (doc as any).execCommand?.(formatCommand, false, null);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEdit(runtime);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.persist(runtime).then(() => editor.blur());
      }
    });
    editor.addEventListener("blur", () => {
      void this.persist(runtime).finally(() => {
        this.closeEditor(runtime, pageIndex);
        this.flushPendingRefresh();
      });
    });
    return runtime;
  }

  private layoutPage(mounted: MountedPage): void {
    this.positionOverlay(mounted);
    const { width, height } = this.pageDimensions(mounted.handle);
    mounted.positions.clear();

    for (const side of ["left", "right"] as const) {
      const column = mounted.columns[side];
      const sideRuntimes = mounted.runtimes.filter(
        (runtime) =>
          runtime.anchor.side === side &&
          !runtime.card.classList.contains("zmc-filtered"),
      );
      const stateKey = this.marginStateKey(mounted.handle.pageIndex, side);
      const editing = sideRuntimes.some((runtime) =>
        runtime.card.classList.contains("zmc-editing"),
      );
      const requestedExpanded = this.expandedMargins.has(stateKey);
      const runtimeByID = new Map(
        sideRuntimes.map((runtime) => [runtime.annotation.key, runtime] as const),
      );
      const result = layoutCollapsibleMargin(
        sideRuntimes.map((runtime) => ({
          id: runtime.annotation.key,
          anchorY: runtime.anchor.y,
          height: this.measureRuntimeHeight(runtime, mounted),
        })),
        {
          pageHeight: height,
          padding: LAYOUT_PADDING,
          gap: CARD_GAP,
          summaryHeight: SUMMARY_HEIGHT,
          expandedTopPadding: EXPANDED_TOP_PADDING,
          expanded: requestedExpanded || editing,
        },
      );
      const expanded = result.overflow && (requestedExpanded || editing);
      if (!result.overflow) this.expandedMargins.delete(stateKey);
      if (!expanded) column.scrollport.scrollTop = 0;

      column.root.classList.toggle("zmc-margin-expanded", expanded);
      column.root.classList.toggle("zmc-margin-overflow", result.overflow);
      column.toggle.hidden = !result.overflow;
      column.toggle.setAttribute("aria-expanded", String(expanded));
      const toggleText = expanded
        ? "收起评论"
        : `还有 ${result.hiddenIDs.length} 条 · 展开`;
      if (column.toggle.textContent !== toggleText) {
        column.toggle.textContent = toggleText;
      }
      const toggleTop = `${expanded ? LAYOUT_PADDING : result.summaryY ?? 0}px`;
      if (column.toggle.style.top !== toggleTop) column.toggle.style.top = toggleTop;
      const contentHeight = `${result.contentHeight}px`;
      if (column.content.style.height !== contentHeight) {
        column.content.style.height = contentHeight;
      }

      const visibleIDs = new Set(result.positions.map((position) => position.id));
      for (const runtime of sideRuntimes) {
        runtime.card.classList.toggle(
          "zmc-overflow-hidden",
          !visibleIDs.has(runtime.annotation.key),
        );
      }
      for (const position of result.positions) {
        mounted.positions.set(position.id, position);
        const runtime = runtimeByID.get(position.id);
        if (runtime) {
          const top = `${position.y}px`;
          if (runtime.card.style.top !== top) runtime.card.style.top = top;
        }
      }
    }

    mounted.lines.style.left = `-${MARGIN_EXTENT}px`;
    mounted.lines.setAttribute("width", String(width + MARGIN_EXTENT * 2));
    mounted.lines.setAttribute("height", String(Math.max(1, height)));
    mounted.lines.setAttribute(
      "viewBox",
      `${-MARGIN_EXTENT} 0 ${width + MARGIN_EXTENT * 2} ${Math.max(1, height)}`,
    );
    this.redrawLeaderLines(mounted);
  }

  private redrawLeaderLines(mounted: MountedPage): void {
    const { width, height } = this.pageDimensions(mounted.handle);
    mounted.lines.replaceChildren();
    for (const runtime of mounted.runtimes) {
      const position = mounted.positions.get(runtime.annotation.key);
      if (!position) continue;
      const column = mounted.columns[runtime.anchor.side];
      const expanded = column.root.classList.contains("zmc-margin-expanded");
      const cardY = position.y - (expanded ? column.scrollport.scrollTop : 0);
      const lineEndY = cardY + Math.min(26, position.height / 2);
      if (expanded && (lineEndY < 0 || lineEndY > height)) continue;
      this.drawLeaderLine(mounted.lines, runtime, cardY, position.height, width);
    }
  }

  private scheduleVisibilityUpdate(): void {
    if (this.destroyed || !this.enabled || !this.adapterReady) return;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.cancelVisibilityFrame?.();
    this.cancelVisibilityFrame = undefined;
    this.pendingVisibilityPages = [];
    this.visibilityTimer = setTimeout(() => {
      this.visibilityTimer = undefined;
      if (this.destroyed || !this.enabled || !this.adapterReady) return;
      this.nativeVisibleIDs = this.adapter.visibleAnnotationIDs();
      const currentPageIndex = this.adapter.currentPageIndex();
      this.pendingVisibilityPages = [...this.mountedPages.values()].sort(
        (left, right) =>
          Math.abs(left.handle.pageIndex - currentPageIndex) -
          Math.abs(right.handle.pageIndex - currentPageIndex),
      );
      this.processNextVisibilityPage(true);
    }, FILTER_UI_SETTLE_MS);
  }

  private processNextVisibilityPage(prioritizeCurrentPage = false): void {
    if (this.cancelVisibilityFrame || !this.pendingVisibilityPages.length) return;
    const schedule = prioritizeCurrentPage
      ? this.adapter.scheduleAnimationFrame.bind(this.adapter)
      : this.adapter.scheduleIdleCallback.bind(this.adapter);
    this.cancelVisibilityFrame = schedule(() => {
      this.cancelVisibilityFrame = undefined;
      const mounted = this.pendingVisibilityPages.shift();
      if (
        mounted &&
        this.mountedPages.get(mounted.handle.pageIndex) === mounted
      ) {
        this.applyNativeVisibility(mounted);
      }
      if (this.pendingVisibilityPages.length) this.processNextVisibilityPage(false);
    });
  }

  private applyNativeVisibility(mounted: MountedPage): void {
    let changed = false;
    for (const runtime of mounted.runtimes) {
      const filtered = !this.isNativeAnnotationVisible(runtime.annotation.key);
      if (runtime.card.classList.contains("zmc-filtered") === filtered) continue;
      runtime.card.classList.toggle("zmc-filtered", filtered);
      changed = true;
    }
    if (changed) this.layoutPage(mounted);
  }

  private isNativeAnnotationVisible(key: string): boolean {
    return this.nativeVisibleIDs === undefined || this.nativeVisibleIDs.has(key);
  }

  private drawLeaderLine(
    svg: SVGSVGElement,
    runtime: CardRuntime,
    cardY: number,
    cardHeight: number,
    pageWidth: number,
  ): void {
    const doc = svg.ownerDocument;
    const line = doc.createElementNS(SVG_NS, "polyline");
    const dot = doc.createElementNS(SVG_NS, "circle");
    const endY = cardY + Math.min(26, cardHeight / 2);
    const isLeft = runtime.anchor.side === "left";
    const elbowX = isLeft ? -12 : pageWidth + 12;
    const endX = isLeft ? -CARD_GAP_FROM_PAGE : pageWidth + CARD_GAP_FROM_PAGE;
    line.classList.add("zmc-line");
    line.dataset.annotationKey = runtime.annotation.key;
    line.classList.toggle("zmc-hovered", this.hoveredKey === runtime.annotation.key);
    line.setAttribute(
      "points",
      `${runtime.anchor.x},${runtime.anchor.y} ${elbowX},${runtime.anchor.y} ${endX},${endY}`,
    );
    line.setAttribute("stroke", runtime.annotation.color);
    dot.classList.add("zmc-line-dot");
    dot.dataset.annotationKey = runtime.annotation.key;
    dot.classList.toggle("zmc-hovered", this.hoveredKey === runtime.annotation.key);
    dot.setAttribute("cx", String(runtime.anchor.x));
    dot.setAttribute("cy", String(runtime.anchor.y));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", runtime.annotation.color);
    svg.append(line, dot);
  }

  private queueSave(runtime: CardRuntime): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined;
      void this.persist(runtime);
    }, 700);
  }

  private async persist(runtime: CardRuntime): Promise<void> {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    if (!runtime.dirty || runtime.saving || runtime.annotation.readOnly) return;

    const value = runtime.currentValue;
    runtime.saving = true;
    if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
    runtime.statusTimer = undefined;
    runtime.state.dataset.error = "false";
    runtime.state.textContent = "正在保存…";
    try {
      await this.store.saveComment(runtime.annotation.itemID, value);
      runtime.originalValue = value;
      runtime.annotation.comment = value;
      runtime.dirty = runtime.currentValue !== value;
      this.updatePreview(runtime);
      runtime.state.textContent = runtime.dirty ? "有新修改" : "已保存";
      if (!runtime.dirty) {
        runtime.statusTimer = setTimeout(() => {
          runtime.statusTimer = undefined;
          if (!runtime.dirty && !runtime.saving && !runtime.annotation.readOnly) {
            runtime.state.textContent = "";
            runtime.measuredHeight = undefined;
            this.relayoutRuntime(runtime);
          }
        }, 1200);
      }
      if (value.trim()) this.forcedKeys.delete(runtime.annotation.key);
    } catch (error) {
      runtime.dirty = true;
      runtime.state.dataset.error = "true";
      runtime.state.textContent = error instanceof Error ? error.message : "保存失败";
      (Zotero as any).logError?.(error);
    } finally {
      runtime.saving = false;
      if (runtime.dirty && runtime.currentValue !== value) this.queueSave(runtime);
      this.flushPendingRefresh();
    }
  }

  private cancelEdit(runtime: CardRuntime): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.currentValue = runtime.originalValue;
    this.renderComment(runtime.editor, runtime.originalValue);
    runtime.annotation.comment = runtime.originalValue;
    runtime.dirty = false;
    runtime.state.dataset.error = "false";
    runtime.state.textContent = runtime.annotation.readOnly ? "只读" : "已取消";
    if (!runtime.annotation.readOnly) {
      runtime.statusTimer = setTimeout(() => {
        runtime.statusTimer = undefined;
        runtime.state.textContent = "";
        runtime.measuredHeight = undefined;
        this.relayoutRuntime(runtime);
      }, 1200);
    }
    this.updatePreview(runtime);
    this.resizeEditor(runtime.editor);
    runtime.editor.blur();
  }

  private openEditor(runtime: CardRuntime, selectAll = false): void {
    if (runtime.annotation.readOnly) return;
    runtime.card.classList.add("zmc-editing");
    runtime.preview.classList.add("zmc-preview-hidden");
    runtime.editor.classList.remove("zmc-editor-hidden");
    this.resizeEditor(runtime.editor);
    const mounted = this.mountedPages.get(runtime.annotation.position.pageIndex);
    if (mounted) this.layoutPage(mounted);
    runtime.editor.focus();
    if (selectAll) selectEditorContents(runtime.editor);
  }

  private closeEditor(runtime: CardRuntime, pageIndex: number): void {
    runtime.card.classList.remove("zmc-editing");
    runtime.editor.classList.add("zmc-editor-hidden");
    runtime.preview.classList.remove("zmc-preview-hidden");
    const mounted = this.mountedPages.get(pageIndex);
    if (mounted) this.layoutPage(mounted);
  }

  private updatePreview(runtime: CardRuntime): void {
    const value = runtime.currentValue;
    if (value) {
      this.renderComment(runtime.preview, value);
    } else {
      runtime.preview.textContent = runtime.editor.dataset.placeholder ?? "";
    }
    runtime.preview.classList.toggle("zmc-empty-preview", !value);
  }

  private renderComment(root: HTMLElement, value: string): void {
    try {
      renderStoredComment(root, value);
    } catch (error) {
      // A rich-text compatibility failure must not prevent every annotation
      // on the page from mounting. Plain text remains editable and visible.
      root.textContent = value;
      (Zotero as any).logError?.(error);
    }
  }

  private readComment(root: HTMLElement): string {
    try {
      return readStoredComment(root);
    } catch (error) {
      (Zotero as any).logError?.(error);
      return root.textContent?.trim() ?? "";
    }
  }

  private copyTextToClipboard(value: string): boolean {
    try {
      const copy = (Zotero as any).Utilities?.Internal?.copyTextToClipboard;
      if (typeof copy !== "function") return false;
      copy.call((Zotero as any).Utilities.Internal, value);
      return true;
    } catch (error) {
      (Zotero as any).logError?.(error);
      return false;
    }
  }

  private measureRuntimeHeight(
    runtime: CardRuntime,
    mounted: MountedPage,
  ): number {
    const mode = [
      mounted.overlay.classList.contains("zmc-low-zoom") ? "low" : "normal",
      runtime.card.classList.contains("zmc-editing") ? "editing" : "preview",
      runtime.state.textContent ? "status" : "plain",
    ].join(":");
    if (runtime.measuredHeight === undefined || runtime.heightMode !== mode) {
      runtime.measuredHeight = measureHeight(runtime.card, runtime.currentValue);
      runtime.heightMode = mode;
    }
    return runtime.measuredHeight;
  }

  private relayoutRuntime(runtime: CardRuntime): void {
    const mounted = this.mountedPages.get(runtime.annotation.position.pageIndex);
    if (mounted) this.layoutPage(mounted);
  }

  private resizeEditor(editor: HTMLElement): void {
    editor.style.height = "0px";
    const fallback = Math.min(156, Math.max(37, 24 + (editor.textContent ?? "").split("\n").length * 18));
    const height = Math.min(156, Math.max(37, editor.scrollHeight || fallback));
    editor.style.height = `${height}px`;
  }

  private setActive(key: string): void {
    this.activeKey = key;
    this.syncActiveCards();
  }

  private setHovered(key?: string): void {
    if (this.hoveredKey === key) return;
    const previous = this.hoveredKey;
    this.hoveredKey = key;
    if (previous) this.adapter.setAnnotationHover(previous, false);
    if (key) this.adapter.setAnnotationHover(key, true);

    for (const runtime of this.cardRuntimes()) {
      runtime.card.classList.toggle("zmc-hovered", runtime.annotation.key === key);
    }
    const lineElements = Array.from(
      this.adapter.document().querySelectorAll(".zmc-line, .zmc-line-dot"),
    ) as unknown as SVGElement[];
    for (const element of lineElements) {
      element.classList.toggle("zmc-hovered", element.dataset.annotationKey === key);
    }
  }

  private syncActiveCards(): void {
    for (const runtime of this.cardRuntimes()) {
      runtime.card.classList.toggle("zmc-active", runtime.annotation.key === this.activeKey);
    }
  }

  private syncCompactNoteIcons(): void {
    this.adapter.setCompactNoteIcons(
      this.compactNoteIcons,
      this.annotations
        .filter((annotation) => annotation.type === "note")
        .map((annotation) => annotation.key),
    );
  }

  private hasBlockingEditor(): boolean {
    return this.cardRuntimes().some(
      (runtime) =>
        runtime.saving || runtime.editor.ownerDocument.activeElement === runtime.editor,
    );
  }

  private flushPendingRefresh(): void {
    if (this.pendingRefresh && !this.hasBlockingEditor()) void this.refresh(true);
  }

  private cardRuntimes(): CardRuntime[] {
    return [...this.mountedPages.values()].flatMap((page) => page.runtimes);
  }

  private ensureStyles(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PDF_STYLES;
    doc.head.append(style);
  }

  private ensureOverlayRoot(doc: Document, viewer: HTMLElement): void {
    const host = viewer.closest<HTMLElement>("#viewerContainer")
      ?? viewer.parentElement
      ?? viewer;
    if (!this.overlayRoot) {
      this.overlayRoot = doc.createElement("div");
      this.overlayRoot.className = "zmc-overlay-root";
    }
    if (this.overlayRoot.parentElement !== host) host.append(this.overlayRoot);
  }

  private positionOverlay(mounted: MountedPage): void {
    const root = this.overlayRoot;
    const host = root?.parentElement;
    if (!root || !host) return;
    if (mounted.overlay.parentElement !== root) root.append(mounted.overlay);

    const pageRect = mounted.handle.element.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = pageRect.width || pageRect.height
      ? pageRect.left - hostRect.left + host.scrollLeft - host.clientLeft
      : mounted.handle.element.offsetLeft;
    const top = pageRect.width || pageRect.height
      ? pageRect.top - hostRect.top + host.scrollTop - host.clientTop
      : mounted.handle.element.offsetTop;
    const { width, height } = this.pageDimensions(mounted.handle, pageRect);
    setPixelStyle(mounted.overlay, "left", left);
    setPixelStyle(mounted.overlay, "top", top);
    setPixelStyle(mounted.overlay, "width", width);
    setPixelStyle(mounted.overlay, "height", height);
  }

  private annotationAnchorForHandle(
    annotation: MarginAnnotation,
    handle: PdfPageHandle,
  ): PageAnchor | undefined {
    const anchor = this.compactNoteIcons && annotation.type === "note"
      ? compactNoteAnchor(annotation.position, handle.viewport)
      : annotationAnchor(annotation.position, handle.viewport);
    if (!anchor) return undefined;
    const { width, height } = this.pageDimensions(handle);
    const scaleX = handle.viewport.width > 0 ? width / handle.viewport.width : 1;
    const scaleY = handle.viewport.height > 0 ? height / handle.viewport.height : 1;
    return {
      x: Math.max(0, Math.min(width, anchor.x * scaleX)),
      y: Math.max(0, Math.min(height, anchor.y * scaleY)),
      side: anchor.side,
    };
  }

  private pageDimensions(
    handle: PdfPageHandle,
    rect = handle.element.getBoundingClientRect(),
  ): { width: number; height: number } {
    return {
      width: handle.element.clientWidth || rect.width || handle.viewport.width,
      height: handle.element.clientHeight || rect.height || handle.viewport.height,
    };
  }

  private unmountPage(pageIndex: number): void {
    const mounted = this.mountedPages.get(pageIndex);
    if (!mounted) return;
    for (const runtime of mounted.runtimes) {
      if (runtime.timer) clearTimeout(runtime.timer);
      if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
    }
    mounted.overlay.remove();
    mounted.handle.element.classList.remove("zmc-page");
    this.mountedPages.delete(pageIndex);
  }

  private removeUi(): void {
    for (const pageIndex of [...this.mountedPages.keys()]) this.unmountPage(pageIndex);
    try {
      this.adapter.viewerElement().classList.remove("zmc-viewer");
      this.adapter.document().getElementById(STYLE_ID)?.remove();
    } catch {
      // The reader may already be closed.
    }
    this.overlayRoot?.remove();
    this.overlayRoot = undefined;
  }
}

function typeLabel(type: MarginAnnotation["type"]): string {
  return {
    highlight: "高亮解释",
    underline: "下划线解释",
    note: "独立评论",
    text: "文本批注",
    image: "区域批注",
  }[type];
}

function measureHeight(card: HTMLElement, value: string): number {
  const measured = card.getBoundingClientRect().height || card.scrollHeight;
  if (measured > 0) return measured;
  return Math.min(210, Math.max(70, 54 + value.split("\n").length * 18));
}

function setPixelStyle(
  element: HTMLElement,
  property: "left" | "top" | "width" | "height",
  value: number,
): void {
  const next = `${value}px`;
  if (element.style[property] !== next) element.style[property] = next;
}
