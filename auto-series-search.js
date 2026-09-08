/**
 * Auto-Series (search pass) — typo-tolerant fill for books the exact-title
 * pass missed. Uses Hardcover's search endpoint (Typesense) which tolerates
 * punctuation/spelling differences, then reads series + cover from the top hit.
 *
 * Env: HARDCOVER_TOKEN, FIREBASE_DB_URL
 * Node 18+.
 */

const HC_TOKEN = process.env.HARDCOVER_TOKEN;
const DB = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const HC_ENDPOINT = 'https://api.hardcover.app/v1/graphql';
if (!HC_TOKEN || !DB) { console.error('Missing env vars'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function hardcover(query, variables, retried) {
  let res;
  try {
    res = await fetch(HC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + HC_TOKEN,
        'User-Agent': 'book-shelf-auto-series-search (personal reading tracker)'
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (e) {
    if (!retried) { await sleep(2000); return hardcover(query, variables, true); }
    throw e;
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '10', 10);
    console.log(`Rate limited, waiting ${wait}s...`);
    await sleep(wait * 1000);
    return hardcover(query, variables);
  }
  if (!res.ok) { console.error(`HC ${res.status}`, (await res.text()).slice(0, 300)); return null; }
  const json = await res.json();
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors).slice(0, 300)); return null; }
  return json.data;
}

async function fbGet(path) { const r = await fetch(`${DB}/${path}.json`); return r.ok ? r.json() : null; }
async function fbPatch(path, data) {
  const r = await fetch(`${DB}/${path}.json`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return r.ok;
}

const SEARCH_QUERY = `
query Search($q: String!) {
  search(query: $q, query_type: "Book", per_page: 5, page: 1) { results }
}`;

// pull hit documents out of the Typesense results blob (defensive — shape may vary)
function hitsFrom(results) {
  if (!results) return [];
  let r = results;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return []; } }
  const hits = r.hits || (r.results && r.results[0] && r.results[0].hits) || [];
  return hits.map(h => h.document || h).filter(Boolean);
}

// find a cover url inside a hit document (tries the common shapes)
function coverFromHit(doc) {
  const img = doc.image || doc.cached_image || (doc.featured_series && doc.featured_series.image);
  if (!img) return '';
  if (typeof img === 'string') { try { const p = JSON.parse(img); return p.url || ''; } catch (e) { return img.startsWith('http') ? img : ''; } }
  return img.url || '';
}

// Google Books fallback for covers
async function googleCover(title, author) {
  try {
    const q = encodeURIComponent(`${title} ${(author||'').split(',')[0]}`);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?maxResults=1&q=${q}`);
    if (!res.ok) return '';
    const data = await res.json();
    const v = data.items && data.items[0] && data.items[0].volumeInfo;
    const img = v && v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
    return img ? img.replace('http://','https://').replace('&edge=curl','') : '';
  } catch (e) { return ''; }
}

(async () => {
  const booksRaw = await fbGet('books');
  if (!booksRaw) { console.log('No books.'); return; }

  const entries = Object.entries(booksRaw).filter(([id, b]) =>
    !(b.series && b.series.trim()) || !(b.cover && b.cover.trim()) || (b.cover && b.cover.includes('od-cdn.com'))
  );
  console.log(`${entries.length} books still need series and/or cover (search pass)...`);
  let seriesFilled = 0, coversFilled = 0, noHit = 0;

  for (const [id, b] of entries) {
   try {
    const q = `${b.title} ${(b.author || '').split(',')[0]}`.trim();
    const data = await hardcover(SEARCH_QUERY, { q });
    await sleep(1300); // search bucket is stricter; pace gently

    const hits = data ? hitsFrom(data.search && data.search.results) : [];
    if (!hits.length) { noHit++; continue; }

    // choose the hit whose author matches ours (fallback: first hit)
    const myAuthor = norm((b.author || '').split(',')[0]);
    let doc = hits.find(h => {
      const names = [].concat(h.author_names || []).map(norm);
      return !myAuthor || names.some(n => n && (n.includes(myAuthor) || myAuthor.includes(n)));
    }) || hits[0];

    const patch = {};
    const isBoxset = /boxset|collection|books \d|vol\.|part (one|two|three)/i.test(b.title || '');

    // series
    if (!(b.series && b.series.trim()) && !isBoxset) {
      const sName = (doc.featured_series && doc.featured_series.series_name)
        || (Array.isArray(doc.series_names) ? doc.series_names[0] : doc.series_names);
      if (sName) {
        patch.series = sName;
        const pos = doc.featured_series_position != null ? doc.featured_series_position
                  : (doc.featured_series && doc.featured_series.position);
        if (pos != null) patch.seriesNum = pos;
      }
    }

    // cover
    if (!(b.cover && b.cover.trim()) || (b.cover && b.cover.includes('od-cdn.com'))) {
      let cov = coverFromHit(doc);
      if (!cov) { cov = await googleCover(b.title, b.author); await sleep(1100); }
      if (cov) { patch.cover = cov; if (b.coverCleared) patch.coverCleared = null; }
    }

    if (!Object.keys(patch).length) continue;
    const ok = await fbPatch('books/' + id, patch);
    if (ok) {
      if (patch.series) seriesFilled++;
      if (patch.cover) coversFilled++;
      console.log(`  ${b.title}${patch.series ? ' → ' + patch.series + (patch.seriesNum != null ? ' #' + patch.seriesNum : '') : ''}${patch.cover ? ' [cover]' : ''}`);
    }
   } catch (e) {
    console.log(`  (skipped ${b.title}: ${e.code || e.message})`);
    await sleep(2000); // brief pause after a network hiccup
   }
  }

  console.log(`Done. Series: +${seriesFilled}, covers: +${coversFilled}, no match: ${noHit}, of ${entries.length}.`);
})().catch(e => { console.error(e); process.exit(1); });
