import { NO_HOST_CAPS, type HostCaps } from "./host-caps";
import { englishTranslate, type Translate } from "./translate";

const is = (provider: string, name: string) => new RegExp(`^${name}(\\b|$)`).test(provider);
const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The provider options that attach folders to a session that runs elsewhere: a bot's own folder (a project's
 * workspace is the working folder) and a team's report folder. The bot can then read and write there without
 * approval prompts beyond what its mode asks for its own working folder. Null when the provider needs nothing or
 * cannot: Antigravity never asks, and a second directory would move its shell commands there.
 */
export function folderAccessOptions(provider: string, folders: string | readonly string[], caps: HostCaps = NO_HOST_CAPS): Record<string, unknown> | null {
  const list: string[] = [];
  for (const folder of typeof folders === "string" ? [folders] : folders) if (!list.some((seen) => slashes(seen) === slashes(folder))) list.push(folder);
  if (list.length === 0) return null;
  if (is(provider, "claude") || (is(provider, "devin") && caps.devinAdditionalDirectories)) return { additionalDirectories: list };
  if (is(provider, "opencode")) {
    const rules: Record<string, "allow"> = {};
    for (const folder of list) {
      const base = slashes(folder);
      rules[`${base}/*`] = "allow";
      rules[`${base}/**`] = "allow";
    }
    return { permission: { external_directory: rules } };
  }
  return null;
}

/** What a bot's details say about working in a project folder, for its provider. */
export function projectFoldersNote(provider: string, caps: HostCaps = NO_HOST_CAPS, t: Translate = englishTranslate): string {
  if (is(provider, "claude") || is(provider, "opencode")) return t("text.folders.attached");
  if (is(provider, "devin")) return caps.devinAdditionalDirectories ? t("text.folders.attached") : t("text.folders.devinNotAttached");
  if (is(provider, "antigravity")) return t("text.folders.antigravity");
  return "";
}
