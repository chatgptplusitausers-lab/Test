const $=id=>document.getElementById(id);
const inputValue=$('inputValue'),usageValue=$('usageValue'),exportValue=$('exportValue'),updatedAt=$('updatedAt'),statusText=$('statusText'),refreshBtn=$('refreshBtn'),summaryText=$('summaryText'),demoBadge=$('demoBadge'),errorCard=$('errorCard'),errorText=$('errorText');
const modal=$('settingsModal');
let busy=false;

function fmt(v){return new Intl.NumberFormat('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0)}
function setBusy(v){busy=v;refreshBtn.classList.toggle('spinning',v);refreshBtn.disabled=v}
function getConfig(){try{return JSON.parse(EnergyBridge.getConfig()||'{}')}catch(e){return {demo:true}}}
function putConfig(c){EnergyBridge.saveConfig(JSON.stringify(c))}

function loadSettings(){const c=getConfig();$('demoInput').checked=c.demo!==false;$('solarSiteId').value=c.solarSiteId||'';$('solarApiKey').value=c.solarApiKey||'';$('shellyHost').value=c.shellyHost||'';$('shellyAuthKey').value=c.shellyAuthKey||'';$('shellyDeviceId').value=c.shellyDeviceId||''}
function openSettings(){loadSettings();modal.hidden=false}
function closeSettings(){modal.hidden=true}

$('settingsBtn').addEventListener('click',openSettings);
$('closeSettings').addEventListener('click',closeSettings);
modal.addEventListener('click',e=>{if(e.target===modal)closeSettings()});
$('saveSettings').addEventListener('click',()=>{
  const c={demo:$('demoInput').checked,solarSiteId:$('solarSiteId').value.trim(),solarApiKey:$('solarApiKey').value.trim(),shellyHost:$('shellyHost').value.trim(),shellyAuthKey:$('shellyAuthKey').value.trim(),shellyDeviceId:$('shellyDeviceId').value.trim()};
  putConfig(c);closeSettings();requestData();
});

function requestData(){if(busy)return;setBusy(true);statusText.textContent='AGGIORNO';try{EnergyBridge.requestData()}catch(e){window.onNativeData({ok:false,message:e.message||'Errore'})}}
window.onNativeData=function(data){
  setBusy(false);
  if(!data||!data.ok){statusText.textContent='OFFLINE';updatedAt.textContent='Dati non disponibili';errorText.textContent=(data&&data.message)||'Errore di lettura';errorCard.hidden=false;summaryText.textContent='Impossibile aggiornare i valori.';return}
  inputValue.textContent=fmt(data.inputKw);usageValue.textContent=fmt(data.usageKw);exportValue.textContent=fmt(data.exportKw);demoBadge.hidden=!data.demo;errorCard.hidden=true;statusText.textContent=data.demo?'LIVE • DEMO':'LIVE';
  const ts=new Date(data.timestamp);updatedAt.textContent=`Aggiornato alle ${ts.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  summaryText.textContent=data.exportKw>0.005?`Stai usando ${fmt(data.usageKw)} kW e immettendo ${fmt(data.exportKw)} kW in rete.`:`Stai usando tutta la produzione disponibile.`;
}
refreshBtn.addEventListener('click',requestData);
requestData();
setInterval(requestData,15000);
