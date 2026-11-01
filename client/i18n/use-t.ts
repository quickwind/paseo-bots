import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import type { Translate } from "../../shared/translate";

/** Translation for a component; works only inside a plugin surface. */
export function useT(): { t: Translate; locale: string } {
  const { t, locale } = useTranslation(messages);
  return { t: t as unknown as Translate, locale };
}
