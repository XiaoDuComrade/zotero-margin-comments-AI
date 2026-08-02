import hooks from "./hooks";
import { PluginController } from "./zotero/plugin-controller";

export class Addon {
  readonly controller = new PluginController();
  readonly hooks = hooks;
  alive = true;
}
