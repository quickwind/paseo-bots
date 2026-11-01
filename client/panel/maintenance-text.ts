import { englishTranslate, type Translate } from "../../shared/translate";
import type { TidyStatus } from "../../shared/rpc";

export function intervalLabel(minutes: number, t: Translate = englishTranslate): string {
  if (minutes === 1440) return t("text.schedule.everyDay");
  if (minutes === 60) return t("text.schedule.cronEveryHour");
  if (minutes % 60 === 0) return t("text.schedule.cronEveryHours", { n: minutes / 60 });
  return t("text.schedule.cronEveryMinutes", { n: minutes });
}

function ago(from: string, now: Date, t: Translate): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return t("text.time.justNow");
  if (minutes < 60) return t("panel.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("panel.hoursAgo", { count: hours });
  return t("panel.daysAgo", { n: Math.round(hours / 24) });
}

/** The Status row under Tidy: what the last run did, anything to review, and a note when memory stays over budget. */
export function describeTidy(status: Pick<TidyStatus, "running" | "waiting" | "last" | "blockedUntil">, now: Date, t: Translate = englishTranslate): string {
  if (status.running) return status.waiting ? t("panel.tidyWaiting") : t("panel.tidyingNow");
  const parts: string[] = [];
  if (status.last) {
    const when = ago(status.last.at, now, t);
    const note = status.last.note ? t("panel.noteAfter", { note: status.last.note }) : "";
    parts.push(status.last.status === "failed" ? t("panel.lastRunFailed", { when, note }) : t("panel.lastRun", { when, note }));
    if (status.last.flags.length) parts.push(t("panel.pleaseReview", { flags: status.last.flags.join(t("text.change.partSep")) }));
  } else parts.push(t("panel.notRunYet"));
  if (status.blockedUntil) parts.push(t("panel.overBudget"));
  return parts.join(t("panel.sentenceSep"));
}
