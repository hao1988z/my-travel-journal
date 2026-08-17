// ── DRAFT ──
function saveDraft(){
  if(editingTripId)return;
  const draft={name:document.getElementById('f-name').value,loc:document.getElementById('f-loc').value,country:document.getElementById('f-country').value,lat:document.getElementById('f-lat').value,lng:document.getElementById('f-lng').value,ds:document.getElementById('f-ds').value,de:document.getElementById('f-de').value};
  if(!draft.name&&!draft.loc)return;
  try{localStorage.setItem('trip_draft',JSON.stringify(draft));}catch(e){reportClientError('saveTripDraft',e);}
}
function clearDraft(){try{localStorage.removeItem('trip_draft');}catch(e){reportClientError('clearDraft',e);}}
function loadDraft(){try{return JSON.parse(localStorage.getItem('trip_draft')||'null');}catch(e){reportClientError('loadTripDraft',e);return null;}}

// ── GEO LOOKUP ──
function clearGeoStatus(){document.getElementById('geo-status').textContent='';}
async function lookupGeo(){
  const loc=document.getElementById('f-loc').value.trim(), country=document.getElementById('f-country').value.trim();
  const query=[loc,country].filter(Boolean).join(', ');
  if(!query){showToast('請先填寫地點或國家');return;}
  const btn=document.getElementById('geo-btn'); btn.disabled=true;
  document.getElementById('geo-status').textContent='查詢中...';
  try{
    const data=await fetchJsonChecked(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,{headers:{'Accept-Language':'zh-TW,zh,en'}},'地點查詢');
    if(data&&data.length>0){
      document.getElementById('f-lat').value=parseFloat(data[0].lat).toFixed(6);
      document.getElementById('f-lng').value=parseFloat(data[0].lon).toFixed(6);
      document.getElementById('geo-status').textContent='✅ 已找到：'+data[0].display_name.slice(0,60);
    } else { document.getElementById('geo-status').textContent='⚠️ 找不到此地點，請手動輸入或換個搜尋詞'; }
  }catch(e){document.getElementById('geo-status').textContent='⚠️ 查詢失敗，請稍後再試';}
  btn.disabled=false;
}

// ── MAP PICKER ──
let pickerMap=null,pickerMarker=null,pickerLat=null,pickerLng=null,pickerCity='',pickerCountry='';

function openPicker(){
  document.getElementById('picker-modal').classList.add('open');
  pickerCity=''; pickerCountry='';
  document.getElementById('picker-confirm').disabled=true;
  document.getElementById('picker-status').textContent='點擊地圖選取位置，支援拖曳標記';
  if(!pickerMap){
    pickerMap=L.map('picker-map').setView([25,105],3);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(pickerMap);
    pickerMap.on('click',e=>setPickerPoint(e.latlng.lat,e.latlng.lng,true));
  }
  const lat=parseFloat(document.getElementById('f-lat').value);
  const lng=parseFloat(document.getElementById('f-lng').value);
  if(hasCoordinates(lat,lng)){pickerMap.setView([lat,lng],8);setPickerPoint(lat,lng,false);}
  setTimeout(()=>pickerMap.invalidateSize(),150);
}

function closePicker(){document.getElementById('picker-modal').classList.remove('open');}

async function setPickerPoint(lat,lng,doReverse){
  pickerLat=lat; pickerLng=lng;
  if(pickerMarker){pickerMarker.setLatLng([lat,lng]);}
  else{
    pickerMarker=L.marker([lat,lng],{draggable:true}).addTo(pickerMap);
    pickerMarker.on('dragend',e=>{const p=e.target.getLatLng();setPickerPoint(p.lat,p.lng,true);});
  }
  document.getElementById('picker-confirm').disabled=false;
  const st=document.getElementById('picker-status');
  if(!doReverse){st.textContent=`緯度 ${lat.toFixed(5)}，經度 ${lng.toFixed(5)}`;return;}
  st.textContent='查詢地址中...';
  try{
    const d=await fetchJsonChecked(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,{headers:{'Accept-Language':'zh-TW,zh,en'}},'地址查詢');
    if(d?.address){
      pickerCity=d.address.city||d.address.county||d.address.town||d.address.state||'';
      pickerCountry=d.address.country||'';
      st.textContent=`📍 ${(d.display_name||'').slice(0,72)}`;
    }
  }catch(e){st.textContent=`緯度 ${lat.toFixed(5)}，經度 ${lng.toFixed(5)}`;}
}

function confirmPicker(){
  if(pickerLat==null)return;
  document.getElementById('f-lat').value=pickerLat.toFixed(6);
  document.getElementById('f-lng').value=pickerLng.toFixed(6);
  if(pickerCity&&!document.getElementById('f-loc').value.trim())
    document.getElementById('f-loc').value=pickerCity;
  if(pickerCountry&&!document.getElementById('f-country').value.trim())
    document.getElementById('f-country').value=pickerCountry;
  document.getElementById('geo-status').textContent='📍 已從地圖選點帶入座標';
  closePicker();
}
