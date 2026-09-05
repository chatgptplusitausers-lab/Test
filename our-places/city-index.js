(() => {
  // Ricerca geografica generale, senza whitelist.
  // Photon interroga OpenStreetMap (quartieri, isole, aree, POI, località, ecc.).
  // Open-Meteo interroga GeoNames allCountries + alternate names, quindi include anche
  // città, paesi, frazioni, località molto piccole e aree amministrative.
  const photonNative = photonSearch;
  const PROVIDER_TIMEOUT_MS = 4200;

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
      PPLC:'capitale', PPLA:'capoluogo', PPLA2:'città', PPLA3:'località', PPLA4:'località',
      PPL:'città/località', PPLX:'quartiere/località', PPLL:'località', PPLS:'località',
      ADM1:'regione', ADM2:'provincia/area', ADM3:'comune/area', ADM4:'area amministrativa',
      ISL:'isola', ISLS:'isole', MT:'monte', MTS:'monti', LK:'lago', BAY:'baia', CAPE:'capo',
      PRT:'porto', AIRP:'aeroporto', PARK:'parco', RESN:'riserva naturale',
      CSTL:'castello', CH:'chiesa', MUS:'museo', MKT:'mercato', SPA:'località termale',
      BEACH:'spiaggia', HLL:'collina', VAL:'valle', FRST:'foresta'
    };
    return map[code] || 'luogo';
  }

  function withTimeout(promise, ms = PROVIDER_TIMEOUT_MS) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve([]), ms))
    ]);
  }

  async function openMeteoSearch(query, limit = 12, signal) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query);
    url.searchParams.set('count', String(Math.max(limit, 12)));
    url.searchParams.set('language', 'it');
    url.searchParams.set('format', 'json');
    const res = await fetch(url, { headers: { Accept:'application/json' }, signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    return (data?.results || []).map(r => {
      const lat = Number(r.latitude), lon = Number(r.longitude);
      if (!r.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const detail = [typeLabel(r.feature_code), r.admin4, r.admin3, r.admin2, r.admin1, r.country]
        .filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · ');
      return {
        name:String(r.name),
        detail,
        coords:[Number(lat.toFixed(6)), Number(lon.toFixed(6))],
        source:'GeoNames'
      };
    }).filter(Boolean);
  }

  function relevance(item, query) {
    const n=norm(item?.name), q=norm(query);
    if(!n||!q) return 99;
    if(n===q) return 0;
    if(n.startsWith(q)) return 1;
    if(n.split(' ').some(p=>p.startsWith(q))) return 2;
    if(n.includes(q)) return 3;
    // I risultati fuzzy di Photon/GeoNames restano validi, ma sotto i match testuali.
    return 4;
  }

  function dedupeAndRank(items, query, limit) {
    const seen=new Set();
    return items
      .filter(x=>x?.name&&Array.isArray(x.coords)&&x.coords.length===2)
      .sort((a,b)=>relevance(a,query)-relevance(b,query))
      .filter(item=>{
        const key=`${norm(item.name)}|${Number(item.coords[0]).toFixed(3)}|${Number(item.coords[1]).toFixed(3)}`;
        if(seen.has(key)) return false;
        seen.add(key); return true;
      })
      .slice(0,limit);
  }

  photonSearch = async function(query, limit = 6, signal) {
    const q=String(query||'').trim().replace(/\s+/g,' ');
    if(!q) return [];

    const osmPromise = withTimeout(
      photonNative(q, Math.max(limit*3,18), signal).catch(err=>{
        if(err?.name==='AbortError') throw err;
        console.warn('Photon/OpenStreetMap non disponibile',err); return [];
      })
    );
    const geoPromise = withTimeout(
      openMeteoSearch(q, Math.max(limit*3,18), signal).catch(err=>{
        if(err?.name==='AbortError') throw err;
        console.warn('Open-Meteo/GeoNames non disponibile',err); return [];
      })
    );

    const [osm,geo] = await Promise.all([osmPromise,geoPromise]);
    if(signal?.aborted) throw new DOMException('Aborted','AbortError');

    return dedupeAndRank([...(osm||[]),...(geo||[])],q,limit);
  };
})();
