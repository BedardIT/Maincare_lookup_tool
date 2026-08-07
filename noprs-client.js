/* =====================================================================
 * NOPRS client-side module  (static-JSON version)
 * =====================================================================
 * Reads the noprs.json that the GitHub Action commits to your repo, then
 * adds NOPRS fallback to your existing MaineCare provider lookup.
 *
 * No Cloudflare Worker / proxy is needed for NOPRS — it's a same-origin
 * static file on GitHub Pages, so there's no CORS to deal with.
 * 
 * Flow:
 *   1. User searches by NPI or name.
 *   2. Your existing FHIR lookup runs first.
 *   3. If FHIR returns nothing, checkNoprs() falls back to noprs.json.
 *   4. renderProviderBadge() shows WHY the provider is (or isn't) valid. 
 * ===================================================================== */

// Path to the committed file, relative to your app on GitHub Pages.
// If your app is at the repo root next to noprs.json, "./noprs.json" is correct.
const NOPRS_JSON_URL = "./noprs.json";

// In-memory cache for the session so we only fetch the file once.
let _noprsCache = null;
let _noprsMeta = null;

/* ---------------------------------------------------------------------
 * 1. Load noprs.json once per page session
 * ------------------------------------------------------------------- */
async function loadNoprsList() {
  if (_noprsCache) return _noprsCache;

  const res = await fetch(NOPRS_JSON_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load noprs.json: ${res.status}`);

  const data = await res.json();
  _noprsCache = Array.isArray(data.providers) ? data.providers : [];
  _noprsMeta = { generatedAt: data.generatedAt, count: data.count };
  return _noprsCache;
}

/* When was the list last refreshed? (for a "Data as of…" label) */
async function getNoprsMeta() {
  if (!_noprsMeta) await loadNoprsList();
  return _noprsMeta;
}

/* ---------------------------------------------------------------------
 * 2. Search the NOPRS list by NPI (exact) or name (contains)
 * ------------------------------------------------------------------- */
async function checkNoprs({ npi, name } = {}) {
  const list = await loadNoprsList();

  if (npi) {
    const clean = String(npi).replace(/\D/g, "");
    return list.filter((p) => p.npi === clean);
  }
  if (name) {
    const q = name.trim().toLowerCase();
    return list.filter((p) => p.name.toLowerCase().includes(q));
  }
  return [];
}

/* ---------------------------------------------------------------------
 * 3. Combined lookup with fallback + source tagging
 *    Wire searchProvider() to your search button.
 * ------------------------------------------------------------------- */
async function searchProvider({ npi, name }) {
  // --- Step A: your existing FHIR lookup ---
  // Replace queryFhir() with whatever your current FHIR search function is.
  const fhirMatches = await queryFhir({ npi, name }); // returns an array

  if (fhirMatches && fhirMatches.length) {
    return fhirMatches.map((p) => ({ ...p, source: "FHIR" }));
  }

  // --- Step B: fall back to NOPRS ---
  const noprsMatches = await checkNoprs({ npi, name });
  if (noprsMatches.length) {
    return noprsMatches.map((p) => ({ ...p, source: "NOPRS" }));
  }

  // --- Step C: nothing anywhere ---
  return [];
}

/* ---------------------------------------------------------------------
 * 4. Render a result badge that explains billing validity
 * ------------------------------------------------------------------- */
function renderProviderBadge(provider) {
  const map = {
    FHIR: {
      label: "Fully Enrolled",
      sub: "Pay-to MaineCare provider",
      cls: "badge-full",
      valid: true,
    },
    NOPRS: {
      label: "NOPR — Order/Prescribe/Refer only",
      sub: "Valid for referrals & prescriptions",
      cls: "badge-nopr",
      valid: true,
    },
  };
  const b = map[provider.source] || {
    label: "Not Enrolled",
    sub: "Cannot bill MaineCare for this referral",
    cls: "badge-none",
    valid: false,
  };

  return `
    <div class="provider-card ${b.cls}">
      <div class="provider-name">${escapeHtml(provider.name || "")}</div>
      <div class="provider-npi">NPI: ${escapeHtml(provider.npi || "")}</div>
      <div class="provider-meta">
        ${escapeHtml(provider.providerType || provider.type || "")}
        ${provider.specialty ? " · " + escapeHtml(provider.specialty) : ""}
      </div>
      <div class="provider-meta">
        ${escapeHtml(provider.address || "")} ${escapeHtml(provider.city || "")}
        ${escapeHtml(provider.state || "")} ${escapeHtml(provider.zip || "")}
      </div>
      <span class="status-badge ${b.cls}">${b.valid ? "✅" : "❌"} ${b.label}</span>
      <div class="status-sub">${b.sub}</div>
    </div>`;
}

/* If NO matches at all, render the "not enrolled" state. */
function renderNoMatch(query) {
  return renderProviderBadge({ name: query, source: "NONE" });
}

/* Optional: a small "NOPRS data as of <date>" line for your UI. */
async function renderNoprsFreshness(targetEl) {
  try {
    const meta = await getNoprsMeta();
    if (meta && meta.generatedAt) {
      const d = new Date(meta.generatedAt);
      targetEl.textContent =
        `NOPRS data as of ${d.toLocaleDateString()} (${meta.count} providers)`;
    }
  } catch (_) { /* file not present yet — ignore */ }
}

/* ---------------------------------------------------------------------
 * Helper
 * ------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------------------------------------------------------------
 * Example wiring (adapt to your DOM)
 * ------------------------------------------------------------------- */
// document.getElementById("searchBtn").addEventListener("click", async () => {
//   const val = document.getElementById("searchInput").value.trim();
//   const isNpi = /^\d{10}$/.test(val.replace(/\D/g, ""));
//   const results = await searchProvider(isNpi ? { npi: val } : { name: val });
//   const out = document.getElementById("results");
//   out.innerHTML = results.length
//     ? results.map(renderProviderBadge).join("")
//     : renderNoMatch(val);
// });
//
// // Show freshness on load:
// renderNoprsFreshness(document.getElementById("noprsFreshness"));
