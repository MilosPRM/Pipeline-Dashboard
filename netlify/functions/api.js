/**
 * Pipeline CRM - API layer.
 *
 * Every read and write the browser performs goes through here. This is the only
 * place that knows where the data physically lives, and the only place that holds
 * credentials. Swapping Google Sheets for Postgres later means rewriting this file
 * and nothing else.
 *
 * Routes (see ARCHITECTURE.md):
 *   GET  /api/health   configuration check, reveals no secret values
 *   GET  /api/deals    all deals as JSON
 *   POST /api/write    proxied write, token injected server side
 */

'use strict';

/* Non-secret defaults. These two URLs are already public, so shipping them as
   fallbacks costs nothing and keeps the site working before the environment
   variables are set. The token deliberately has no fallback. */
var CSV_URL = process.env.SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRBeSbdlZv6mIqF_JGMAHbgk8kBXGgkMRO8BlgH0MhU58_Musmu5cuBLtBzcFc4QU44bniYDZvOZsxi/pub?gid=0&single=true&output=csv';
var SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbyxjW7255V3MKoDSOPkj826lqNhmimO69-9NhPJT1SxmbK3WEIxRUd7Hz4IjZiVYorR/exec';
var SCRIPT_TOKEN = process.env.APPS_SCRIPT_TOKEN || '';
var SHEET_NAME = process.env.SHEET_NAME || 'Master Sheet';

var ALLOWED_ACTIONS = ['update', 'append'];

/* Small in-memory cache. Netlify keeps a warm container alive between requests,
   so this saves re-fetching the whole sheet on every page load. */
var cache = { at: 0, payload: null };
var CACHE_MS = 30 * 1000;

/* ---------- helpers ---------- */

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

/* RFC 4180 CSV reader: handles quoted fields, embedded commas and newlines. */
function parseCSV(text) {
  var rows = [], row = [], field = '', inQuotes = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* Header matching is deliberately fuzzy. The sheet is still being reworked, so
   "Asking Price", "asking_price" and "ASKING PRICE " all have to resolve to the
   same field, and anything we do not recognise is preserved rather than dropped. */
function norm(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

var ALIASES = {
  name:         ['propertyname', 'property', 'name', 'dealname'],
  address:      ['address', 'propertyaddress', 'streetaddress'],
  state:        ['state', 'st'],
  broker:       ['broker', 'brokername', 'listingbroker', 'agent'],
  email:        ['brokeremail', 'email', 'contactemail'],
  phone:        ['brokerphone', 'phone', 'contactphone'],
  year:         ['year', 'yearbuilt', 'built'],
  price:        ['askingprice', 'price', 'ask', 'listprice'],
  units:        ['units', 'ofunits', 'numberofunits', 'unitcount'],
  ppu:          ['perunit', 'priceperunit', 'perunitprice'],
  stage:        ['pipelinestage', 'stage', 'status'],
  priority:     ['priority', 'prio'],
  folder:       ['folderlink', 'folder', 'folderurl', 'drivefolder'],
  url:          ['url', 'link', 'listingurl', 'listinglink'],
  added:        ['dateadded', 'added', 'created', 'createddate'],
  stageChanged: ['laststagechange', 'stagechanged', 'lastchange'],
  source:       ['source', 'channel', 'brokerage']
};

function mapHeaders(headerRow) {
  var map = {}, taken = {}, i, key, n;
  for (i = 0; i < headerRow.length; i++) {
    n = norm(headerRow[i]);
    if (!n) { continue; }
    for (key in ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(ALIASES, key)) { continue; }
      if (taken[key]) { continue; }
      if (ALIASES[key].indexOf(n) !== -1) { map[i] = key; taken[key] = true; break; }
    }
  }
  return map;
}

function toNumber(v) {
  if (v == null) { return null; }
  var s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') { return null; }
  var n = Number(s);
  return isFinite(n) ? n : null;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function buildDeals(rows) {
  if (!rows.length) { return { deals: [], columns: [] }; }
  var header = rows[0];
  var map = mapHeaders(header);
  var deals = [], i, j, key, raw, d, extraKey;

  for (i = 1; i < rows.length; i++) {
    raw = rows[i];
    if (!raw || !raw.join('').trim()) { continue; }

    d = { sheetRow: i + 1, extra: {} };
    for (j = 0; j < header.length; j++) {
      key = map[j];
      if (key) {
        d[key] = raw[j] == null ? '' : String(raw[j]).trim();
      } else if (header[j] && raw[j]) {
        extraKey = String(header[j]).trim();
        d.extra[extraKey] = String(raw[j]).trim();
      }
    }

    d.units = toNumber(d.units);
    d.price = toNumber(d.price);
    d.ppu = toNumber(d.ppu);
    if (d.ppu === null && d.price !== null && d.units) { d.ppu = Math.round(d.price / d.units); }

    /* Stable-ish identifier. Row numbers move when rows are inserted or deleted,
       so prefer the listing URL, then name plus address. sheetRow is kept as the
       physical address for writes. */
    d.id = d.url ? 'u-' + slug(d.url) : (slug(d.name) + '-' + slug(d.address)) || ('r-' + d.sheetRow);

    deals.push(d);
  }
  return { deals: deals, columns: header };
}

async function loadDeals(force) {
  var now = Date.now();
  if (!force && cache.payload && (now - cache.at) < CACHE_MS) { return cache.payload; }

  var res = await fetch(CSV_URL, { redirect: 'follow' });
  if (!res.ok) { throw new Error('Source returned HTTP ' + res.status); }
  var text = await res.text();
  var built = buildDeals(parseCSV(text));

  cache = {
    at: now,
    payload: {
      deals: built.deals,
      columns: built.columns,
      total: built.deals.length,
      fetchedAt: new Date(now).toISOString()
    }
  };
  return cache.payload;
}

/* ---------- routing ---------- */

function segments(path) {
  var s = String(path || '')
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '');
  return s.split('/').filter(Boolean);
}

exports.handler = async function (event) {
  var method = (event.httpMethod || 'GET').toUpperCase();
  var parts = segments(event.path);
  var route = parts[0] || '';
  var q = event.queryStringParameters || {};

  try {

    /* --- GET /api/health ------------------------------------------------ */
    if (route === 'health') {
      return json(200, {
        ok: true,
        data: {
          service: 'pipeline-crm-api',
          storage: 'google-sheets',
          reads: 'enabled',
          writes: SCRIPT_TOKEN ? 'enabled' : 'disabled - APPS_SCRIPT_TOKEN not set',
          env: {
            SHEET_CSV_URL: process.env.SHEET_CSV_URL ? 'set' : 'using default',
            APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL ? 'set' : 'using default',
            APPS_SCRIPT_TOKEN: process.env.APPS_SCRIPT_TOKEN ? 'set' : 'missing'
          },
          now: new Date().toISOString()
        }
      });
    }

    /* --- GET /api/deals -------------------------------------------------- */
    if (route === 'deals' && method === 'GET') {
      var payload = await loadDeals(q.refresh === '1');
      var list = payload.deals;

      if (parts[1]) {
        var one = null, k;
        for (k = 0; k < list.length; k++) {
          if (list[k].id === parts[1] || String(list[k].sheetRow) === parts[1]) { one = list[k]; break; }
        }
        if (!one) { return json(404, { ok: false, error: 'No deal with that id' }); }
        return json(200, { ok: true, data: one });
      }

      if (q.stage) {
        list = list.filter(function (d) { return d.stage === q.stage; });
      }
      if (q.priority) {
        list = list.filter(function (d) { return d.priority === q.priority; });
      }
      if (q.q) {
        var needle = String(q.q).toLowerCase();
        list = list.filter(function (d) {
          return [d.name, d.address, d.broker, d.source].join(' ').toLowerCase().indexOf(needle) !== -1;
        });
      }

      var total = list.length;
      var limit = Math.min(parseInt(q.limit, 10) || 5000, 5000);
      var offset = parseInt(q.offset, 10) || 0;

      return json(200, {
        ok: true,
        data: {
          deals: list.slice(offset, offset + limit),
          total: total,
          offset: offset,
          columns: payload.columns,
          fetchedAt: payload.fetchedAt
        }
      });
    }

    /* --- POST /api/write ------------------------------------------------- */
    /* The browser sends the same payload it always did, minus the token. The
       token is added here, on the server, where it cannot be read by anyone
       viewing the page source. */
    if (route === 'write' && method === 'POST') {
      if (!SCRIPT_TOKEN) {
        return json(503, {
          ok: false,
          error: 'Writes are disabled. Set APPS_SCRIPT_TOKEN in the Netlify environment variables.'
        });
      }

      var payload;
      try { payload = JSON.parse(event.body || '{}'); }
      catch (e) { return json(400, { ok: false, error: 'Body is not valid JSON' }); }

      if (ALLOWED_ACTIONS.indexOf(payload.action) === -1) {
        return json(400, { ok: false, error: 'Unsupported action: ' + String(payload.action) });
      }

      payload.token = SCRIPT_TOKEN;
      payload.sheet = payload.sheet || SHEET_NAME;

      var upstream = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
      var text = await upstream.text();

      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) {
        return json(502, { ok: false, error: 'Upstream did not return JSON', status: upstream.status });
      }

      /* A successful write invalidates the cached sheet immediately. */
      if (parsed && parsed.ok) { cache = { at: 0, payload: null }; }

      return json(upstream.ok ? 200 : 502, parsed);
    }

    /* --- fallthrough ----------------------------------------------------- */
    return json(404, { ok: false, error: 'No such route: ' + method + ' /api/' + parts.join('/') });

  } catch (err) {
    return json(500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};
