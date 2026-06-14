// i18n.ts — the global i18next instance for the viewer web app.
//
// ONE default namespace 'translation'; every UI string is keyed t('<area>.<key>')
// where <area> is the camelCase component name. The catalogs are plain JSON of
// shape { "<area>": { "<key>": "<string>" } } and are created/merged by the
// orchestrator at ./locales/zh-Hant.json + ./locales/en.json.
//
// Default UI language is 'zh-Hant' (Traditional Chinese); English is opt-in via
// the per-browser localStorage key 'ui-language'. A team default (from auth
// status) is applied at runtime in store.tsx ONLY when no local choice exists,
// so existing users are unaffected. interpolation.escapeValue is false because
// React already escapes rendered values.

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhHant from './locales/zh-Hant.json';
import en from './locales/en.json';

const LANG_KEY = 'ui-language';

function resolveInitialLang(): 'zh-Hant' | 'en' {
  // Guard for SSR / non-browser contexts where localStorage is unavailable.
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(LANG_KEY);
      if (stored === 'en' || stored === 'zh-Hant') return stored;
    }
  } catch {
    // localStorage can throw (private mode / disabled) — fall through to default.
  }
  return 'zh-Hant';
}

void i18next.use(initReactI18next).init({
  resources: {
    'zh-Hant': { translation: zhHant },
    en: { translation: en },
  },
  lng: resolveInitialLang(),
  fallbackLng: 'zh-Hant',
  interpolation: { escapeValue: false },
});

export default i18next;
