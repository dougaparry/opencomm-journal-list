# #opencomm Journal List – website

A read-only website for the **Open Media and Communication Research (#opencomm) Journal List**: peer-reviewed journals in media and communication research that support open science (open access, APC-free publishing, registered reports, open peer review, open data, and more).

The list is created by Moritz Büchi, Michael Reiss, and Tobias Dienlin, and maintained in a [Google Sheet](https://docs.google.com/spreadsheets/d/1WDTBIop2Eg9CKsvQ1BUgMXJdmrh1TAreyS02SiWEJDY/edit?gid=0). This site always reflects the sheet.

The website is built by [Douglas Parry](https://github.com/dougaparry) as an independent project and is not directly affiliated with the list's authors. To suggest a journal or report outdated information, comment on the sheet or request edit access there.

## How it works

- **Plain HTML, CSS and JavaScript.** No framework, no build step, no dependencies.
- **Snapshot in the HTML.** `index.html` contains the full list, pre-rendered between the `SNAPSHOT` markers, so search engines, link previews and visitors without JavaScript see real content. The same data is in `data/journals.json`.
- **Live refresh in the browser.** On page load, `app.js` fetches the sheet as CSV and updates the list if it changed. If the sheet cannot be reached, the snapshot stays on screen with a note and a Retry button.
- **Daily rebuild.** The GitHub Action in `.github/workflows/deploy.yml` runs `scripts/fetch-sheet.mjs` every day (and on every push to `main`, or manually), then deploys to GitHub Pages. These snapshot updates are deployed directly and are not committed to `main`.

`app.js` is shared: in the browser it runs the page, and in Node the snapshot script uses its parsing and rendering functions, so the pre-rendered and live versions always look the same.

The sheet's header row is found by looking for the `Journal` cell; the lines above it (title, credits, last update, contribution note, inclusion criteria) become the intro. Columns are read from the header row, so new or renamed columns still appear (in each journal's details). The `checked` column is a maintainers' bookkeeping column and is hidden (`CONFIG.hiddenColumns` in `app.js`).

## Changing the sheet

The sheet ID and tab are set once, at the top of `app.js`:

```js
const CONFIG = {
  sheetId: '1WDTBIop2Eg9CKsvQ1BUgMXJdmrh1TAreyS02SiWEJDY',
  gid: '0',
  ...
};
```

The sheet must be shared as **Anyone with the link: Viewer**, otherwise fetching fails.

Which columns appear in the main table, and in which group, is set by `GROUPS` in `app.js` (matched by name pattern, so e.g. a new year in "Scopus 2025 Percentile" still matches).

## Updating the snapshot locally

```bash
node scripts/fetch-sheet.mjs
```

Requires Node 18 or newer. This rewrites the snapshot in `index.html`, `data/journals.json` and the date in `sitemap.xml`.

## Running locally

Opening `index.html` directly from disk works, including search, filters and sorting, but it shows the committed snapshot: browsers block the live sheet request from `file://` pages (Google's redirect sends no CORS header for them). To see the live refresh, and to test closest to GitHub Pages, serve the folder:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploying

1. Push this repository to GitHub.
2. In the repository settings, under **Pages**, set **Source** to **GitHub Actions**.
3. The workflow deploys on every push to `main`, daily, and when run manually from the **Actions** tab.

The site is published at https://dougaparry.github.io/opencomm-journal-list/. That URL is used for the canonical link, social preview tags, structured data, `robots.txt` and `sitemap.xml`; if the address changes (e.g. a custom domain), update it in those files and in `SITE_URL` in `scripts/fetch-sheet.mjs`.

GitHub pauses scheduled workflows in repositories with no activity for 60 days. If that happens, re-enable the workflow in the **Actions** tab; the live refresh in the browser keeps the list current in the meantime.
