const KV_API = 'https://api.keyval.org';
const ROOT = window.__OUR_PLACES_ROOT__ || '';
const PROFILE_KEY = 'our-places-profile-v3';
const POLL_MS = 30000;
const GEOCODE_MIN_GAP_MS = 1150;

const $ = (id) => document.getElementById(id);
const el = {
  placeInput:$('placeInput'), dateInput:$('dateInput'), magnetInput:$('magnetInput'), addBtn:$('addBtn'),
  voiceBtn:$('voiceBtn'), voiceHint:$('voiceHint'), placesList:$('placesList'), emptyState:$('emptyState'),
  searchInput:$('searchInput'), refreshBtn:$('refreshBtn'), syncStatus:$('syncStatus'), placeCount:$('placeCount'),
  magnetCount:$('magnetCount'), shareBtn:$('shareBtn'), profileBtn:$('profileBtn'), profileDialog:$('profileDialog'),
  toast:$('toast'), filterRow:$('filterRow'), viewSwitch:$('viewSwitch'), listView:$('listView'), mapPanel:$('mapPanel'),
  mapStatus:$('mapStatus')
};

let places=[];
let profile=localStorage.getItem(PROFILE_KEY)||'';
let activeFilter='all';
let activeView='list';
let syncing=false;
let toastTimer;
let map=null;
let mapLayer=null;
let lastGeocodeAt=0;
let geocodeQueueRunning=false;
const geocodeTried=new Set();

function today(){const d=new Date();const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)}
function shortId(){return `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`}
function setStatus(text,mode=''){el.syncStatus.textContent=text;el.syncStatus.className=`sync-status ${mode}`.trim()}
function toast(message){clearTimeout(toastTimer);el.toast.textContent=message;el.toast.classList.add('show');toastTimer=setTimeout(()=>el.toast.classList.remove('show'),2800)}
function setVisitedChoice(code){const radio=document.querySelector(`input[name="visitedBy"][value="${code}"]`);if(radio)radio.checked=true}
function getVisitedChoice(){return document.querySelector('input[name="visitedBy"]:checked')?.value||'B'}
function setProfile(name){profile=name;localStorage.setItem(PROFILE_KEY,name);el.profileBtn.textContent=name==='Marco'?'M':'A';el.profileBtn.title=`Stai usando l'app come ${name}`;setVisitedChoice(name==='Marco'?'M':'A')}
function askProfileIfNeeded(){if(!profile)setTimeout(()=>el.profileDialog.showModal(),250);else setProfile(profile)}

function parseWire(raw){const text=String(raw??'').trim();if(!text)return'';try{const data=JSON.parse(text);if(typeof data==='string'||typeof data==='number')return String(data);if(data&&typeof data==='object'){if('val'in data)return String(data.val??'');if('value'in data)return String(data.value??'')}}catch{}return text.replace(/^"|"$/g,'')}
async function kvGet(key){const res=await fetch(`${KV_API}/get/${encodeURIComponent(key)}`,{cache:'no-store'});if(!res.ok)throw new Error(`KeyVal read: ${res.status}`);return parseWire(await res.text())}
async function kvSet(key,val){const value=String(val);if(value.length>295)throw new Error('VALUE_TOO_LARGE');const res=await fetch(`${KV_API}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,{cache:'no-store'});if(!res.ok)throw new Error(`KeyVal write: ${res.status}`);const confirmed=await kvGet(key);if(confirmed!==value)throw new Error('WRITE_NOT_CONFIRMED');return true}

function toBase64Url(text){const bytes=new TextEncoder().encode(text);let bin='';bytes.forEach(b=>bin+=String.fromCharCode(b));return btoa(bin).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
function fromBase64Url(value){const normalized=value.replaceAll('-','+').replaceAll('_','/');const padded=normalized+'='.repeat((4-normalized.length%4)%4);const bin=atob(padded);const bytes=Uint8Array.from(bin,ch=>ch.charCodeAt(0));return new TextDecoder().decode(bytes)}
function encodeRecord(record){return `b64:${toBase64Url(JSON.stringify(record))}`}
function decodeRecord(raw){if(!raw)return null;try{return JSON.parse(raw.startsWith('b64:')?fromBase64Url(raw.slice(4)):raw)}catch(err){console.warn('Record non leggibile',err);return null}}

function codeFor(name){return name==='Marco'?'m':'a'}
function metaKey(name){return `${ROOT}-${codeFor(name)}meta`}
function itemKey(name,index){return `${ROOT}-${codeFor(name)}${index}`}
async function loadUser(name){const count=Math.max(0,Math.min(500,Number.parseInt(await kvGet(metaKey(name)),10)||0));if(!count)return[];const values=await Promise.all(Array.from({length:count},(_,i)=>kvGet(itemKey(name,i+1))));const result=[];values.forEach((raw,i)=>{if(!raw)return;const p=decodeRecord(raw);if(p&&p.i&&p.n){const fallback=name==='Marco'?'M':'A';result.push({...p,v:p.v||fallback,_owner:name,_index:i+1,_key:itemKey(name,i+1)})}});return result}
async function loadCloud(){const[marco,ale]=await Promise.all([loadUser('Marco'),loadUser('Ale')]);places=[...marco,...ale];return places}
async function syncFromCloud({quiet=false}={}){if(!ROOT||syncing)return;syncing=true;if(!quiet)setStatus('Aggiorno…');try{await loadCloud();render();setStatus('Sincronizzato','ok');queueMissingGeocodes()}catch(err){console.error(err);setStatus('Connessione non disponibile','error')}finally{syncing=false}}

function cleanRecord(p,patch={}){return {i:p.i,n:p.n,d:p.d,m:p.m?1:0,v:p.v||'B',t:p.t||Date.now(),x:p.x?1:0,...(Array.isArray(p.g)&&p.g.length===2?{g:p.g}:{}),...patch}}
async function persistRecord(p,patch={}){const record=cleanRecord(p,patch);await kvSet(p._key,encodeRecord(record));Object.assign(p,record);return p}

async function waitForGeocodeSlot(){const delay=Math.max(0,GEOCODE_MIN_GAP_MS-(Date.now()-lastGeocodeAt));if(delay)await new Promise(r=>setTimeout(r,delay));lastGeocodeAt=Date.now()}
async function geocodePlace(name){await waitForGeocodeSlot();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),9000);try{const url=new URL('https://nominatim.openstreetmap.org/search');url.searchParams.set('q',name);url.searchParams.set('format','jsonv2');url.searchParams.set('limit','1');url.searchParams.set('addressdetails','0');url.searchParams.set('accept-language','it');const res=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal});if(!res.ok)throw new Error(`Geocoding ${res.status}`);const data=await res.json();const hit=data?.[0];if(!hit)return null;const lat=Number(hit.lat),lon=Number(hit.lon);return Number.isFinite(lat)&&Number.isFinite(lon)?[Number(lat.toFixed(6)),Number(lon.toFixed(6))]:null}finally{clearTimeout(timer)}}
async function queueMissingGeocodes(){if(geocodeQueueRunning)return;const missing=visiblePlaces().filter(p=>!Array.isArray(p.g)&&!geocodeTried.has(p.i));if(!missing.length)return;geocodeQueueRunning=true;try{for(const p of missing){geocodeTried.add(p.i);if(activeView==='map')el.mapStatus.textContent=`Sto geolocalizzando ${p.n}…`;try{const coords=await geocodePlace(p.n);if(coords){await persistRecord(p,{g:coords});render()}}catch(err){console.warn('Geocoding non riuscito',p.n,err)}}}finally{geocodeQueueRunning=false;if(activeView==='map')renderMap()}}

function displayDate(iso){if(!iso)return'Data non indicata';const[y,m,d]=iso.split('-').map(Number);return new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short',year:'numeric'}).format(new Date(y,m-1,d))}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]))}
function visiblePlaces(){return places.filter(p=>!p.x)}
function visitedLabel(v){return v==='B'?'Entrambi ❤️':v==='A'?'Solo Ale':'Solo Marco'}
function matchesFilter(p){if(activeFilter==='all')return true;if(activeFilter==='M')return p.v==='M'||p.v==='B';if(activeFilter==='A')return p.v==='A'||p.v==='B';if(activeFilter==='B')return p.v==='B';if(activeFilter==='missing')return !p.m;return true}
function filteredPlaces(){const q=el.searchInput.value.trim().toLocaleLowerCase('it');return visiblePlaces().filter(p=>(!q||p.n.toLocaleLowerCase('it').includes(q))&&matchesFilter(p)).sort((a,b)=>(b.d||'').localeCompare(a.d||'')||(b.t||0)-(a.t||0))}
function render(){const active=visiblePlaces();const filtered=filteredPlaces();el.placeCount.textContent=active.length;el.magnetCount.textContent=active.filter(p=>p.m).length;el.emptyState.hidden=filtered.length!==0;el.placesList.innerHTML=filtered.map(p=>`<article class="place-card" data-id="${escapeHtml(p.i)}"><div class="place-mark">${p.m?'🧲':'📍'}</div><div class="place-copy"><h3>${escapeHtml(p.n)}</h3><div class="place-meta"><span>${displayDate(p.d)}</span><span class="visit-badge">· ${visitedLabel(p.v)}</span><span class="magnet">· ${p.m?'calamita già presa':'calamita da prendere'}</span>${Array.isArray(p.g)?'<span class="geo-ok">· sulla mappa</span>':'<span class="geo-wait">· posizione in ricerca</span>'}</div></div><button class="delete-btn" type="button" aria-label="Elimina luogo" data-delete="${escapeHtml(p.i)}">×</button></article>`).join('');if(activeView==='map')renderMap()}

function ensureMap(){if(map||!window.L)return;if(!el.mapPanel)return;map=L.map('map',{zoomControl:true,attributionControl:true}).setView([41.9,12.5],5);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);mapLayer=L.layerGroup().addTo(map)}
function markerClass(v){return v==='B'?'pin-both':v==='A'?'pin-ale':'pin-marco'}
function renderMap(){if(activeView!=='map')return;ensureMap();if(!map){el.mapStatus.textContent='La mappa non è disponibile in questo momento.';return}mapLayer.clearLayers();const filtered=filteredPlaces();const located=filtered.filter(p=>Array.isArray(p.g)&&p.g.length===2);const missing=filtered.length-located.length;const bounds=[];located.forEach(p=>{const icon=L.divIcon({className:'map-div-icon',html:`<div class="map-pin ${markerClass(p.v)}"><b>${p.v==='B'?'♥':p.v==='A'?'A':'M'}</b>${p.m?'<span>🧲</span>':''}</div>`,iconSize:[38,44],iconAnchor:[19,40],popupAnchor:[0,-36]});const marker=L.marker(p.g,{icon}).bindPopup(`<strong>${escapeHtml(p.n)}</strong><br><span>${escapeHtml(visitedLabel(p.v))}</span><br><span>${p.m?'🧲 Calamita già presa':'📍 Calamita da prendere'}</span>`);marker.addTo(mapLayer);bounds.push(p.g)});el.mapStatus.textContent=located.length?`${located.length} ${located.length===1?'luogo visibile':'luoghi visibili'} sulla mappa${missing?` · ${missing} in geolocalizzazione`:''}`:(missing?'Sto geolocalizzando i luoghi inseriti…':'Nessun luogo da mostrare con questi filtri.');setTimeout(()=>{map.invalidateSize();if(bounds.length===1)map.setView(bounds[0],9);else if(bounds.length>1)map.fitBounds(bounds,{padding:[30,30],maxZoom:10})},60)}
function setView(view){activeView=view;el.viewSwitch.querySelectorAll('[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===view));el.listView.hidden=view!=='list';el.mapPanel.hidden=view!=='map';if(view==='map'){renderMap();queueMissingGeocodes()}}

async function addPlace(){const name=el.placeInput.value.trim().replace(/\s+/g,' ');if(!name){el.placeInput.focus();toast('Prima il posto. Poi la gloria.');return}if(!profile){el.profileDialog.showModal();return}if(!ROOT){toast('Lo spazio condiviso non è configurato');return}el.addBtn.disabled=true;setStatus('Controllo e geolocalizzo…');try{await loadCloud();if(visiblePlaces().some(p=>p.n.trim().toLocaleLowerCase('it')===name.toLocaleLowerCase('it')))throw new Error('DUPLICATE');let coords=null;try{coords=await geocodePlace(name)}catch(err){console.warn('Geocoding in inserimento fallito',err)}const count=Math.max(0,Number.parseInt(await kvGet(metaKey(profile)),10)||0);const next=count+1;const item={i:shortId(),n:name.slice(0,80),d:el.dateInput.value||today(),m:el.magnetInput.checked?1:0,v:getVisitedChoice(),t:Date.now(),x:0,...(coords?{g:coords}:{})};await kvSet(itemKey(profile,next),encodeRecord(item));await kvSet(metaKey(profile),next);el.placeInput.value='';el.magnetInput.checked=true;setVisitedChoice(profile==='Marco'?'M':'A');await syncFromCloud();toast(coords?`${name} aggiunto e messo sulla mappa ✨`:`${name} aggiunto. Cercherò la posizione in background.`);el.placeInput.focus()}catch(err){console.error(err);if(err.message==='DUPLICATE')toast('Questo posto c’è già. Memoria selettiva, eh?');else{setStatus('Errore di sincronizzazione','error');toast('Non sono riuscito a salvarlo. Riprova.')}}finally{el.addBtn.disabled=false}}
async function deletePlace(id){const target=places.find(p=>p.i===id&&!p.x);if(!target)return;if(!confirm(`Togliere “${target.n}” dai vostri luoghi?`))return;try{setStatus('Salvo…');await persistRecord(target,{x:1});await syncFromCloud();toast('Luogo rimosso')}catch(err){console.error(err);setStatus('Errore di sincronizzazione','error');toast('Non sono riuscito a eliminarlo')}}
async function shareApp(){const shareData={title:'I nostri luoghi comuni 🧲',text:'Il nostro atlante condiviso ❤️',url:location.href};try{if(navigator.share)await navigator.share(shareData);else{await navigator.clipboard.writeText(location.href);toast('Link copiato. Ora giralo ad Ale 🫡')}}catch(err){if(err.name!=='AbortError')toast('Non sono riuscito a condividere il link')}}

function setupVoice(){const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){el.voiceBtn.addEventListener('click',()=>toast('Il riconoscimento vocale non è supportato da questo browser'));return}const recognition=new Recognition();recognition.lang='it-IT';recognition.interimResults=false;recognition.maxAlternatives=1;el.voiceBtn.addEventListener('click',()=>{try{recognition.start()}catch{}});recognition.onstart=()=>{el.voiceBtn.classList.add('listening');el.voiceHint.textContent='Ti ascolto… dimmi il nome del posto.'};recognition.onresult=event=>{const text=event.results?.[0]?.[0]?.transcript?.trim();if(text){el.placeInput.value=text.replace(/[.!?]+$/,'');el.voiceHint.textContent='Preso. Controlla e premi Aggiungi.'}};recognition.onerror=()=>{el.voiceHint.textContent='Non ti ho capito. Ritenta senza fare il tenore.'};recognition.onend=()=>el.voiceBtn.classList.remove('listening')}
function wireEvents(){el.addBtn.addEventListener('click',addPlace);el.placeInput.addEventListener('keydown',e=>{if(e.key==='Enter')addPlace()});el.searchInput.addEventListener('input',render);el.refreshBtn.addEventListener('click',()=>syncFromCloud());el.shareBtn.addEventListener('click',shareApp);el.profileBtn.addEventListener('click',()=>el.profileDialog.showModal());el.profileDialog.addEventListener('click',e=>{const btn=e.target.closest('[data-profile]');if(btn)setProfile(btn.dataset.profile)});el.placesList.addEventListener('click',e=>{const btn=e.target.closest('[data-delete]');if(btn)deletePlace(btn.dataset.delete)});el.filterRow.addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(!btn)return;activeFilter=btn.dataset.filter;el.filterRow.querySelectorAll('.filter-chip').forEach(x=>x.classList.toggle('active',x===btn));render()});el.viewSwitch.addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)setView(btn.dataset.view)});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncFromCloud({quiet:true})})}
async function init(){el.dateInput.value=today();wireEvents();setupVoice();askProfileIfNeeded();if(!ROOT){setStatus('Spazio condiviso non configurato','error');return}await syncFromCloud();setInterval(()=>syncFromCloud({quiet:true}),POLL_MS)}
init();
