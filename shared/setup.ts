import { z } from "zod";

/** "Set up with the bot": the interview a bot opens with, and whether a new blank bot starts it by itself. */
export const SetupSettingsSchema = z.object({
  /** Empty uses the built-in prompt. */
  prompt: z.string().max(8000).default(""),
  autoStart: z.boolean().default(true),
});
export type SetupSettings = z.infer<typeof SetupSettingsSchema>;

export const DEFAULT_SETUP_PROMPT =
  "Let's set you up. Interview me, one short question at a time, about what I want from you, how I like to work, and what you should never do. " +
  "Stop asking once you know enough; eight questions is plenty.\n\n" +
  "Then call get_setup to see your current settings, and call propose_changes once, as an update to yourself, with a name, a one-line title, a short description and standing instructions for yourself, " +
  "plus any library skills that fit. Do not change your provider, model, approval mode or thinking setting; if I want those changed, tell me to use the Model and Permissions settings. " +
  "I apply the changes from the card you propose.\n\n" +
  "Write a starting MEMORY.md once I confirm, and tell me when everything is in place.";

/** The prompt a setup chat opens with: the configured one, or the built-in. */
export function setupPromptText(setup: SetupSettings | undefined): string {
  return setup?.prompt.trim() || DEFAULT_SETUP_PROMPT;
}

/**
 * Whether a bot just created from the New bot dialog starts its setup interview: only a blank bot
 * (a role or preset already brings instructions), only when it has a provider to run on, and
 * unless the plugin setting turns it off.
 */
export function shouldAutoSetup(start: { template?: unknown; preset?: unknown } | undefined, setup: Pick<SetupSettings, "autoStart"> | undefined, provider: string): boolean {
  return !start?.template && !start?.preset && Boolean(provider) && (setup?.autoStart ?? true);
}
