/* eslint-disable no-undef */

var chromeHandle;

function install() {}

async function startup({ resourceURI, rootURI }) {
  await waitForZotero();
  rootURI = rootURI || (resourceURI && resourceURI.spec) || "";

  const classes = typeof Components !== "undefined" ? Components.classes : Cc;
  const interfaces = typeof Components !== "undefined" ? Components.interfaces : Ci;
  const startupService = classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(interfaces.amIAddonManagerStartup);

  chromeHandle = startupService.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "__addonRef__", rootURI + "content/"]],
  );

  const clipboard = classes["@mozilla.org/widget/clipboard;1"]
    .getService(interfaces.nsIClipboard);
  const clipboardHelper = classes["@mozilla.org/widget/clipboardhelper;1"]
    .getService(interfaces.nsIClipboardHelper);
  const clipboardTextFlavors = [
    "text/unicode",
    "text/plain",
    "text/plain;charset=utf-8",
    "text/html",
  ];

  function readClipboardString(flavor) {
    const transferable = classes["@mozilla.org/widget/transferable;1"]
      .createInstance(interfaces.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor(flavor);
    clipboard.getData(
      transferable,
      interfaces.nsIClipboard.kGlobalClipboard,
    );
    const output = {};
    transferable.getTransferData(flavor, output);
    for (const stringInterface of [
      interfaces.nsISupportsString,
      interfaces.nsISupportsCString,
    ]) {
      try {
        const value = output.value.QueryInterface(stringInterface).data;
        if (typeof value === "string") return value;
      }
      catch (_) {}
    }
    return "";
  }

  function htmlToPlainText(html) {
    try {
      const DOMParserConstructor = Zotero.getMainWindow?.()?.DOMParser;
      if (typeof DOMParserConstructor !== "function") {
        throw new Error("DOMParser is unavailable");
      }
      const doc = new DOMParserConstructor().parseFromString(html, "text/html");
      return doc.body?.innerText || doc.body?.textContent || "";
    }
    catch (_) {
      return html.replace(/<br\s*\/?\s*>/giu, "\n")
        .replace(/<[^>]+>/gu, "");
    }
  }

  const context = {
    rootURI,
    _zmcClipboard: {
      copyText(value) {
        clipboardHelper.copyString(String(value));
      },
      readText() {
        for (const flavor of clipboardTextFlavors) {
          if (!clipboard.hasDataMatchingFlavors(
            [flavor],
            interfaces.nsIClipboard.kGlobalClipboard,
          )) continue;
          const value = readClipboardString(flavor);
          if (!value) continue;
          return flavor === "text/html" ? htmlToPlainText(value) : value;
        }
        return "";
      },
    },
  };
  context._globalThis = context;
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/__addonRef__.js",
    context,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

function onMainWindowLoad({ window }) {
  return Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  return Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

function shutdown({ resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.__addonInstance__?.hooks.onShutdown();
  rootURI = rootURI || (resourceURI && resourceURI.spec) || "";
  if (rootURI && typeof Cu !== "undefined" && typeof Cu.unload === "function") {
    Cu.unload(rootURI + "content/scripts/__addonRef__.js");
  }
  chromeHandle?.destruct();
  chromeHandle = undefined;
}

function uninstall() {}

async function waitForZotero() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (typeof Zotero !== "undefined") {
      await Zotero.initializationPromise;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Zotero object was not available during plugin startup");
}
