import { hostCaps, type HostCaps } from "../shared/host-caps";

/**
 * What the host announces about itself in the IRIX_HOST_CAPS environment variable (a JSON object, set by the host
 * when it starts). Stock Paseo sets nothing, so every capability is false there.
 */
export function readHostCaps(env: Record<string, string | undefined> = process.env): HostCaps {
  const raw = env.IRIX_HOST_CAPS;
  if (!raw) return hostCaps(undefined);
  try {
    return hostCaps(JSON.parse(raw));
  } catch {
    return hostCaps(undefined);
  }
}
