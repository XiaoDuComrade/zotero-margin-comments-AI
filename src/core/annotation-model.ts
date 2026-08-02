import type {
  AnnotationPosition,
  MarginAnnotation,
  MarginAnnotationType,
  PageAnchor,
  ViewportLike,
} from "./types";
import { MARGIN_ANNOTATION_TYPES } from "./types";

const SUPPORTED_TYPES = new Set<MarginAnnotationType>(MARGIN_ANNOTATION_TYPES);

// Zotero 9 stores note positions as a 22 x 22 PDF rectangle, while the
// Canvas renderer draws a 24 x 24 icon from that rectangle's top-left corner.
// Compact mode draws the icon at 14 x 14 and keeps the original 24 x 24
// visual box centre fixed.
export const ZOTERO_NOTE_POSITION_SIZE = 22;
export const ZOTERO_NOTE_ICON_SIZE = 24;
export const COMPACT_NOTE_ICON_SIZE = 14;
export const COMPACT_NOTE_ICON_OFFSET =
  (ZOTERO_NOTE_ICON_SIZE - COMPACT_NOTE_ICON_SIZE) / 2;

export function isSupportedType(value: unknown): value is MarginAnnotationType {
  return typeof value === "string" && SUPPORTED_TYPES.has(value as MarginAnnotationType);
}

export function parsePosition(value: unknown): AnnotationPosition | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  if (!candidate || typeof candidate !== "object") return undefined;
  const position = candidate as Partial<AnnotationPosition>;
  if (!Number.isInteger(position.pageIndex) || Number(position.pageIndex) < 0) {
    return undefined;
  }

  return {
    pageIndex: Number(position.pageIndex),
    rects: validArrays(position.rects),
    nextPageRects: validArrays(position.nextPageRects),
    paths: validArrays(position.paths),
    width: typeof position.width === "number" ? position.width : undefined,
  };
}

export function shouldDisplayAnnotation(
  annotation: MarginAnnotation,
  forcedKeys: ReadonlySet<string> = new Set(),
): boolean {
  return (
    forcedKeys.has(annotation.key) ||
    annotation.type === "note" ||
    annotation.comment.trim().length > 0
  );
}

export function annotationAnchor(
  position: AnnotationPosition,
  viewport: ViewportLike,
): PageAnchor | undefined {
  const rects = position.rects?.filter((rect) => rect.length >= 4) ?? [];
  if (rects.length) {
    const converted = rects.map((rect) => convertRect(rect, viewport));
    const leftmost = Math.min(...converted.map((rect) => rect[0]));
    const rightmost = Math.max(...converted.map((rect) => rect[2]));
    const top = Math.min(...converted.map((rect) => rect[1]));
    const bottom = Math.max(...converted.map((rect) => rect[3]));
    return marginFacingAnchor(leftmost, rightmost, top, bottom, viewport);
  }

  const points = (position.paths ?? [])
    .flatMap((path) => pairs(path))
    .map(([x, y]) => viewport.convertToViewportPoint(x, y));
  if (!points.length) return undefined;

  const leftmost = Math.min(...points.map(([x]) => x));
  const rightmost = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  return marginFacingAnchor(leftmost, rightmost, top, bottom, viewport);
}

export function compactNoteAnchor(
  position: AnnotationPosition,
  viewport: ViewportLike,
): PageAnchor | undefined {
  const rect = position.rects?.find((candidate) => candidate.length >= 4);
  if (!rect) return annotationAnchor(position, viewport);

  const [left, top, right, bottom] = convertRect(rect, viewport);
  const unitX = (right - left) / ZOTERO_NOTE_POSITION_SIZE;
  const unitY = (bottom - top) / ZOTERO_NOTE_POSITION_SIZE;
  if (!(unitX > 0) || !(unitY > 0)) return annotationAnchor(position, viewport);

  const compactLeft = left + COMPACT_NOTE_ICON_OFFSET * unitX;
  const compactTop = top + COMPACT_NOTE_ICON_OFFSET * unitY;
  return marginFacingAnchor(
    compactLeft,
    compactLeft + COMPACT_NOTE_ICON_SIZE * unitX,
    compactTop,
    compactTop + COMPACT_NOTE_ICON_SIZE * unitY,
    viewport,
  );
}

function convertRect(rect: number[], viewport: ViewportLike): number[] {
  const [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

function marginFacingAnchor(
  left: number,
  right: number,
  top: number,
  bottom: number,
  viewport: ViewportLike,
): PageAnchor {
  const side = (left + right) / 2 < viewport.width / 2 ? "left" : "right";
  return {
    x: Math.max(0, Math.min(viewport.width, side === "left" ? left : right)),
    y: Math.max(0, Math.min(viewport.height, top)),
    side,
  };
}

function validArrays(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (entry): entry is number[] =>
      Array.isArray(entry) && entry.length > 0 && entry.every(Number.isFinite),
  );
  return result.length ? result.map((entry) => entry.slice()) : undefined;
}

function pairs(values: number[]): [number, number][] {
  const result: [number, number][] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    result.push([values[index], values[index + 1]]);
  }
  return result;
}
