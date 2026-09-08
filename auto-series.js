/**
 * Auto-Series — runs on a schedule via GitHub Actions (or manually).
 * For every book on the shelf that has no series yet, asks Hardcover what
 * series it belongs to (and its position), and writes that back to Firebase.
 *
 * Env vars (from GitHub secrets):
 *   HARDCOVER_TOKEN  - personal access token
 *   FIREBASE_DB_URL  - realtime database URL
 *
 * Node 18+ (global fetch). No npm dependencies.
 */

const HC_TOKEN = process.env.HARDCOVER_TOKEN;
const DB = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const HC_ENDPOINT = 'https://api.hardcover.app/v1/graphql';

if (!HC_TOKEN || !DB) { console.error('Missing HARDCOVER_TOKEN or FIREBASE_DB_URL'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hardcover(query, variables) {
  const res = await fetch(HC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + HC_TOKEN,
      'User-Agent': 'book-shelf-auto-series (personal reading tracker)'
    },
    body: JSON.stringify({ query, variables })
  });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '10', 10);
    console.log(`Rate limited, waiting ${wait}s...`);
    await sleep(wait * 1000);
    return hardcover(query, variables);
  }
  if (!res.ok) { console.error(`HC ${res.status}`, await res.text()); return null; }
  const json = await res.json();
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors)); return null; }
  return json.data;
}

async function fbGet(path) { const r = await fetch(`${DB}/${path}.json`); return r.ok ? r.json() : null; }
async function fbPatch(path, data) {
  const r = await fetch(`${DB}/${path}.json`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return r.ok;
}

// Find a book by title, then read its featured series + position.
// Matches loosely on title (exact), then checks an author contribution matches.
const SERIES_QUERY = `
query BookSeries($title: String!) {
  books(where: { title: { _eq: $title }, book_status_id: { _eq: 1 } }, limit: 5) {
    id
    title
    contributions(where: { contributable_type: { _eq: "Book" } }) {
      author { name }
    }
    book_series {
      position
      series { name }
    }
  }
}`;

// normalise for author comparison
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

(async () => {
  const booksRaw = await fbGet('books');
  if (!booksRaw) { console.log('No books in Firebase.'); return; }

  // only standalone books (no series set), skip the boxsets/collections (title contains "boxset"/"collection"/"books 1")
  const entries = Object.entries(booksRaw).filter(([id, b]) => {
    if (b.series && b.series.trim()) return false;
    const t = (b.title || '').toLowerCase();
    if (/boxset|collection|books \d|vol\.|part (one|two|three)/.test(t)) return false;
    return true;
  });

  console.log(`${entries.length} standalone books to check for series...`);
  let filled = 0;

  for (const [id, b] of entries) {
    const data = await hardcover(SERIES_QUERY, { title: b.title });
    await sleep(1100);
    if (!data || !data.books || !data.books.length) continue;

    // prefer a match whose author matches ours and which HAS a series
    const myAuthor = norm((b.author || '').split(',')[0]);
    let match = null;
    for (const hb of data.books) {
      const authors = (hb.contributions || []).map(c => norm(c.author && c.author.name));
      const authorOk = !myAuthor || authors.some(a => a && (a.includes(myAuthor) || myAuthor.includes(a)));
      if (authorOk && hb.book_series && hb.book_series.length) { match = hb; break; }
    }
    if (!match) continue;

    // take the first series listed
    const bs = match.book_series[0];
    const seriesName = bs.series && bs.series.name;
    if (!seriesName) continue;
    const patch = { series: seriesName };
    if (bs.position != null) patch.seriesNum = bs.position;

    const ok = await fbPatch('books/' + id, patch);
    if (ok) { filled++; console.log(`  ${b.title} -> ${seriesName}${patch.seriesNum ? ' #' + patch.seriesNum : ''}`); }
  }

  console.log(`Done. Filled series on ${filled} of ${entries.length} books.`);
})().catch(e => { console.error(e); process.exit(1); });
