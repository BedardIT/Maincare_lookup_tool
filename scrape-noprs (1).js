/**
 * scrape-noprs.js
 * ---------------------------------------------------------------------------
 * Renders the MaineCare NOPRS Telerik report in a real (headless) browser,
 * extracts the provider table, and writes noprs.json to the repo root.
 *
 * Runs in GitHub Actions on a daily schedule (see .github/workflows/noprs-scrape.yml).
 *
 * Why a browser? The report page (mhpviewer.aspx?FID=NORPSPROVREP) is a
 * SharePoint page hosting a Telerik Report Viewer. The provider rows are
 * rendered by JavaScript AFTER load, so a plain fetch() only gets an empty
 * shell. Playwright runs the JS just like Chrome, so the rows appear.
 * ---------------------------------------------------------------------------
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const NOPRS_URL = "https://mainecare.maine.gov/mhpviewer.aspx?FID=NORPSPROVREP";
const OUT_FILE = path.join(process.cwd(), "noprs.json");

// Safety floor: if we scrape fewer than this many rows, treat it as a failed
// render and DO NOT overwrite the last good file. (List normally has 1000s.)
const MIN_ROWS = 200;
const RENDER_TIMEOUT_MS = 120000; // 2 min to fully render the report

/* ---- HTML table parser (same logic proven against the rendered table) ---- */
function cleanCell(cellHtml) {
  return cellHtml
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNoprsTable(html) {
  const providers = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cleanCell);
    if (cells.length < 9) continue;
    const npi = cells[1].replace(/\D/g, "");
    if (!/^\d{10}$/.test(npi)) continue;
    providers.push({
      name: cells[0],
      npi,
      address: cells[2],
      city: cells[3],
      state: cells[4],
      zip: cells[5],
      phone: cells[6],
      providerType: cells[7],
      specialty: cells[8],
    });
  }
  return providers;
}

/* Collect HTML from the main page AND every child frame, since the Telerik
   viewer often renders the report inside an <iframe>. Return the HTML blob
   that yields the most NPI rows. */
async function getBestFrameHtml(page) {
  const htmls = [];
  htmls.push(await page.content());
  for (const frame of page.frames()) {
    try {
      htmls.push(await frame.content());
    } catch (_) { /* detached frame — ignore */ }
  }
  let best = [];
  let bestHtml = "";
  for (const html of htmls) {
    const parsed = parseNoprsTable(html);
    if (parsed.length > best.length) {
      best = parsed;
      bestHtml = html;
    }
  }
  return { providers: best, html: bestHtml };
}

async function run() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await context.newPage();

  console.log("Navigating to NOPRS report...");
  await page.goto(NOPRS_URL, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });

  // Poll until the report grid has rendered enough rows (or we time out).
  console.log("Waiting for report rows to render...");
  const start = Date.now();
  let result = { providers: [], html: "" };
  while (Date.now() - start < RENDER_TIMEOUT_MS) {
    result = await getBestFrameHtml(page);
    if (result.providers.length >= MIN_ROWS) break;
    await page.waitForTimeout(2000);
  }

  const providers = result.providers;
  console.log(`Parsed ${providers.length} NOPRS providers.`);

  if (providers.length < MIN_ROWS) {
    // Save the rendered HTML as an artifact for debugging, then fail loudly.
    fs.writeFileSync(path.join(process.cwd(), "noprs-debug.html"), result.html || "");
    await browser.close();
    throw new Error(
      `Only ${providers.length} rows found (min ${MIN_ROWS}). ` +
      `Not overwriting noprs.json. See noprs-debug.html artifact.`
    );
  }

  // De-dupe by NPI (some providers list multiple locations).
  const seen = new Set();
  const deduped = [];
  for (const p of providers) {
    if (seen.has(p.npi)) continue;
    seen.add(p.npi);
    deduped.push(p);
  }

  const output = {
    source: "MaineCare NOPRS Report",
    sourceUrl: NOPRS_URL,
    generatedAt: new Date().toISOString(),
    count: deduped.length,
    providers: deduped,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  console.log(`Wrote ${OUT_FILE} with ${deduped.length} unique providers.`);

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
