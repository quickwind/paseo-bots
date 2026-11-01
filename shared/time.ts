import { englishTranslate, type Translate } from "./translate";

export function relativeTime(iso: string | null | undefined, now: number = Date.now(), t: Translate = englishTranslate): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t("text.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("text.time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("text.time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("text.time.daysAgo", { count: days });
  return new Date(then).toISOString().slice(0, 10);
}
