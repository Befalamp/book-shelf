/**
 * Catch Up — for each series the user has started, find books that come AFTER
 * their highest-owned position and that they don't already own. Writes them to
 * Firebase /catchup for the app's Catch Up tab.
 *
 * Env: HARDCOVER_TOKEN, FIREBASE_DB_URL. Node 18+.
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
        'User-Agent': 'book-shelf-catchup (personal reading tracker)'
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (e) {
    if (!retried) { await sleep(2000); return hardcover(query, variables, true); }
    throw e;
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '10', 10);
    await sleep(wait * 1000); return hardcover(query, variables, retried);
  }
  if (!res.ok) { console.error(`HC ${res.status}`, (await res.text()).slice(0, 200)); return null; }
  const json = await res.json();
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors).slice(0, 200)); return null; }
  return json.data;
}

async function fbGet(path) { const r = await fetch(`${DB}/${path}.json`); return r.ok ? r.json() : null; }
async function fbPut(path, data) {
  const r = await fetch(`${DB}/${path}.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return r.ok;
}

// find the series id by name (exact), then list its books in order
const SERIES_ID_QUERY = `
query SeriesId($name: String!) {
  series(where: { name: { _eq: $name } }, order_by: { books_count: desc }, limit: 1) {
    id
    name
  }
}`;

const SERIES_BOOKS_QUERY = `
query SeriesBooks($id: Int!) {
  series_by_pk(id: $id) {
    name
    book_series(
      where: { book: { book_status_id: { _eq: 1 }, compilation: { _eq: false } } },
      order_by: { position: asc }
    ) {
      position
      book {
        title
        slug
        release_date
        users_read_count
        image { url }
        cached_image
      }
    }
  }
}`;

function coverFrom(bk) {
  if (bk.image && bk.image.url) return bk.image.url;
  if (bk.cached_image) {
    try { const c = typeof bk.cached_image === 'string' ? JSON.parse(bk.cached_image) : bk.cached_image; if (c && c.url) return c.url; } catch (e) {}
  }
  return '';
}

const keyFor = (t, a) => (a + '_' + t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180);

(async () => {
  const booksRaw = await fbGet('books');
  if (!booksRaw) { console.log('No books.'); return; }
  const owned = Object.values(booksRaw);

  // group owned books by series, capturing highest owned position and a set of owned titles
  const series = {}; // name -> { maxPos, titles:Set, author }
  for (const b of owned) {
    if (!b.series || !b.series.trim()) continue;
    const s = (series[b.series] = series[b.series] || { maxPos: 0, titles: new Set(), author: (b.author||'').split(',')[0].trim() });
    s.titles.add(norm(b.title));
    // if it's a boxset with coversUpTo, use that; otherwise use seriesNum
    const pos = (b.coversUpTo != null) ? b.coversUpTo
              : (b.seriesNum != null && b.seriesNum !== 0) ? b.seriesNum : 0;
    if (pos > s.maxPos) s.maxPos = pos;
  }

  const names = Object.keys(series);
  console.log(`${names.length} series you've started — checking for later books...`);
  const catchup = {};

  for (const name of names) {
    const s = series[name];
    // resolve series id
    const idData = await hardcover(SERIES_ID_QUERY, { name });
    await sleep(1100);
    const sid = idData && idData.series && idData.series[0] && idData.series[0].id;
    if (!sid) { console.log(`  ? ${name}: not found on Hardcover`); continue; }

    const data = await hardcover(SERIES_BOOKS_QUERY, { id: sid });
    await sleep(1100);
    const list = data && data.series_by_pk && data.series_by_pk.book_series;
    if (!list || !list.length) continue;

    // dedupe by position, keeping the most-read edition (per emgoto's duplicate note)
    const byPos = {};
    for (const row of list) {
      if (row.position == null) continue;
      const cur = byPos[row.position];
      if (!cur || (row.book.users_read_count || 0) > (cur.book.users_read_count || 0)) byPos[row.position] = row;
    }

    // books after user's highest owned position, not already owned
    let added = 0;
    for (const pos of Object.keys(byPos).map(Number).sort((a,b)=>a-b)) {
      if (pos <= s.maxPos) continue;              // already past this
      const bk = byPos[pos].book;
      if (s.titles.has(norm(bk.title))) continue;  // already own it
      const k = keyFor(bk.title, s.author || name);
      catchup[k] = {
        title: bk.title,
        author: s.author || '',
        series: name,
        seriesNum: pos,
        slug: bk.slug || '',
        cover: coverFrom(bk),
        releaseDate: bk.release_date || ''
      };
      added++;
      if (added >= 5) break; // cap per series so it doesn't flood
    }
    if (added) console.log(`  ${name}: +${added} to catch up on (you're at #${s.maxPos})`);
  }

  const ok = await fbPut('catchup', catchup);
  console.log(ok ? `Wrote ${Object.keys(catchup).length} catch-up books.` : 'Failed to write.');
  if (!ok) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
