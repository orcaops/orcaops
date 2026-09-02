import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';
import { pages, sections } from '../../docs.config.mjs';
import { validateBuiltLinks } from '../../validate-built-links.mjs';

const base = '/';

// The hosted, searchable documentation site. Page order comes from the shared
// docs.config.mjs catalog.
export default defineConfig({
  base,
  title: 'Orcaops',
  description: 'Capture and evaluate AI coding sessions.',
  lang: 'en-US',
  appearance: 'dark',
  cleanUrls: true,
  sitemap: { hostname: 'https://docs.orcaops.ai' },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#0a0b0d' }],
  ],
  // Output under the package's dist/ so it's git-ignored and turbo-cacheable.
  outDir: '../dist/site',
  vite: {
    plugins: [
      llmstxt({
        domain: 'https://docs.orcaops.ai',
        excludeUnnecessaryFiles: false,
        injectLLMHint: false,
      }),
    ],
  },
  buildEnd: validateBuiltLinks,
  themeConfig: {
    logo: {
      light: '/orcaops-wordmark-light.png',
      dark: '/orcaops-wordmark-dark.png',
      alt: 'Orcaops',
    },
    siteTitle: false,
    nav: [
      { text: 'Docs', link: `/${pages[0].slug}` },
      { text: 'Website', link: 'https://orcaops.ai' },
    ],
    sidebar: sections.map((section) => ({
      text: section.title,
      collapsed: false,
      items: section.items.map((page) => ({ text: page.title, link: `/${page.slug}` })),
    })),
    search: { provider: 'local' },
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: 'https://github.com/orcaops/orcaops' }],
  },
});
