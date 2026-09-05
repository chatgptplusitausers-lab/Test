(() => {
  const CITY_DATA_URL = 'https://cdn.jsdelivr.net/gh/joelacus/world-cities@main/world_cities_15000.csv';
  let cityIndexPromise = null;
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['it'], { type: 'region' }); } catch {}

  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  async function loadCityIndex() {
    if (cityIndexPromise) return cityIndexPromise;
    cityIndexPromise = (async () => {
      const res = await fetch(CITY_DATA_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`City dataset ${res.status}`);
      const text = await res.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = parseCsvLine(lines.shift()).map(x => x.trim().toLowerCase());
      const ci = header.indexOf('country');
      const ni = header.indexOf('name');
      const lati = header.indexOf('lat');
      const lngi = header.indexOf('lng');
      if ([ci, ni, lati, lngi].some(i => i < 0)) throw new Error('City dataset format');

      return lines.map(line => {
        const row = parseCsvLine(line);
        const lat = Number(row[lati]);
        const lon = Number(row[lngi]);
        const name = row[ni] || '';
        return {
          country: row[ci] || '',
          name,
          lat,
          lon,
          q: name.toLocaleLowerCase('it')
        };
      }).filter(c => c.name && Number.isFinite(c.lat) && Number.isFinite(c.lon));
    })();
    return cityIndexPromise;
  }

  async function staticCitySearch(query, limit = 5) {
    const data = await loadCityIndex();
    const q = query.trim().toLocaleLowerCase('it');
    if (!q) return [];
    const starts = [];
    const words = [];
    const contains = [];

    for (const c of data) {
      if (c.q.startsWith(q)) starts.push(c);
      else if (c.q.split(/[\s'-]+/).some(part => part.startsWith(q))) words.push(c);
      else if (q.length >= 4 && c.q.includes(q)) contains.push(c);
      if (starts.length >= limit * 4 && words.length >= limit * 2) break;
    }

    const unique = [];
    const seen = new Set();
    for (const c of [...starts, ...words, ...contains]) {
      const key = `${c.name}|${c.country}|${c.lat}|${c.lon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let country = c.country;
      try { country = regionNames?.of(c.country) || c.country; } catch {}
      unique.push({
        name: c.name,
        detail: country,
        coords: [Number(c.lat.toFixed(6)), Number(c.lon.toFixed(6))]
      });
      if (unique.length >= limit) break;
    }
    return unique;
  }

  // app.js usa photonSearch per autocomplete e geocodifica primaria.
  // La sostituiamo con l'indice statico: nessuna chiamata remota per ogni tasto.
  photonSearch = async function(query, limit = 5) {
    return staticCitySearch(query, limit);
  };

  document.getElementById('placeInput')?.addEventListener('focus', () => {
    loadCityIndex().catch(err => console.warn('Indice città non disponibile', err));
  }, { once: true });
})();
