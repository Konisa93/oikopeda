// Συλλέγει τις κατοικίες προς πώληση του Intrum Marketplace σε data/listings.json.
//
// Ανοίγει τις δημόσιες σελίδες του site με headless Chromium, όπως ένας επισκέπτης:
// πρώτα τη λίστα (50 ανά σελίδα), μετά τη σελίδα κάθε ακινήτου που είναι νέο,
// άλλαξε τιμή ή δεν έχει ελεγχθεί για καιρό.
//
// Χρήση: node scraper/scrape.js [--minutes 300] [--max-details 2000] [--concurrency 3] [--refresh]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://marketplace.intrum.gr';
const LIST_URL = (page, sort) => `${BASE}/residential/sale?per_page=50&page=${page}&sort_by=${sort}`;
// Η προεπιλεγμένη ταξινόμηση δεν είναι σταθερή (ίσα «βάρη»), οπότε μια σελίδα μπορεί να επαναλάβει αγγελίες.
// Αν μετά από ένα πέρασμα λείπουν αγγελίες, ξαναπερνάμε με άλλη ταξινόμηση.
const LIST_SORTS = ['weight:desc', 'price:asc', 'price:desc'];
const DETAIL_URL = (id) => `${BASE}/el/listings/${id}`;
const OUT = path.join(__dirname, '..', 'data', 'listings.json');
const DETAIL_MAX_AGE_DAYS = 30;

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
    const [k, v] = s.trim().split(/\s+/);
    return [k, v === undefined ? true : v];
  })
);
const MINUTES = Number(args.minutes || 300);
const MAX_DETAILS = Number(args['max-details'] || 5000);
const REFRESH = !!args.refresh; // ξαναδιάβασε όλες τις σελίδες ακινήτων
const CONCURRENCY = Number(args.concurrency || 3);
const deadline = Date.now() + MINUTES * 60 * 1000;
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    return { updatedAt: null, source: BASE, listings: [] };
  }
}

function save(db) {
  db.updatedAt = new Date().toISOString();
  db.listings.sort((a, b) => b.id - a.id);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
}

const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

async function newPage(browser, { blockMaps = false } = {}) {
  const page = await browser.newPage({ locale: 'el-GR' });
  await page.route('**/*', (r) => {
    const req = r.request();
    if (['image', 'font', 'media'].includes(req.resourceType())) return r.abort();
    // Στη λίστα ο χάρτης αλλάζει τα όρια αναζήτησης και γυρνάει τη σελίδα στην 1η.
    if (blockMaps && /maps\.googleapis|maps\.gstatic/.test(req.url())) return r.abort();
    if (/googletagmanager|google-analytics|recaptcha|doubleclick/.test(req.url())) return r.abort();
    return r.continue();
  });
  return page;
}

// ---------- Λίστα ----------

function parseCard(lines) {
  // lines: κείμενο μιας κάρτας, π.χ.
  // [ΝΕΑ ΠΡΟΣΘΗΚΗ, 15, κ.α: VG2-0037305, <τίτλος>, 70 τ.μ., 3ος όροφος, 1, €92.000, €1.314 / τ.μ., Περισσότερα]
  const out = { badge: null, code: null, title: null, price: null, sqm: null, floorLabel: null };
  const iCode = lines.findIndex((l) => l.startsWith('κ.α:'));
  if (iCode > 0 && /[Α-ΩA-Z]{3,}/.test(lines[0])) out.badge = lines[0];
  if (iCode >= 0) {
    out.code = lines[iCode].replace('κ.α:', '').trim();
    out.title = lines[iCode + 1] || null;
  }
  const sqmLine = lines.slice(iCode + 2).find((l) => /^\d[\d.]*\s*τ\.μ\.$/.test(l));
  out.sqm = num(sqmLine);
  out.floorLabel = lines.find((l) => /όροφος$|^Ισόγειο$|^Υπόγειο$|^Ημιυπόγειο$|^Ημιόροφος$/.test(l)) || null;
  const priceLine = lines.find((l) => /^€[\d.]+$/.test(l));
  out.price = priceLine ? num(priceLine) : null;
  out.priceOnRequest = lines.some((l) => /κατόπιν αιτήματος/i.test(l));
  return out;
}

async function scrapeList(browser) {
  const page = await newPage(browser, { blockMaps: true });
  const seen = new Map();
  let total = null;
  for (const sort of LIST_SORTS) {
  if (total != null && seen.size >= total) break;
  let lastPage = 200;
  for (let n = 1; n <= lastPage; n++) {
    let cards = null;
    for (let attempt = 1; attempt <= 3 && !cards; attempt++) {
      try {
        await page.goto(LIST_URL(n, sort), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href*="/listings/"]', { timeout: 45000 });
        await sleep(800);
        const onPage = Number(new URL(page.url()).searchParams.get('page') || 1);
        if (onPage !== n) throw new Error(`η σελίδα μεταφέρθηκε στην ${onPage}`);
        cards = await page.evaluate(() => {
          const txt = document.body.innerText.match(/([\d.]+)\s+ακίνητα βρέθηκαν/);
          const ids = [...new Set([...document.querySelectorAll('a[href*="/listings/"]')]
            .map((a) => a.getAttribute('href').match(/listings\/(\d+)/)?.[1]).filter(Boolean))];
          const items = ids.map((id) => {
            // ανέβα μέχρι το στοιχείο που περιέχει μόνο αυτή την κάρτα
            let card = document.querySelector(`a[href*="/listings/${id}"]`);
            while (card.parentElement) {
              const hrefs = new Set([...card.parentElement.querySelectorAll('a[href*="/listings/"]')]
                .map((a) => a.getAttribute('href').match(/listings\/(\d+)/)?.[1]));
              if (hrefs.size > 1) break;
              card = card.parentElement;
            }
            return { id: Number(id), lines: card.innerText.split('\n').map((s) => s.trim()).filter(Boolean) };
          });
          return { total: txt ? Number(txt[1].replace(/\./g, '')) : null, items };
        });
      } catch (e) {
        console.warn(`list page ${n} attempt ${attempt}: ${e.message.split('\n')[0]}`);
        await sleep(3000 * attempt);
      }
    }
    if (!cards) throw new Error(`Αποτυχία στη σελίδα λίστας ${n}`);
    if (cards.total != null) total = cards.total;
    const before = seen.size;
    for (const c of cards.items) if (!seen.has(c.id)) seen.set(c.id, { id: c.id, ...parseCard(c.lines) });
    console.log(`list ${sort} page ${n}: +${seen.size - before} (σύνολο ${seen.size}/${total ?? '?'})`);
    if (total != null) lastPage = Math.ceil(total / 50);
    if (cards.items.length === 0) break;
    if (total != null && seen.size >= total) break;
  }
  console.log(`ταξινόμηση ${sort}: ${seen.size}/${total ?? '?'}`);
  }
  await page.close();
  return { cards: [...seen.values()], total };
}

// ---------- Σελίδα ακινήτου ----------

const SECTION_HEADERS = new Set(['Γενικά', 'Οικόπεδο', 'Κτίριο', 'Εσωτερικό', 'Εξωτερικό', 'Μονάδα', 'Ασφάλεια', 'Παροχές', 'Εγκαταστάσεις']);

function parseDetail(raw) {
  const lines = raw.text.split('\n').map((s) => s.trim()).filter(Boolean);
  const idx = (label, from = 0) => lines.indexOf(label, from);

  const iDesc = idx('Περιγραφή');
  const iFeat = idx('Χαρακτηριστικά', Math.max(iDesc, 0));
  const iDisc = lines.findIndex((l, i) => i > iFeat && l.startsWith('*Intrum'));
  const description = iDesc >= 0 && iFeat > iDesc ? lines.slice(iDesc + 1, iFeat).join('\n') : null;

  // Τα χαρακτηριστικά διαβάζονται από τη δομή της σελίδας (ζεύγη ετικέτα/τιμή)· οι γραμμές κειμένου είναι μόνο εφεδρεία.
  const features = {};
  if (raw.features && raw.features.length) {
    for (const [k, v] of raw.features) if (k) features[k] = v || 'Ναι';
  } else if (iFeat >= 0) {
    const block = lines.slice(iFeat + 1, iDisc > iFeat ? iDisc : undefined).filter((l) => !SECTION_HEADERS.has(l));
    for (let i = 0; i + 1 < block.length; i += 2) features[block[i]] = block[i + 1];
  }

  let address = null;
  const iAddr = idx('Διεύθυνση ακινήτου');
  if (iAddr >= 0) address = lines[iAddr + 1] || null;

  const distances = [];
  const iDist = idx('Απόσταση από το ακίνητο');
  if (iDist >= 0) {
    for (let i = iDist + 1; i + 1 < lines.length && lines[i + 1].startsWith('Απόσταση:'); i += 2) {
      const [kind, ...name] = lines[i].split(' - ');
      const d = lines[i + 1].replace('Απόσταση:', '').trim();
      const meters = /χλμ/.test(d) ? num(d) * 1000 : num(d);
      distances.push({ kind: kind.trim(), name: name.join(' - ').trim(), meters });
    }
  }

  let lat = null, lng = null;
  for (const h of raw.maps) {
    const m = h.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/) || h.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) { lat = Number(m[1]); lng = Number(m[2]); break; }
  }

  const loc = raw.crumbs.map(([name, href]) => ({ name, slug: (href.match(/locations=([^&]+)/) || [])[1] }));
  const f = features;
  return {
    region: loc[0] || null,
    area: loc[1] || null,
    neighborhood: loc[2] || null,
    address,
    lat, lng,
    image: raw.image || null,
    description,
    distances,
    features,
    year: num(f['Έτος κατασκευής']),
    energyClass: f['Ενεργειακή κλάση'] || null,
    floorText: f['Οροφος'] || f['Όροφος'] || null,
    mainSqm: num(f['Εμβαδόν κύριων χώρων']),
    auxSqm: num(f['Εμβαδόν βοηθητικών χώρων']),
    plotSqm: num(f['Μέγεθος οικοπέδου']),
    bedrooms: num(f['Υπνοδωμάτια']),
    bathrooms: num(f['Μπάνια']),
    buildingFloors: num(f['Όροφοι']),
    elevator: f['Ανελκυστήρας'] || f['Ασανσέρ'] || null,
    stage: f['Στάδιο ολοκλήρωσης'] || null,
    heating: f['Θέρμανση'] || null,
    glazing: f['Υαλοπίνακες κουφωμάτων'] || null,
  };
}

async function scrapeDetail(page, id) {
  await page.goto(DETAIL_URL(id), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('text=Χαρακτηριστικά', { timeout: 45000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForSelector('text=Διεύθυνση ακινήτου', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('a[href*="maps.google"], a[href*="google.com/maps"]'), null, { timeout: 8000 }).catch(() => {});
  const raw = await page.evaluate(() => ({
    crumbs: [...document.querySelectorAll('a[href*="locations="]')].map((a) => [a.innerText.trim(), a.getAttribute('href')]),
    maps: [...document.querySelectorAll('a[href*="maps.google"], a[href*="google.com/maps"]')].map((a) => a.href),
    image: document.querySelector('meta[property="og:image"]')?.content,
    features: [...document.querySelectorAll('.label-attribute')].map((a) => [
      a.querySelector('.attribute__label')?.innerText.trim(),
      a.querySelector('.attribute__value')?.innerText.trim(),
    ]),
    text: document.querySelector('main')?.innerText || document.body.innerText,
  }));
  return parseDetail(raw);
}

// ---------- Κύρια ροή ----------

(async () => {
  const db = load();
  if (!db.baseline) db.baseline = today; // ημερομηνία πρώτης συλλογής: ό,τι υπήρχε τότε δεν μετράει ως «νέο»
  const byId = new Map(db.listings.map((l) => [l.id, l]));
  const browser = await chromium.launch();

  const { cards, total } = await scrapeList(browser);
  if (total && cards.length < total * 0.9) {
    console.warn(`Προσοχή: βρέθηκαν ${cards.length} από ${total}. Δεν σημειώνω τίποτα ως αποσυρμένο.`);
  }
  const live = new Set(cards.map((c) => c.id));

  for (const c of cards) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c, url: DETAIL_URL(c.id), firstSeen: today, lastSeen: today, priceHistory: c.price ? [{ date: today, price: c.price }] : [] });
      continue;
    }
    if (c.price && prev.price !== c.price) {
      prev.priceHistory = [...(prev.priceHistory || []), { date: today, price: c.price }];
      prev.detailFetchedAt = null; // ξαναδιάβασε τη σελίδα του
    }
    Object.assign(prev, c, { lastSeen: today, removedAt: null });
  }
  if (!total || cards.length >= total * 0.9) {
    for (const l of byId.values()) if (!live.has(l.id) && !l.removedAt) l.removedAt = today;
  }
  db.listings = [...byId.values()];
  db.total = total;
  save(db);

  const stale = (l) => REFRESH || !l.detailFetchedAt || !!l.detailError || (Date.now() - Date.parse(l.detailFetchedAt)) / 864e5 > DETAIL_MAX_AGE_DAYS;
  const queue = db.listings.filter((l) => !l.removedAt && stale(l))
    .sort((a, b) => (a.detailFetchedAt ? 1 : 0) - (b.detailFetchedAt ? 1 : 0) || b.id - a.id)
    .slice(0, MAX_DETAILS);
  console.log(`Σελίδες ακινήτων προς ανάγνωση: ${queue.length}`);

  let done = 0, failed = 0;
  const worker = async () => {
    const page = await newPage(browser);
    while (queue.length && Date.now() < deadline) {
      const l = queue.shift();
      try {
        Object.assign(l, await scrapeDetail(page, l.id), { detailFetchedAt: new Date().toISOString(), detailError: null });
        done++;
      } catch (e) {
        failed++;
        l.detailError = e.message.split('\n')[0];
        console.warn(`#${l.id}: ${l.detailError}`);
      }
      if ((done + failed) % 25 === 0) { save(db); console.log(`λεπτομέρειες: ${done} οκ, ${failed} αποτυχίες, ${queue.length} απομένουν`); }
      await sleep(300);
    }
    await page.close();
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save(db);
  await browser.close();
  console.log(`Τέλος: ${db.listings.filter((l) => !l.removedAt).length} ενεργές αγγελίες, ${done} σελίδες ακινήτων, ${failed} αποτυχίες, ${queue.length} για την επόμενη φορά.`);
})().catch((e) => { console.error(e); process.exit(1); });
