(() => {
  const VECTOR_MAP_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
  let countryLayer = null;
  let countryDataPromise = null;

  function loadCountryData() {
    if (countryDataPromise) return countryDataPromise;
    countryDataPromise = fetch(VECTOR_MAP_URL, { cache: 'force-cache' })
      .then(res => {
        if (!res.ok) throw new Error(`Natural Earth ${res.status}`);
        return res.json();
      })
      .catch(err => {
        console.warn('Confini geografici non disponibili', err);
        return null;
      });
    return countryDataPromise;
  }

  function destroyVectorMap() {
    try { mapResizeObserver?.disconnect(); } catch {}
    mapResizeObserver = null;
    countryLayer = null;
    if (map) {
      try { map.off(); map.remove(); } catch (err) { console.warn('Chiusura mappa', err); }
    }
    map = null;
    mapLayer = null;
  }

  function fitCurrentMarkers() {
    if (!map || activeView !== 'map') return;
    const located = filteredPlaces().filter(p =>
      Array.isArray(p.g) && p.g.length === 2 &&
      Number.isFinite(Number(p.g[0])) && Number.isFinite(Number(p.g[1]))
    );
    const bounds = located.map(p => [Number(p.g[0]), Number(p.g[1])]);
    try {
      map.invalidateSize({ pan:false, animate:false });
      if (bounds.length === 1) map.setView(bounds[0], 8, { animate:false });
      else if (bounds.length > 1) map.fitBounds(bounds, { padding:[32,32], maxZoom:8, animate:false });
      else map.setView([42.5, 12.5], 4, { animate:false });
    } catch {}
  }

  hardResizeMap = function() {
    if (!map || activeView !== 'map') return;
    const node = document.getElementById('map');
    if (!node || node.clientWidth < 40 || node.clientHeight < 40) return;
    requestAnimationFrame(() => {
      try { map.invalidateSize({ pan:false, animate:false }); } catch {}
    });
  };

  ensureMap = function() {
    if (map || !window.L || !el.mapPanel || el.mapPanel.hidden) return;
    const node = document.getElementById('map');
    if (!node || node.clientWidth < 40 || node.clientHeight < 40) return;

    map = L.map(node, {
      zoomControl:true,
      attributionControl:true,
      zoomAnimation:false,
      fadeAnimation:false,
      markerZoomAnimation:false,
      minZoom:2,
      maxZoom:10,
      worldCopyJump:true
    }).setView([42.5, 12.5], 4);

    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('Natural Earth');
    mapLayer = L.layerGroup().addTo(map);

    if ('ResizeObserver' in window) {
      mapResizeObserver = new ResizeObserver(() => hardResizeMap());
      mapResizeObserver.observe(node);
    }

    loadCountryData().then(data => {
      if (!data || !map || activeView !== 'map') return;
      countryLayer = L.geoJSON(data, {
        interactive:false,
        style: {
          color:'#d6c4b8',
          weight:1,
          opacity:1,
          fillColor:'#fffaf5',
          fillOpacity:1
        }
      }).addTo(map);
      if (mapLayer) mapLayer.bringToFront?.();
      hardResizeMap();
      fitCurrentMarkers();
    });
  };

  renderMap = function() {
    if (activeView !== 'map' || el.mapPanel.hidden) return;
    ensureMap();
    if (!map || !mapLayer) {
      el.mapStatus.textContent = 'Sto preparando la mappa…';
      setTimeout(() => { if (activeView === 'map') renderMap(); }, 120);
      return;
    }

    mapLayer.clearLayers();
    const filtered = filteredPlaces();
    const located = filtered.filter(p =>
      Array.isArray(p.g) && p.g.length === 2 &&
      Number.isFinite(Number(p.g[0])) && Number.isFinite(Number(p.g[1]))
    );
    const missing = filtered.length - located.length;

    located.forEach(p => {
      const coords = [Number(p.g[0]), Number(p.g[1])];
      const icon = L.divIcon({
        className:'map-div-icon',
        html:`<div class="map-pin ${markerClass(p.v)}"><b>${p.v==='B'?'♥':p.v==='A'?'A':'M'}</b>${p.m?'<span>🧲</span>':''}</div>`,
        iconSize:[38,44],
        iconAnchor:[19,40],
        popupAnchor:[0,-36]
      });
      L.marker(coords,{icon})
        .bindPopup(`<strong>${escapeHtml(p.n)}</strong><br>${escapeHtml(visitedLabel(p.v))}<br>${p.m?'🧲 Calamita già presa':'📍 Calamita da prendere'}`)
        .addTo(mapLayer);
    });

    el.mapStatus.textContent = located.length
      ? `${located.length} ${located.length===1?'luogo visibile':'luoghi visibili'} sulla mappa${missing?` · ${missing} da geolocalizzare`:''}`
      : (missing ? 'Sto geolocalizzando i luoghi inseriti…' : 'Nessun luogo da mostrare con questi filtri.');

    requestAnimationFrame(() => {
      hardResizeMap();
      fitCurrentMarkers();
      setTimeout(() => { hardResizeMap(); fitCurrentMarkers(); }, 180);
    });
  };

  setView = function(view) {
    activeView = view;
    el.viewSwitch.querySelectorAll('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    el.listView.hidden = view !== 'list';
    el.mapPanel.hidden = view !== 'map';

    if (view === 'list') {
      destroyVectorMap();
      return;
    }

    destroyVectorMap();
    el.mapStatus.textContent = 'Sto preparando la mappa vettoriale…';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (activeView !== 'map') return;
      ensureMap();
      renderMap();
      queueMissingGeocodes();
    }));
  };

  window.addEventListener('orientationchange', () => {
    if (activeView === 'map') setTimeout(() => { hardResizeMap(); fitCurrentMarkers(); }, 220);
  }, { passive:true });
})();
