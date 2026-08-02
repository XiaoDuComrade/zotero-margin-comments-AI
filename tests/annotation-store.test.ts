import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationStore } from "../src/zotero/annotation-store";

afterEach(() => vi.unstubAllGlobals());

describe("AnnotationStore", () => {
  it("reads supported Zotero annotation fields", () => {
    const annotation = {
      id: 11,
      key: "ABCDEFGH",
      isAnnotation: () => true,
      isEditable: () => true,
      annotationType: "underline",
      annotationComment: "关键解释",
      annotationColor: "#ff6666",
      annotationPageLabel: "iv",
      annotationPosition: '{"pageIndex":3,"rects":[[1,2,3,4]]}',
    };
    vi.stubGlobal("Zotero", {
      Items: { get: () => ({ getAnnotations: () => [annotation] }) },
    });

    expect(new AnnotationStore().list(7)).toEqual([
      {
        itemID: 11,
        key: "ABCDEFGH",
        type: "underline",
        comment: "关键解释",
        color: "#ff6666",
        pageLabel: "iv",
        position: {
          pageIndex: 3,
          rects: [[1, 2, 3, 4]],
          nextPageRects: undefined,
          paths: undefined,
          width: undefined,
        },
        readOnly: false,
      },
    ]);
  });

  it("saves through the Zotero item transaction API", async () => {
    const saveTx = vi.fn(async () => undefined);
    const item = {
      isAnnotation: () => true,
      isEditable: () => true,
      annotationComment: "旧内容",
      saveTx,
    };
    vi.stubGlobal("Zotero", { Items: { get: () => item } });

    await new AnnotationStore().saveComment(1, "新内容");
    expect(item.annotationComment).toBe("新内容");
    expect(saveTx).toHaveBeenCalledOnce();
  });

  it("writes AI highlights with one color and one batched notifier commit", async () => {
    const saveFromJSON = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const attachment = {
      isAttachment: () => true,
      isEditable: () => true,
    };
    vi.stubGlobal("Zotero", {
      Items: { get: () => attachment },
      Notifier: { Queue: class {}, commit },
      DataObjectUtilities: { generateKey: () => "AIKEY001" },
      Annotations: { saveFromJSON },
    });

    const created = await new AnnotationStore().createAiHighlights(
      7,
      [
        {
          pdfPage: 1,
          quote: "Source",
          comment: "学术解释",
          category: "thesis",
          pageIndex: 0,
          pageLabel: "1",
          text: "Source",
          position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
          sortIndex: "00000|000001|00001",
        },
      ],
      "#a28ae5",
    );

    expect(created).toBe(1);
    expect(saveFromJSON).toHaveBeenCalledWith(
      attachment,
      expect.objectContaining({
        key: "AIKEY001",
        type: "highlight",
        color: "#a28ae5",
        tags: [{ name: "AI 学术标注" }],
      }),
      expect.objectContaining({ skipSelect: true }),
    );
    expect(commit).toHaveBeenCalledOnce();
  });
});
