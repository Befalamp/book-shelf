/**
 * Release Radar — runs on a schedule via GitHub Actions.
 * Reads followed authors from Firebase, asks Hardcover for each author's
 * books with a future release_date, writes the hits back to Firebase /releases.
 *
 * Env vars (from GitHub secrets):
 *   HARDCOVER_TOKEN  - personal access token from hardcover.app/account/api
 *   FIREBASE_DB_URL  - e.g. https://book-shelf-xxxxx-default-rtdb.europe-west1.firebasedatabase.app
 *
 * Node 18+ (has global fetch). No npm dependencies needed.
 */

const HC_TOKEN = process.env.HARDCOVER_TOKEN;
const DB = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const HC_ENDPOINT = 'https://api.hardcover.app/v1/graphql';

if (!HC_TOKEN || !DB) {
  console.error('Missing HARDCOVER_TOKEN or FIREBASE_DB_URL env vars.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// --- helpers -------------------------------------------------------------

async function hardcover(query, variables) {
  const res = await fetch(HC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + HC_TOKEN,
      'User-Agent': 'book-shelf-release-radar (personal reading tracker)'
    },
    body: JSON.stringify({ query, variables })
  });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '10', 10);
    console.log(`Rate limited, waiting ${wait}s...`);
    await sleep(wait * 1000);
    return hardcover(query, variables); // retry once
  }
  if (!res.ok) {
    console.error(`Hardcover ${res.status} for`, variables, await res.text());
    return null;
  }
  const json = await res.json();
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors)); return null; }
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// slugify a title+author into a stable Firebase key (no ./#/$/[/]/ chars)
function keyFor(title, author) {
  return (author + '_' + title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180);
}

// --- Firebase REST -------------------------------------------------------

async function fbGet(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) return null;
  return res.json();
}
async function fbPut(path, data) {
  const res = await fetch(`${DB}/${path}.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.ok;
}

// --- Hardcover query -----------------------------------------------------
// Books by an author with a release_date strictly after today.
const UPCOMING_QUERY = `
query Upcoming($name: String!, $today: date!) {
  books(
    where: {
      contributions: { author: { name: { _eq: $name } } },
      release_date: { _gt: $today },
      book_status_id: { _eq: 1 }
    },
    order_by: { release_date: asc },
    limit: 10
  ) {
    id
    title
    release_date
    slug
    contributions(where: { contributable_type: { _eq: "Book" } }, limit: 1) {
      author { name }
    }
  }
}`;

// --- main ----------------------------------------------------------------

(async () => {
  // 1. read followed authors: { autoKey: "Author Name", ... } or array
  const followedRaw = await fbGet('followedAuthors');
  let authors = [];
  if (Array.isArray(followedRaw)) authors = followedRaw.filter(Boolean);
  else if (followedRaw && typeof followedRaw === 'object') authors = Object.values(followedRaw).filter(Boolean);

  // de-dupe, trim
  authors = [...new Set(authors.map(a => String(a).trim()).filter(Boolean))];

  if (!authors.length) {
    console.log('No followed authors yet — nothing to check. (The app seeds these from your shelf.)');
    return;
  }
  console.log(`Checking ${authors.length} authors for upcoming releases...`);

  const releases = {};
  for (const name of authors) {
    const data = await hardcover(UPCOMING_QUERY, { name, today });
    if (!data || !data.books) { await sleep(1100); continue; }
    for (const b of data.books) {
      if (!b.release_date) continue;
      const author = (b.contributions && b.contributions[0] && b.contributions[0].author && b.contributions[0].author.name) || name;
      const k = keyFor(b.title, author);
      releases[k] = {
        title: b.title,
        author,
        date: b.release_date,
        hardcoverId: b.id,
        slug: b.slug || '',
        checkedAt: today
      };
    }
    console.log(`  ${name}: ${data.books.length} upcoming`);
    await sleep(1100); // stay well under 60/min
  }

  // 2. write the whole releases node (replace — it's derived data, safe to overwrite)
  const count = Object.keys(releases).length;
  const ok = await fbPut('releases', releases);
  console.log(ok ? `Wrote ${count} upcoming releases to Firebase.` : 'Failed to write releases.');
  if (!ok) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
