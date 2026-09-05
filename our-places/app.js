const KV_API = 'https://api.keyval.org';
const ROOT = window.__OUR_PLACES_ROOT__ || '';
const PROFILE_KEY = 'our-places-profile-v3';
const POLL_MS = 30000;

const $ = (id) => document.getElementById(id);
const el = {
  placeInput:$('placeInput'), dateInput:$('dateInput'), magnetInput:$('magnetInput'), addBtn:$('addBtn'),
  voiceBtn:$('voiceBtn'), voiceHint:$('voiceHint'), placesList:$('placesList'), emptyState:$('emptyState'),
  searchInput:$('searchInput'), refreshBtn:$('refreshBtn'), syncStatus:$('syncStatus'), placeCount:$('placeCount'),
  magnetCount:$('magnetCount'), shareBtn:$('shareBtn'), profileBtn:$('profileBtn'), profileDialog:$('profileDialog'),
  toast:$('toast'), filterRow:$('filterRow')
};

let places=[];
let profile=localStorage.getItem(PROFILE_KEY)||'';
let activeFilter='all';
let syncing=false;
let toastTimer;

function today(){const d=new Date();const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)}
function shortId(){return `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`}
function setStatus(text,mode=''){el.syncStatus.textContent=text;el.syncStatus.className=`sync-status ${mode}`.trim()}
function toast(message){clearTimeout(toastTimer);el.toast.textContent=message;el.toast.classList.add('show');toastTimer=setTimeout(()=>el.toast.classList.remove('show'),2300)}
function setVisitedChoice(code){const radio=document.querySelector(`input[name="visitedBy"][value="${code}"]`);if(radio)radio.checked=true}
function getVisitedChoice(){return document.querySelector('input[name="visitedBy"]:checked')?.value||'B'}
function setProfile(name){profile=name;localStorage.setItem(PROFILE_KEY,name);el.profileBtn.textContent=name==='Marco'?'M':'A';el.profileBtn.title=`Stai usando l'app come ${name}`;setVisitedChoice(name==='Marco'?'M':'A')}
function askProfileIfNeeded(){if(!profile)setTimeout(()=>el.profileDialog.showModal(),250);else setProfile(profile)}

function parseWire(raw){const text=String(raw??'').trim();if(!text)return'';try{const data=JSON.parse(text);if(typeof data==='string'||typeof data==='number')return String(data);if(data&&typeof data==='object'){if('val'in data)return String(data.val??'');if('value'in data)return String(data.value??'')}}catch{}return text.replace(/^"|"$/g,'')}
async function kvGet(key){const res=await fetch(`${KV_API}/get/${encodeURIComponent(key)}`,{cache:'no-store'});if(!res.ok)throw new Error(`KeyVal read: ${res.status}`);return parseWire(await res.text())}
async function kvSet(key,val){const value=String(val);if(value.length>295)throw new Error('VALUE_TOO_LARGE');const res=await fetch(`${KV_API}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,{cache:'no-store'});if(!res.ok)throw new Error(`KeyVal write: ${res.status}`);const confirmed=await kvGet(key);if(confirmed!==value)throw new Error('WRITE_NOT_CONFIRMED');return true}

function codeFor(name){return name==='Marco'?'m':'a'}
function metaKey(name){return `${ROOT}-${codeFor(name)}meta`}
function itemKey(name,index){return `${ROOT}-${codeFor(name)}${index}`}
async function loadUser(name){const count=Math.max(0,Math.min(500,Number.parseInt(await kvGet(metaKey(name)),10)||0));if(!count)return[];const values=await Promise.all(Array.from({length:count},(_,i)=>kvGet(itemKey(name,i+1))));const result=[];values.forEach((raw,i)=>{if(!raw)return;try{const p=JSON.parse(raw);if(p&&p.i&&p.n){const fallback=name==='Marco'?'M':'A';result.push({...p,v:p.v||fallback,_owner:name,_index:i+1,_key:itemKey(name,i+1)})}}catch(err){console.warn('Record non leggibile',name,i+1,err)}});return result}
async function loadCloud(){const[marco,ale]=await Promise.all([loadUser('Marco'),loadUser('Ale')]);places=[...marco,...ale];return places}
async function syncFromCloud({quiet=false}={}){if(!ROOT||syncing)return;syncing=true;if(!quiet)setStatus('Aggiorno…');try{await loadCloud();render();setStatus('Sincronizzato','ok')}catch(err){console.error(err);setStatus('Connessione non disponibile','error')}finally{syncing=false}}

function displayDate(iso){if(!iso)return'Data non indicata';const[y,m,d]=iso.split('-').map(Number);return new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short',year:'numeric'}).format(new Date(y,m-1,d))}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]))}
function visiblePlaces(){return places.filter(p=>!p.x)}
function visitedLabel(v){return v==='B'?'Entrambi ❤️':v==='A'?'Solo Ale':'Solo Marco'}
function matchesFilter(p){if(activeFilter==='all')return true;if(activeFilter==='M')return p.v==='M'||p.v==='B';if(activeFilter==='A')return p.v==='A'||p.v==='B';if(activeFilter==='B')return p.v==='B';if(activeFilter==='missing')return !p.m;return true}
function filteredPlaces(){const q=el.searchInput.value.trim().toLocaleLowerCase('it');return visiblePlaces().filter(p=>(!q||p.n.toLocaleLowerCase('it').includes(q))&&matchesFilter(p)).sort((a,b)=>(b.d||'').localeCompare(a.d||'')||(b.t||0)-(a.t||0))}
function render(){const active=visiblePlaces();const filtered=filteredPlaces();el.placeCount.textContent=active.length;el.magnetCount.textContent=active.filter(p=>p.m).length;el.emptyState.hidden=filtered.length!==0;el.placesList.innerHTML=filtered.map(p=>`<article class="place-card" data-id="${escapeHtml(p.i)}"><div class="place-mark">${p.m?'🧲':'📍'}</div><div class="place-copy"><h3>${escapeHtml(p.n)}</h3><div class="place-meta"><span>${displayDate(p.d)}</span><span class="visit-badge">· ${visitedLabel(p.v)}</span><span class="magnet">· ${p.m?'calamita già presa':'calamita da prendere'}</span></div></div><button class="delete-btn" type="button" aria-label="Elimina luogo" data-delete="${escapeHtml(p.i)}">×</button></article>`).join('')}

async function addPlace(){const name=el.placeInput.value.trim();if(!name){el.placeInput.focus();toast('Prima il posto. Poi la gloria.');return}if(!profile){el.profileDialog.showModal();return}if(!ROOT){toast('Lo spazio condiviso non è configurato');return}el.addBtn.disabled=true;setStatus('Salvo…');try{await loadCloud();if(visiblePlaces().some(p=>p.n.trim().toLocaleLowerCase('it')===name.toLocaleLowerCase('it')))throw new Error('DUPLICATE');const count=Math.max(0,Number.parseInt(await kvGet(metaKey(profile)),10)||0);const next=count+1;const item={i:shortId(),n:name.slice(0,80),d:el.dateInput.value||today(),m:el.magnetInput.checked?1:0,v:getVisitedChoice(),t:Date.now(),x:0};await kvSet(itemKey(profile,next),JSON.stringify(item));await kvSet(metaKey(profile),next);el.placeInput.value='';el.magnetInput.checked=true;setVisitedChoice(profile==='Marco'?'M':'A');await syncFromCloud();toast(`${name} aggiunto ✨`);el.placeInput.focus()}catch(err){console.error(err);if(err.message==='DUPLICATE')toast('Questo posto c’è già. Memoria selettiva, eh?');else{setStatus('Errore di sincronizzazione','error');toast('Non sono riuscito a salvarlo. Riprova.')}}finally{el.addBtn.disabled=false}}
async function deletePlace(id){const target=places.find(p=>p.i===id&&!p.x);if(!target)return;if(!confirm(`Togliere “${target.n}” dai vostri luoghi?`))return;try{setStatus('Salvo…');const clean={i:target.i,n:target.n,d:target.d,m:target.m,v:target.v,t:target.t,x:1};await kvSet(target._key,JSON.stringify(clean));await syncFromCloud();toast('Luogo rimosso')}catch(err){console.error(err);setStatus('Errore di sincronizzazione','error');toast('Non sono riuscito a eliminarlo')}}
async function shareApp(){const shareData={title:'I nostri luoghi comuni 🧲',text:'Il nostro atlante condiviso ❤️',url:location.href};try{if(navigator.share)await navigator.share(shareData);else{await navigator.clipboard.writeText(location.href);toast('Link copiato. Ora giralo ad Ale 🫡')}}catch(err){if(err.name!=='AbortError')toast('Non sono riuscito a condividere il link')}}

function setupVoice(){const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){el.voiceBtn.addEventListener('click',()=>toast('Il riconoscimento vocale non è supportato da questo browser'));return}const recognition=new Recognition();recognition.lang='it-IT';recognition.interimResults=false;recognition.maxAlternatives=1;el.voiceBtn.addEventListener('click',()=>{try{recognition.start()}catch{}});recognition.onstart=()=>{el.voiceBtn.classList.add('listening');el.voiceHint.textContent='Ti ascolto… dimmi il nome del posto.'};recognition.onresult=event=>{const text=event.results?.[0]?.[0]?.transcript?.trim();if(text){el.placeInput.value=text.replace(/[.!?]+$/,'');el.voiceHint.textContent='Preso. Controlla e premi Aggiungi.'}};recognition.onerror=()=>{el.voiceHint.textContent='Non ti ho capito. Ritenta senza fare il tenore.'};recognition.onend=()=>el.voiceBtn.classList.remove('listening')}
function wireEvents(){el.addBtn.addEventListener('click',addPlace);el.placeInput.addEventListener('keydown',e=>{if(e.key==='Enter')addPlace()});el.searchInput.addEventListener('input',render);el.refreshBtn.addEventListener('click',()=>syncFromCloud());el.shareBtn.addEventListener('click',shareApp);el.profileBtn.addEventListener('click',()=>el.profileDialog.showModal());el.profileDialog.addEventListener('click',e=>{const btn=e.target.closest('[data-profile]');if(btn)setProfile(btn.dataset.profile)});el.placesList.addEventListener('click',e=>{const btn=e.target.closest('[data-delete]');if(btn)deletePlace(btn.dataset.delete)});el.filterRow.addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(!btn)return;activeFilter=btn.dataset.filter;el.filterRow.querySelectorAll('.filter-chip').forEach(x=>x.classList.toggle('active',x===btn));render()});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncFromCloud({quiet:true})})}
async function init(){el.dateInput.value=today();wireEvents();setupVoice();askProfileIfNeeded();if(!ROOT){setStatus('Spazio condiviso non configurato','error');return}await syncFromCloud();setInterval(()=>syncFromCloud({quiet:true}),POLL_MS)}
init();
