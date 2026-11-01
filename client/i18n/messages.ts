import { defineTranslations } from "@getpaseo/plugin/client";
import en from "../../shared/locales/en.json";
import zhCN from "../../shared/locales/zh-CN.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
