import { PluginTranslationRuntime, isPluginMessage } from "@getpaseo/plugin/client/host";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.client";

// The screens pull in react-native, which vitest cannot parse; only the registrations matter here.
vi.mock("../client/BotsNav", () => ({ BotsNav: () => null }));
vi.mock("../client/BotsSurface", () => ({ BotsSurface: () => null }));
vi.mock("../client/native-agent-view", () => ({ hostHidesBotsProject: () => false }));
vi.mock("../client/chat/stream/ApprovalCard", () => ({ ApprovalCard: () => null }));
vi.mock("../client/chat/stream/ProposalCard", () => ({ ProposalCard: () => null }));
vi.mock("../client/chat/stream/RoutineRunCard", () => ({ RoutineRunCard: () => null }));
vi.mock("../client/settings/BotsSettings", () => ({ BotsSettings: () => null }));
vi.mock("../client/ui/Tooltip", () => ({ installTooltips: () => () => {} }));

function record() {
  const items: any[] = [];
  const commands: any[] = [];
  const noop = () => {};
  const client: any = {
    rpc: () => Promise.resolve(),
    addSurface: noop,
    addScreen: noop,
    addSidebarItem: noop,
    addSidebarHeaderItem: noop,
    addSettingsScreen: noop,
    addTimelineTransformer: noop,
    addTimelineRenderer: noop,
    addCommandCenterItem: (item: unknown) => items.push(item),
    addSlashCommand: (cmd: unknown) => commands.push(cmd),
  };
  return { client, items, commands };
}
const runtime = (locale: string) => new PluginTranslationRuntime({ getLocale: () => locale, subscribe: () => () => {} });

describe("labels the host draws", () => {
  const { client, items, commands } = record();
  contribute(client);
  const titles = (id: string) => items.find((i) => i.id === id);
  const learn = commands.find((c) => c.name === "learn");

  it("are plugin messages", () => {
    expect(isPluginMessage(titles("open-bots").title)).toBe(true);
    expect(isPluginMessage(titles("new-bot").title)).toBe(true);
    expect(isPluginMessage(learn.description)).toBe(true);
    expect(isPluginMessage(learn.argumentHint)).toBe(true);
  });
  it("resolve in Chinese and English", () => {
    const zh = runtime("zh-CN");
    const en = runtime("en");
    expect(zh.resolve(titles("open-bots").title)).toBe("打开助理");
    expect(zh.resolve(titles("new-bot").title)).toBe("新建助理");
    expect(en.resolve(titles("open-bots").title)).toBe("Open Assistants");
    expect(en.resolve(titles("new-bot").title)).toBe("New assistant");
    expect(en.resolve(learn.description)).toBe("Save what the assistant just did as a skill");
    expect(en.resolve(learn.argumentHint)).toBe("[what to focus on]");
    expect(zh.resolve(learn.description)).toBe("把助理刚做的事存成技能");
    expect(zh.resolve(learn.argumentHint)).toBe("[重点关注什么]");
  });
  it("keep English keywords and add Chinese ones", () => {
    expect(titles("open-bots").keywords).toEqual(expect.arrayContaining(["bot", "assistant", "助理"]));
    expect(titles("new-bot").keywords).toEqual(expect.arrayContaining(["bot", "create", "新建"]));
    expect(titles("open-bots").keywords).toEqual(["bot", "assistant", "persona", "助理"]);
    expect(titles("new-bot").keywords).toEqual(["bot", "create", "assistant", "助理", "新建"]);
  });
});
