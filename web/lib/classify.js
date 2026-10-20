/* Industry classification for the dashboard.
   Source of truth: the NSE industry classification stored in the sheet's
   Main tab (Sector -> Industry -> Basic Industry, filled by Code.gs
   fillSectorIndustryFromBasicIndustry_ / auditIndustryClassification).
   This module only groups those NSE values into the dashboard's
   categories; it never guesses from a company name or ticker. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).classify = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // Dashboard categories, in display order.
  var CATEGORIES = [
    { id: 'it', name: 'Information Technology' },
    { id: 'chemicals', name: 'Chemicals & Specialty Chemicals' },
    { id: 'pharma', name: 'Pharmaceuticals & Healthcare' },
    { id: 'banking', name: 'Banking' },
    { id: 'financials', name: 'Financial Services & NBFCs' },
    { id: 'insurance', name: 'Insurance' },
    { id: 'auto', name: 'Automobiles & Auto Components' },
    { id: 'capital-goods', name: 'Capital Goods & Engineering' },
    { id: 'infra', name: 'Infrastructure & Construction' },
    { id: 'cement', name: 'Cement & Construction Materials' },
    { id: 'metals', name: 'Metals & Mining' },
    { id: 'energy', name: 'Oil, Gas & Energy' },
    { id: 'power', name: 'Power & Utilities' },
    { id: 'fmcg', name: 'FMCG' },
    { id: 'durables', name: 'Consumer Durables' },
    { id: 'consumer-services', name: 'Consumer Services' },
    { id: 'telecom', name: 'Telecom' },
    { id: 'media', name: 'Media & Entertainment' },
    { id: 'textiles', name: 'Textiles & Apparel' },
    { id: 'realty', name: 'Realty & Real Estate' },
    { id: 'logistics', name: 'Logistics & Transportation' },
    { id: 'agri', name: 'Agriculture & Fertilizers' },
    { id: 'paper-packaging', name: 'Paper & Packaging' },
    { id: 'diversified', name: 'Diversified & Other' }
  ];

  // NSE sector (normalised) -> default category
  var SECTOR_MAP = {
    'information technology': 'it',
    'chemicals': 'chemicals',
    'healthcare': 'pharma',
    'financial services': 'financials',
    'automobile and auto components': 'auto',
    'capital goods': 'capital-goods',
    'construction': 'infra',
    'construction materials': 'cement',
    'metals & mining': 'metals',
    'oil gas & consumable fuels': 'energy',
    'power': 'power',
    'utilities': 'power',
    'fast moving consumer goods': 'fmcg',
    'consumer durables': 'durables',
    'consumer services': 'consumer-services',
    'telecommunication': 'telecom',
    'media entertainment & publication': 'media',
    'textiles': 'textiles',
    'realty': 'realty',
    'forest materials': 'paper-packaging',
    'services': 'diversified',
    'diversified': 'diversified'
  };

  // NSE basic industry (normalised) -> category, where it is more specific
  // than the sector (e.g. banks inside Financial Services).
  var BASIC_MAP = {
    'private sector bank': 'banking',
    'public sector bank': 'banking',
    'other bank': 'banking',
    'small finance bank': 'banking',
    'life insurance': 'insurance',
    'general insurance': 'insurance',
    'insurance distributors': 'insurance',
    'fertilizers': 'agri',
    'pesticides & agrochemicals': 'agri',
    'other agricultural products': 'agri',
    'packaging': 'paper-packaging',
    'paper & paper products': 'paper-packaging',
    'logistics solution provider': 'logistics',
    'shipping': 'logistics',
    'port & port services': 'logistics',
    'transport related services': 'logistics',
    'road transport': 'logistics',
    'airport & airport services': 'logistics',
    'airline': 'logistics',
    'dredging': 'logistics',
    'road assets-toll annuity hybrid-annuity': 'infra',
    'road assets - toll annuity hybrid-annuity': 'infra',
    'residential/commercial/sez project': 'realty'
  };

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  }

  // Tidy the NSE text for display: one spelling per name
  // ("Media, Entertainment & Publication" == "Media Entertainment & Publication",
  //  "HOSPITAL" -> "Hospital").
  function tidy(s) {
    if (s == null) return null;
    var t = String(s).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) {
      t = t.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    }
    return t;
  }
  var CANON_SECTOR = {};   // normalised -> preferred display spelling

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  /** Classify one stock from its NSE metadata.
   *  -> { category, categoryName, sector, industry, basicIndustry, method, issues[] } */
  function classify(stock) {
    var sector = tidy(stock && stock.sector);
    var basic = tidy(stock && (stock.basicIndustry || stock.ind));
    var industry = tidy(stock && stock.industry);
    var issues = [];
    var cat = null, method = null;
    var b = norm(basic), s = norm(sector);
    if (b && BASIC_MAP[b]) { cat = BASIC_MAP[b]; method = 'basic-industry'; }
    else if (s && SECTOR_MAP[s]) { cat = SECTOR_MAP[s]; method = 'sector'; }
    if (!sector) issues.push('missing sector');
    if (!basic) issues.push('missing basic industry');
    if (s && !SECTOR_MAP[s]) issues.push('unknown sector "' + sector + '"');
    if (stock && stock.basicIndustry && String(stock.basicIndustry).trim() !== basic) issues.push('basic industry spelling normalised');
    if (stock && stock.ind && !stock.basicIndustry && String(stock.ind).trim() !== basic) issues.push('basic industry spelling normalised');
    if (!cat) { cat = null; method = 'unclassified'; }
    if (s) CANON_SECTOR[s] = CANON_SECTOR[s] || sector;
    var c = cat ? categoryById(cat) : null;
    return {
      category: cat,
      categoryName: c ? c.name : 'Unclassified',
      sector: s ? CANON_SECTOR[s] : null,
      industry: industry,
      basicIndustry: basic,
      method: method,
      issues: issues
    };
  }

  /** Review list: stocks whose classification is missing or conflicts with
   *  the rest of the universe (same basic industry under different sectors). */
  function reviewList(stocks) {
    var bySym = [];
    var basicSectors = {};
    stocks.forEach(function (st) {
      var k = norm(st.basicIndustry || st.ind);
      if (!k) return;
      var s = norm(st.sector);
      (basicSectors[k] = basicSectors[k] || {})[s] = ((basicSectors[k] || {})[s] || 0) + 1;
    });
    stocks.forEach(function (st) {
      var c = classify(st);
      var issues = c.issues.slice();
      var k = norm(st.basicIndustry || st.ind);
      var m = k && basicSectors[k];
      if (m) {
        var keys = Object.keys(m);
        if (keys.length > 1) {
          var top = keys.sort(function (a, b) { return m[b] - m[a]; })[0];
          if (norm(st.sector) !== top) issues.push('basic industry usually under "' + top + '"');
        }
      }
      var real = issues.filter(function (x) { return x !== 'basic industry spelling normalised'; });
      if (real.length || !c.category) bySym.push({ symbol: st.sym || st.symbol, name: st.name, sector: st.sector || null, basicIndustry: st.basicIndustry || st.ind || null, category: c.categoryName, issues: issues });
    });
    return bySym;
  }

  return { CATEGORIES: CATEGORIES, classify: classify, reviewList: reviewList, categoryById: categoryById, normalise: norm, tidy: tidy };
});
