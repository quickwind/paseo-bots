import type { TidyStatus } from "../../shared/rpc";

export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return "Every day";
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function ago(from: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The Status row under Tidy: what the last run did, anything to review, and a note when memory stays over budget. */
export function describeTidy(status: Pick<TidyStatus, "running" | "waiting" | "last" | "blockedUntil">, now: Date): string {
  if (status.running) return status.waiting ? "Waiting for you to approve something in the Memory tidy chat" : "Tidying now...";
  const parts: string[] = [];
  if (status.last) {
    const note = status.last.note ? `: ${status.last.note}` : "";
    parts.push(status.last.status === "failed" ? `Last run ${ago(status.last.at, now)} failed${note}` : `Last run ${ago(status.last.at, now)}${note}`);
    if (status.last.flags.length) parts.push(`Please review: ${status.last.flags.join("; ")}`);
  } else parts.push("Not run yet");
  if (status.blockedUntil) parts.push("Memory is over budget and tidy could not shrink it; it will try again tomorrow");
  return parts.join(". ");
}
