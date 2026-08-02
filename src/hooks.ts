import { config } from "../package.json";

declare const addon: import("./addon").Addon;

async function onStartup(): Promise<void> {
  await Promise.all([
    promiseLike(Zotero.initializationPromise),
    promiseLike(Zotero.unlockPromise),
    promiseLike(Zotero.uiReadyPromise),
  ]);
  await addon.controller.start();
}

async function onMainWindowLoad(win: Window): Promise<void> {
  addon.controller.registerWindow(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  addon.controller.unregisterWindow(win);
}

async function onShutdown(): Promise<void> {
  await addon.controller.stop();
  addon.alive = false;
  delete (Zotero as any)[config.addonInstance];
}

function promiseLike(value: unknown): Promise<unknown> {
  return value && typeof (value as PromiseLike<unknown>).then === "function"
    ? Promise.resolve(value)
    : Promise.resolve();
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
