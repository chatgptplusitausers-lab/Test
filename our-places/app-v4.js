(() => {
  const baseGeoSearch = photonSearch;
  let editingId = null;

  const ITALIAN_REGIONS = [
    ['Abruzzo',42.1920,13.7289,['abruzzo']],
    ['Basilicata',40.6395,15.8056,['basilicata','lucania']],
    ['Calabria',38.9059,16.5944,['calabria']],
    ['Campania',40.8396,14.2508,['campania']],
    ['Emilia-Romagna',44.5968,11.2186,['emilia romagna','emilia-romagna']],
    ['Friuli-Venezia Giulia',46.2259,13.1034,['friuli venezia giulia','friuli-venezia giulia','friuli']],
    ['Lazio',41.6552,12.9896,['lazio']],
    ['Liguria',44.3168,8.3965,['liguria']],
    ['Lombardia',45.4791,9.8452,['lombardia']],
    ['Marche',43.6168,13.5189,['marche','le marche']],
    ['Molise',41.6739,14.7521,['molise']],
    ['Piemonte',45.0703,7.6869,['piemonte']],
    ['Puglia',41.1256,16.8674,['puglia']],
    ['Sardegna',40.1209,9.0129,['sardegna']],
    ['Sicilia',37.5999,14.0154,['sicilia']],
    ['Toscana',43.7711,11.2486,['toscana']],
    ['Trentino-Alto Adige',46.4337,11.1693,['trentino alto adige','trentino-alto adige','sudtirol','südtirol']],
    ['Umbria',43.1122,12.3888,['umbria']],
    ["Valle d'Aosta",45.7370,7.3201,["valle d'aosta",'valle aosta','aosta valley']],
    ['Veneto',45.4349,12.3385,['veneto']]
  ];

  function norm(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLocaleLowerCase('it')
      .replace(/[^a-z0-9]+/g,' ')
      .trim().replace(/\s+/g,' ');
  }

  function regionSuggestions(query, limit = 6) {
    const q = norm(query);
    if (q.length < 2) return [];
    return ITALIAN_REGIONS
      .map(([name,lat,lon,aliases]) => {
        let score = 99;
        for (const alias of aliases) {
          const a = norm(alias);
          if (a === q) score = Math.min(score,0);
          else if (a.startsWith(q)) score = Math.min(score,1);
          else if (q.length >= 4 && a.includes(q)) score = Math.min(score,2);
        }
        return {score,item:{name,detail:'regione · Italia',coords:[lat,lon],source:'Regioni italiane'}};
      })
      .filter(x => x.score < 99)
      .sort((a,b) => a.score-b.score || a.item.name.localeCompare(b.item.name))
      .slice(0,limit)
      .map(x => x.item);
  }

  function dedupe(items, limit) {
    const out=[]; const seen=new Set();
    for (const item of items) {
      if (!item?.name || !Array.isArray(item.coords)) continue;
      const key=`${norm(item.name)}|${Number(item.coords[0]).toFixed(3)}|${Number(item.coords[1]).toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  photonSearch = async function(query, limit = 6, signal) {
    const regions = regionSuggestions(query, limit);
    let live=[];
    try { live = await baseGeoSearch(query, Math.max(limit*2,12), signal); }
    catch (err) { if (err?.name === 'AbortError') throw err; console.warn('Ricerca geografica live non disponibile',err); }
    return dedupe([...regions,...live],limit);
  };

  // Filtri esclusivi: Marco non include Entrambi, idem Ale.
  matchesFilter = function(p) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'M') return p.v === 'M';
    if (activeFilter === 'A') return p.v === 'A';
    if (activeFilter === 'B') return p.v === 'B';
    if (activeFilter === 'missing') return !p.m;
    return true;
  };

  function cardHtml(p) {
    return `<article class="place-card" data-id="${escapeHtml(p.i)}">
      <div class="place-mark">${p.m?'🧲':'📍'}</div>
      <div class="place-copy">
        <h3>${escapeHtml(p.n)}</h3>
        <div class="place-meta">
          <span>${displayDate(p.d)}</span>
          <span class="visit-badge">· ${visitedLabel(p.v)}</span>
          <span class="magnet">· ${p.m?'calamita già presa':'calamita da prendere'}</span>
          ${Array.isArray(p.g)?'<span class="geo-ok">· sulla mappa</span>':'<span class="geo-wait">· posizione in ricerca</span>'}
        </div>
      </div>
      <div class="place-actions">
        <button class="edit-btn" type="button" aria-label="Modifica luogo" data-edit="${escapeHtml(p.i)}">✎</button>
        <button class="delete-btn" type="button" aria-label="Elimina luogo" data-delete="${escapeHtml(p.i)}">×</button>
      </div>
    </article>`;
  }

  render = function() {
    const active=visiblePlaces();
    const filtered=filteredPlaces();
    el.placeCount.textContent=active.length;
    el.magnetCount.textContent=active.filter(p=>p.m).length;
    el.emptyState.hidden=filtered.length!==0;
    el.placesList.innerHTML=filtered.map(cardHtml).join('');
    if(activeView==='map') renderMap();
  };

  function destroyMap() {
    try { mapResizeObserver?.disconnect(); } catch {}
    mapResizeObserver=null;
    if (map) {
      try { map.off(); map.remove(); } catch (err) { console.warn('Chiusura mappa',err); }
    }
    map=null; mapLayer=null;
  }

  hardResizeMap = function() {
    if (!map || activeView !== 'map') return;
    const node=document.getElementById('map');
    if (!node || node.clientWidth < 40 || node.clientHeight < 40) return;
    requestAnimationFrame(()=>{
      try { map.invalidateSize({pan:false,animate:false}); } catch {}
    });
  };

  ensureMap = function() {
    if (map || !window.L || !el.mapPanel || el.mapPanel.hidden) return;
    const node=document.getElementById('map');
    if (!node || node.clientWidth < 40 || node.clientHeight < 40) return;
    map=L.map(node,{zoomControl:true,attributionControl:true,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([41.9,12.5],5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,
      attribution:'&copy; OpenStreetMap contributors',
      updateWhenIdle:true,
      updateWhenZooming:false,
      keepBuffer:2,
      detectRetina:false
    }).addTo(map);
    mapLayer=L.layerGroup().addTo(map);
    if ('ResizeObserver' in window) {
      mapResizeObserver=new ResizeObserver(()=>hardResizeMap());
      mapResizeObserver.observe(node);
    }
  };

  renderMap = function() {
    if (activeView !== 'map' || el.mapPanel.hidden) return;
    ensureMap();
    if (!map || !mapLayer) {
      el.mapStatus.textContent='Sto preparando la mappa…';
      setTimeout(()=>{ if(activeView==='map'){ ensureMap(); renderMap(); } },120);
      return;
    }

    mapLayer.clearLayers();
    const filtered=filteredPlaces();
    const located=filtered.filter(p=>Array.isArray(p.g)&&p.g.length===2&&Number.isFinite(Number(p.g[0]))&&Number.isFinite(Number(p.g[1])));
    const missing=filtered.length-located.length;
    const bounds=[];

    located.forEach(p=>{
      const coords=[Number(p.g[0]),Number(p.g[1])];
      const icon=L.divIcon({
        className:'map-div-icon',
        html:`<div class="map-pin ${markerClass(p.v)}"><b>${p.v==='B'?'♥':p.v==='A'?'A':'M'}</b>${p.m?'<span>🧲</span>':''}</div>`,
        iconSize:[38,44],iconAnchor:[19,40],popupAnchor:[0,-36]
      });
      L.marker(coords,{icon})
        .bindPopup(`<strong>${escapeHtml(p.n)}</strong><br>${escapeHtml(visitedLabel(p.v))}<br>${p.m?'🧲 Calamita già presa':'📍 Calamita da prendere'}`)
        .addTo(mapLayer);
      bounds.push(coords);
    });

    el.mapStatus.textContent=located.length
      ? `${located.length} ${located.length===1?'luogo visibile':'luoghi visibili'}${missing?` · ${missing} da geolocalizzare`:''}`
      : (missing?'Sto geolocalizzando i luoghi inseriti…':'Nessun luogo da mostrare con questi filtri.');

    requestAnimationFrame(()=>{
      hardResizeMap();
      try {
        if(bounds.length===1) map.setView(bounds[0],9,{animate:false});
        else if(bounds.length>1) map.fitBounds(bounds,{padding:[28,28],maxZoom:10,animate:false});
      } catch {}
      setTimeout(()=>hardResizeMap(),180);
    });
  };

  setView = function(view) {
    activeView=view;
    el.viewSwitch.querySelectorAll('[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===view));
    el.listView.hidden=view!=='list';
    el.mapPanel.hidden=view!=='map';

    if (view === 'list') {
      destroyMap();
      return;
    }

    destroyMap();
    el.mapStatus.textContent='Sto preparando la mappa…';
    setTimeout(()=>{
      if(activeView!=='map') return;
      ensureMap();
      renderMap();
      queueMissingGeocodes();
    },90);
  };

  const editDialog=document.getElementById('editDialog');
  const editName=document.getElementById('editName');
  const editDate=document.getElementById('editDate');
  const editMagnet=document.getElementById('editMagnet');
  const editSave=document.getElementById('editSave');

  function setEditVisited(code) {
    const radio=document.querySelector(`input[name="editVisitedBy"][value="${code}"]`);
    if (radio) radio.checked=true;
  }
  function getEditVisited() {
    return document.querySelector('input[name="editVisitedBy"]:checked')?.value || 'B';
  }

  function openEditor(id) {
    const p=places.find(x=>x.i===id&&!x.x);
    if(!p||!editDialog) return;
    editingId=id;
    editName.value=p.n;
    editDate.value=p.d||today();
    editMagnet.checked=!!p.m;
    setEditVisited(p.v||'B');
    document.getElementById('editGeoHint').textContent=Array.isArray(p.g)?'📍 Posizione già salvata':'📍 La posizione verrà cercata quando salvi';
    editDialog.showModal();
  }

  async function saveEditor() {
    const p=places.find(x=>x.i===editingId&&!x.x);
    if(!p) return;
    const newName=editName.value.trim().replace(/\s+/g,' ');
    if(!newName){ editName.focus(); return; }
    if(visiblePlaces().some(x=>x.i!==p.i&&norm(x.n)===norm(newName))){ toast('Esiste già un luogo con questo nome'); return; }

    editSave.disabled=true;
    setStatus('Aggiorno…');
    try {
      let coords=Array.isArray(p.g)?p.g:null;
      if(norm(newName)!==norm(p.n)) {
        coords=null;
        try {
          const hits=await photonSearch(newName,1);
          coords=hits?.[0]?.coords||null;
        } catch(err) { console.warn('Nuova geolocalizzazione non riuscita',err); }
      }
      await persistRecord(p,{
        n:newName.slice(0,80),
        d:editDate.value||today(),
        m:editMagnet.checked?1:0,
        v:getEditVisited(),
        g:coords
      });
      editDialog.close();
      editingId=null;
      await syncFromCloud();
      toast('Luogo aggiornato ✓');
    } catch(err) {
      console.error(err);
      setStatus('Errore di sincronizzazione','error');
      toast('Non sono riuscito ad aggiornare il luogo');
    } finally { editSave.disabled=false; }
  }

  el.placesList.addEventListener('click',e=>{
    const btn=e.target.closest('[data-edit]');
    if(btn) openEditor(btn.dataset.edit);
  });
  editSave?.addEventListener('click',saveEditor);
  editDialog?.addEventListener('close',()=>{editingId=null;});

  // L'input di ricerca aveva già un listener con il vecchio render: questo garantisce
  // che l'ultimo rendering usi anche i nuovi pulsanti Modifica.
  el.searchInput.addEventListener('input',()=>render());
  window.addEventListener('orientationchange',()=>{ if(activeView==='map') setTimeout(()=>hardResizeMap(),160); },{passive:true});
})();
