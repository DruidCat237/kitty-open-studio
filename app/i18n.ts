import { getRequestConfig } from "next-intl/server";

export const locales = [
  "en", "ru", "pl", "de", "it", "es", "pt", "fr",
  "zh", "ja", "cs", "sk", "lt", "sv", "da",
  "no", "el", "uk",
] as const;
export type Locale = (typeof locales)[number];

export default getRequestConfig(async ({ locale }) => {
  const validLocale =
    !locale || !locales.includes(locale as Locale) ? "en" : locale;

  return {
    locale: validLocale,
    messages: (await import(`./messages/${validLocale}.json`)).default,
  };
});
