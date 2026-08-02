export const AI_ANNOTATION_TAG = "AI 学术标注";
export const DEFAULT_AI_ANNOTATION_COLOR = "#a28ae5";

export const AI_API_PROTOCOLS = [
  "auto",
  "responses",
  "chat-completions",
] as const;

export type AiApiProtocol = (typeof AI_API_PROTOCOLS)[number];

export const AI_ANNOTATION_CATEGORIES = [
  "thesis",
  "contribution",
  "method",
  "evidence",
  "limitation",
  "implication",
  "terminology",
] as const;

export type AiAnnotationCategory = (typeof AI_ANNOTATION_CATEGORIES)[number];

export interface AiAnnotationSuggestion {
  pdfPage: number;
  quote: string;
  comment: string;
  category: AiAnnotationCategory;
}

export interface PdfTextChar {
  c: string;
  inlineRect: number[];
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  spaceAfter?: boolean;
  ignorable?: boolean;
}

export interface PdfTextPage {
  pageIndex: number;
  pageLabel: string;
  viewBox: number[];
  chars: PdfTextChar[];
}

export interface LocatedAiAnnotation extends AiAnnotationSuggestion {
  pageIndex: number;
  pageLabel: string;
  text: string;
  position: {
    pageIndex: number;
    rects: number[][];
  };
  sortIndex: string;
}

export interface UnmatchedAiAnnotation {
  suggestion: AiAnnotationSuggestion;
  reason: string;
}

export interface AiLocationResult {
  located: LocatedAiAnnotation[];
  unmatched: UnmatchedAiAnnotation[];
}

export interface AiSettings {
  enabled: boolean;
  webChatEnabled: boolean;
  apiProtocol: AiApiProtocol;
  apiBase: string;
  apiKey: string;
  model: string;
  color: string;
  maxAnnotations: number;
  customInstructions: string;
}
