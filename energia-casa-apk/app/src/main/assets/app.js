const $=id=>document.getElementById(id);
const inputValue=$('inputValue'),usageValue=$('usageValue'),exportValue=$('exportValue'),updatedAt=$('updatedAt'),statusText=$('statusText'),refreshBtn=$('refreshBtn'),summaryText=$('summaryText'),demoBadge=$('demoBadge'),errorCard=$('errorCard'),errorText=$('errorText'),errorTitle=$('errorTitle');
const inputSourceLabel=$('inputSourceLabel'),usageSourceLabel=$('usageSourceLabel'),exportSourceLabel=$('exportSourceLabel');
const modal=$('settingsModal');
let busy=false;

function fmt(v){return new Intl.NumberFormat('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0)}
function setBusy(v){busy=v;refreshBtn.classList.toggle('spinning',v);refreshBtn.disabled=v}
function getConfig(){try{return JSON.parse(EnergyBridge.getConfig()||'{}')}catch(e){return {solarDemo:true,shellyDemo:true}}}
function putConfig(c){EnergyBridge.saveConfig(JSON.stringify(c))}
function modeLabel(isDemo){return isDemo?'DEMO':'LIVE'}

function loadSettings(){
  const c=getConfig();
  $('solarDemoInput').checked=c.solarDemo!==false;
  $('shellyDemoInput').checked=c.shellyDemo!==false;
  $('solarSiteId').value=c.solarSiteId||'';
  $('solarApiKey').value=c.solarApiKey||'';
  $('shellyHost').value=c.shellyHost||'';
  $('shellyAuthKey').value=c.shellyAuthKey||'';
  $('shellyDeviceId').value=c.shellyDeviceId||'';
}
function openSettings(){loadSettings();modal.hidden=false}
function closeSettings(){modal.hidden=true}

$('settingsBtn').addEventListener('click',openSettings);
$('closeSettings').addEventListener('click',closeSettings);
modal.addEventListener('click',e=>{if(e.target===modal)closeSettings()});
$('saveSettings').addEventListener('click',()=>{
  const c={
    solarDemo:$('solarDemoInput').checked,
    shellyDemo:$('shellyDemoInput').checked,
    solarSiteId:$('solarSiteId').value.trim(),
    solarApiKey:$('solarApiKey').value.trim(),
    shellyHost:$('shellyHost').value.trim(),
    shellyAuthKey:$('shellyAuthKey').value.trim(),
    shellyDeviceId:$('shellyDeviceId').value.trim()
  };
  putConfig(c);closeSettings();requestData();
});

function requestData(){
  if(busy)return;
  setBusy(true);
  statusText.textContent='AGGIORNO';
  try{EnergyBridge.requestData()}catch(e){window.onNativeData({ok:false,message:e.message||'Errore'})}
}

window.onNativeData=function(data){
  setBusy(false);

  if(!data||!data.ok){
    statusText.textContent='OFFLINE';
    updatedAt.textContent='Dati non disponibili';
    inputValue.textContent='--';usageValue.textContent='--';exportValue.textContent='--';
    inputSourceLabel.textContent='SolarEdge non disponibile';
    usageSourceLabel.textContent='Shelly non disponibile';
    exportSourceLabel.textContent='Richiede produzione + consumo';
    demoBadge.hidden=true;
    errorTitle.textContent='Connessione non riuscita';
    errorText.textContent=(data&&data.message)||'Errore di lettura';
    errorCard.hidden=false;
    summaryText.textContent='Nessuna fonte dati disponibile.';
    return;
  }

  const solarOk=data.solarOk===true;
  const shellyOk=data.shellyOk===true;
  const solarDemo=data.solarDemo===true;
  const shellyDemo=data.shellyDemo===true;

  inputValue.textContent=solarOk?fmt(data.inputKw):'--';
  usageValue.textContent=shellyOk?fmt(data.usageKw):'--';
  exportValue.textContent=(solarOk&&shellyOk&&data.exportKw!=null)?fmt(data.exportKw):'--';

  inputSourceLabel.textContent=solarOk?`Produzione fotovoltaico • ${modeLabel(solarDemo)}`:'SolarEdge non disponibile';
  usageSourceLabel.textContent=shellyOk?`Consumo casa • ${modeLabel(shellyDemo)}`:'Shelly non disponibile';
  exportSourceLabel.textContent=(solarOk&&shellyOk)?((solarDemo||shellyDemo)?'Calcolo da fonti demo/miste':'Immissione in rete'):'Richiede produzione + consumo';

  const demoParts=[];
  if(solarDemo)demoParts.push('SOLAR DEMO');
  if(shellyDemo)demoParts.push('SHELLY DEMO');
  if(demoParts.length){demoBadge.textContent=demoParts.join(' • ');demoBadge.hidden=false}else{demoBadge.hidden=true}

  if(solarOk&&shellyOk){
    statusText.textContent=(solarDemo||shellyDemo)?((solarDemo&&shellyDemo)?'LIVE • DEMO':'LIVE • MIX'):'LIVE';
  }else{
    statusText.textContent='PARZIALE';
  }

  const ts=new Date(data.timestamp);
  updatedAt.textContent=`Aggiornato alle ${ts.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;

  if(solarOk&&shellyOk){
    summaryText.textContent=data.exportKw>0.005
      ?`Stai usando ${fmt(data.usageKw)} kW e immettendo ${fmt(data.exportKw)} kW in rete.`
      :`Stai usando ${fmt(data.usageKw)} kW; la produzione disponibile non supera il consumo.`;
  }else if(shellyOk){
    summaryText.textContent=`Consumo Shelly: ${fmt(data.usageKw)} kW. SolarEdge non è ancora disponibile.`;
  }else if(solarOk){
    summaryText.textContent=`Produzione SolarEdge: ${fmt(data.inputKw)} kW. Shelly non è disponibile.`;
  }

  const errors=[];
  if(!solarOk&&data.solarError)errors.push(data.solarError);
  if(!shellyOk&&data.shellyError)errors.push(data.shellyError);
  if(errors.length){
    errorTitle.textContent='Una fonte non è disponibile';
    errorText.textContent=errors.join(' • ');
    errorCard.hidden=false;
  }else{
    errorCard.hidden=true;
  }
}

refreshBtn.addEventListener('click',requestData);
requestData();
setInterval(requestData,15000);
