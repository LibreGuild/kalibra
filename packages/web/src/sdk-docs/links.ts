import type { Lang } from './types';

/** URL slug of each SDK's docs: /sdk-docs/javascript, /sdk-docs/python. */
export const SDK_SLUG: Record<Lang, string> = { js: 'javascript', python: 'python' };

/** The public docs path for a language (and section), for links from the app. They open in a new tab. */
export const sdkDocsPath = (lang: Lang, section?: string) => `/sdk-docs/${SDK_SLUG[lang]}${section ? `#${section}` : ''}`;
