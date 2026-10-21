// Fetches the #opencomm Google Sheet and regenerates the static snapshot:
//   - data/journals.json
//   - the pre-rendered list and JSON-LD in index.html
//   - <lastmod> in sitemap.xml
//
// Usage: node scripts/fetch-sheet.mjs   (Node 18+, no dependencies)

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { CONFIG, LEAD, cleanCell, parseCSV, parseSheet, buildMain, toHTML, safeUrl } = require('../app.js');

const ROOT = new URL('../', import.meta.url);
const SITE_URL = 'https://dougaparry.github.io/opencomm-journal-list/';

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
    url: SITE_URL,
    isBasedOn: CONFIG.sheetUrl,
    creator: creators,
    keywords: ['open science', 'open access', 'communication research', 'media studies', 'academic journals',
      'registered reports', 'open peer review', 'open data', 'article processing charges', 'APC'],
    inLanguage: 'en',
    dateModified: data.fetchedAt,
    distribution: [
      { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: CONFIG.csvUrl },
      { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: SITE_URL + 'data/journals.json' },
    ],
  };
}

// Returns the text of one file inside a ZIP archive (an XLSX file is a ZIP archive).
function readZipEntry(zip, name) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16); // start of the central directory
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(p + 28);
    if (zip.toString('utf8', p + 46, p + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(p + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(p + 20));
      return (zip.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return '';
}

const xmlAttr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';
};

// The CSV export drops cell hyperlinks (e.g. each journal name links to the journal's
// website), so they are read from the XLSX export of the same tab. Returns
// { journal name: { column name: url } }.
async function fetchLinks(rawRows) {
  const response = await fetch(CONFIG.xlsxUrl);
  if (!response.ok) throw new Error(`XLSX request failed: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const sheet = readZipEntry(zip, 'xl/worksheets/sheet1.xml');
  const targets = {};
  for (const [tag] of readZipEntry(zip, 'xl/worksheets/_rels/sheet1.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    targets[xmlAttr(tag, 'Id')] = xmlAttr(tag, 'Target');
  }

  const rows = rawRows.map((r) => r.map(cleanCell));
  const headerIndex = rows.findIndex((r) => r.some((c) => /^journal$/i.test(c)));
  const header = rows[headerIndex];
  const nameIndex = header.findIndex((c) => /^journal$/i.test(c));
  const links = {};
  for (const [tag] of sheet.matchAll(/<hyperlink\b[^>]*>/g)) {
    const url = safeUrl(targets[xmlAttr(tag, 'r:id')] || '');
    const cell = xmlAttr(tag, 'ref').match(/^([A-Z]+)(\d+)/);
    if (!url || !cell) continue;
    const col = [...cell[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(cell[2]) - 1;
    const name = rows[row] && rows[row][nameIndex];
    if (row <= headerIndex || !name || !header[col]) continue;
    (links[name] = links[name] || {})[header[col]] = url;
  }
  return links;
}

async function updateSnapshot() {
  const response = await fetch(CONFIG.csvUrl);
  if (!response.ok) throw new Error(`Sheet request failed: HTTP ${response.status}`);
  const rawRows = parseCSV(await response.text());
  const parsed = parseSheet(rawRows);
  if (!parsed) throw new Error('No header row with a "Journal" cell found. Is the sheet shared publicly?');
  if (!parsed.rows.length) throw new Error('The sheet has no journal rows; keeping the old snapshot.');
  const data = Object.assign({ fetchedAt: new Date().toISOString() }, parsed);

  try {
    data.links = await fetchLinks(rawRows);
  } catch (error) {
    console.warn(`Could not read links from the sheet, keeping the previous ones: ${error.message}`);
    data.links = JSON.parse(await readFile(file('data/journals.json'), 'utf8')).links || {};
  }

  await writeFile(file('data/journals.json'), JSON.stringify(data, null, 2) + '\n');

  let html = await readFile(file('index.html'), 'utf8');
  const main = buildMain(data).map(toHTML).join('') +
    `<script type="application/json" id="snapshot-data">${scriptJSON(data)}</script>`;
  html = replaceBetween(html, 'SNAPSHOT', main);
  html = replaceBetween(html, 'JSONLD', `<script type="application/ld+json">\n${scriptJSON(jsonLd(data), 2)}\n</script>`);
  await writeFile(file('index.html'), html);

  const sitemap = await readFile(file('sitemap.xml'), 'utf8');
  await writeFile(file('sitemap.xml'), sitemap.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${data.fetchedAt.slice(0, 10)}</lastmod>`));

  console.log(`Snapshot updated: ${data.rows.length} journals, ${data.columns.length} columns, links for ${Object.keys(data.links).length} journals.`);
}

try {
  await updateSnapshot();
} catch (error) {
  console.error(`Could not update the snapshot: ${error.message}`);
  process.exitCode = 1;
}
