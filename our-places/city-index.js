(() => {
  // Ricerca geografica generale: nessuna whitelist e nessun elenco di eccezioni.
  // Photon (OpenStreetMap) copre feature geografiche generiche; Open-Meteo/GeoNames
  // rafforza città, paesi, frazioni e località abitate con nomi localizzati.
  const photonNative = photonSearch;

  function norm(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('it')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function typeLabel(code) {
    const map = {
      PPLC: 'capitale', PPLA: 'capoluogo', PPLA2: 'città', PPLA3: 'località', PPLA4: 'località',
      PPL: 'città/località', PPLX: 'quartiere/località', PPLL: 'località', PPLS: 'località',
      ADM1: 'regione', ADM2: 'provincia/area', ADM3: 'comune/area', ADM4: 'area amministrativa',
      ISL: 'isola', ISLS: 'isole', MT: 'monte', MTS: 'monti', LK: 'lago', BAY: 'baia', CAPE: 'capo',
      PRT: 'porto', AIRP: 'aeroporto', PARK: 'parco', RESN: 'riserva naturale'
    };
    return map[code] || '';
  }

  async function openMeteoSearch(query, limit = 8, signal) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query);
    url.searchParams.set('count', String(Math.max(limit, 10)));
    url.searchParams.set('language', 'it');
    url.searchParams.set('format', 'json');
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    return (data?.results || []).map(r => {
      const lat = Number(r.latitude), lon = Number(r.longitude);
      if (!r.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const parts = [typeLabel(r.feature_code), r.admin4, r.admin3, r.admin2, r.admin1, r.country]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      return {
        name: String(r.name),
        detail: parts.join(' · '),
        coords: [Number(lat.toFixed(6)), Number(lon.toFixed(6))],
        source: 'GeoNames'
      };
    }).filter(Boolean);
  }

  function relevance(item, query) {
    const n = norm(item?.name), q = norm(query);
    if (!n || !q) return 999;
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(' ').some(p => p.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return 5;
  }

  function dedupeAndRank(items, query, limit) {
    const seen = new Set();
    return items
      .filter(x => x?.name && Array.isArray(x.coords))
      .sort((a,b) => relevance(a, query) - relevance(b, query))
      .filter(item => {
        const key = `${norm(item.name)}|${Number(item.coords[0]).toFixed(3)}|${Number(item.coords[1]).toFixed(3)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  photonSearch = async function(query, limit = 6, signal) {
    const q = String(query || '').trim().replace(/\s+/g, ' ');
    if (!q) return [];

    // I due provider vengono interrogati in parallelo. Se uno viene bloccato/throttled,
    // l'altro continua a dare risultati senza far sparire l'autocomplete.
    const [osmResult, geoResult] = await Promise.allSettled([
      photonNative(q, Math.max(limit * 2, 12), signal),
      openMeteoSearch(q, Math.max(limit * 2, 12), signal)
    ]);

    if (signal?.aborted) throw new DOMException('Aborted','AbortError');

    const osm = osmResult.status === 'fulfilled' ? osmResult.value : [];
    const geo = geoResult.status === 'fulfilled' ? geoResult.value : [];
    if (osmResult.status === 'rejected' && osmResult.reason?.name !== 'AbortError') console.warn('Photon non disponibile', osmResult.reason);
    if (geoResult.status === 'rejected' && geoResult.reason?.name !== 'AbortError') console.warn('Open-Meteo geocoder non disponibile', geoResult.reason);

    return dedupeAndRank([...osm, ...geo], q, limit);
  };
})();
