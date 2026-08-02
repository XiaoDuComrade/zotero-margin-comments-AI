export const PDF_STYLES = `
.pdfViewer.zmc-viewer {
  --zmc-gutter-width: 304px;
  padding-inline-start: calc(18px + var(--zmc-gutter-width)) !important;
  padding-inline-end: calc(18px + var(--zmc-gutter-width)) !important;
}

.zmc-overlay-root {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 0;
  overflow: visible;
  pointer-events: none;
  z-index: 90;
}

.zmc-page-overlay {
  position: absolute;
  overflow: visible;
  pointer-events: none;
}

.zmc-line-layer {
  position: absolute;
  inset: 0 auto auto 0;
  overflow: visible;
  pointer-events: none;
}

.zmc-line {
  fill: none;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: .72;
  vector-effect: non-scaling-stroke;
  transition: opacity .14s ease, stroke-width .14s ease, filter .14s ease;
}

.zmc-line-dot {
  stroke: white;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  transition: filter .14s ease, r .14s ease;
}

.zmc-line.zmc-hovered {
  stroke-width: 2;
  opacity: .98;
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .28));
}

.zmc-line-dot.zmc-hovered {
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .3));
}

[data-annotation-id].zmc-native-hover {
  filter: brightness(.9) saturate(1.22) drop-shadow(0 1px 1.5px rgba(0, 0, 0, .28));
  scale: 1.018;
  transform-box: fill-box;
  transform-origin: center;
  transition: filter .14s ease, scale .14s ease;
}

.zmc-card-layer {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}

.zmc-margin-column {
  position: absolute;
  top: 0;
  width: 264px;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.zmc-margin-column-left {
  right: calc(100% + 24px);
}

.zmc-margin-column-right {
  left: calc(100% + 24px);
}

.zmc-margin-scrollport {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, CanvasText 32%, transparent) transparent;
}

.zmc-margin-content {
  position: relative;
  width: 100%;
  min-height: 100%;
  pointer-events: none;
}

.zmc-margin-expanded .zmc-margin-scrollport {
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}

.zmc-margin-toggle {
  position: absolute;
  left: 0;
  z-index: 3;
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, Canvas 93%, var(--zmc-toggle-color, #6b7c93) 7%);
  color: CanvasText;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .14);
  font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
  pointer-events: auto;
}

.zmc-margin-toggle:hover {
  background: color-mix(in srgb, Canvas 86%, CanvasText 14%);
}

.zmc-margin-toggle[hidden] {
  display: none;
}

.zmc-card {
  position: absolute;
  box-sizing: border-box;
  width: 264px;
  min-height: 42px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--zmc-color) 45%, #a8adb5);
  border-radius: 6px;
  background: color-mix(in srgb, Canvas 96%, var(--zmc-color) 4%);
  color: CanvasText;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .16);
  font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
  transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
}

.zmc-card-right {
  padding-left: 11px;
  border-left: 3px solid var(--zmc-color);
  transform-origin: left center;
}

.zmc-card-left {
  padding-right: 11px;
  border-right: 3px solid var(--zmc-color);
  transform-origin: right center;
}

.zmc-margin-column .zmc-card {
  right: auto;
  left: 0;
}

.zmc-card.zmc-overflow-hidden,
.zmc-card.zmc-filtered {
  display: none;
}

.zmc-card:hover,
.zmc-card.zmc-hovered,
.zmc-card.zmc-active {
  border-color: var(--zmc-color);
  box-shadow: 0 2px 9px rgba(0, 0, 0, .22);
}

.zmc-card.zmc-hovered {
  z-index: 4;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .27);
}

.zmc-card-right.zmc-hovered {
  transform: translateX(3px) scale(1.018);
}

.zmc-card-left.zmc-hovered {
  transform: translateX(-3px) scale(1.018);
}

.zmc-card-right.zmc-active:not(.zmc-hovered) {
  transform: translateX(2px);
}

.zmc-card-left.zmc-active:not(.zmc-hovered) {
  transform: translateX(-2px);
}

.zmc-card-preview {
  display: -webkit-box;
  box-sizing: border-box;
  width: 100%;
  max-height: calc(3 * 1.45em);
  margin: 0;
  padding: 3px 4px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 3px;
  appearance: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.45;
  text-align: start;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  cursor: text;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

.zmc-card-preview:hover {
  background: color-mix(in srgb, CanvasText 3%, transparent);
}

.zmc-card-preview.zmc-empty-preview {
  color: color-mix(in srgb, CanvasText 48%, transparent);
}

.zmc-card-editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 37px;
  max-height: 156px;
  margin: 0;
  padding: 3px 4px;
  resize: none;
  overflow-y: auto;
  border: 1px solid transparent;
  border-radius: 3px;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  cursor: text;
  -moz-user-select: text !important;
  user-select: text !important;
}

.zmc-card-editor:hover {
  background: color-mix(in srgb, CanvasText 3%, transparent);
}

.zmc-card-editor:focus {
  border-color: color-mix(in srgb, var(--zmc-color) 72%, #4a78c2);
  background: Canvas;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--zmc-color) 18%, transparent);
}

.zmc-card-editor[contenteditable="false"] {
  cursor: default;
}

.zmc-card-editor:empty::before {
  content: attr(data-placeholder);
  color: color-mix(in srgb, CanvasText 48%, transparent);
  pointer-events: none;
}

/* PDF.js/Zotero selection rules can make a real DOM Range effectively
   invisible. Keep the editor's native selection visibly distinct. */
.zmc-card-editor::selection,
.zmc-card-editor *::selection {
  background: Highlight !important;
  color: HighlightText !important;
  text-shadow: none !important;
}

.zmc-card-editor::-moz-selection,
.zmc-card-editor *::-moz-selection {
  background: Highlight !important;
  color: HighlightText !important;
  text-shadow: none !important;
}

.zmc-card .zmc-preview-hidden,
.zmc-card .zmc-editor-hidden {
  display: none;
}

.zmc-low-zoom .zmc-card:not(.zmc-editing) {
  min-height: 0;
  padding-top: 5px;
  padding-bottom: 5px;
}

.zmc-low-zoom .zmc-card:not(.zmc-editing) .zmc-card-preview {
  display: block;
  max-height: 1.45em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zmc-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-height: 17px;
  margin-top: 3px;
}

.zmc-card-footer:has(.zmc-save-state:empty) {
  display: none;
}

.zmc-save-state {
  margin-right: auto;
  color: color-mix(in srgb, CanvasText 55%, transparent);
  font-size: 10px;
}

.zmc-save-state[data-error="true"] {
  color: #c83c36;
}

@media (prefers-color-scheme: dark) {
  .zmc-card {
    box-shadow: 0 2px 7px rgba(0, 0, 0, .42);
  }
}
`;

export const TOOLBAR_STYLES = `
.zmc-toolbar-group {
  display: inline-flex !important;
  flex: 0 0 auto !important;
  flex-flow: row nowrap !important;
  align-items: center !important;
  width: max-content !important;
  white-space: nowrap !important;
}
.zmc-toolbar-group > .toolbar-button {
  flex: 0 0 auto !important;
}
.zmc-toolbar-toggle svg,
.zmc-toolbar-ai svg {
  width: 20px;
  height: 20px;
  pointer-events: none;
}
.zmc-toolbar-toggle.active {
  background: color-mix(in srgb, currentColor 13%, transparent) !important;
}
.zmc-toolbar-ai {
  color: #7d66c5;
}
.zmc-toolbar-ai.zmc-working svg {
  animation: zmc-ai-pulse 1.05s ease-in-out infinite;
}
.zmc-ai-progress {
  position: fixed;
  top: 54px;
  right: 18px;
  z-index: 2147483646;
  max-width: min(460px, calc(100vw - 36px));
  padding: 9px 13px;
  border: 1px solid color-mix(in srgb, #7d66c5 56%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, Canvas 94%, #7d66c5 6%);
  color: CanvasText;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .18);
  font: menu;
  line-height: 1.4;
  pointer-events: none;
}
@keyframes zmc-ai-pulse {
  0%, 100% { opacity: .55; transform: scale(.92); }
  50% { opacity: 1; transform: scale(1.08); }
}
`;
