/**
 * What the host (Paseo or another host) does for providers that the plugin cannot see for itself. Everything is
 * false until the host says otherwise, which is how stock Paseo behaves.
 */
export interface HostCaps {
  /** The host passes a session's additional directories to Devin (ACP `session/new`), so rules there load and writes need no approval. */
  devinAdditionalDirectories: boolean;
}

export const NO_HOST_CAPS: HostCaps = { devinAdditionalDirectories: false };

/** Reads the host's capabilities from whatever it exposes; anything that does not say `true` is false. */
export function hostCaps(source: unknown): HostCaps {
  const value = (source as { devinAdditionalDirectories?: unknown } | null | undefined)?.devinAdditionalDirectories;
  return { devinAdditionalDirectories: value === true };
}
