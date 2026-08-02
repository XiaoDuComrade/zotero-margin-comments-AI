import { describe, expect, it } from "vitest";
import {
  annotationAnchor,
  compactNoteAnchor,
  parsePosition,
  shouldDisplayAnnotation,
} from "../src/core/annotation-model";
import type { MarginAnnotation } from "../src/core/types";

const base: MarginAnnotation = {
  itemID: 1,
  key: "ABC12345",
  type: "highlight",
  comment: "解释",
  color: "#ffd400",
  pageLabel: "2",
  position: { pageIndex: 1, rects: [[10, 20, 40, 30]] },
  readOnly: false,
};

describe("annotation model", () => {
  it("parses Zotero's JSON annotation position", () => {
    expect(
      parsePosition('{"pageIndex":2,"rects":[[10,20,30,40]]}'),
    ).toEqual({
      pageIndex: 2,
      rects: [[10, 20, 30, 40]],
      nextPageRects: undefined,
      paths: undefined,
      width: undefined,
    });
    expect(parsePosition("not-json")).toBeUndefined();
    expect(parsePosition({ pageIndex: -1 })).toBeUndefined();
  });

  it("chooses the nearest page side and its facing edge", () => {
    const anchor = annotationAnchor(
      {
        pageIndex: 0,
        rects: [
          [10, 80, 50, 90],
          [10, 60, 70, 70],
        ],
      },
      {
        width: 100,
        height: 100,
        convertToViewportPoint: (x, y) => [x, 100 - y],
      },
    );
    expect(anchor).toEqual({ x: 10, y: 10, side: "left" });

    expect(
      annotationAnchor(
        { pageIndex: 0, rects: [[60, 60, 90, 70]] },
        {
          width: 100,
          height: 100,
          convertToViewportPoint: (x, y) => [x, 100 - y],
        },
      ),
    ).toEqual({ x: 90, y: 30, side: "right" });
  });

  it("anchors compact notes to the centred 14-unit visual icon", () => {
    const anchor = compactNoteAnchor(
      { pageIndex: 0, rects: [[60, 58, 82, 80]] },
      {
        width: 100,
        height: 100,
        convertToViewportPoint: (x, y) => [x, 100 - y],
      },
    );

    expect(anchor).toEqual({ x: 79, y: 25, side: "right" });
  });

  it("shows notes, comments, and explicitly revealed empty highlights", () => {
    expect(shouldDisplayAnnotation(base)).toBe(true);
    expect(shouldDisplayAnnotation({ ...base, comment: "" })).toBe(false);
    expect(shouldDisplayAnnotation({ ...base, type: "note", comment: "" })).toBe(true);
    expect(
      shouldDisplayAnnotation({ ...base, comment: "" }, new Set([base.key])),
    ).toBe(true);
  });
});
