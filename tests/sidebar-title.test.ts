import { describe, expect, it } from "vitest";
import en from "../shared/locales/en.json";
import zh from "../shared/locales/zh-CN.json";

describe("the sidebar row's title", () => {
  it("is Aydo in English and 'Aydo 个人助理' in Chinese", () => {
    expect(en.host.sidebarTitle).toBe("Aydo");
    expect(zh.host.sidebarTitle).toBe("Aydo 个人助理");
  });
});
