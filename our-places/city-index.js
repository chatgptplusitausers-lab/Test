(() => {
  // Motore ibrido: Photon/OpenStreetMap per la ricerca geografica vera,
  // dataset GeoNames-like delle città solo come fallback offline/statico.
  const livePhotonSearch = photonSearch;
  const CITY_DATA_URL = 'https://cdn.jsdelivr.net/gh/joelacus/world-cities@main/world_cities_15000.csv';
  let cityIndexPromise = null;
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['it'], { type: 'region' }); } catch {}

  // Località/aree turistiche che non sono necessariamente "città" amministrative.
  // Servono anche da fallback se il servizio live non risponde.
  const LANDMARKS = [
    {
      name: 'Naxos',
      detail: 'Cicladi · Grecia',
      coords: [37.0726, 25.4862],
      aliases: ['naxos', 'nasso', 'isola di naxos', 'isola di nasso']
    },
    {
      name: 'Grotte di Castellana',
      detail: 'Castellana Grotte · Puglia · Italia',
      coords: [40.875786, 17.145964],
      aliases: ['grotte di castellana', 'grotte ci castellana', 'grotte castellana', 'castellana grotte', 'grotte di castelana']
    },
    {
      name: 'Santa Maria di Leuca',
      detail: 'Castrignano del Capo · Puglia · Italia',
      coords: [39.801111, 18.356944],
      aliases: ['santa maria di leuca', 's maria di leuca', 'santa maria leuca', 'leuca']
    },
    {
      name: 'Cinque Terre',
      detail: 'Liguria · Italia',
      coords: [44.126939, 9.709439],
      aliases: ['cinque terre', '5 terre', 'le cinque terre']
    }
  ];

  function norm(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('it')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function distance(a, b) {
    a = norm(a); b = norm(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const prev = Array.from({length:n+1}, (_,i)=>i);
    const cur = new Array(n+1);
    for (let i=1;i<=m;i++) {
      cur[0]=i;
      for (let j=1;j<=n;j++) cur[j]=Math.min(cur[j-1]+1, prev[j]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
      for (let j=0;j<=n;j++) prev[j]=cur[j];
    }
    return prev[n];
  }

  function landmarkScore(query, landmark) {
    const q = norm(query);
    let best = Infinity;
    for (const alias of landmark.aliases) {
      const a = norm(alias);
      if (a === q) return 0;
      if (a.startsWith(q) || q.startsWith(a)) best = Math.min(best, 0.25);
      else if (a.includes(q) || q.includes(a)) best = Math.min(best, 0.5);
      else {
        const d = distance(q, a);
        const ratio = d / Math.max(q.length, a.length, 1);
        if (ratio <= 0.28) best = Math.min(best, 1 + ratio);
      }
    }
    return best;
  }

  function landmarkSearch(query, limit = 5) {
    return LANDMARKS
      .map(p => ({p, score: landmarkScore(query, p)}))
      .filter(x => Number.isFinite(x.score))
      .sort((a,b)=>a.score-b.score)
      .slice(0, limit)
      .map(x => ({name:x.p.name, detail:x.p.detail, coords:x.p.coords}));
  }

  function parseCsvLine(line) {
    const out = []; let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  }

  async function loadCityIndex() {
    if (cityIndexPromise) return cityIndexPromise;
    cityIndexPromise = (async () => {
      const res = await fetch(CITY_DATA_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`City dataset ${res.status}`);
      const text = await res.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = parseCsvLine(lines.shift()).map(x => x.trim().toLowerCase());
      const ci = header.indexOf('country'), ni = header.indexOf('name'), lati = header.indexOf('lat'), lngi = header.indexOf('lng');
      if ([ci, ni, lati, lngi].some(i => i < 0)) throw new Error('City dataset format');
      return lines.map(line => {
        const row = parseCsvLine(line), lat = Number(row[lati]), lon = Number(row[lngi]), name = row[ni] || '';
        return {country:row[ci]||'', name, lat, lon, q:norm(name)};
      }).filter(c => c.name && Number.isFinite(c.lat) && Number.isFinite(c.lon));
    })();
    return cityIndexPromise;
  }

  async function staticCitySearch(query, limit = 5) {
    const data = await loadCityIndex();
    const q = norm(query); if (!q) return [];
    const scored=[];
    for (const c of data) {
      let score=99;
      if(c.q===q) score=0;
      else if(c.q.startsWith(q)) score=1;
      else if(c.q.split(' ').some(part=>part.startsWith(q))) score=2;
      else if(q.length>=4&&c.q.includes(q)) score=3;
      if(score<99) scored.push({c,score});
    }
    scored.sort((a,b)=>a.score-b.score||a.c.name.localeCompare(b.c.name));
    const out=[], seen=new Set();
    for(const {c} of scored){
      const key=`${c.name}|${c.country}|${c.lat}|${c.lon}`; if(seen.has(key))continue; seen.add(key);
      let country=c.country; try{country=regionNames?.of(c.country)||c.country}catch{}
      out.push({name:c.name,detail:country,coords:[Number(c.lat.toFixed(6)),Number(c.lon.toFixed(6))]});
      if(out.length>=limit)break;
    }
    return out;
  }

  function dedupe(items, limit) {
    const out=[], seen=new Set();
    for (const item of items) {
      if (!item?.name || !Array.isArray(item.coords)) continue;
      const key = `${norm(item.name)}|${item.coords[0].toFixed(3)}|${item.coords[1].toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  function correctedQuery(query) {
    const q = norm(query);
    if (q === 'grotte ci castellana' || q === 'grotte castellana') return 'Grotte di Castellana';
    if (q === '5 terre') return 'Cinque Terre';
    return query;
  }

  photonSearch = async function(query, limit = 5, signal) {
    const q = String(query || '').trim();
    if (!q) return [];

    const curated = landmarkSearch(q, limit);
    let live = [];
    try {
      live = await livePhotonSearch(correctedQuery(q), Math.max(limit + 3, 8), signal);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      console.warn('Photon live non disponibile, uso fallback geografico', err);
    }

    let cities = [];
    if (curated.length + live.length < limit) {
      try { cities = await staticCitySearch(q, limit); }
      catch (err) { console.warn('Fallback città non disponibile', err); }
    }

    // Un match canonico esatto/forte resta in testa; poi risultati OSM live; infine città statiche.
    return dedupe([...curated, ...live, ...cities], limit);
  };

  document.getElementById('placeInput')?.addEventListener('focus', () => {
    loadCityIndex().catch(err => console.warn('Indice città di fallback non disponibile', err));
  }, { once: true });
})();
