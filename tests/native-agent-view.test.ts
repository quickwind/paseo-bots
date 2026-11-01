import { describe, expect, it } from "vitest";
import { nativeAgentView } from "../client/native-agent-view";

const View = () => null;

describe("nativeAgentView", () => {
  it("is absent on a host that does not offer it", () => {
    expect(nativeAgentView({})).toBeNull();
  });

  it("is used when the host offers it with the capability we know", () => {
    expect(nativeAgentView({ AgentView: View, capabilities: { agentView: 1 } })).toBe(View);
  });

  it("is ignored without the capability or with a newer one", () => {
    expect(nativeAgentView({ AgentView: View })).toBeNull();
    expect(nativeAgentView({ AgentView: View, capabilities: { agentView: 2 } })).toBeNull();
  });

  it("is ignored when it is not a component", () => {
    expect(nativeAgentView({ AgentView: "x", capabilities: { agentView: 1 } })).toBeNull();
  });
});

describe("hostHidesBotsProject", () => {
  it("is true only for a host that says it hides the Bots project", async () => {
    const { hostHidesBotsProject } = await import("../client/native-agent-view");
    expect(hostHidesBotsProject({})).toBe(false);
    expect(hostHidesBotsProject({ capabilities: { agentView: 1 } })).toBe(false);
    expect(hostHidesBotsProject({ capabilities: { agentView: 1, managedProjectsHidden: 1 } })).toBe(true);
  });
});
