import en from "./locales/en.json";

export type Translate = (
  key: string,
  options?: { count?: number; [name: string]: string | number | undefined },
) => string;

type Tree = { [k: string]: string | Tree };

function lookup(key: string): string | undefined {
  let node: string | Tree | undefined = en as Tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** English text for code that has no React context (server, shared). */
export const englishTranslate: Translate = (key, options) => {
  let text: string | undefined;
  if (typeof options?.count === "number") {
    const form = new Intl.PluralRules("en").select(options.count);
    text = lookup(`${key}_${form}`) ?? lookup(`${key}_other`);
  }
  text ??= lookup(key);
  if (text === undefined) throw new Error(`Unknown translation key: ${key}`);
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = options?.[name];
    return value === undefined ? whole : String(value);
  });
};

/** True for simplified Chinese tags: zh, zh-CN, zh-Hans and any suffix of them. */
export function isChineseLocale(locale: string | undefined): boolean {
  if (!locale) return false;
  return /^zh(-cn|-hans(-.*)?)?$/i.test(locale);
}
