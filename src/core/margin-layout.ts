export interface LayoutItem {
  id: string;
  anchorY: number;
  height: number;
}

export interface PositionedLayoutItem extends LayoutItem {
  y: number;
}

export interface LayoutOptions {
  pageHeight: number;
  padding?: number;
  gap?: number;
}

export interface CollapsibleLayoutOptions extends LayoutOptions {
  expanded?: boolean;
  summaryHeight?: number;
  expandedTopPadding?: number;
}

export interface CollapsibleLayoutResult {
  positions: PositionedLayoutItem[];
  hiddenIDs: string[];
  overflow: boolean;
  contentHeight: number;
  summaryY?: number;
}

export function layoutMarginCards(
  items: readonly LayoutItem[],
  options: LayoutOptions,
): PositionedLayoutItem[] {
  const padding = Math.max(0, options.padding ?? 10);
  const gap = Math.max(0, options.gap ?? 8);
  const bottom = Math.max(padding, options.pageHeight - padding);
  const sorted = [...items]
    .map((item) => ({ ...item, height: Math.max(1, item.height) }))
    .sort((a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id));

  const positioned: PositionedLayoutItem[] = [];
  for (const item of sorted) {
    const desired = Math.max(
      padding,
      Math.min(bottom - item.height, item.anchorY - item.height / 2),
    );
    const previous = positioned.at(-1);
    positioned.push({
      ...item,
      y: previous ? Math.max(desired, previous.y + previous.height + gap) : desired,
    });
  }

  for (let index = positioned.length - 1; index >= 0; index -= 1) {
    const item = positioned[index];
    const next = positioned[index + 1];
    const latest = next ? next.y - gap - item.height : bottom - item.height;
    item.y = Math.max(padding, Math.min(item.y, latest));
  }

  // If the cards are denser than the page, preserve their order and spacing.
  // Overflow is preferable to overlapping editable controls.
  for (let index = 1; index < positioned.length; index += 1) {
    const previous = positioned[index - 1];
    positioned[index].y = Math.max(
      positioned[index].y,
      previous.y + previous.height + gap,
    );
  }

  return positioned;
}

export function layoutCollapsibleMargin(
  items: readonly LayoutItem[],
  options: CollapsibleLayoutOptions,
): CollapsibleLayoutResult {
  const padding = Math.max(0, options.padding ?? 10);
  const gap = Math.max(0, options.gap ?? 8);
  const pageHeight = Math.max(1, options.pageHeight);
  const normalized = [...items]
    .map((item) => ({ ...item, height: Math.max(1, item.height) }))
    .sort((a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id));
  const requiredHeight = normalized.reduce(
    (total, item, index) => total + item.height + (index ? gap : 0),
    0,
  );
  const overflow = requiredHeight > Math.max(0, pageHeight - padding * 2);

  if (!overflow) {
    return {
      positions: layoutMarginCards(normalized, { pageHeight, padding, gap }),
      hiddenIDs: [],
      overflow: false,
      contentHeight: pageHeight,
    };
  }

  if (options.expanded) {
    const top = Math.max(padding, options.expandedTopPadding ?? 44);
    const positions: PositionedLayoutItem[] = [];
    let cursor = top;
    for (const item of normalized) {
      const desired = Math.max(top, item.anchorY - item.height / 2);
      const y = Math.max(cursor, desired);
      positions.push({ ...item, y });
      cursor = y + item.height + gap;
    }
    return {
      positions,
      hiddenIDs: [],
      overflow: true,
      contentHeight: Math.max(pageHeight, cursor - gap + padding),
    };
  }

  const summaryHeight = Math.max(1, options.summaryHeight ?? 36);
  const summaryY = Math.max(padding, pageHeight - padding - summaryHeight);
  const availableBottom = Math.max(padding, summaryY - gap);
  let usedBottom = padding;
  let visibleCount = 0;
  for (const item of normalized) {
    const nextBottom = usedBottom + (visibleCount ? gap : 0) + item.height;
    if (nextBottom > availableBottom) break;
    usedBottom = nextBottom;
    visibleCount += 1;
  }

  const visible = normalized.slice(0, visibleCount);
  return {
    positions: layoutMarginCards(visible, {
      pageHeight: availableBottom + padding,
      padding,
      gap,
    }),
    hiddenIDs: normalized.slice(visibleCount).map((item) => item.id),
    overflow: true,
    contentHeight: pageHeight,
    summaryY,
  };
}
