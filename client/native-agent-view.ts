import * as hostUi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";

/**
 * Paseo's own chat view for one agent. A host may add it to `@getpaseo/plugin/client/ui`; stock Paseo
 * does not have it, so the plugin looks for it at run time and keeps its own chat window otherwise.
 */
export interface NativeAgentViewProps {
  agentId: string;
  serverId: string;
  workspaceId: string;
}

interface HostExtras {
  AgentView?: ComponentType<NativeAgentViewProps>;
  capabilities?: { agentView?: number; managedProjectsHidden?: number };
}

/** The host's chat view, or null when this host does not offer one (or offers a version we do not know). */
export function nativeAgentView(ui: object = hostUi): ComponentType<NativeAgentViewProps> | null {
  const { AgentView, capabilities } = ui as HostExtras;
  return typeof AgentView === "function" && capabilities?.agentView === 1 ? AgentView : null;
}

/** Whether the host leaves the Bots project out of its own sidebar, so the plugin shows its bots there itself. */
export function hostHidesBotsProject(ui: object = hostUi): boolean {
  return (ui as HostExtras).capabilities?.managedProjectsHidden === 1;
}
