import { describe, expect, it } from "vitest";
import { folderAccessOptions, projectFoldersNote } from "../shared/folder-access";
import { hostCaps, NO_HOST_CAPS } from "../shared/host-caps";

const home = "/data/bots/scout";
const devinHost = { devinAdditionalDirectories: true };

describe("folderAccessOptions", () => {
  it("attaches the folder for Claude as an additional directory", () => {
    expect(folderAccessOptions("claude", home)).toEqual({ additionalDirectories: [home] });
  });

  it("attaches it for Devin only when the host honours additional directories", () => {
    expect(folderAccessOptions("devin", home)).toBeNull();
    expect(folderAccessOptions("devin", home, NO_HOST_CAPS)).toBeNull();
    expect(folderAccessOptions("devin", home, devinHost)).toEqual({ additionalDirectories: [home] });
  });

  it("allows OpenCode to reach the folder through an external_directory rule", () => {
    expect(folderAccessOptions("opencode", home)).toEqual({ permission: { external_directory: { [`${home}/*`]: "allow", [`${home}/**`]: "allow" } } });
  });

  it("adds nothing for Antigravity, whose second directory would move its shell commands", () => {
    expect(folderAccessOptions("antigravity", home)).toBeNull();
  });

  it("adds nothing, and does not fail, for a provider it does not know", () => {
    expect(folderAccessOptions("gemini", home)).toBeNull();
    expect(folderAccessOptions("", home)).toBeNull();
  });

  it("keeps a Windows path as given for Claude and uses forward slashes in OpenCode's globs", () => {
    expect(folderAccessOptions("claude", "C:\\Users\\a\\Bots\\x")).toEqual({ additionalDirectories: ["C:\\Users\\a\\Bots\\x"] });
    expect(folderAccessOptions("opencode", "C:\\Users\\a\\Bots\\x")).toEqual({ permission: { external_directory: { "C:/Users/a/Bots/x/*": "allow", "C:/Users/a/Bots/x/**": "allow" } } });
  });
});

describe("folderAccessOptions with several folders", () => {
  const reports = "/data/shared/Teams/t1/reports";
  it("attaches every folder for Claude and for Devin when the host allows it", () => {
    expect(folderAccessOptions("claude", [home, reports])).toEqual({ additionalDirectories: [home, reports] });
    expect(folderAccessOptions("devin", [home, reports], devinHost)).toEqual({ additionalDirectories: [home, reports] });
    expect(folderAccessOptions("devin", [home, reports])).toBeNull();
  });
  it("allows every folder's files and subfolders for OpenCode", () => {
    expect(folderAccessOptions("opencode", [home, reports])).toEqual({
      permission: { external_directory: { [`${home}/*`]: "allow", [`${home}/**`]: "allow", [`${reports}/*`]: "allow", [`${reports}/**`]: "allow" } },
    });
  });
  it("gives nothing for no folders or for Antigravity, and counts a folder named twice once", () => {
    expect(folderAccessOptions("claude", [])).toBeNull();
    expect(folderAccessOptions("antigravity", [home, reports])).toBeNull();
    expect(folderAccessOptions("claude", [home, home, `${home}/`])).toEqual({ additionalDirectories: [home] });
  });
});

describe("hostCaps", () => {
  it("is all false for anything that does not say true", () => {
    expect(hostCaps(undefined)).toEqual(NO_HOST_CAPS);
    expect(hostCaps({})).toEqual(NO_HOST_CAPS);
    expect(hostCaps({ devinAdditionalDirectories: "yes" })).toEqual(NO_HOST_CAPS);
  });
  it("reads devinAdditionalDirectories", () => {
    expect(hostCaps({ devinAdditionalDirectories: true }).devinAdditionalDirectories).toBe(true);
  });
});

describe("projectFoldersNote", () => {
  const attached = "In a project folder this assistant's own folder is attached, so writes to it ask exactly what edits in the project ask in the assistant's approval mode (Always ask asks every time).";
  it("says the folder is attached for Claude and OpenCode", () => {
    expect(projectFoldersNote("claude")).toBe(attached);
    expect(projectFoldersNote("opencode")).toBe(attached);
  });
  it("tells the truth about Devin before and after the host attaches the folder", () => {
    expect(projectFoldersNote("devin")).toBe("In a project folder this assistant keeps its identity only if the host injects the system prompt (stock Paseo drops it), and its writes to its own folder ask once per session (the host does not attach it yet).");
    expect(projectFoldersNote("devin", devinHost)).toBe(attached);
  });
  it("says Antigravity never asks and uses files", () => {
    expect(projectFoldersNote("antigravity")).toBe("It never asks for approval. Its tools are files, since it cannot take the plugin's MCP server.");
  });
  it("is empty for other providers", () => {
    expect(projectFoldersNote("gemini")).toBe("");
  });
});
