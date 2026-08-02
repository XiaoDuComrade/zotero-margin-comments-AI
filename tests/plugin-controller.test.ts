import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginController } from "../src/zotero/plugin-controller";

describe("PluginController annotation type settings", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", {
      Prefs: {
        get: vi.fn(() => true),
        set: vi.fn(),
      },
      PreferencePanes: {
        register: vi.fn().mockResolvedValue("margin-comments-preferences"),
        unregister: vi.fn(),
      },
      Reader: { _readers: [] },
      logError: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("registers a preference pane and persists type changes immediately", async () => {
    const controller = new PluginController() as any;
    const session = {
      setVisibleTypes: vi.fn(),
      setCompactNoteIcons: vi.fn(),
    };
    controller.sessions.set({}, session);
    await controller.registerPreferencePane();

    expect((Zotero as any).PreferencePanes.register).toHaveBeenCalledWith({
      pluginID: "margin-comments@local.zotero",
      id: "margin-comments-preferences",
      label: "页边批注",
      src: "chrome://margincomments/content/preferences.xhtml",
      image: "chrome://margincomments/content/icons/margin-comments.svg",
      stylesheets: ["chrome://margincomments/content/preferences.css"],
    });

    const pane = document.createElement("section");
    pane.id = "zotero-prefpane-margincomments";
    for (const type of ["highlight", "underline", "note", "text", "image"]) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.zmcType = type;
      pane.append(checkbox);
    }
    const compactNoteIcons = document.createElement("input");
    compactNoteIcons.type = "checkbox";
    compactNoteIcons.dataset.zmcSetting = "compact-note-icons";
    pane.append(compactNoteIcons);
    const defaultPrompt = document.createElement("pre");
    defaultPrompt.dataset.zmcAiDefaultPrompt = "true";
    pane.append(defaultPrompt);
    const webChatEnabled = document.createElement("input");
    webChatEnabled.type = "checkbox";
    webChatEnabled.dataset.zmcAiSetting = "webChatEnabled";
    pane.append(webChatEnabled);
    document.body.append(pane);
    controller.registerPreferencePaneWindow(window);

    expect(defaultPrompt.textContent).toContain("严谨的专业学者和同行评审人");

    const checkboxes = pane.querySelectorAll<HTMLInputElement>("[data-zmc-type]");
    expect(checkboxes).toHaveLength(5);
    expect(
      (Array.from(checkboxes) as HTMLInputElement[]).map(
        (checkbox) => checkbox.dataset.zmcType,
      ),
    ).toEqual(["highlight", "underline", "note", "text", "image"]);

    const underline = pane.querySelector<HTMLInputElement>(
      '[data-zmc-type="underline"]',
    )!;
    underline.click();

    expect(underline.checked).toBe(false);
    expect((Zotero as any).Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.margincomments.types.underline",
      false,
      true,
    );
    const visibleTypes = session.setVisibleTypes.mock.calls.at(-1)![0] as Set<string>;
    expect(visibleTypes.has("underline")).toBe(false);
    expect(visibleTypes.has("highlight")).toBe(true);

    expect(compactNoteIcons.checked).toBe(false);
    compactNoteIcons.click();
    expect((Zotero as any).Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.margincomments.compactNoteIcons",
      true,
      true,
    );
    expect(session.setCompactNoteIcons).toHaveBeenLastCalledWith(true);

    expect(webChatEnabled.checked).toBe(false);
    webChatEnabled.click();
    expect((Zotero as any).Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.margincomments.ai.webChatEnabled",
      true,
      true,
    );
  });

  it("keeps the margin and AI buttons in one non-wrapping toolbar group", () => {
    const controller = new PluginController() as any;
    const group = controller.createToolbarGroup(document, { itemID: 123 });

    expect(group.classList.contains("zmc-toolbar-group")).toBe(true);
    expect(group.children).toHaveLength(2);
    expect(group.children[0].classList.contains("zmc-toolbar-toggle")).toBe(true);
    expect(group.children[1].classList.contains("zmc-toolbar-ai")).toBe(true);
    expect(document.getElementById("zmc-toolbar-styles")?.textContent)
      .toContain("flex-flow: row nowrap !important");
  });
});
