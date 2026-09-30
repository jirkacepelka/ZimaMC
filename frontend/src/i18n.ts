import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Every JSON file in ./locales is a language. To add one, copy en.json to
 * <code>.json (e.g. de.json), translate the values and set _meta.name.
 * See CONTRIBUTING.md.
 */
const files = import.meta.glob<{ default: Record<string, unknown> & { _meta: { name: string } } }>("./locales/*.json", {
  eager: true,
});

export const languages = Object.entries(files)
  .map(([path, mod]) => ({ code: path.match(/([\w-]+)\.json$/)![1], name: mod.default._meta.name }))
  .sort((a, b) => (a.code === "en" ? -1 : b.code === "en" ? 1 : a.name.localeCompare(b.name)));

const resources = Object.fromEntries(
  Object.entries(files).map(([path, mod]) => [path.match(/([\w-]+)\.json$/)![1], { translation: mod.default }]),
);

function initialLanguage() {
  try {
    const saved = localStorage.getItem("zimamc.lang");
    if (saved && resources[saved]) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = navigator.language?.split("-")[0];
  return nav && resources[nav] ? nav : "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(code: string) {
  void i18n.changeLanguage(code);
  document.documentElement.lang = code;
  try {
    localStorage.setItem("zimamc.lang", code);
  } catch {
    /* storage unavailable */
  }
}

export default i18n;
