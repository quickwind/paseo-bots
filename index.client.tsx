import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { BotsNav } from "./client/BotsNav";
import { BotsSurface } from "./client/BotsSurface";
import { ApprovalCard } from "./client/chat/stream/ApprovalCard";
import { ProposalCard } from "./client/chat/stream/ProposalCard";
import { RoutineRunCard } from "./client/chat/stream/RoutineRunCard";
import { messages } from "./client/i18n/messages";
import { requestIntent } from "./client/intent";
import { BotsSettings } from "./client/settings/BotsSettings";
import { installTooltips } from "./client/ui/Tooltip";
import { BOT_LABEL } from "./shared/bot";
import { APPROVAL_CARD, ApprovalCardSchema, approvalIdOf } from "./shared/approvals";
import { proposalIdOf } from "./shared/proposals";
import { helloRpc, ROUTINE_RUN_CARD, RoutineRunCardSchema } from "./shared/rpc";
import { LEARN_COMMAND, learnPrompt } from "./shared/skills";

export default function contribute(client: PluginClientContext) {
  // Hands the daemon side its Paseo API so bot routines can run.
  void client.rpc(helloRpc, {}).catch(() => {});
  const removeTooltips = installTooltips();
  // A newer host titles the screen; an older one only knows surfaces (which are titled by their id).
  if (typeof client.addScreen === "function") client.addScreen({ id: "bots", title: "Aydo", Component: BotsSurface });
  else client.addSurface("bots", BotsSurface);
  // The row is ours on every host (Paseo 0.13 and later have addSidebarHeaderItem): one status dot for all assistants. The host shows
  // one row per plugin and keeps the host in its own picker on the screen, so neither names a host.
  client.addSidebarHeaderItem({ id: "bots", title: "Aydo", Component: BotsNav });
  client.addSettingsScreen({ id: "bots", title: "Aydo", icon: "Bot", Component: BotsSettings });
  client.addCommandCenterItem({
    id: "open-bots",
    title: messages.message("host.openBots"),
    icon: "Bot",
    keywords: ["bot", "assistant", "persona", "助理"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("bots");
    },
  });
  client.addCommandCenterItem({
    id: "new-bot",
    title: messages.message("host.newBot"),
    icon: "Plus",
    keywords: ["bot", "create", "assistant", "助理", "新建"],
    context: "global",
    onSelect({ openSurface }) {
      requestIntent({ kind: "new-bot" });
      openSurface("bots");
    },
  });
  // Bot chats opened in Paseo's own agent view get the same /learn and skill cards.
  client.addSlashCommand({
    ...LEARN_COMMAND,
    description: messages.message("host.learn"),
    argumentHint: messages.message("host.learnHint"),
    context: "agent",
    async onSubmit({ agent, args, paseo }) {
      if (!agent.labels[BOT_LABEL]) throw new Error(client.i18n.t(messages, "host.learnOnlyInChats"));
      await paseo.agents.ref(agent.id).send(learnPrompt(args));
    },
  });
  client.addTimelineTransformer({
    id: "proposals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const proposalId = proposalIdOf(item);
      return proposalId ? { items: [{ type: "plugin", kind: "proposal", version: 1, data: { proposalId } }] } : undefined;
    },
  });
  client.addTimelineTransformer({
    id: "approvals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const approvalId = approvalIdOf(item);
      return approvalId ? { items: [{ type: "plugin", ...APPROVAL_CARD, data: { approvalId } }] } : undefined;
    },
  });
  client.addTimelineRenderer({
    ...APPROVAL_CARD,
    schema: ApprovalCardSchema,
    Component: ({ item, theme, layout }) => <ApprovalCard colors={theme.colors} compact={layout.compact} approvalId={item.data.approvalId} />,
  });
  client.addTimelineRenderer({
    kind: "proposal",
    version: 1,
    schema: z.object({ proposalId: z.string() }),
    Component: ({ item, theme, layout }) => <ProposalCard colors={theme.colors} compact={layout.compact} proposalId={item.data.proposalId} />,
  });
  // A routine's results chat opened in Paseo's view shows its run cards too (no navigation there).
  client.addTimelineRenderer({
    ...ROUTINE_RUN_CARD,
    schema: RoutineRunCardSchema,
    Component: ({ item, theme }) => <RoutineRunCard colors={theme.colors} card={item.data} />,
  });
  return removeTooltips;
}
