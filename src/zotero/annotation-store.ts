import { isSupportedType, parsePosition } from "../core/annotation-model";
import type { MarginAnnotation } from "../core/types";
import {
  AI_ANNOTATION_TAG,
  type LocatedAiAnnotation,
} from "../ai/types";

export class AnnotationStore {
  list(attachmentID: number): MarginAnnotation[] {
    const attachment = (Zotero.Items as any).get(attachmentID);
    if (!attachment || typeof attachment.getAnnotations !== "function") return [];

    return attachment
      .getAnnotations(false)
      .map((item: any) => this.toMarginAnnotation(item))
      .filter((item: MarginAnnotation | undefined): item is MarginAnnotation => !!item);
  }

  async saveComment(itemID: number, value: string): Promise<void> {
    const item = (Zotero.Items as any).get(itemID);
    if (!item?.isAnnotation?.()) {
      throw new Error("批注已经不存在");
    }
    if (item.isEditable?.() === false) {
      throw new Error("此批注为只读，无法编辑");
    }

    item.annotationComment = value;
    await item.saveTx();
  }

  async createAiHighlights(
    attachmentID: number,
    annotations: readonly LocatedAiAnnotation[],
    color: string,
  ): Promise<number> {
    const attachment = (Zotero.Items as any).get(attachmentID);
    if (!attachment || attachment.isAttachment?.() === false) {
      throw new Error("当前 PDF 附件已经不存在");
    }
    if (attachment.isEditable?.() === false) {
      throw new Error("当前 PDF 所在文库为只读，无法写入 AI 批注");
    }

    const notifierQueue = new (Zotero.Notifier as any).Queue();
    let created = 0;
    try {
      for (const annotation of annotations) {
        const key = (Zotero as any).DataObjectUtilities.generateKey();
        await (Zotero as any).Annotations.saveFromJSON(
          attachment,
          {
            key,
            type: "highlight",
            authorName: attachment.library?.libraryType === "group"
              ? (Zotero.Users as any).getCurrentName?.() || ""
              : "",
            text: annotation.text,
            comment: annotation.comment,
            color,
            pageLabel: annotation.pageLabel,
            sortIndex: annotation.sortIndex,
            position: annotation.position,
            tags: [{ name: AI_ANNOTATION_TAG }],
          },
          {
            notifierQueue,
            skipSelect: true,
            notifierData: { autoSyncDelay: 1 },
          },
        );
        created++;
      }
    } finally {
      await (Zotero.Notifier as any).commit(notifierQueue);
    }
    return created;
  }

  private toMarginAnnotation(item: any): MarginAnnotation | undefined {
    if (!item?.isAnnotation?.() || !isSupportedType(item.annotationType)) {
      return undefined;
    }
    const position = parsePosition(item.annotationPosition);
    if (!position) return undefined;

    return {
      itemID: Number(item.id),
      key: String(item.key),
      type: item.annotationType,
      comment: String(item.annotationComment ?? ""),
      color: normalizeColor(item.annotationColor),
      pageLabel: String(item.annotationPageLabel ?? position.pageIndex + 1),
      position,
      readOnly: item.isEditable?.() === false,
    };
  }
}

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : "#ffd400";
}
