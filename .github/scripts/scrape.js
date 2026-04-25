const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const PALEO_BASE = 'https://www.paleo.gg/games/jurassic-world-alive/dinodex';

const RARITY_THRESHOLDS = {
  Common: 50, Rare: 100, Epic: 150,
  Legendary: 200, Unique: 250, Apex: 300, Omega: 500
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrape() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Fetching creature list...');
  await page.goto(PALEO_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  // Extract all creature slugs and names from the listing page
  const slugs = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/dinodex/"]');
    const seen = new Set();
    const result = [];
    links.forEach(a => {
      const href = a.getAttribute('href');
      const match = href.match(/\/dinodex\/([a-z0-9_]+)$/);
      if (match) {
        const slug = match[1];
        if (!seen.has(slug)) {
          seen.add(slug);
          result.push({ slug, name: a.textContent.trim() });
        }
      }
    });
    return result;
  });

  console.log(`Found ${slugs.length} creatures`);

  const db = {};

  for (let i = 0; i < slugs.length; i++) {
    const { slug, name: fallbackName } = slugs[i];
    console.log(`[${i + 1}/${slugs.length}] ${slug}`);

    try {
      await page.goto(`${PALEO_BASE}/${slug}`, { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(500);

      const creature = await page.evaluate((fallbackName, RARITY_THRESHOLDS) => {
        // Name
        const h1 = document.querySelector('h1');
        const name = h1 ? h1.textContent.trim() : fallbackName;

        // Rarity
        let rarity = 'Common';
        const allText = document.body.innerText;
        const rarityMatch = allText.match(/Rarity\s*\n?\s*([A-Za-z]+)/);
        if (rarityMatch) rarity = rarityMatch[1].trim();

        // Class
        let creatureClass = 'Unknown';
        const classMatch = allText.match(/Class\s*\n?\s*([A-Za-z ]+)/);
        if (classMatch) creatureClass = classMatch[1].trim();

        // Hybrid type
        let hybridType = 'Non Hybrid';
        const htMatch = allText.match(/Hybrid Type\s*\n?\s*([A-Za-z ]+)/);
        if (htMatch) hybridType = htMatch[1].trim();
        const isHybrid = hybridType.toLowerCase() !== 'non hybrid';

        // Components — look for "For Fusing" section
        const components = [];
        if (isHybrid) {
          const fuseIdx = allText.indexOf('For Fusing');
          if (fuseIdx !== -1) {
            const section = allText.slice(fuseIdx, fuseIdx + 1000);
            // Match lines like "1,600 DNA  CreatureName"
            const matches = [...section.matchAll(/([\d,]+)\s+DNA\s+([A-Z][A-Za-z0-9 '.]+)/g)];
            const threshold = RARITY_THRESHOLDS[rarity] || 200;
            const fusesNeeded = threshold / 10;
            matches.forEach(m => {
              const total = parseInt(m[1].replace(/,/g, ''));
              const compName = m[2].trim();
              if (compName && compName !== name && total > 0) {
                const costPerFuse = Math.max(1, Math.round(total / fusesNeeded));
                if (!components.find(c => c.name === compName)) {
                  components.push({ name: compName, costPerFuse });
                }
              }
            });
          }
        }

        return { name, rarity, class: creatureClass, isHybrid, hybridType, components };
      }, fallbackName, RARITY_THRESHOLDS);

      db[creature.name] = creature;
    } catch (e) {
      console.error(`  FAILED: ${slug} — ${e.message}`);
    }

    // Polite delay between pages
    await sleep(300);
  }

  await browser.close();

  console.log(`\nDone. ${Object.keys(db).length} creatures scraped.`);
  return db;
}

async function main() {
  const db = await scrape();

  // Write the DB as a JS const that gets injected into index.html
  const dbJson = JSON.stringify(db, null, 2);

  // Read the current index.html, replace the DB placeholder
  const indexPath = path.join(__dirname, '..', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Replace everything between the DB markers
  const startMarker = '// @@DB_START@@';
  const endMarker = '// @@DB_END@@';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error('DB markers not found in index.html');
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const replacement = `${startMarker}\nlet creatureDB = ${dbJson};\nconst DB_UPDATED = '${today}';\n${endMarker}`;
  html = html.slice(0, startIdx) + replacement + html.slice(endIdx + endMarker.length);

  fs.writeFileSync(indexPath, html);
  console.log(`index.html updated with ${Object.keys(db).length} creatures (${today})`);
}

main().catch(e => { console.error(e); process.exit(1); });
