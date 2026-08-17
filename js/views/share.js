// ── PUBLIC SHARE PAGE ──
async function loadSharedTrip(token){
  document.body.classList.add('share-mode');
  const rpcResult=await sb.rpc('get_shared_trip',{token});
  let{data,error}=rpcResult;
  if(error?.code==='PGRST202'){
    // Older projects may not have the public RPC yet; keep the token and share flag in the query.
    const fallback=await sb.from('trips').select('name,location,country,lat,lng,date_start,date_end,photos_meta,cover_path').eq('share_token',token).eq('is_shared',true).maybeSingle();
    data=fallback.data;
    error=fallback.error;
  }else if(error){
    reportClientError('loadSharedTrip.rpc',error);
  }
  if(error||!data){
    document.getElementById('share-title').textContent='分享連結不存在或已關閉';
    if(error){reportClientError('loadSharedTrip',error);}
    document.getElementById('share-meta').textContent='請確認連結是否完整，或請旅程主人重新開啟分享。';
    document.getElementById('share-photo-grid').innerHTML='<div class="share-empty">目前無法讀取這個旅程。</div>';
    return;
  }
  const trip=data;
  const photos=await Promise.all(parsePhotosMeta(trip.photos_meta).map(async p=>({...p,url:await signPhoto(p.path,3600)})));
  const usablePhotos=photos.filter(p=>p.url);
  const cover=usablePhotos[0]?.url||trip.cover_url;
  if(cover)document.getElementById('share-hero').style.setProperty('--share-cover',`url("${cover}")`);
  document.getElementById('share-title').textContent=trip.name||'未命名旅程';
  document.getElementById('share-meta').textContent=[trip.location,trip.country,trip.date_start&&`${trip.date_start}${trip.date_end?' ～ '+trip.date_end:''}`,`${usablePhotos.length} 張照片`].filter(Boolean).join(' · ');
  renderShareMap(trip,cover);
  const grid=document.getElementById('share-photo-grid');
  if(usablePhotos.length===0){grid.innerHTML='<div class="share-empty">這個分享旅程目前還沒有照片。</div>';return;}
  grid.innerHTML=usablePhotos.map(p=>`<div class="share-photo" onclick="downloadPhoto('${esc(p.url)}','${esc((p.path||'photo.jpg').split('/').pop())}')"><img src="${esc(p.url)}" alt="">${p.caption?`<span class="share-caption">${esc(p.caption)}</span>`:''}<span class="share-caption" style="padding:4px 8px 8px;font-size:9px;color:rgba(255,255,255,.7);">點擊下載</span></div>`).join('');
}

async function downloadPhoto(url,filename){
  try{
    showToast('下載中...');
    const a=document.createElement('a');
    a.href=url;
    a.download=filename||'travel-photo.jpg';
    a.target='_blank';
    a.rel='noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }catch(e){reportClientError('downloadPhoto',e);showToast('下載失敗，請稍後再試');}
}

function renderShareMap(trip,cover){
  if(!hasCoordinates(trip.lat,trip.lng)){document.getElementById('share-map').innerHTML='<div class="share-empty">這趟旅程沒有座標資料。</div>';return;}
  shareMapInstance=L.map('share-map',{zoomControl:false}).setView([trip.lat,trip.lng],8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(shareMapInstance);
  L.control.zoom({position:'topleft'}).addTo(shareMapInstance);
  const icon=L.divIcon({className:'custom-marker',html:`<div class="marker-pin" style="background:#f0d4c4;display:flex;align-items:center;justify-content:center;">${cover?`<img src="${esc(cover)}" style="width:100%;height:100%;object-fit:cover;transform:rotate(45deg) scale(1.4)">`: '<span style="font-size:20px;transform:rotate(45deg)">🗺️</span>'}</div>`,iconSize:[46,46],iconAnchor:[23,46],popupAnchor:[0,-50]});
  L.marker([trip.lat,trip.lng],{icon}).addTo(shareMapInstance).bindPopup(`<div class="mpopup"><div class="mpopup-name">${esc(trip.name)}</div><div class="mpopup-meta">${esc(trip.location||'')}${trip.country?'・'+esc(trip.country):''}</div></div>`);
  setTimeout(()=>shareMapInstance.invalidateSize(),100);
}
