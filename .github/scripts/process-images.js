const https = require('https');
const fs = require('fs');
const path = require('path');
const { createHmac, createHash } = require('crypto');

const CLOUD_NAME    = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY       = process.env.CLOUDINARY_API_KEY;
const API_SECRET    = process.env.CLOUDINARY_API_SECRET;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const FOLDER        = 'jwa-screenshots';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Cloudinary signed API request
async function cloudinaryRequest(endpoint, params = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  params.timestamp = timestamp;
  params.api_key = API_KEY;

  // Build signature
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'api_key' && k !== 'resource_type' && k !== 'file')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  params.signature = createHash('sha256').update(sortedParams + API_SECRET).digest('hex');

  const body = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const options = {
    hostname: 'api.cloudinary.com',
    path: `/v1_1/${CLOUD_NAME}/${endpoint}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const result = await httpsRequest(options, body);
  return JSON.parse(result.body);
}

// List images in the jwa-screenshots folder
async function listImages() {
  const auth = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  const options = {
    hostname: 'api.cloudinary.com',
    path: `/v1_1/${CLOUD_NAME}/resources/image?prefix=${FOLDER}&max_results=1&type=upload`,
    method: 'GET',
    headers: { 'Authorization': `Basic ${auth}` }
  };
  const result = await httpsRequest(options);
  return JSON.parse(result.body);
}

// Download image as base64
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });
    }).on('error', reject);
  });
}

// Send image to Gemini
async function analyzeWithGemini(base64Image, mimeType) {
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Image } },
        { text: `This is a Jurassic World Alive screenshot showing creature cards.
For each visible creature extract:
- name (exact in-game name)
- dna (the DNA count number shown)
- level (the level number shown on the card, usually in the bottom-left corner)
- rarity (determined by card border color: green=Common, blue=Rare, purple/pink=Epic, gold/orange=Legendary, teal/green-unique=Unique, red/dark=Apex)

Return ONLY a JSON object like:
{"Velociraptor":{"dna":1250,"level":5,"rarity":"Common"},"Indominus Rex":{"dna":340,"level":2,"rarity":"Legendary"}}
No markdown, no explanation, no extra text.` }
      ]
    }]
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const result = await httpsRequest(options, body);
  const data = JSON.parse(result.body);

  if (!data.candidates?.[0]) {
    throw new Error(data.error?.message || 'No response from Gemini');
  }

  let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// Delete image from Cloudinary
async function deleteImage(publicId) {
  return cloudinaryRequest('image/destroy', { public_id: publicId });
}

// Update dna data in index.html
function updateInventory(newData) {
  const indexPath = path.join(__dirname, '..', '..', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Find existing inventory marker or build new one
  const startMarker = '// @@INVENTORY_START@@';
  const endMarker   = '// @@INVENTORY_END@@';
  const startIdx = html.indexOf(startMarker);
  const endIdx   = html.indexOf(endMarker);

  // Load existing inventory
  let inventory = {};
  if (startIdx !== -1 && endIdx !== -1) {
    const block = html.slice(startIdx + startMarker.length, endIdx);
    const match = block.match(/let savedInventory\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try { inventory = JSON.parse(match[1]); } catch(e) {}
    }
  }

  // Merge new data
  Object.entries(newData).forEach(([name, val]) => {
    if (typeof val === 'number' && val >= 0) {
      inventory[name] = { dna: val, level: '?', rarity: '?' };
    } else if (val && typeof val.dna === 'number' && val.dna >= 0) {
      inventory[name] = { dna: val.dna, level: val.level || '?', rarity: val.rarity || '?' };
    }
  });

  const today = new Date().toISOString().split('T')[0];
  const replacement = `${startMarker}\n// Auto-updated by GitHub Action ${today}\nlet savedInventory = ${JSON.stringify(inventory, null, 2)};\n${endMarker}`;

  if (startIdx !== -1 && endIdx !== -1) {
    html = html.slice(0, startIdx) + replacement + html.slice(endIdx + endMarker.length);
  } else {
    // Insert before INIT comment
    html = html.replace('// ─────────────────────────────────────────────────────────────────────────────\n// INIT', replacement + '\n// ─────────────────────────────────────────────────────────────────────────────\n// INIT');
  }

  fs.writeFileSync(indexPath, html);
  return Object.keys(inventory).length;
}

async function main() {
  console.log('Checking for pending images...');

  const list = await listImages();
  const images = list.resources || [];

  if (!images.length) {
    console.log('No pending images. Done.');
    process.exit(0);
  }

  const image = images[0];
  console.log(`Processing: ${image.public_id}`);

  // Download
  const base64 = await downloadImage(image.secure_url);
  const mimeType = `image/${image.format === 'jpg' ? 'jpeg' : image.format}`;

  // Analyze
  console.log('Sending to Gemini...');
  const parsed = await analyzeWithGemini(base64, mimeType);
  const count = Object.keys(parsed).length;
  console.log(`Gemini found ${count} creatures`);

  // Update inventory
  const total = updateInventory(parsed);
  console.log(`Inventory now has ${total} creatures`);

  // Delete from Cloudinary
  await deleteImage(image.public_id);
  console.log(`Deleted ${image.public_id} from Cloudinary`);

  // Check how many remain
  const remaining = await listImages();
  const remainCount = (remaining.resources || []).length;
  console.log(`${remainCount} image(s) remaining in queue`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
