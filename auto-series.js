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
    image { url }
    cached_image
    editions(limit: 5, order_by: { users_count: desc_nulls_last }) {
      isbn_10
      isbn_13
    }
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

  // helper: pull a usable cover URL out of the Hardcover book record
  function coverFrom(hb) {
    if (hb.image && hb.image.url) return hb.image.url;
    if (hb.cached_image) {
      try {
        const c = typeof hb.cached_image === 'string' ? JSON.parse(hb.cached_image) : hb.cached_image;
        if (c && c.url) return c.url;
      } catch (e) {}
    }
    return '';
  }

  // convert ISBN-13 (978 prefix) to ISBN-10
  function isbn13to10(isbn13) {
    const clean = isbn13.replace(/[^0-9]/g, '');
    if (clean.length !== 13 || !clean.startsWith('978')) return null;
    const core = clean.slice(3, 12); // 9 digits
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(core[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    return core + (check === 10 ? 'X' : String(check));
  }

  // get Amazon cover URL from Hardcover editions' ISBNs
  function amazonCover(hb) {
    if (!hb.editions || !hb.editions.length) return '';
    for (const ed of hb.editions) {
      if (ed.isbn_10) return `https://m.media-amazon.com/images/P/${ed.isbn_10}.jpg`;
      if (ed.isbn_13) {
        const isbn10 = isbn13to10(ed.isbn_13);
        if (isbn10) return `https://m.media-amazon.com/images/P/${isbn10}.jpg`;
      }
    }
    return '';
  }

  // Google Books fallback for covers Hardcover doesn't have
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

  // process any book missing a series OR needing a better cover (not already Amazon)
  const entries = Object.entries(booksRaw).filter(([id, b]) => {
    const needsSeries = !(b.series && b.series.trim());
    const hasAmazonCover = b.cover && b.cover.includes('m.media-amazon.com');
    const needsCover = !hasAmazonCover; // replace everything non-Amazon
    if (!needsSeries && !needsCover) return false;
    return true;
  });

  console.log(`${entries.length} books need a series and/or cover...`);
  let seriesFilled = 0, coversFilled = 0;

  for (const [id, b] of entries) {
    const data = await hardcover(SERIES_QUERY, { title: b.title });
    await sleep(1100);
    if (!data || !data.books || !data.books.length) continue;

    const myAuthor = norm((b.author || '').split(',')[0]);
    // pick the best matching book record (author matches; prefer one with a series)
    let match = null, fallback = null;
    for (const hb of data.books) {
      const authors = (hb.contributions || []).map(c => norm(c.author && c.author.name));
      const authorOk = !myAuthor || authors.some(a => a && (a.includes(myAuthor) || myAuthor.includes(a)));
      if (!authorOk) continue;
      if (!fallback) fallback = hb;
      if (hb.book_series && hb.book_series.length) { match = hb; break; }
    }
    const chosen = match || fallback;
    if (!chosen) continue;

    const patch = {};

    // series (only if we don't already have one, and this is a boxset-safe title)
    const isBoxset = /boxset|collection|books \d|vol\.|part (one|two|three)/i.test(b.title || '');
    if (!(b.series && b.series.trim()) && !isBoxset && chosen.book_series && chosen.book_series.length) {
      const bs = chosen.book_series[0];
      if (bs.series && bs.series.name) {
        patch.series = bs.series.name;
        if (bs.position != null) patch.seriesNum = bs.position;
      }
    }

    // cover: Amazon via ISBN first, then Hardcover image, then Google Books
    const hasAmazonCover = b.cover && b.cover.includes('m.media-amazon.com');
    if (!hasAmazonCover) {
      let cov = amazonCover(chosen);
      if (!cov) cov = coverFrom(chosen);
      if (!cov) { cov = await googleCover(b.title, b.author); await sleep(1100); }
      if (cov) { patch.cover = cov; if (b.coverCleared) patch.coverCleared = null; }
    }

    if (!Object.keys(patch).length) continue;
    const ok = await fbPatch('books/' + id, patch);
    if (ok) {
      if (patch.series) { seriesFilled++; }
      if (patch.cover) { coversFilled++; }
      console.log(`  ${b.title}${patch.series ? ' → ' + patch.series + (patch.seriesNum!=null?' #'+patch.seriesNum:'') : ''}${patch.cover ? ' [cover]' : ''}`);
    }
  }

  console.log(`Done. Series filled: ${seriesFilled}, covers filled: ${coversFilled}, of ${entries.length} checked.`);
})().catch(e => { console.error(e); process.exit(1); });
