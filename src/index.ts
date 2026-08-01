import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKootCommands } from "./koot.ts";
import { registerRegenerateCommands } from "./regenerate.ts";

export default function extension(pi: ExtensionAPI): void {
  registerRegenerateCommands(pi);
  registerKootCommands(pi);
}
