import type { LibraryKind } from "../shared/library";

// Skills & Tools lives inside the Bots screen. A bot's settings and the bot
// list ask for it here, optionally for one item, and the Bots screen switches
// to it. Paseo can keep more than one Bots screen mounted, so every listener
// gets the target instead of the first one taking it.

/** The library item to show: a skill or an MCP server. */
export type LibraryTarget = { kind: LibraryKind; id: string };

type Listener = (target: LibraryTarget | null) => void;
const listeners = new Set<Listener>();

export function openLibrary(target: LibraryTarget | null = null): void {
  for (const listener of listeners) listener(target);
}

const approvalListeners = new Set<() => void>();

/** Opens the approvals list inside the Bots screen (same store as Skills & Tools: every mounted Bots screen hears it). */
export function openApprovals(): void {
  for (const listener of approvalListeners) listener();
}

export function onApprovalsOpen(listener: () => void): () => void {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
}

export function onLibraryTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
