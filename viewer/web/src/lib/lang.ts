// lang.ts — pure UI-language resolution, kept dependency-free so it is unit
// testable without react-i18next being installed. The default UI language is
// Traditional Chinese ('zh-Hant'); English is strictly opt-in so existing
// users are unaffected. A LOCAL choice (per-browser, localStorage 'ui-language')
// always wins over the TEAM default that the server reports on auth status.

export type UiLang = 'zh-Hant' | 'en';

/**
 * Resolve the effective UI language.
 * @param localPref the per-browser override ('ui-language' in localStorage), if any.
 * @param teamDefault the team-configured default from auth status, if any.
 * @returns localPref when set, else teamDefault when set, else 'zh-Hant'.
 */
export function effectiveLanguage(
  localPref?: UiLang | null,
  teamDefault?: UiLang | null,
): UiLang {
  return localPref ?? teamDefault ?? 'zh-Hant';
}
