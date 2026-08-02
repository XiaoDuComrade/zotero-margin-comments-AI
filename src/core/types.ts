export type MarginAnnotationType =
  | "highlight"
  | "underline"
  | "note"
  | "text"
  | "image";

export const MARGIN_ANNOTATION_TYPES: readonly MarginAnnotationType[] = [
  "highlight",
  "underline",
  "note",
  "text",
  "image",
];

export interface AnnotationPosition {
  pageIndex: number;
  rects?: number[][];
  nextPageRects?: number[][];
  paths?: number[][];
  width?: number;
}

export interface MarginAnnotation {
  itemID: number;
  key: string;
  type: MarginAnnotationType;
  comment: string;
  color: string;
  pageLabel: string;
  position: AnnotationPosition;
  readOnly: boolean;
}

export interface PageAnchor {
  x: number;
  y: number;
  side: "left" | "right";
}

export interface ViewportLike {
  width: number;
  height: number;
  scale?: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}
