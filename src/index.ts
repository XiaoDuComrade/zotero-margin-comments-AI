import { config } from "../package.json";
import { Addon } from "./addon";

declare const _globalThis: Record<string, unknown>;

const instance = new Addon();
_globalThis.addon = instance;
(Zotero as any)[config.addonInstance] = instance;
