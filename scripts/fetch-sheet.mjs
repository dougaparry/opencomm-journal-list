// Fetches the #opencomm Google Sheet and regenerates the static snapshot:
//   - data/journals.json
//   - the pre-rendered list and JSON-LD in index.html
//   - <lastmod> in sitemap.xml
// If SITE_URL is set (the GitHub Action passes the Pages URL), the placeholder site URL in
// index.html, robots.txt and sitemap.xml is replaced with it.
//
// Usage: node scripts/fetch-sheet.mjs   (Node 18+, no dependencies)

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CONFIG, LEAD, parseCSV, parseSheet, buildMain, toHTML } = require('../app.js');

const ROOT = new URL('../', import.meta.url);
const PLACEHOLDER_URL = 'https://USERNAME.github.io/opencomm-journal-list/';

const file = (name) => new URL(name, ROOT);

function replaceBetween(text, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) throw new Error(`Marker ${name} not found in index.html`);
  return text.replace(re, (_, start, end) => `${start}\n${content}\n${end}`);
}

// JSON inside <script> must not contain "</script>".
const scriptJSON = (value, indent) => JSON.stringify(value, null, indent).replace(/</g, '\\u003c');

function jsonLd(data) {
  const creators = data.credit
    .replace(/^created by\s*/i, '')
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
    .filter(Boolean)
    .map((name) => ({ '@type': 'Person', name }));
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: data.title,
    description: `${LEAD} ${data.criteria}`,
    url: PLACEHOLDER_URL,
    isBasedOn: CONFIG.sheetUrl,
    creator: creators,
    keywords: ['open science', 'open access', 'communication research', 'media studies', 'academic journals',
      'registered reports', 'open peer review', 'open data', 'article processing charges', 'APC'],
    inLanguage: 'en',
    dateModified: data.fetchedAt,
    distribution: [
      { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: CONFIG.csvUrl },
      { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: PLACEHOLDER_URL + 'data/journals.json' },
    ],
  };
}

async function updateSnapshot() {
  const response = await fetch(CONFIG.csvUrl);
  if (!response.ok) throw new Error(`Sheet request failed: HTTP ${response.status}`);
  const parsed = parseSheet(parseCSV(await response.text()));
  if (!parsed) throw new Error('No header row with a "Journal" cell found. Is the sheet shared publicly?');
  if (!parsed.rows.length) throw new Error('The sheet has no journal rows; keeping the old snapshot.');
  const data = Object.assign({ fetchedAt: new Date().toISOString() }, parsed);

  await writeFile(file('data/journals.json'), JSON.stringify(data, null, 2) + '\n');

  let html = await readFile(file('index.html'), 'utf8');
  const main = buildMain(data).map(toHTML).join('') +
    `<script type="application/json" id="snapshot-data">${scriptJSON(data)}</script>`;
  html = replaceBetween(html, 'SNAPSHOT', main);
  html = replaceBetween(html, 'JSONLD', `<script type="application/ld+json">\n${scriptJSON(jsonLd(data), 2)}\n</script>`);
  await writeFile(file('index.html'), html);

  const sitemap = await readFile(file('sitemap.xml'), 'utf8');
  await writeFile(file('sitemap.xml'), sitemap.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${data.fetchedAt.slice(0, 10)}</lastmod>`));

  console.log(`Snapshot updated: ${data.rows.length} journals, ${data.columns.length} columns.`);
}

async function applySiteUrl(siteUrl) {
  const base = siteUrl.replace(/\/?$/, '/');
  for (const name of ['index.html', 'robots.txt', 'sitemap.xml']) {
    const text = await readFile(file(name), 'utf8');
    await writeFile(file(name), text.split(PLACEHOLDER_URL).join(base));
  }
  console.log(`Site URL set to ${base}`);
}

try {
  await updateSnapshot();
} catch (error) {
  console.error(`Could not update the snapshot: ${error.message}`);
  process.exitCode = 1;
}
// Apply the site URL even if the sheet could not be fetched, so a deploy of the
// previous snapshot still has correct canonical and sitemap URLs.
if (process.env.SITE_URL) await applySiteUrl(process.env.SITE_URL);
