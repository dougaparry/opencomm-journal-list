/*
 * #opencomm Journal List
 *
 * This file runs in two places:
 *  - In the browser (classic <script>): adds search, filters and sorting, and refreshes
 *    the list from the live Google Sheet.
 *  - In Node (scripts/fetch-sheet.mjs): the same parsing and rendering functions
 *    pre-render the snapshot into index.html, so search engines, link previews and
 *    visitors without JavaScript see the full list.
 *
 * Rendering builds a small tree of plain objects ({ tag, attrs, children }) that becomes
 * DOM nodes in the browser or escaped HTML in Node. Sheet content is always inserted as
 * text, never as HTML.
 */
(function () {
  'use strict';

  const CONFIG = {
    sheetId: '1WDTBIop2Eg9CKsvQ1BUgMXJdmrh1TAreyS02SiWEJDY',
    gid: '0',
    fetchTimeoutMs: 15000,
    // Columns the sheet maintainers use for bookkeeping; not shown on the site.
    hiddenColumns: ['checked'],
    websiteAuthor: { name: 'Douglas Parry', url: 'https://dougaparry.com/' },
  };
  CONFIG.sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/edit?gid=${CONFIG.gid}`;
  // The export endpoint keeps the sheet's layout (context rows, then the header row).
  // The gviz endpoint merges the context rows into the header, so it is not used.
  CONFIG.csvUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/export?format=csv&gid=${CONFIG.gid}`;

  const LEAD = 'A curated list of peer-reviewed journals in media and communication research ' +
    'that support open science. Compare full open access, article processing charges (APC), ' +
    'registered reports, open peer review, open data, open science badges, openness to ' +
    'replications, and indexing in DOAJ, Web of Science and Scopus.';

  // Columns shown in the main table, grouped. Matched by pattern so the site keeps working
  // when e.g. "Scopus 2024 Percentile" becomes "Scopus 2025 Percentile". Every other column
  // still appears in each journal's details.
  const GROUPS = [
    { label: 'Access', columns: [/^full open access/i, /^apc free/i] },
    { label: 'Open science', columns: [/^registered reports/i, /^open peer review/i, /^open data/i, /^open science badges/i, /^replications/i] },
    { label: 'Indexing', columns: [/doaj/i, /\bwos\b|web of science/i, /^included in scopus/i] },
    { label: 'Metrics', columns: [/percentile/i, /^s[jr][jr]\b/i] },
  ];
  const NAME_COLUMN = /^journal$/i;
  const SUBTITLE_COLUMN = /^publisher$/i; // shown under the journal name

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  // RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Turns the sheet's rows into { title, credit, lastUpdate, criteria, contribute, notes,
  // columns, rows }. The header row is the one containing a "Journal" cell; everything
  // above it is page context. Returns null if no header row is found.
  function parseSheet(rawRows) {
    const rows = rawRows.map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim()));
    const headerIndex = rows.findIndex((r) => r.some((c) => NAME_COLUMN.test(c)));
    if (headerIndex < 0) return null;

    const context = [];
    rows.slice(0, headerIndex).forEach((r) => r.forEach((c) => {
      if (c && !/^google docs link$/i.test(c)) context.push(c);
    }));
    const take = (re) => {
      const i = context.findIndex((t) => re.test(t));
      return i < 0 ? '' : context.splice(i, 1)[0];
    };
    const credit = take(/^created by/i);
    const lastUpdate = take(/^last update/i);
    const criteria = take(/^inclusion criteria/i);
    const contribute = take(/edit access|please comment/i);
    const title = context.shift() || 'Open Media and Communication Research #opencomm – Journal List';

    const header = rows[headerIndex];
    const hidden = CONFIG.hiddenColumns.map((n) => n.toLowerCase());
    const keep = header
      .map((name, i) => (name && !hidden.includes(name.toLowerCase()) ? i : -1))
      .filter((i) => i >= 0);
    const nameIndex = header.findIndex((c) => NAME_COLUMN.test(c));
    const dataRows = rows.slice(headerIndex + 1)
      .filter((r) => r[nameIndex])
      .map((r) => keep.map((i) => r[i] || ''));

    return {
      title, credit, lastUpdate, criteria, contribute, notes: context,
      columns: keep.map((i) => header[i]),
      rows: dataRows,
    };
  }

  // "TRUE"/"Yes" -> true, "FALSE"/"No" -> false, anything else -> null.
  function flagValue(value) {
    const v = value.toLowerCase();
    if (v === 'true' || v === 'yes') return true;
    if (v === 'false' || v === 'no') return false;
    return null;
  }

  // Numbers such as "2.410", "1977" or "96th"; null for "NA", "Not Com." etc.
  function numberValue(value) {
    return /^\d+(\.\d+)?(st|nd|rd|th)?$/i.test(value) ? parseFloat(value) : null;
  }

  function normalize(text) {
    return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function slugify(text) {
    return normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function shortLabel(name) {
    return name.replace(/^included in /i, '').replace(/\s*\(.*\)\s*$/, '');
  }

  function describeColumns(data) {
    return data.columns.map((name, index) => {
      const values = data.rows.map((r) => r[index]).filter(Boolean);
      const share = (test) => (values.length ? values.filter(test).length / values.length : 0);
      let kind = 'text';
      if (NAME_COLUMN.test(name)) kind = 'name';
      else if (share((v) => flagValue(v) !== null) >= 0.3) kind = 'flag';
      else if (share((v) => numberValue(v) !== null) >= 0.5) kind = 'number';
      else if (new Set(values).size > 1 && new Set(values).size <= 6) kind = 'category';
      return {
        index, name, kind,
        label: shortLabel(name),
        group: GROUPS.findIndex((g) => g.columns.some((re) => re.test(name))),
      };
    });
  }

  // Everything the page needs to render and filter a data set.
  function buildModel(data) {
    const cols = describeColumns(data);
    const name = cols.find((c) => c.kind === 'name');
    const subtitle = cols.find((c) => SUBTITLE_COLUMN.test(c.name));
    const groups = GROUPS
      .map((g, gi) => ({ label: g.label, columns: cols.filter((c) => c.group === gi && c !== name) }))
      .filter((g) => g.columns.length);
    const tableCols = groups.flatMap((g) => g.columns);
    const detailCols = cols.filter((c) => c !== name && c !== subtitle && !tableCols.includes(c));

    const seen = new Set();
    const journals = data.rows.map((values) => {
      let id = 'journal-' + (slugify(values[name.index]) || 'unnamed');
      for (let n = 2; seen.has(id); n++) id = id.replace(/-\d+$/, '') + '-' + n;
      seen.add(id);
      return { id, values, search: normalize(values.join(' ')) };
    });

    return {
      cols, name, subtitle, groups, tableCols, detailCols, journals,
      flagCols: tableCols.filter((c) => c.kind === 'flag'),
      categoryCols: detailCols.filter((c) => c.kind === 'category'),
      sortCols: [name].concat(tableCols.filter((c) => c.kind === 'number')),
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering (shared by browser and Node)
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    return {
      tag,
      attrs: attrs || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''),
    };
  }

  const VOID_TAGS = new Set(['input', 'br']);
  const LINE_BREAK_AFTER = new Set(['section', 'div', 'p', 'h1', 'h2', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'dl']);

  function escapeHTML(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toHTML(node) {
    if (typeof node === 'string' || typeof node === 'number') return escapeHTML(node);
    let attrs = '';
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      attrs += value === true ? ` ${key}` : ` ${key}="${escapeHTML(value)}"`;
    }
    if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
    const html = `<${node.tag}${attrs}>${node.children.map(toHTML).join('')}</${node.tag}>`;
    return LINE_BREAK_AFTER.has(node.tag) ? html + '\n' : html;
  }

  function toDOM(node) {
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
    const el = document.createElement(node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(key, value === true ? '' : String(value));
    }
    node.children.forEach((child) => el.appendChild(toDOM(child)));
    return el;
  }

  function safeUrl(text) {
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  // A cell is only made a link if the whole value is an http(s) URL.
  function renderText(value) {
    const url = safeUrl(value);
    return url ? h('a', { href: url }, value) : value;
  }

  function renderValue(value, col) {
    const flag = col.kind === 'flag' ? flagValue(value) : null;
    if (flag === true) return h('span', { class: 'mark yes' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'Yes');
    if (flag === false) return h('span', { class: 'mark no' }, h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'No'));
    return renderText(value);
  }

  // "Inclusion criteria: text" -> ['Inclusion criteria', 'text']
  function splitLabel(text, fallback) {
    const m = text.match(/^([^:]{1,40}):\s*(.*)$/);
    return m ? [m[1], m[2]] : [fallback, text];
  }

  function buildIntro(data) {
    const [criteriaLabel, criteriaText] = splitLabel(data.criteria, 'Inclusion criteria');
    return h('section', { id: 'about', class: 'intro', 'aria-labelledby': 'page-title' },
      h('h1', { id: 'page-title' }, data.title),
      h('p', { class: 'lead' }, LEAD),
      h('div', { class: 'intro-grid' },
        h('div', { class: 'intro-col' },
          h('h2', null, 'About this list'),
          data.credit && h('p', null, data.credit.replace(/\s*\.?$/, '.')),
          data.lastUpdate && h('p', null, data.lastUpdate.replace(/\s*\.?$/, '.')),
          h('h2', null, 'About this website'),
          h('p', null, 'This website was built by ',
            h('a', { href: CONFIG.websiteAuthor.url }, CONFIG.websiteAuthor.name),
            '. It pulls its data directly from the #opencomm Google Sheet, which is created and maintained by the list’s authors. ' +
            'The website is an independent project and is not directly affiliated with them.'),
          h('h2', null, 'Download the data'),
          h('ul', { class: 'plain-list' },
            h('li', null, h('a', { href: CONFIG.csvUrl }, 'CSV export of the live sheet')),
            h('li', null, h('a', { href: './data/journals.json' }, 'JSON snapshot used by this site')))),
        h('div', { class: 'intro-col' },
          criteriaText && h('h2', null, criteriaLabel),
          criteriaText && h('p', null, criteriaText),
          data.notes.map((note) => h('p', null, note)),
          h('h2', null, 'Suggest a journal or report an error'),
          data.contribute && h('p', null, data.contribute.replace(/\s*\.?$/, '.')),
          h('p', null, h('a', { href: CONFIG.sheetUrl }, 'Open the #opencomm Google Sheet')))));
  }

  function sortDirection(state, col) {
    if (!state.sort || state.sort.col !== col.name) return null;
    return state.sort.dir > 0 ? 'ascending' : 'descending';
  }

  function headerCell(model, state, col, attrs) {
    const dir = sortDirection(state, col);
    const icon = dir === 'ascending' ? '▲' : dir === 'descending' ? '▼' : '↕';
    return h('th', Object.assign({ scope: 'col', class: 'col-' + col.kind, 'aria-sort': dir }, attrs),
      h('button', { type: 'button', class: 'sort', 'data-sort': col.name, title: 'Sort by ' + col.name },
        col.label, ' ', h('span', { class: 'sort-icon', 'aria-hidden': 'true' }, icon)));
  }

  function buildRows(model, journals, state) {
    const groupStarts = new Set(model.groups.map((g) => g.columns[0]));
    const columnCount = 1 + model.tableCols.length;
    return journals.map((j) => {
      const open = state.expanded.has(j.id);
      const name = j.values[model.name.index];
      const subtitle = model.subtitle && j.values[model.subtitle.index];
      const details = model.detailCols.filter((c) => j.values[c.index]);
      return [
        h('tr', { id: j.id, class: 'journal' },
          h('th', { scope: 'row', class: 'col-name' },
            h('span', { class: 'journal-name' }, name),
            subtitle && h('span', { class: 'publisher' }, subtitle),
            h('span', { class: 'row-actions' },
              h('button', { type: 'button', class: 'toggle', 'aria-expanded': String(open), 'aria-controls': j.id + '-details', 'data-toggle': j.id },
                open ? 'Hide details' : 'Details'),
              h('a', { class: 'permalink', href: '#' + j.id }, 'Link', h('span', { class: 'sr-only' }, ' to ' + name)))),
          model.tableCols.map((c) => h('td', {
            class: 'col-' + c.kind + (groupStarts.has(c) ? ' group-start' : ''),
            'data-label': c.name,
          }, renderValue(j.values[c.index], c)))),
        h('tr', { id: j.id + '-details', class: 'details' + (open ? ' open' : '') },
          h('td', { colspan: columnCount },
            h('dl', null, details.map((c) => h('div', { class: 'detail' },
              h('dt', null, c.name),
              h('dd', null, renderText(j.values[c.index]))))))),
      ];
    });
  }

  function buildTable(model, journals, state) {
    const total = model.journals.length;
    if (!journals.length) {
      return h('div', { class: 'empty' },
        h('p', null, total ? 'No journals match your search and filters.' : 'The sheet currently lists no journals.'),
        total ? h('button', { type: 'button', class: 'button', 'data-action': 'clear' }, 'Clear search and filters') : null);
    }
    return h('table', { class: 'journal-table' },
      h('caption', { class: 'sr-only' }, 'Journals with their open access, open science, indexing and metric details'),
      h('thead', null,
        h('tr', { class: 'group-row' },
          headerCell(model, state, model.name, { rowspan: 2 }),
          model.groups.map((g) => h('th', { scope: 'colgroup', colspan: g.columns.length, class: 'group-start' }, g.label))),
        h('tr', { class: 'col-row' },
          model.groups.map((g) => g.columns.map((c, i) => headerCell(model, state, c, i === 0 ? { class: 'col-' + c.kind + ' group-start' } : null))))),
      h('tbody', null, buildRows(model, journals, state)));
  }

  function countText(shown, total) {
    return shown === total ? `${total} journals` : `Showing ${shown} of ${total} journals`;
  }

  // The whole <main> content, as pre-rendered into index.html.
  function buildMain(data) {
    const model = buildModel(data);
    const state = { sort: null, expanded: new Set() };
    return [
      buildIntro(data),
      h('section', { id: 'journals', class: 'journals', 'aria-labelledby': 'journals-title' },
        h('h2', { id: 'journals-title' }, 'Journals'),
        h('p', { class: 'legend' },
          h('span', { class: 'mark yes' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'Yes'),
          ' = offered or indexed. ',
          h('span', { class: 'mark no' }, '–'),
          ' = no. An amount under “APC free” is the fee charged. ' +
          'Select “Details” for licence, scope, first issue, society support and notes on fees.'),
        h('div', { id: 'controls', class: 'controls', hidden: true }),
        h('div', { class: 'status-bar' },
          h('p', { id: 'result-count', class: 'result-count', role: 'status' }, countText(model.journals.length, model.journals.length)),
          h('p', { id: 'data-status', class: 'data-status' },
            data.fetchedAt ? `Snapshot of the sheet from ${formatDate(data.fetchedAt)}.` : '')),
        h('div', { id: 'table-container', class: 'table-container' }, buildTable(model, model.journals, state))),
    ];
  }

  // ---------------------------------------------------------------------------
  // Browser
  // ---------------------------------------------------------------------------

  function visibleJournals(model, state) {
    const words = normalize(state.query).split(/\s+/).filter(Boolean);
    const list = model.journals.filter((j) =>
      model.flagCols.every((c) => !state.flags.has(c.name) || flagValue(j.values[c.index]) === true) &&
      model.categoryCols.every((c) => !state.category[c.name] || j.values[c.index] === state.category[c.name]) &&
      words.every((w) => j.search.includes(w)));

    if (!state.sort) return list;
    const col = model.cols.find((c) => c.name === state.sort.col);
    if (!col) return list;
    const key = (j) => {
      const v = j.values[col.index];
      if (col.kind === 'flag') return flagValue(v) === true ? 1 : 0;
      if (col.kind === 'number') return numberValue(v);
      return v ? normalize(v) : null;
    };
    const byName = (a, b) => normalize(a.values[model.name.index]).localeCompare(normalize(b.values[model.name.index]));
    return list.slice().sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) return byName(a, b);
      if (ka === null) return 1; // missing values always last
      if (kb === null) return -1;
      return (ka < kb ? -1 : 1) * state.sort.dir;
    });
  }

  function buildControls(model, state) {
    const sortValue = state.sort ? state.sort.col + '|' + state.sort.dir : '';
    const flagGroups = model.groups.filter((g) => g.columns.some((c) => c.kind === 'flag'));
    return [
      h('div', { class: 'control-search' },
        h('label', { for: 'search' }, 'Search'),
        h('input', { id: 'search', type: 'search', value: state.query, autocomplete: 'off', placeholder: 'Journal, publisher, ISSN, licence, notes…' })),
      h('fieldset', { class: 'filters' },
        h('legend', null, 'Show only journals with'),
        flagGroups.map((g) => h('div', { class: 'filter-group' },
          h('p', { class: 'filter-group-label' }, g.label),
          g.columns.filter((c) => c.kind === 'flag').map((c) =>
            h('label', { class: 'check' },
              h('input', { type: 'checkbox', 'data-filter-flag': c.name, checked: state.flags.has(c.name) }),
              ' ', c.label))))),
      h('div', { class: 'control-row' },
        model.categoryCols.map((c) => h('label', { class: 'select' }, c.name,
          h('select', { 'data-filter-category': c.name },
            h('option', { value: '' }, 'All'),
            Array.from(new Set(model.journals.map((j) => j.values[c.index]).filter(Boolean))).sort()
              .map((v) => h('option', { value: v, selected: state.category[c.name] === v }, v))))),
        h('label', { class: 'select sort-select' }, 'Sort by',
          h('select', { id: 'sort-select' },
            h('option', { value: '' }, 'Sheet order'),
            model.sortCols.flatMap((c) => c.kind === 'name'
              ? [h('option', { value: c.name + '|1', selected: sortValue === c.name + '|1' }, c.name + ' (A–Z)')]
              : [h('option', { value: c.name + '|-1', selected: sortValue === c.name + '|-1' }, c.name + ' (high to low)')]))),
        h('button', { type: 'button', class: 'button', 'data-action': 'clear' }, 'Clear all')),
    ];
  }

  function initBrowser() {
    const byId = (id) => document.getElementById(id);
    const state = { query: '', flags: new Set(), category: {}, sort: null, expanded: new Set() };
    let snapshot = null;
    let data = null;
    let model = null;
    let controlsKey = '';

    try {
      snapshot = JSON.parse(byId('snapshot-data').textContent);
    } catch (e) {
      snapshot = null;
    }

    function setData(next) {
      data = next;
      model = buildModel(data);
      byId('about').replaceWith(toDOM(buildIntro(data)));
      // Rebuild controls only when the columns change, so typing is never interrupted.
      const key = model.cols.map((c) => c.name + ':' + c.kind).join('|');
      if (key !== controlsKey) {
        controlsKey = key;
        renderControls();
      }
      renderTable();
    }

    function renderControls() {
      const names = new Set(model.cols.map((c) => c.name));
      state.flags.forEach((n) => { if (!names.has(n)) state.flags.delete(n); });
      Object.keys(state.category).forEach((n) => { if (!names.has(n)) delete state.category[n]; });
      const controls = byId('controls');
      controls.replaceChildren(...buildControls(model, state).map(toDOM));
      controls.hidden = false;
    }

    function renderTable() {
      const list = visibleJournals(model, state);
      byId('table-container').replaceChildren(toDOM(buildTable(model, list, state)));
      byId('result-count').textContent = countText(list.length, model.journals.length);
      const sortSelect = byId('sort-select');
      if (sortSelect) {
        const value = state.sort ? state.sort.col + '|' + state.sort.dir : '';
        sortSelect.value = Array.from(sortSelect.options).some((o) => o.value === value) ? value : '';
      }
    }

    function setStatus(kind, message, retry) {
      const marks = { error: 'Error:', note: 'Note:' };
      byId('data-status').replaceChildren(toDOM(h('span', { class: 'status status-' + kind },
        marks[kind] && h('span', { class: 'status-mark' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), marks[kind]),
        ' ', message,
        retry && ' ',
        retry && h('button', { type: 'button', class: 'button button-small', 'data-action': 'retry' }, 'Retry'))));
    }

    async function loadLive() {
      const snapshotDate = snapshot && snapshot.fetchedAt ? formatDate(snapshot.fetchedAt) : null;
      setStatus('loading', snapshotDate
        ? `Showing the snapshot from ${snapshotDate}. Checking the live sheet for updates…`
        : 'Loading the journal list from the live sheet…');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);
      try {
        const response = await fetch(CONFIG.csvUrl, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const live = parseSheet(parseCSV(await response.text()));
        if (!live) throw new Error('No header row found');
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const content = (d) => JSON.stringify([d.title, d.credit, d.lastUpdate, d.criteria, d.contribute, d.notes, d.columns, d.rows]);
        const changed = !data || content(data) !== content(live);
        if (changed) setData(Object.assign(live, { fetchedAt: new Date().toISOString() }));
        setStatus('ok', changed && snapshot
          ? `Updated from the live sheet at ${time}.`
          : `Up to date with the live sheet (checked at ${time}).`);
      } catch (error) {
        setStatus(data ? 'note' : 'error', data
          ? `The live sheet could not be loaded, so this is the snapshot from ${snapshotDate}.`
          : 'The journal list could not be loaded.', true);
      } finally {
        clearTimeout(timer);
      }
    }

    function expandFromHash() {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!/^journal-/.test(id)) return;
      state.expanded.add(id);
      const button = document.querySelector(`[data-toggle="${CSS.escape(id)}"]`);
      if (button && button.getAttribute('aria-expanded') !== 'true') toggleDetails(id);
    }

    // Opens or closes one journal's details in place, keeping keyboard focus where it is.
    function toggleDetails(id) {
      const open = !byId(id + '-details').classList.contains('open');
      if (open) state.expanded.add(id); else state.expanded.delete(id);
      byId(id + '-details').classList.toggle('open', open);
      const button = document.querySelector(`[data-toggle="${CSS.escape(id)}"]`);
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Hide details' : 'Details';
    }

    document.addEventListener('input', (event) => {
      if (event.target.id === 'search') {
        state.query = event.target.value;
        renderTable();
      }
    });

    document.addEventListener('change', (event) => {
      const t = event.target;
      if (t.dataset.filterFlag) {
        if (t.checked) state.flags.add(t.dataset.filterFlag); else state.flags.delete(t.dataset.filterFlag);
      } else if (t.dataset.filterCategory) {
        state.category[t.dataset.filterCategory] = t.value;
      } else if (t.id === 'sort-select') {
        const [col, dir] = t.value.split('|');
        state.sort = col ? { col, dir: Number(dir) } : null;
      } else {
        return;
      }
      renderTable();
    });

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-sort], [data-toggle], [data-action]');
      if (!target) return;
      if (target.dataset.toggle) {
        toggleDetails(target.dataset.toggle);
      } else if (target.dataset.sort) {
        // First click: names A–Z, flags and numbers high to low. Next click reverses.
        const col = model.cols.find((c) => c.name === target.dataset.sort);
        const first = col.kind === 'name' || col.kind === 'text' ? 1 : -1;
        state.sort = { col: col.name, dir: state.sort && state.sort.col === col.name ? -state.sort.dir : first };
        renderTable();
        document.querySelector(`[data-sort="${CSS.escape(col.name)}"]`).focus();
      } else if (target.dataset.action === 'clear') {
        state.query = '';
        state.flags.clear();
        state.category = {};
        state.sort = null;
        renderControls();
        renderTable();
        byId('search').focus();
      } else if (target.dataset.action === 'retry') {
        loadLive();
      }
    });

    window.addEventListener('hashchange', expandFromHash);

    if (location.hash) state.expanded.add(decodeURIComponent(location.hash.slice(1)));
    if (snapshot) setData(snapshot);
    loadLive();
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { CONFIG, LEAD, parseCSV, parseSheet, buildMain, toHTML };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowser);
  } else {
    initBrowser();
  }
})();
