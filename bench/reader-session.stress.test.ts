import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarginAnnotation } from "../src/core/types";
import { ReaderSession } from "../src/zotero/reader-session";

interface StressResult {
  annotations: number;
  initialRenderMs: number;
  expandMs: number;
  filterDispatchMs: number;
  filterApplyMs: number;
  filterRestoreDispatchMs: number;
  filterRestoreMs: number;
  scrollEventMs: number;
  scaleTotalMs: number;
  scaleFrameMs: number;
  cards: number;
  visibleLines: number;
}

describe("ReaderSession stress", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("profiles dense pages without dropping cards", async () => {
    const results: StressResult[] = [];
    for (const count of [50, 150, 300, 600, 1_000]) {
      results.push(await runScenario(count));
    }

    console.log(`STRESS_RESULTS ${JSON.stringify(results)}`);
    expect(results.map((result) => result.cards)).toEqual([
      50,
      150,
      300,
      600,
      1_000,
    ]);
    expect(results.every((result) => Number.isFinite(result.scaleFrameMs))).toBe(true);
  });
});

async function runScenario(count: number): Promise<StressResult> {
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.stubGlobal("Zotero", { logError: vi.fn() });

  const viewerContainer = document.createElement("div");
  viewerContainer.id = "viewerContainer";
  const viewer = document.createElement("div");
  viewer.id = "viewer";
  viewer.className = "pdfViewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  viewer.append(page);
  viewerContainer.append(viewer);
  document.body.append(viewerContainer);

  let pageWidth = 800;
  page.getBoundingClientRect = () =>
    rect(320 - viewerContainer.scrollLeft, 20, pageWidth, 900);
  viewerContainer.getBoundingClientRect = () => rect(0, 0, 1440, 1000);
  const viewport = {
    width: 800,
    height: 900,
    convertToViewportPoint: (x: number, y: number): [number, number] => [
      x * (pageWidth / 800),
      900 - y,
    ],
  };

  const callbacks = new Map<string, () => void>();
  const animationFrames: FrameRequestCallback[] = [];
  const eventBus = {
    on: (name: string, callback: () => void) => callbacks.set(name, callback),
    off: () => undefined,
  };
  const pdfViewer = {
    currentScale: 1,
    currentPageNumber: 1,
    pagesPromise: Promise.resolve(),
    getPageView: () => ({ div: page, viewport }),
  };
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame: () => undefined,
    PDFViewerApplication: {
      initializedPromise: Promise.resolve(),
      eventBus,
      pdfViewer,
    },
  });

  const annotations = makeAnnotations(count);
  const nativeAnnotations = annotations.map((annotation) => ({
    id: annotation.key,
  })) as Array<{ id: string; _hidden?: boolean }>;
  const store = {
    list: () => annotations,
    saveComment: async () => undefined,
  };
  const internalReader: any = {
    initializedPromise: new Promise(() => undefined),
    _state: {
      selectedAnnotationIDs: [],
      annotations: nativeAnnotations,
    },
    _updateState(state: Record<string, unknown>) {
      this._state = { ...this._state, ...state };
    },
    setSelectedAnnotations: () => undefined,
    _primaryView: {
      initializedPromise: Promise.resolve(),
      _iframeWindow: window,
      _iframeDocument: document,
    },
  };
  const reader = {
    itemID: 1,
    _initPromise: Promise.resolve(),
    _internalReader: internalReader,
    navigate: () => undefined,
  };
  const session = new ReaderSession(reader, store as any, () => undefined);

  const initialStart = performance.now();
  await session.start(true);
  const initialRenderMs = performance.now() - initialStart;

  const stableCard = document.querySelector(".zmc-card");
  nativeAnnotations.forEach((annotation, index) => {
    if (index % 2 === 0) annotation._hidden = true;
  });
  const filterDispatchStart = performance.now();
  internalReader._updateState({ annotations: [...nativeAnnotations] });
  const filterDispatchMs = performance.now() - filterDispatchStart;
  await delay(90);
  const filterStart = performance.now();
  while (animationFrames.length) {
    animationFrames.shift()!(performance.now());
  }
  const filterApplyMs = performance.now() - filterStart;

  nativeAnnotations.forEach((annotation) => delete annotation._hidden);
  const filterRestoreDispatchStart = performance.now();
  internalReader._updateState({ annotations: [...nativeAnnotations] });
  const filterRestoreDispatchMs = performance.now() - filterRestoreDispatchStart;
  await delay(90);
  const filterRestoreStart = performance.now();
  while (animationFrames.length) {
    animationFrames.shift()!(performance.now());
  }
  const filterRestoreMs = performance.now() - filterRestoreStart;
  expect(document.querySelector(".zmc-card")).toBe(stableCard);

  const expandStart = performance.now();
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".zmc-margin-toggle:not([hidden])",
  )) {
    button.click();
  }
  const expandMs = performance.now() - expandStart;

  const scrollports = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".zmc-margin-expanded .zmc-margin-scrollport",
    ),
  );
  const scrollStart = performance.now();
  for (let index = 0; index < 30; index += 1) {
    for (const scrollport of scrollports) {
      scrollport.scrollTop = index * 24;
      scrollport.dispatchEvent(new Event("scroll"));
    }
  }
  const scrollEventMs = (performance.now() - scrollStart) / 60;

  const scaleStart = performance.now();
  for (let cycle = 0; cycle < 10; cycle += 1) {
    pageWidth = cycle % 2 ? 800 : 880;
    callbacks.get("scalechanging")?.();
    while (animationFrames.length) {
      animationFrames.shift()!(performance.now());
    }
  }
  const scaleTotalMs = performance.now() - scaleStart;

  const result = {
    annotations: count,
    initialRenderMs: round(initialRenderMs),
    expandMs: round(expandMs),
    filterDispatchMs: round(filterDispatchMs),
    filterApplyMs: round(filterApplyMs),
    filterRestoreDispatchMs: round(filterRestoreDispatchMs),
    filterRestoreMs: round(filterRestoreMs),
    scrollEventMs: round(scrollEventMs),
    scaleTotalMs: round(scaleTotalMs),
    scaleFrameMs: round(scaleTotalMs / 40),
    cards: document.querySelectorAll(".zmc-card").length,
    visibleLines: document.querySelectorAll(".zmc-line").length,
  };
  session.destroy();
  return result;
}

function makeAnnotations(count: number): MarginAnnotation[] {
  return Array.from({ length: count }, (_, index) => {
    const left = index % 2 === 0;
    const top = 20 + (index % 30) * 28;
    const x1 = left ? 40 : 610;
    return {
      itemID: index + 1,
      key: `STRESS${String(index).padStart(5, "0")}`,
      type: index % 7 === 0 ? "note" : "highlight",
      comment: Array.from(
        { length: 1 + (index % 4) },
        (_, line) => `第 ${index + 1} 条评论第 ${line + 1} 行`,
      ).join("\n"),
      color: index % 2 ? "#ffd400" : "#ff6666",
      pageLabel: "1",
      position: {
        pageIndex: 0,
        rects: [[x1, 900 - top - 10, x1 + 150, 900 - top]],
      },
      readOnly: false,
    } as MarginAnnotation;
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
