import { describe, expect, it } from "vitest";
import { NO_HOST_CAPS } from "../shared/host-caps";
import { readHostCaps } from "../server/host-caps";

describe("the host's capabilities, as the host announces them in IRIX_HOST_CAPS", () => {
  it("reads what the host announces", () => {
    const caps = readHostCaps({ IRIX_HOST_CAPS: '{"devinSystemPrompt":true,"devinAdditionalDirectories":true}' });
    expect(caps.devinAdditionalDirectories).toBe(true);
  });
  it("is all false when the variable is missing, is not JSON, or says anything but true", () => {
    expect(readHostCaps({})).toEqual(NO_HOST_CAPS);
    expect(readHostCaps({ IRIX_HOST_CAPS: "" })).toEqual(NO_HOST_CAPS);
    expect(readHostCaps({ IRIX_HOST_CAPS: "{not json" })).toEqual(NO_HOST_CAPS);
    expect(readHostCaps({ IRIX_HOST_CAPS: '"yes"' })).toEqual(NO_HOST_CAPS);
    expect(readHostCaps({ IRIX_HOST_CAPS: "null" })).toEqual(NO_HOST_CAPS);
    expect(readHostCaps({ IRIX_HOST_CAPS: '{"devinAdditionalDirectories":"true"}' })).toEqual(NO_HOST_CAPS);
  });
});
