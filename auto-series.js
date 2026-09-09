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
    default_cover_edition {
      image { url }
      cached_image
    }
    editions(limit: 3, order_by: { users_count: desc_nulls_last }) {
      image { url }
      cached_image
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

// strip Audible-style suffixes that other databases don't use
function cleanTitle(t) {
  return String(t || '')
    .replace(/,\s*Book\s*\d+$/i, '')           // ", Book 2"
    .replace(/:\s*A\s+[\w\s]+(?:Thriller|Mystery|Novel)$/i, '')  // ": A Scottish Crime Thriller"
    .replace(/:\s*An\s+[\w\s]+(?:Thriller|Mystery|Novel)$/i, '') // ": An Alexander Gregory Thriller"
    .replace(/:\s*Books?\s*\d[\d\-]*$/i, '')    // ": Books 1-3"
    .replace(/,\s*Books?\s*\d[\d\-]*$/i, '')    // ", Books 1-3"
    .trim();
}

(async () => {
  const booksRaw = await fbGet('books');
  if (!booksRaw) { console.log('No books in Firebase.'); return; }

  // helper: extract a cover URL from image/cached_image fields
  function imageFrom(obj) {
    if (obj.image && obj.image.url) return obj.image.url;
    if (obj.cached_image && typeof obj.cached_image === 'object' && Object.keys(obj.cached_image).length > 0) {
      try {
        const c = typeof obj.cached_image === 'string' ? JSON.parse(obj.cached_image) : obj.cached_image;
        if (c && c.url) return c.url;
      } catch (e) {}
    }
    if (obj.cached_image && typeof obj.cached_image === 'string' && obj.cached_image.startsWith('http')) return obj.cached_image;
    return '';
  }

  // pull cover from book → default_cover_edition → any edition
  function coverFrom(hb) {
    let cov = imageFrom(hb);
    if (cov) return cov;
    // try the specific edition Hardcover uses for its cover
    if (hb.default_cover_edition) {
      cov = imageFrom(hb.default_cover_edition);
      if (cov) return cov;
    }
    // try other editions
    if (hb.editions && hb.editions.length) {
      for (const ed of hb.editions) {
        cov = imageFrom(ed);
        if (cov) return cov;
      }
    }
    console.log(`    [cover-debug] ${hb.title}: all HC image fields empty`);
    return '';
  }

  // Open Library: search by title+author, return a verified cover URL or ''
  async function openLibraryCover(title, author) {
    try {
      const q = `title=${encodeURIComponent(title)}&author=${encodeURIComponent((author||'').split(',')[0])}`;
      const res = await fetch(`https://openlibrary.org/search.json?${q}&fields=cover_i&limit=1`);
      if (!res.ok) return '';
      const data = await res.json();
      const doc = data.docs && data.docs[0];
      if (!doc || !doc.cover_i) return '';  // no cover_i = no cover exists
      return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
    } catch (e) { return ''; }
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

  // process any book missing a series OR needing a verified cover
  const entries = Object.entries(booksRaw).filter(([id, b]) => {
    const needsSeries = !(b.series && b.series.trim());
    // keep covers from: Hardcover (hardcover.app), OL (covers.openlibrary.org), manually pasted amazon (media-amazon with /images/I/)
    const goodCover = b.cover && (
      b.cover.includes('hardcover.app') ||
      b.cover.includes('covers.openlibrary.org') ||
      b.cover.includes('openlibrary.org') ||
      (b.cover.includes('media-amazon.com') && b.cover.includes('/images/I/')) ||  // manually pasted real amazon URLs
      b.cover.includes('books.google')
    );
    if (!needsSeries && goodCover) return false;
    return true;
  });

  console.log(`${entries.length} books need a series and/or cover...`);
  let seriesFilled = 0, coversFilled = 0;

  for (const [id, b] of entries) {
    // try exact title first, then cleaned (without Audible suffixes)
    let data = await hardcover(SERIES_QUERY, { title: b.title });
    await sleep(1100);
    const cleaned = cleanTitle(b.title);
    if ((!data || !data.books || !data.books.length) && cleaned !== b.title) {
      data = await hardcover(SERIES_QUERY, { title: cleaned });
      await sleep(1100);
    }
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

    // cover: Hardcover image → Open Library (verified) → Google Books
    const goodCover = b.cover && (
      b.cover.includes('hardcover.app') || b.cover.includes('openlibrary.org') ||
      (b.cover.includes('media-amazon.com') && b.cover.includes('/images/I/')) ||
      b.cover.includes('books.google')
    );
    if (!goodCover) {
      let cov = coverFrom(chosen);
      let src = cov ? 'hardcover' : '';
      if (!cov) { cov = await openLibraryCover(cleanTitle(b.title), b.author); await sleep(1100); src = cov ? 'openlibrary' : ''; }
      if (!cov) { cov = await googleCover(cleanTitle(b.title), b.author); await sleep(1100); src = cov ? 'google' : ''; }
      if (cov) { patch.cover = cov; if (b.coverCleared) patch.coverCleared = null; }
      else { console.log(`    [no-cover] ${b.title} — all 3 sources failed`); }
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
