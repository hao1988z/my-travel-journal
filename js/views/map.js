// ── MAP ──
function initMap(){
  mapInstance=L.map('map',{zoomControl:false}).setView([25,15],2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(mapInstance);
  L.control.zoom({position:'topleft'}).addTo(mapInstance);
  mapMarkerGroup=L.markerClusterGroup({maxClusterRadius:60,showCoverageOnHover:false});
  mapInstance.addLayer(mapMarkerGroup);
  setTimeout(()=>mapInstance.invalidateSize(),100);
}

function updateMapFilterOptions(){
  const years=[...new Set(trips.map(t=>t.date_start?.slice(0,4)).filter(Boolean))].sort((a,b)=>b-a);
  const countries=[...new Set(trips.map(t=>t.country).filter(Boolean))].sort();
  const ySel=document.getElementById('map-filter-year'), cSel=document.getElementById('map-filter-country');
  if(!ySel||!cSel)return;
  const curY=ySel.value, curC=cSel.value;
  ySel.innerHTML='<option value="">所有年份</option>'+years.map(y=>`<option value="${y}"${curY===y?' selected':''}>${y}</option>`).join('');
  cSel.innerHTML='<option value="">所有國家</option>'+countries.map(c=>`<option value="${esc(c)}"${curC===c?' selected':''}>${esc(c)}</option>`).join('');
}

function renderMapMarkers(){
  if(!mapInstance)return;
  mapMarkerGroup.clearLayers(); markers={};
  updateMapFilterOptions();
  const selY=document.getElementById('map-filter-year')?.value||'';
  const selC=document.getElementById('map-filter-country')?.value||'';
  const filtered=trips.filter(t=>{
    if(selY&&!t.date_start?.startsWith(selY))return false;
    if(selC&&t.country!==selC)return false;
    return true;
  });
  const emojis=['🗺️','🌅','🏔️','🌊','🌸','🏯','🗼','🏛️'];
  filtered.forEach(trip=>{
    if(!hasCoordinates(trip.lat,trip.lng))return;
    const em=emojis[Math.abs(trip.name.charCodeAt(0))%emojis.length];
    const icon=L.divIcon({className:'custom-marker',html:`<div class="marker-pin" style="background:#f0d4c4;display:flex;align-items:center;justify-content:center;">${trip.cover_url?`<img src="${esc(trip.cover_url)}" style="width:100%;height:100%;object-fit:cover;transform:rotate(45deg) scale(1.4)">`:`<span style="font-size:20px;transform:rotate(45deg)">${em}</span>`}</div>`,iconSize:[46,46],iconAnchor:[23,46],popupAnchor:[0,-50]});
    const m=L.marker([trip.lat,trip.lng],{icon}).addTo(mapMarkerGroup);
    m.bindPopup(`<div class="mpopup">${trip.cover_url?'<img src="'+esc(trip.cover_url)+'" style="width:100%;height:70px;object-fit:cover;border-radius:3px;margin-bottom:6px">':''}<div class="mpopup-name">${esc(trip.name)}</div><div class="mpopup-meta">${esc(trip.location||'')}${trip.country?'・'+esc(trip.country):''}</div><div class="mpopup-meta">${esc(trip.date_start||'')}</div><button class="mpopup-btn" onclick="openPhotosForTrip('${trip.id}')">查看照片</button></div>`,{maxWidth:170});
    markers[trip.id]=m;
  });
  renderSidebar(); updateStats();
  updateHeatmap();
}

function updateHeatmap(){
  if(!heatLayer||!showHeat)return;
  heatLayer.setLatLngs(trips.filter(t=>hasCoordinates(t.lat,t.lng)).map(t=>[t.lat,t.lng,0.8]));
}

function toggleHeat(){
  showHeat=!showHeat;
  const btn=document.getElementById('heat-toggle-btn');
  if(showHeat){
    if(!mapInstance)return;
    if(!heatLayer&&typeof L.heatLayer!=='undefined'){
      heatLayer=L.heatLayer([],{radius:35,blur:22,maxZoom:12,gradient:{0.4:'#f0d4c4',0.65:'#c4622a',1:'#7a1200'}}).addTo(mapInstance);
    } else if(heatLayer){mapInstance.addLayer(heatLayer);}
    updateHeatmap();
    if(btn){btn.style.background='rgba(196,98,42,.75)';btn.style.color='#fff';}
  } else {
    if(heatLayer&&mapInstance){try{mapInstance.removeLayer(heatLayer);}catch(e){reportClientError('toggleHeat.removeLayer',e);}}
    if(btn){btn.style.background='';btn.style.color='';}
  }
}

function renderSidebar(){
  const emojis=['🗺️','🌅','🏔️','🌊','🌸','🏯','🗼','🏛️'];
  document.getElementById('trip-count').textContent=trips.length+' 個';
  if(trips.length===0){document.getElementById('sidebar-trips').innerHTML=`<div class="empty-rich"><b>還沒有旅程</b>先新增第一趟旅行，地圖就會開始留下你的足跡。<div class="quick-actions"><button class="quick-btn primary" onclick="openUpload()">新增旅程</button></div></div>`;return;}
  document.getElementById('sidebar-trips').innerHTML=trips.map(t=>{
    const em=emojis[Math.abs((t.name||'').charCodeAt(0))%emojis.length];
    return`<div class="sidebar-card" id="sc-${t.id}" onclick="focusTrip('${t.id}')"><div class="s-thumb">${t.cover_url?'<img src="'+esc(t.cover_url)+'">':em}</div><div class="s-info"><div class="s-name">${esc(t.name)}</div><div class="s-meta">${esc(t.location||'')} ${esc(t.country||'')}</div><div class="s-status"><span class="pill ${t.is_shared?'pill-pub':'pill-priv'}">${t.is_shared?'公開':'私人'}</span><span class="pill pill-n">${t.photo_count||0} 張</span></div></div></div>`;
  }).join('');
}

function focusTrip(id){
  const t=trips.find(x=>x.id===id); if(!t||!hasCoordinates(t.lat,t.lng))return;
  document.querySelectorAll('.sidebar-card').forEach(el=>el.classList.remove('sel'));
  document.getElementById('sc-'+id)?.classList.add('sel');
  mapInstance.setView([t.lat,t.lng],7,{animate:true});
  setTimeout(()=>markers[id]?.openPopup(),400);
}

function updateStats(){
  const countries=new Set(trips.map(t=>t.country).filter(Boolean)).size;
  const total=trips.reduce((s,t)=>s+(t.photo_count||0),0);
  const shared=trips.filter(t=>t.is_shared).length;
  ['st-trips','dash-trips'].forEach(id=>document.getElementById(id).textContent=trips.length);
  ['st-countries'].forEach(id=>document.getElementById(id).textContent=countries);
  ['st-photos','dash-photos'].forEach(id=>document.getElementById(id).textContent=total.toLocaleString());
  ['st-shared','dash-shared'].forEach(id=>document.getElementById(id).textContent=shared);
}
