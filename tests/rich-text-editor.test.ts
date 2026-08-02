import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStoredComment,
  renderStoredComment,
  selectEditorContents,
} from "../src/zotero/rich-text-editor";

describe("rich text annotation comment editor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works in Zotero's bootstrap sandbox without a global Node constructor", () => {
    const editor = document.createElement("div");
    vi.stubGlobal("Node", undefined);

    renderStoredComment(editor, "<b>仍然显示</b>");

    expect(editor.querySelector("b")?.textContent).toBe("仍然显示");
    expect(readStoredComment(editor)).toBe("<b>仍然显示</b>");
  });

  it("renders Zotero formatting tags without interpreting arbitrary HTML", () => {
    const editor = document.createElement("div");
    renderStoredComment(
      editor,
      "<b>粗体</b>、<i>斜体</i>和<img src=x onerror=alert(1)>",
    );

    expect(editor.querySelector("b")?.textContent).toBe("粗体");
    expect(editor.querySelector("i")?.textContent).toBe("斜体");
    expect(editor.querySelector("img")).toBeNull();
    expect(editor.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("serializes contenteditable DOM to Zotero's supported comment format", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "<strong style=\"color:red\">重点</strong><br>第二行";

    expect(readStoredComment(editor)).toBe("<b>重点</b>\n第二行");
    expect(editor.innerHTML).toBe("<b>重点</b><br>第二行");
  });

  it("selects the complete editor contents", () => {
    const editor = document.createElement("div");
    editor.textContent = "可以框选";
    document.body.append(editor);

    selectEditorContents(editor);

    expect(document.getSelection()?.toString()).toBe("可以框选");
  });
});
