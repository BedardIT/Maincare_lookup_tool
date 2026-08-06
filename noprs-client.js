/* =====================================================================
 * NOPRS client-side module  (drop into your GitHub Pages app)
 * =====================================================================
 * Adds NOPRS fallback to your existing MaineCare provider lookup.
 *
 * Flow:
 *   1. User searches by NPI or name.
 *   2. You query the FHIR directory as you already do.
 *   3. If FHIR returns nothing, call checkNoprs() to fall back.
 *   4. Render a badge showing WHY the provider is (or isn't) valid.
 *
 * The full NOPRS list is fetched ONCE, cached in localStorage for 24h,
 * then searched locally — instant, no repeated network calls.
 * ===================================================================== */

// 🔧 Set this to your Cloudflare Worker base URL (same one your FHIR calls use).
const WORKER_BASE = "https://your-worker.your-subdomain.workers.dev";

const NOPRS_CACHE_KEY = "noprs_cache_v1";
const NOPRS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/* ---------------------------------------------------------------------
 * 1. Load the full NOPRS list (cached in localStorage for 24h)
 * ------------------------------------------------------------------- */
async function loadNoprsList() {
  // Try cache first
  try {
    const raw = localStorage.getItem(NOPRS_CACHE_KEY);
    if (raw) {
      const { ts, providers } = JSON.parse(raw);
      if (Date.now() - ts < NOPRS_CACHE_TTL_MS && Array.isArray(providers)) {
        return providers;
      }
    }
  } catch (_) { /* ignore corrupt cache */ }

  // Fetch fresh from the Worker (Worker returns pre-parsed JSON)
  const res = await fetch(`${WORKER_BASE}/noprs`);
  if (!res.ok) throw new Error(`NOPRS fetch failed: ${res.status}`);
  const data = await res.json();
  const providers = data.providers || [];

  try {
    localStorage.setItem(
      NOPRS_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), providers })
    );
  } catch (_) { /* storage full / private mode — fine, we just won't cache */ }

  return providers;
}

/* ---------------------------------------------------------------------
 * 2. Search the cached NOPRS list by NPI (exact) or name (contains)
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
  const fhirMatches = await queryFhir({ npi, name }); // returns array

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

// If NO matches at all, render the "not enrolled" state:
function renderNoMatch(query) {
  return renderProviderBadge({ name: query, source: "NONE" });
}

/* ---------------------------------------------------------------------
 * Small helper
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
