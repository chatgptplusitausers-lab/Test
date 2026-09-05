const KV_API = 'https://api.keyval.org';
const ROOT = window.__OUR_PLACES_ROOT__ || '';
const PROFILE_KEY = 'our-places-profile-v3';
const POLL_MS = 30000;
const GEOCODE_MIN_GAP_MS = 1150;
const AUTOCOMPLETE_DEBOUNCE_MS = 380;

const $ = id => document.getElementById(id);
const el = {
  placeInput:$('placeInput'), placeSuggestions:$('placeSuggestions'), dateInput:$('dateInput'), magnetInput:$('magnetInput'), addBtn:$('addBtn'),
  voiceBtn:$('voiceBtn'), voiceHint:$('voiceHint'), placesList:$('placesList'), emptyState:$('emptyState'),
  searchInput:$('searchInput'), refreshBtn:$('refreshBtn'), syncStatus:$('syncStatus'), placeCount:$('placeCount'),
  magnetCount:$('magnetCount'), shareBtn:$('shareBtn'), profileBtn:$('profileBtn'), profileDialog:$('profileDialog'),
  toast:$('toast'), filterRow:$('filterRow'), viewSwitch:$('viewSwitch'), listView:$('listView'), mapPanel:$('mapPanel'),
  mapStatus:$('mapStatus')
};

let places = [];
let profile = localStorage.getItem(PROFILE_KEY) || '';
let activeFilter = 'all';
let activeView = 'list';
let syncing = false;
let toastTimer;
let map = null;
let mapLayer = null;
let mapResizeObserver = null;
let lastGeocodeAt = 0;
let geocodeQueueRunning = false;
const geocodeTried = new Set();
let autocompleteTimer = null;
let autocompleteController = null;
let suggestions = [];
let activeSuggestion = -1;
let selectedPlace = null;

function today(){
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0,10);
}
function shortId(){ return `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function setStatus(text,mode=''){ el.syncStatus.textContent=text; el.syncStatus.className=`sync-status ${mode}`.trim(); }
function toast(message){ clearTimeout(toastTimer); el.toast.textContent=message; el.toast.classList.add('show'); toastTimer=setTimeout(()=>el.toast.classList.remove('show'),2800); }
function setVisitedChoice(code){ const radio=document.querySelector(`input[name="visitedBy"][value="${code}"]`); if(radio) radio.checked=true; }
function getVisitedChoice(){ return document.querySelector('input[name="visitedBy"]:checked')?.value || 'B'; }
function setProfile(name){ profile=name; localStorage.setItem(PROFILE_KEY,name); el.profileBtn.textContent=name==='Marco'?'M':'A'; el.profileBtn.title=`Stai usando l'app come ${name}`; setVisitedChoice(name==='Marco'?'M':'A'); }
function askProfileIfNeeded(){ if(!profile) setTimeout(()=>el.profileDialog.showModal(),250); else setProfile(profile); }

function parseWire(raw){
  const text=String(raw??'').trim(); if(!text) return '';
  try{
    const data=JSON.parse(text);
    if(typeof data==='string'||typeof data==='number') return String(data);
    if(data&&typeof data==='object'){
      if('val' in data) return String(data.val??'');
      if('value' in data) return String(data.value??'');
    }
  }catch{}
  return text.replace(/^"|"$/g,'');
}

async function fetchWithTimeout(url, options={}, timeout=9000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}

async function kvGet(key){
  let lastErr;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const res=await fetchWithTimeout(`${KV_API}/get/${encodeURIComponent(key)}`,{cache:'no-store'},8000);
      if(!res.ok) throw new Error(`KeyVal read: ${res.status}`);
      return parseWire(await res.text());
    }catch(err){ lastErr=err; if(attempt<2) await sleep(220*(attempt+1)); }
  }
  throw lastErr;
}

async function kvSet(key,val){
  const value=String(val);
  if(value.length>295) throw new Error('VALUE_TOO_LARGE');
  let lastErr;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const res=await fetchWithTimeout(`${KV_API}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,{cache:'no-store'},8000);
      if(!res.ok) throw new Error(`KeyVal write: ${res.status}`);
      for(let verify=0; verify<5; verify++){
        const confirmed=await kvGet(key).catch(()=>null);
        if(confirmed===value) return true;
        await sleep(180 + verify*120);
      }
      throw new Error('WRITE_NOT_CONFIRMED');
    }catch(err){ lastErr=err; if(attempt<2) await sleep(300*(attempt+1)); }
  }
  throw lastErr;
}

function toBase64Url(text){
  const bytes=new TextEncoder().encode(text); let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b));
  return btoa(bin).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function fromBase64Url(value){
  const normalized=value.replaceAll('-','+').replaceAll('_','/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const bin=atob(padded); const bytes=Uint8Array.from(bin,ch=>ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeRecord(record){
  const lat=Array.isArray(record.g)?String(record.g[0]):'';
  const lon=Array.isArray(record.g)?String(record.g[1]):'';
  return ['v2',record.i,toBase64Url(record.n),record.d||'',record.m?1:0,record.v||'B',record.t||Date.now(),record.x?1:0,lat,lon].join('_');
}
function decodeRecord(raw){
  if(!raw) return null;
  try{
    if(raw.startsWith('v2_')){
      const parts=raw.split('_');
      if(parts.length<10) return null;
      const lat=Number(parts[8]), lon=Number(parts[9]);
      return {i:parts[1],n:fromBase64Url(parts[2]),d:parts[3],m:Number(parts[4])?1:0,v:parts[5]||'B',t:Number(parts[6])||Date.now(),x:Number(parts[7])?1:0,...(Number.isFinite(lat)&&Number.isFinite(lon)?{g:[lat,lon]}:{})};
    }
    if(raw.startsWith('b64:')) return JSON.parse(fromBase64Url(raw.slice(4)));
    if(raw.startsWith('b64_')) return JSON.parse(fromBase64Url(raw.slice(4)));
    return JSON.parse(raw);
  }catch(err){ console.warn('Record non leggibile',err); return null; }
}

function codeFor(name){ return name==='Marco'?'m':'a'; }
function metaKey(name){ return `${ROOT}-${codeFor(name)}meta`; }
function itemKey(name,index){ return `${ROOT}-${codeFor(name)}${index}`; }
async function loadUser(name){
  const count=Math.max(0,Math.min(500,Number.parseInt(await kvGet(metaKey(name)),10)||0));
  if(!count) return [];
  const values=await Promise.all(Array.from({length:count},(_,i)=>kvGet(itemKey(name,i+1)).catch(()=>'')));
  const result=[];
  values.forEach((raw,i)=>{
    if(!raw) return;
    const p=decodeRecord(raw);
    if(p&&p.i&&p.n){
      const fallback=name==='Marco'?'M':'A';
      result.push({...p,v:p.v||fallback,_owner:name,_index:i+1,_key:itemKey(name,i+1)});
    }
  });
  return result;
}
async function loadCloud(){ const [marco,ale]=await Promise.all([loadUser('Marco'),loadUser('Ale')]); places=[...marco,...ale]; return places; }
async function syncFromCloud({quiet=false}={}){
  if(!ROOT||syncing) return;
  syncing=true; if(!quiet) setStatus('Aggiorno…');
  try{ await loadCloud(); render(); setStatus('Sincronizzato','ok'); queueMissingGeocodes(); }
  catch(err){ console.error(err); setStatus('Connessione non disponibile','error'); }
  finally{ syncing=false; }
}

function cleanRecord(p,patch={}){ return {i:p.i,n:p.n,d:p.d,m:p.m?1:0,v:p.v||'B',t:p.t||Date.now(),x:p.x?1:0,...(Array.isArray(p.g)&&p.g.length===2?{g:p.g}:{}),...patch}; }
async function persistRecord(p,patch={}){ const record=cleanRecord(p,patch); await kvSet(p._key,encodeRecord(record)); Object.assign(p,record); return p; }

async function waitForGeocodeSlot(){
  const delay=Math.max(0,GEOCODE_MIN_GAP_MS-(Date.now()-lastGeocodeAt));
  if(delay) await sleep(delay);
  lastGeocodeAt=Date.now();
}

function formatPhotonFeature(feature){
  const p=feature?.properties||{};
  const coords=feature?.geometry?.coordinates;
  if(!Array.isArray(coords)||coords.length<2) return null;
  const lon=Number(coords[0]), lat=Number(coords[1]);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  const name=p.name||p.city||p.locality||p.district;
  if(!name) return null;
  const detail=[p.city&&p.city!==name?p.city:null,p.state,p.country].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · ');
  return {name:String(name),detail,coords:[Number(lat.toFixed(6)),Number(lon.toFixed(6))]};
}

async function photonSearch(query,limit=5,signal){
  const url=new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q',query);
  url.searchParams.set('limit',String(limit));
  url.searchParams.set('lang','it');
  const res=await fetch(url,{headers:{Accept:'application/json'},signal});
  if(!res.ok) throw new Error(`Photon ${res.status}`);
  const data=await res.json();
  return (data?.features||[]).map(formatPhotonFeature).filter(Boolean);
}

async function geocodePlace(name){
  await waitForGeocodeSlot();
  try{
    const hits=await photonSearch(name,1);
    if(hits[0]) return hits[0].coords;
  }catch(err){ console.warn('Photon geocode fallito',err); }

  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),9000);
  try{
    const url=new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q',name); url.searchParams.set('format','jsonv2'); url.searchParams.set('limit','1'); url.searchParams.set('accept-language','it');
    const res=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal});
    if(!res.ok) throw new Error(`Geocoding ${res.status}`);
    const data=await res.json(); const hit=data?.[0]; if(!hit) return null;
    const lat=Number(hit.lat),lon=Number(hit.lon);
    return Number.isFinite(lat)&&Number.isFinite(lon)?[Number(lat.toFixed(6)),Number(lon.toFixed(6))]:null;
  }finally{ clearTimeout(timer); }
}

async function queueMissingGeocodes(){
  if(geocodeQueueRunning) return;
  const missing=visiblePlaces().filter(p=>!Array.isArray(p.g)&&!geocodeTried.has(p.i));
  if(!missing.length) return;
  geocodeQueueRunning=true;
  try{
    for(const p of missing){
      geocodeTried.add(p.i);
      if(activeView==='map') el.mapStatus.textContent=`Sto geolocalizzando ${p.n}…`;
      try{
        const coords=await geocodePlace(p.n);
        if(coords){ await persistRecord(p,{g:coords}); render(); }
      }catch(err){ console.warn('Geocoding non riuscito',p.n,err); }
    }
  }finally{ geocodeQueueRunning=false; if(activeView==='map') renderMap(); }
}

function displayDate(iso){ if(!iso)return'Data non indicata'; const[y,m,d]=iso.split('-').map(Number); return new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short',year:'numeric'}).format(new Date(y,m-1,d)); }
function escapeHtml(value=''){ return String(value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch])); }
function visiblePlaces(){ return places.filter(p=>!p.x); }
function visitedLabel(v){ return v==='B'?'Entrambi ❤️':v==='A'?'Solo Ale':'Solo Marco'; }
function matchesFilter(p){ if(activeFilter==='all')return true; if(activeFilter==='M')return p.v==='M'||p.v==='B'; if(activeFilter==='A')return p.v==='A'||p.v==='B'; if(activeFilter==='B')return p.v==='B'; if(activeFilter==='missing')return !p.m; return true; }
function filteredPlaces(){ const q=el.searchInput.value.trim().toLocaleLowerCase('it'); return visiblePlaces().filter(p=>(!q||p.n.toLocaleLowerCase('it').includes(q))&&matchesFilter(p)).sort((a,b)=>(b.d||'').localeCompare(a.d||'')||(b.t||0)-(a.t||0)); }
function render(){
  const active=visiblePlaces(); const filtered=filteredPlaces();
  el.placeCount.textContent=active.length; el.magnetCount.textContent=active.filter(p=>p.m).length; el.emptyState.hidden=filtered.length!==0;
  el.placesList.innerHTML=filtered.map(p=>`<article class="place-card" data-id="${escapeHtml(p.i)}"><div class="place-mark">${p.m?'🧲':'📍'}</div><div class="place-copy"><h3>${escapeHtml(p.n)}</h3><div class="place-meta"><span>${displayDate(p.d)}</span><span class="visit-badge">· ${visitedLabel(p.v)}</span><span class="magnet">· ${p.m?'calamita già presa':'calamita da prendere'}</span>${Array.isArray(p.g)?'<span class="geo-ok">· sulla mappa</span>':'<span class="geo-wait">· posizione in ricerca</span>'}</div></div><button class="delete-btn" type="button" aria-label="Elimina luogo" data-delete="${escapeHtml(p.i)}">×</button></article>`).join('');
  if(activeView==='map') renderMap();
}

function hardResizeMap(){
  if(!map) return;
  requestAnimationFrame(()=>{
    map.invalidateSize({pan:false,animate:false});
    setTimeout(()=>map?.invalidateSize({pan:false,animate:false}),120);
    setTimeout(()=>map?.invalidateSize({pan:false,animate:false}),420);
  });
}
function ensureMap(){
  if(map||!window.L||!el.mapPanel) return;
  map=L.map('map',{zoomControl:true,attributionControl:true,preferCanvas:true}).setView([41.9,12.5],5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors',updateWhenIdle:false,keepBuffer:4}).addTo(map);
  mapLayer=L.layerGroup().addTo(map);
  if('ResizeObserver' in window){ mapResizeObserver=new ResizeObserver(()=>hardResizeMap()); mapResizeObserver.observe(document.getElementById('map')); }
  window.addEventListener('resize',hardResizeMap,{passive:true});
}
function markerClass(v){ return v==='B'?'pin-both':v==='A'?'pin-ale':'pin-marco'; }
function renderMap(){
  if(activeView!=='map') return;
  ensureMap();
  if(!map){ el.mapStatus.textContent='La mappa non è disponibile in questo momento.'; return; }
  hardResizeMap();
  mapLayer.clearLayers();
  const filtered=filteredPlaces(); const located=filtered.filter(p=>Array.isArray(p.g)&&p.g.length===2); const missing=filtered.length-located.length; const bounds=[];
  located.forEach(p=>{
    const icon=L.divIcon({className:'map-div-icon',html:`<div class="map-pin ${markerClass(p.v)}"><b>${p.v==='B'?'♥':p.v==='A'?'A':'M'}</b>${p.m?'<span>🧲</span>':''}</div>`,iconSize:[38,44],iconAnchor:[19,40],popupAnchor:[0,-36]});
    const marker=L.marker(p.g,{icon}).bindPopup(`<strong>${escapeHtml(p.n)}</strong><br><span>${escapeHtml(visitedLabel(p.v))}</span><br><span>${p.m?'🧲 Calamita già presa':'📍 Calamita da prendere'}</span>`);
    marker.addTo(mapLayer); bounds.push(p.g);
  });
  el.mapStatus.textContent=located.length?`${located.length} ${located.length===1?'luogo visibile':'luoghi visibili'} sulla mappa${missing?` · ${missing} in geolocalizzazione`:''}`:(missing?'Sto geolocalizzando i luoghi inseriti…':'Nessun luogo da mostrare con questi filtri.');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    hardResizeMap();
    if(bounds.length===1) map.setView(bounds[0],9,{animate:false});
    else if(bounds.length>1) map.fitBounds(bounds,{padding:[26,26],maxZoom:10,animate:false});
  }));
}
function setView(view){
  activeView=view;
  el.viewSwitch.querySelectorAll('[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===view));
  el.listView.hidden=view!=='list'; el.mapPanel.hidden=view!=='map';
  if(view==='map'){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{ ensureMap(); hardResizeMap(); renderMap(); queueMissingGeocodes(); }));
  }
}

function hideSuggestions(){ suggestions=[]; activeSuggestion=-1; el.placeSuggestions.hidden=true; el.placeInput.setAttribute('aria-expanded','false'); }
function renderSuggestions(){
  if(!suggestions.length){ hideSuggestions(); return; }
  el.placeSuggestions.innerHTML=suggestions.map((s,i)=>`<button type="button" class="suggestion-item ${i===activeSuggestion?'active':''}" data-suggestion="${i}" role="option"><span class="suggestion-pin">⌖</span><span class="suggestion-copy"><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.detail||'')}</small></span></button>`).join('');
  el.placeSuggestions.hidden=false; el.placeInput.setAttribute('aria-expanded','true');
}
function chooseSuggestion(index){
  const s=suggestions[index]; if(!s) return;
  selectedPlace=s; el.placeInput.value=s.name; hideSuggestions(); el.placeInput.focus();
  el.voiceHint.textContent=s.detail?`📍 ${s.detail}`:'Posizione trovata.';
}
async function requestSuggestions(query){
  autocompleteController?.abort(); autocompleteController=new AbortController();
  try{
    const hits=await photonSearch(query,6,autocompleteController.signal);
    if(el.placeInput.value.trim().replace(/\s+/g,' ')!==query) return;
    suggestions=hits.slice(0,5); activeSuggestion=-1; renderSuggestions();
  }catch(err){ if(err.name!=='AbortError'){ console.warn('Autocomplete non disponibile',err); hideSuggestions(); } }
}
function scheduleAutocomplete(){
  clearTimeout(autocompleteTimer); selectedPlace=null;
  const query=el.placeInput.value.trim().replace(/\s+/g,' ');
  if(query.length<2){ hideSuggestions(); return; }
  el.placeSuggestions.innerHTML='<div class="suggestion-loading">Cerco la città…</div>'; el.placeSuggestions.hidden=false; el.placeInput.setAttribute('aria-expanded','true');
  autocompleteTimer=setTimeout(()=>requestSuggestions(query),AUTOCOMPLETE_DEBOUNCE_MS);
}

async function addPlace(){
  const name=el.placeInput.value.trim().replace(/\s+/g,' ');
  if(!name){ el.placeInput.focus(); toast('Prima il posto. Poi la gloria.'); return; }
  if(!profile){ el.profileDialog.showModal(); return; }
  if(!ROOT){ toast('Lo spazio condiviso non è configurato'); return; }
  el.addBtn.disabled=true; setStatus('Salvo…'); hideSuggestions();
  try{
    await loadCloud();
    if(visiblePlaces().some(p=>p.n.trim().toLocaleLowerCase('it')===name.toLocaleLowerCase('it'))) throw new Error('DUPLICATE');
    let coords=selectedPlace&&selectedPlace.name.toLocaleLowerCase('it')===name.toLocaleLowerCase('it')?selectedPlace.coords:null;
    if(!coords){ setStatus('Geolocalizzo…'); try{ coords=await geocodePlace(name); }catch(err){ console.warn('Geocoding in inserimento fallito',err); } }
    const count=Math.max(0,Number.parseInt(await kvGet(metaKey(profile)),10)||0); const next=count+1;
    const item={i:shortId(),n:name.slice(0,80),d:el.dateInput.value||today(),m:el.magnetInput.checked?1:0,v:getVisitedChoice(),t:Date.now(),x:0,...(coords?{g:coords}:{})};
    await kvSet(itemKey(profile,next),encodeRecord(item));
    await kvSet(metaKey(profile),String(next));
    el.placeInput.value=''; selectedPlace=null; el.magnetInput.checked=true; setVisitedChoice(profile==='Marco'?'M':'A');
    await syncFromCloud();
    toast(coords?`${name} aggiunto e messo sulla mappa ✨`:`${name} aggiunto. Cercherò la posizione in background.`);
    el.placeInput.focus();
  }catch(err){
    console.error(err);
    if(err.message==='DUPLICATE') toast('Questo posto c’è già. Memoria selettiva, eh?');
    else if(err.message==='VALUE_TOO_LARGE') toast('Nome troppo lungo per lo storage.');
    else{ setStatus('Errore di sincronizzazione','error'); toast('Non sono riuscito a salvarlo. Riprova.'); }
  }finally{ el.addBtn.disabled=false; }
}

async function deletePlace(id){
  const target=places.find(p=>p.i===id&&!p.x); if(!target)return;
  if(!confirm(`Togliere “${target.n}” dai vostri luoghi?`)) return;
  try{ setStatus('Salvo…'); await persistRecord(target,{x:1}); await syncFromCloud(); toast('Luogo rimosso'); }
  catch(err){ console.error(err); setStatus('Errore di sincronizzazione','error'); toast('Non sono riuscito a eliminarlo'); }
}
async function shareApp(){
  const shareData={title:'I nostri luoghi comuni 🧲',text:'Il nostro atlante condiviso ❤️',url:location.href};
  try{ if(navigator.share) await navigator.share(shareData); else{ await navigator.clipboard.writeText(location.href); toast('Link copiato. Ora giralo ad Ale 🫡'); } }
  catch(err){ if(err.name!=='AbortError') toast('Non sono riuscito a condividere il link'); }
}

function setupVoice(){
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition){ el.voiceBtn.addEventListener('click',()=>toast('Il riconoscimento vocale non è supportato da questo browser')); return; }
  const recognition=new Recognition(); recognition.lang='it-IT'; recognition.interimResults=false; recognition.maxAlternatives=1;
  el.voiceBtn.addEventListener('click',()=>{try{recognition.start()}catch{}});
  recognition.onstart=()=>{el.voiceBtn.classList.add('listening');el.voiceHint.textContent='Ti ascolto… dimmi il nome del posto.'};
  recognition.onresult=event=>{const text=event.results?.[0]?.[0]?.transcript?.trim();if(text){el.placeInput.value=text.replace(/[.!?]+$/,'');el.voiceHint.textContent='Preso. Ti mostro i suggerimenti…';scheduleAutocomplete();}};
  recognition.onerror=()=>{el.voiceHint.textContent='Non ti ho capito. Ritenta senza fare il tenore.'}; recognition.onend=()=>el.voiceBtn.classList.remove('listening');
}

function wireEvents(){
  el.addBtn.addEventListener('click',addPlace);
  el.placeInput.addEventListener('input',scheduleAutocomplete);
  el.placeInput.addEventListener('keydown',e=>{
    if(!el.placeSuggestions.hidden&&suggestions.length){
      if(e.key==='ArrowDown'){e.preventDefault();activeSuggestion=Math.min(suggestions.length-1,activeSuggestion+1);renderSuggestions();return;}
      if(e.key==='ArrowUp'){e.preventDefault();activeSuggestion=Math.max(0,activeSuggestion-1);renderSuggestions();return;}
      if(e.key==='Escape'){hideSuggestions();return;}
      if(e.key==='Enter'&&activeSuggestion>=0){e.preventDefault();chooseSuggestion(activeSuggestion);return;}
    }
    if(e.key==='Enter'){e.preventDefault();addPlace();}
  });
  el.placeSuggestions.addEventListener('click',e=>{const btn=e.target.closest('[data-suggestion]');if(btn)chooseSuggestion(Number(btn.dataset.suggestion));});
  document.addEventListener('click',e=>{if(!e.target.closest('.place-input-wrap')) hideSuggestions();});
  el.searchInput.addEventListener('input',render);
  el.refreshBtn.addEventListener('click',()=>syncFromCloud());
  el.shareBtn.addEventListener('click',shareApp);
  el.profileBtn.addEventListener('click',()=>el.profileDialog.showModal());
  el.profileDialog.addEventListener('click',e=>{const btn=e.target.closest('[data-profile]');if(btn)setProfile(btn.dataset.profile)});
  el.placesList.addEventListener('click',e=>{const btn=e.target.closest('[data-delete]');if(btn)deletePlace(btn.dataset.delete)});
  el.filterRow.addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(!btn)return;activeFilter=btn.dataset.filter;el.filterRow.querySelectorAll('.filter-chip').forEach(x=>x.classList.toggle('active',x===btn));render();});
  el.viewSwitch.addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)setView(btn.dataset.view)});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){syncFromCloud({quiet:true});if(activeView==='map')hardResizeMap();}});
}

async function init(){
  el.dateInput.value=today(); wireEvents(); setupVoice(); askProfileIfNeeded();
  if(!ROOT){setStatus('Spazio condiviso non configurato','error');return;}
  await syncFromCloud(); setInterval(()=>syncFromCloud({quiet:true}),POLL_MS);
}
init();
