import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARGIN_ANNOTATION_TYPES,
  type MarginAnnotation,
} from "../src/core/types";
import { ReaderSession } from "../src/zotero/reader-session";

describe("ReaderSession", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", {
      logError: vi.fn(),
      Utilities: {
        Internal: {
          copyTextToClipboard: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders leader cards and writes edited text back", async () => {
    const viewer = document.createElement("div");
    viewer.id = "viewer";
    viewer.className = "pdfViewer";
    const viewerContainer = document.createElement("div");
    viewerContainer.id = "viewerContainer";
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    let renderedPageWidth = 600;
    page.getBoundingClientRect = () => {
      const left = 300 - viewerContainer.scrollLeft;
      return {
        x: left,
        y: 20,
        left,
        top: 20,
        right: left + renderedPageWidth,
        bottom: 240,
        width: renderedPageWidth,
        height: 220,
        toJSON: () => ({}),
      };
    };
    viewer.getBoundingClientRect = () => {
      const left = -viewerContainer.scrollLeft;
      return {
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + 1200,
        bottom: 1600,
        width: 1200,
        height: 1600,
        toJSON: () => ({}),
      };
    };
    viewerContainer.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    });
    viewer.append(page);
    viewerContainer.append(viewer);
    viewerContainer.scrollLeft = 140;
    document.body.append(viewerContainer);

    let viewportScaleX = 1;
    const viewport = {
      width: 600,
      height: 220,
      convertToViewportPoint: (x: number, y: number): [number, number] => [
        x * viewportScaleX,
        220 - y,
      ],
    };
    const layoutHandlers = new Map<string, () => void>();
    const eventBus = {
      on: vi.fn((eventName: string, callback: () => void) => {
        layoutHandlers.set(eventName, callback);
      }),
      off: vi.fn(),
    };
    const pdfViewer = {
      currentScale: 0.75,
      currentPageNumber: 1,
      pagesPromise: Promise.resolve(),
      getPageView: () => ({ div: page, viewport }),
    };
    Object.assign(window, {
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 16),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      PDFViewerApplication: {
        initializedPromise: Promise.resolve(),
        eventBus,
        pdfViewer,
      },
    });

    const annotations: MarginAnnotation[] = [
      {
        itemID: 21,
        key: "COMMENT1",
        type: "highlight",
        comment: "原有解释",
        color: "#ffd400",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[10, 180, 250, 200]] },
        readOnly: false,
      },
      {
        itemID: 22,
        key: "NOTE0001",
        type: "note",
        comment: "",
        color: "#2ea8e5",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[300, 98, 322, 120]] },
        readOnly: false,
      },
      {
        itemID: 23,
        key: "COMMENT2",
        type: "highlight",
        comment: "第二条左侧解释",
        color: "#ff6666",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[20, 100, 220, 120]] },
        readOnly: false,
      },
      {
        itemID: 24,
        key: "COMMENT3",
        type: "highlight",
        comment: "第三条左侧解释",
        color: "#5fb236",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[30, 20, 230, 40]] },
        readOnly: false,
      },
    ];
    const store = {
      list: vi.fn(() => annotations),
      saveComment: vi.fn(async () => undefined),
    };
    const annotationHost = document.createElement("div");
    annotationHost.id = "annotation-overlay";
    const annotationShadowRoot = annotationHost.attachShadow({ mode: "open" });
    const annotationRenderRoot = document.createElement("div");
    const nativeAnnotation = document.createElement("div");
    nativeAnnotation.dataset.annotationId = "COMMENT1";
    const nativeNoteIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    nativeNoteIcon.dataset.annotationId = "NOTE0001";
    annotationRenderRoot.append(nativeAnnotation, nativeNoteIcon);
    annotationShadowRoot.append(annotationRenderRoot);
    document.body.append(annotationHost);
    const nativeStateAnnotations = annotations.map((annotation) => ({
      id: annotation.key,
      type: annotation.type,
      position: annotation.position,
      color: annotation.color,
      readOnly: annotation.readOnly,
    }));
    const nativeNote = nativeStateAnnotations.find(
      (annotation) => annotation.id === "NOTE0001",
    )!;
    const noteContext = {
      save: vi.fn(),
      transform: vi.fn(),
      restore: vi.fn(),
    };
    const rendererPrototype = {
      _drawNote: vi.fn(function (this: any, annotation: any) {
        this._drawNoteIcon(this._context, annotation.color);
      }),
    };
    const renderer: any = Object.assign(Object.create(rendererPrototype), {
      _context: noteContext,
      _scale: 1,
      _drawNoteIcon: vi.fn(),
      _invalidateSignature: vi.fn(),
      _p2v: (position: MarginAnnotation["position"]) => ({
        ...position,
        rects: position.rects?.map(([x1, y1, x2, y2]) => [
          x1,
          220 - y2,
          x2,
          220 - y1,
        ]),
      }),
    });
    const nativePage = {
      _pageIndex: 0,
      _pageRenderer: renderer,
      _detailRenderer: undefined,
      render: vi.fn(() => renderer._drawNote(nativeNote)),
    };
    const viewPrototype = {
      getSelectableAnnotations(this: any, position: MarginAnnotation["position"]) {
        const point = position.rects?.[0];
        if (!point) return [];
        const [left, bottom, right, top] = nativeNote.position.rects![0];
        return point[0] >= left && point[0] <= right
          && point[1] >= bottom && point[1] <= top
          ? [nativeNote]
          : [];
      },
      getSelectedAnnotationAction(_annotation: any, _position: any) {
        return { type: "moveAndDrag" };
      },
    };
    const primaryView: any = Object.assign(Object.create(viewPrototype), {
      initializedPromise: Promise.resolve(),
      _iframeWindow: window,
      _iframeDocument: document,
      _annotationRenderRootEl: annotationRenderRoot,
      _pages: [nativePage],
      getPageByIndex: (pageIndex: number) => pageIndex === 0 ? nativePage : undefined,
    });
    const nativeUpdateState = vi.fn(function (
      this: any,
      state: Record<string, unknown>,
    ) {
      this._state = { ...this._state, ...state };
    });
    const internalReader: any = {
      // This promise remains pending in Zotero 9.0.6 even when the PDF view is ready.
      initializedPromise: new Promise(() => undefined),
      _state: {
        selectedAnnotationIDs: [],
        annotations: nativeStateAnnotations,
      },
      _updateState: nativeUpdateState,
      setSelectedAnnotations: vi.fn(),
      _primaryView: primaryView,
    };
    Object.assign(window, { _reader: internalReader });
    internalReader._annotationManager = {
      setFilter: vi.fn(async ({ hiddenIDs = [] }: { hiddenIDs?: string[] }) => {
        for (const annotation of nativeStateAnnotations) {
          if (hiddenIDs.includes(annotation.id)) {
            (annotation as any)._hidden = true;
          } else {
            delete (annotation as any)._hidden;
          }
        }
        internalReader._updateState({ annotations: [...nativeStateAnnotations] });
      }),
    };
    let releaseReaderInit!: () => void;
    const readerInit = new Promise<void>((resolve) => {
      releaseReaderInit = resolve;
    });
    const reader = {
      itemID: 5,
      _initPromise: readerInit,
      _internalReader: internalReader,
      _iframeWindow: window,
      navigate: vi.fn(),
    };
    const session = new ReaderSession(reader, store as any, vi.fn());

    const starting = session.start(true);
    // Zotero can notify about annotations before the Reader adapter is ready.
    // This must cache the data without trying to touch the PDF DOM prematurely.
    await expect(session.refresh(true)).resolves.toBeUndefined();
    expect(document.querySelector(".zmc-page-overlay")).toBeNull();
    releaseReaderInit();
    await starting;
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(4);
    expect(document.querySelectorAll(".zmc-card-left")).toHaveLength(3);
    expect(document.querySelectorAll(".zmc-card-right")).toHaveLength(1);
    expect(document.querySelectorAll(".zmc-line")).toHaveLength(3);
    expect(document.querySelector(".zmc-card-header")).toBeNull();
    expect(document.querySelector(".zmc-save-button")).toBeNull();
    expect(document.querySelector(".zmc-page-overlay.zmc-low-zoom")).not.toBeNull();
    expect(document.getElementById("zmc-pdf-styles")?.textContent).toContain(
      "padding-inline",
    );

    const originalDrawNote = rendererPrototype._drawNote;
    const originalSelectable = viewPrototype.getSelectableAnnotations;
    const originalSelectedAction = viewPrototype.getSelectedAnnotationAction;
    session.setCompactNoteIcons(true);
    expect(rendererPrototype._drawNote).not.toBe(originalDrawNote);
    expect(viewPrototype.getSelectableAnnotations).not.toBe(originalSelectable);
    expect(viewPrototype.getSelectedAnnotationAction).not.toBe(originalSelectedAction);
    expect(noteContext.transform).toHaveBeenLastCalledWith(
      14 / 24,
      0,
      0,
      14 / 24,
      305,
      105,
    );
    expect(
      primaryView.getSelectableAnnotations({
        pageIndex: 0,
        rects: [[312, 108, 312, 108]],
      }),
    ).toEqual([nativeNote]);
    expect(
      primaryView.getSelectableAnnotations({
        pageIndex: 0,
        rects: [[301, 119, 301, 119]],
      }),
    ).toEqual([]);
    expect(
      primaryView.getSelectedAnnotationAction(nativeNote, {
        pageIndex: 0,
        rects: [[301, 119, 301, 119]],
      }),
    ).toBeNull();
    expect(
      document
        .querySelector('.zmc-line[data-annotation-key="NOTE0001"]')
        ?.getAttribute("points"),
    ).toMatch(/^319,105 /);
    session.setCompactNoteIcons(false);
    expect(rendererPrototype._drawNote).toBe(originalDrawNote);
    expect(viewPrototype.getSelectableAnnotations).toBe(originalSelectable);
    expect(viewPrototype.getSelectedAnnotationAction).toBe(originalSelectedAction);

    session.setVisibleTypes(new Set(["note"]));
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(1);
    expect(document.querySelector('[data-annotation-key="NOTE0001"]')).not.toBeNull();
    session.setVisibleTypes(new Set());
    expect(document.querySelector(".zmc-page-overlay")).toBeNull();
    expect(viewer.classList.contains("zmc-viewer")).toBe(false);
    session.setVisibleTypes(new Set(MARGIN_ANNOTATION_TYPES));
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(4);

    const originalOverlay = document.querySelector(".zmc-page-overlay")!;
    const originalCard = document.querySelector(
      '.zmc-card[data-annotation-key="COMMENT1"]',
    )!;
    expect(page.contains(originalOverlay)).toBe(false);
    expect(originalOverlay.parentElement?.classList.contains("zmc-overlay-root")).toBe(true);
    expect(originalOverlay.parentElement?.parentElement).toBe(viewerContainer);
    expect(viewerContainer.contains(originalOverlay)).toBe(true);
    expect((originalOverlay as HTMLElement).style.left).toBe("300px");
    vi.useFakeTimers();
    expect(layoutHandlers.has("updateviewarea")).toBe(true);
    // PDF.js clears page-owned children during zoom. The plugin overlay must
    // live outside that subtree so the reset cannot remove it.
    page.replaceChildren();
    // PDF.js can update the rendered page box before its viewport. The anchor
    // must be corrected against the live box during that intermediate frame.
    renderedPageWidth = 720;
    pdfViewer.currentScale = 1;
    layoutHandlers.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(20);
    expect(viewerContainer.scrollLeft).toBe(60);
    expect(document.querySelector(".zmc-page-overlay")).toBe(originalOverlay);
    expect(
      document.querySelector('.zmc-card[data-annotation-key="COMMENT1"]'),
    ).toBe(originalCard);
    expect(originalOverlay.classList.contains("zmc-low-zoom")).toBe(false);
    expect((originalOverlay as HTMLElement).style.width).toBe("720px");
    expect(
      document
        .querySelector('.zmc-line[data-annotation-key="COMMENT1"]')
        ?.getAttribute("points"),
    ).toMatch(/^12,20 /);

    const secondCommentCard = document.querySelector<HTMLElement>(
      '.zmc-card[data-annotation-key="COMMENT2"]',
    )!;
    await internalReader._annotationManager.setFilter({
      hiddenIDs: ["COMMENT2"],
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(
      document.querySelector('.zmc-card[data-annotation-key="COMMENT2"]'),
    ).toBe(secondCommentCard);
    expect(secondCommentCard.classList.contains("zmc-filtered")).toBe(true);
    expect(document.querySelectorAll(".zmc-card:not(.zmc-filtered)")).toHaveLength(3);

    await internalReader._annotationManager.setFilter({ hiddenIDs: [] });
    await vi.advanceTimersByTimeAsync(120);
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(4);
    expect(
      document.querySelector('.zmc-card[data-annotation-key="COMMENT2"]'),
    ).toBe(secondCommentCard);
    expect(secondCommentCard.classList.contains("zmc-filtered")).toBe(false);

    viewport.width = 720;
    viewportScaleX = 1.2;
    layoutHandlers.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(80);
    expect(
      document
        .querySelector('.zmc-line[data-annotation-key="COMMENT1"]')
        ?.getAttribute("points"),
    ).toMatch(/^12,20 /);

    const leftColumn = document.querySelector<HTMLElement>(
      ".zmc-margin-column-left",
    )!;
    const overflowToggle = leftColumn.querySelector<HTMLButtonElement>(
      ".zmc-margin-toggle",
    )!;
    expect(overflowToggle.textContent).toContain("还有 1 条");
    expect(leftColumn.querySelectorAll(".zmc-overflow-hidden")).toHaveLength(1);
    overflowToggle.click();
    expect(leftColumn.classList.contains("zmc-margin-expanded")).toBe(true);
    expect(leftColumn.querySelectorAll(".zmc-overflow-hidden")).toHaveLength(0);
    const scrollport = leftColumn.querySelector<HTMLElement>(
      ".zmc-margin-scrollport",
    )!;
    scrollport.scrollTop = 50;
    scrollport.dispatchEvent(new Event("scroll"));
    expect(document.querySelectorAll(".zmc-line")).toHaveLength(4);
    overflowToggle.click();
    expect(leftColumn.classList.contains("zmc-margin-expanded")).toBe(false);

    const commentCard = document.querySelector<HTMLElement>(
      '.zmc-card[data-annotation-key="COMMENT1"]',
    )!;
    commentCard.dispatchEvent(new Event("pointerenter"));
    expect(commentCard.classList.contains("zmc-hovered")).toBe(true);
    expect(
      document.querySelector(
        '.zmc-line[data-annotation-key="COMMENT1"].zmc-hovered',
      ),
    ).not.toBeNull();
    expect(nativeAnnotation.classList.contains("zmc-native-hover")).toBe(true);
    commentCard.dispatchEvent(new Event("pointerleave"));
    expect(nativeAnnotation.classList.contains("zmc-native-hover")).toBe(false);

    const preview = document.querySelector<HTMLButtonElement>(
      '[data-annotation-key="COMMENT1"] .zmc-card-preview',
    )!;
    preview.click();
    const editor = document.querySelector<HTMLElement>(
      '[data-annotation-key="COMMENT1"] .zmc-card-editor',
    )!;
    expect(editor.classList.contains("zmc-editor-hidden")).toBe(false);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    const navigateCallsBeforeEditorPointer = reader.navigate.mock.calls.length;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.setEnd(editor.firstChild!, 4);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    editor.dispatchEvent(new Event("mousedown", { bubbles: true }));
    expect(reader.navigate).toHaveBeenCalledTimes(navigateCallsBeforeEditorPointer);
    expect(selection.toString()).toHaveLength(4);
    expect(document.getElementById("zmc-pdf-styles")?.textContent).toContain(
      "user-select: text !important",
    );
    expect(document.getElementById("zmc-pdf-styles")?.textContent).toContain(
      "background: Highlight !important",
    );
    const selectedText = selection.toString();
    const clipboardData = { setData: vi.fn() };
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", { value: clipboardData });
    editor.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", selectedText);

    const execCommand = vi.fn(() => true);
    (document as any).execCommand = execCommand;
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
    );
    expect((Zotero as any).Utilities.Internal.copyTextToClipboard).toHaveBeenLastCalledWith(
      selectedText,
    );
    expect(execCommand).not.toHaveBeenCalledWith("copy", false, null);
    editor.textContent = "修改后的解释";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(store.saveComment).toHaveBeenCalledWith(21, "修改后的解释");

    const noteEditor = document.querySelector<HTMLElement>(
      '[data-annotation-key="NOTE0001"] .zmc-card-editor',
    )!;
    noteEditor.textContent = "自动保存的独立评论";
    noteEditor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(store.saveComment).toHaveBeenCalledWith(22, "自动保存的独立评论");

    annotations.splice(0);
    await session.refresh(true);
    expect(viewer.classList.contains("zmc-viewer")).toBe(false);
    expect(document.querySelector(".zmc-overlay-root")).toBeNull();
    expect(document.querySelector(".zmc-page-overlay")).toBeNull();

    session.destroy();
    expect(document.querySelector(".zmc-page-overlay")).toBeNull();
    expect(internalReader._updateState).toBe(nativeUpdateState);
  });
});
