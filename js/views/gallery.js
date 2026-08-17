// ── GALLERY ──
function updateFilterOptions(){
  const years=[...new Set(trips.map(t=>t.date_start?.slice(0,4)).filter(Boolean))].sort((a,b)=>b-a);
  const countries=[...new Set(trips.map(t=>t.country).filter(Boolean))].sort();
  const ySel=document.getElementById('filter-year'), cSel=document.getElementById('filter-country');
  if(!ySel||!cSel)return;
  const curY=ySel.value, curC=cSel.value;
  ySel.innerHTML='<option value="">所有年份</option>'+years.map(y=>`<option value="${y}"${curY===y?' selected':''}>${y}</option>`).join('');
  cSel.innerHTML='<option value="">所有國家</option>'+countries.map(c=>`<option value="${esc(c)}"${curC===c?' selected':''}>${esc(c)}</option>`).join('');
}

function renderTodayHistory(){
  const el=document.getElementById('today-history'); if(!el)return;
  const today=new Date();
  const mm=String(today.getMonth()+1).padStart(2,'0'), dd=String(today.getDate()).padStart(2,'0');
  const todayMMDD=mm+'-'+dd, isLeapDay=todayMMDD==='02-29';
  const matches=trips.filter(t=>{
    if(!t.date_start)return false;
    const tripMMDD=t.date_start.slice(5), tripYear=t.date_start.slice(0,4);
    if(tripYear===String(today.getFullYear()))return false;
    if(tripMMDD===todayMMDD)return true;
    if(isLeapDay&&tripMMDD==='02-28')return true;
    return false;
  });
  if(matches.length===0){el.innerHTML='';return;}
  const emojis=['🗺️','🌅','🏔️','🌊','🌸','🏯','🗼','🏛️'];
  el.innerHTML=matches.map(t=>{
    const em=emojis[Math.abs((t.name||'').charCodeAt(0))%emojis.length];
    const yearsAgo=today.getFullYear()-parseInt(t.date_start.slice(0,4));
    return`<div class="today-card" onclick="openPhotosForTrip('${t.id}')"><div class="today-icon">${t.cover_url?`<img src="${esc(t.cover_url)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;">`:em}</div><div><div class="today-label">📅 ${yearsAgo} 年前的今天</div><div class="today-name">${esc(t.name)}</div><div class="today-meta">📍 ${esc(t.location||'')}${t.country?' · '+esc(t.country):''}</div></div></div>`;
  }).join('');
}

function renderGallery(filter){
  updateFilterOptions();
  const selY=document.getElementById('filter-year')?.value||'', selC=document.getElementById('filter-country')?.value||'';
  let base=filter==='all'?trips:trips.filter(t=>filter==='shared'?t.is_shared:!t.is_shared);
  if(selY) base=base.filter(t=>t.date_start?.startsWith(selY));
  if(selC) base=base.filter(t=>t.country===selC);
  const q=galleryQuery.trim().toLowerCase();
  const filtered=q?base.filter(t=>[t.name,t.location,t.country,t.date_start,t.date_end].join(' ').toLowerCase().includes(q)):base;
  const emojis=['🗺️','🌅','🏔️','🌊','🌸','🏯','🗼','🏛️'];
  document.getElementById('gal-sub').textContent=filtered.length+' 個旅程・'+filtered.reduce((s,t)=>s+(t.photo_count||0),0).toLocaleString()+' 張照片';
  renderTodayHistory();
  if(filtered.length===0){
    document.getElementById('trips-grid').innerHTML=`<div class="empty-rich" style="grid-column:1/-1;"><b>${trips.length===0?'相簿還是空的':'找不到符合的旅程'}</b>${trips.length===0?'新增旅程後，照片、日期、地點和分享狀態會集中在這裡。':'換個關鍵字，或切回「全部」看看。'}<div class="quick-actions"><button class="quick-btn primary" onclick="openUpload()">新增旅程</button><button class="quick-btn" onclick="galleryQuery='';document.getElementById('gallery-search').value='';document.getElementById('filter-year').value='';document.getElementById('filter-country').value='';filterGallery('all',document.querySelector('.fbtn'))">查看全部</button></div></div>`;
    return;
  }
  document.getElementById('trips-grid').innerHTML=filtered.map(t=>{
    const em=emojis[Math.abs((t.name||'').charCodeAt(0))%emojis.length];
    return`<div class="trip-card"><div class="tc-cover${t.cover_url?' sk':''}">` + (t.cover_url?`<img src="${esc(t.cover_url)}" alt="" onload="this.parentElement.classList.remove('sk')">`:`<span>${em}</span>`) + `<span class="tc-count">${t.photo_count||0} 張</span><button class="tc-sharebtn ${t.is_shared?'on':''}" onclick="toggleShare(event,'${t.id}')"><span class="s-dot"></span>${t.is_shared?'分享中':'私人'}</button></div><div class="tc-body"><div class="tc-name">${esc(t.name)}</div><div class="tc-loc">📍 ${esc(t.location||'')} ${t.country?'・'+esc(t.country):''}</div><div class="tc-date">📅 ${esc(t.date_start||'—')} ～ ${esc(t.date_end||'—')}</div><div class="tc-actions"><button class="act-btn" onclick="viewOnMap('${t.id}')">地圖</button><button class="act-btn" onclick="openUpload('${t.id}')">編輯</button>${t.is_shared?`<button class="act-btn" onclick="openShareModal('${t.id}')">複製連結</button>`:''}<button class="act-btn danger" onclick="deleteTrip(event,'${t.id}')">刪除</button><button class="act-btn primary" onclick="openPhotosForTrip('${t.id}')">查看照片</button></div></div></div>`;
  }).join('');
}

function filterGallery(f,btn){
  currentFilter=f;
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  try{sessionStorage.setItem('gal_filter',f);}catch(e){reportClientError('saveGalleryFilter',e);}
  renderGallery(f);
}

function restoreFilterState(){
  try{
    const f=sessionStorage.getItem('gal_filter')||'all';
    currentFilter=f;
    const btn=document.querySelector(`.fbtn[onclick*="'${f}'"]`);
    if(btn){document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');}
    const y=sessionStorage.getItem('gal_year')||'', c=sessionStorage.getItem('gal_country')||'';
    if(document.getElementById('filter-year'))document.getElementById('filter-year').value=y;
    if(document.getElementById('filter-country'))document.getElementById('filter-country').value=c;
  }catch(e){reportClientError('restoreFilterState',e);}
}

async function toggleShare(e,id){
  e.stopPropagation();
  const t=trips.find(x=>x.id===id); if(!t)return;
  const newVal=!t.is_shared;
  const{error}=await sb.from('trips').update({is_shared:newVal}).eq('id',id);
  if(error){reportClientError('toggleShare',error);showToast('分享狀態更新失敗：'+error.message);return;}
  t.is_shared=newVal; renderGallery(currentFilter); renderSidebar(); updateStats();
  if(newVal)openShareModal(id); else showToast('已關閉分享');
}

function openShareModal(id){
  const t=trips.find(x=>x.id===id); if(!t)return;
  document.getElementById('share-link-val').value=window.location.origin+window.location.pathname+'?share='+t.share_token;
  document.getElementById('share-modal').classList.add('open');
}
function closeShare(){document.getElementById('share-modal').classList.remove('open');}
function copyShareLink(){navigator.clipboard.writeText(document.getElementById('share-link-val').value).catch(()=>{});showToast('連結已複製！');}
function viewOnMap(id){showView('map');setTimeout(()=>focusTrip(id),100);}

async function deleteTrip(e,id){
  e?.stopPropagation?.();
  const t=trips.find(x=>x.id===id); if(!t)return;
  if(!confirm(`確定要刪除「${t.name}」嗎？Storage 中的照片也會一併刪除。`))return;
  const photos=parsePhotosMeta(t.photos_meta);
  const{error}=await sb.from('trips').delete().eq('id',id);
  if(error){reportClientError('deleteTrip.deleteTrip',error);showToast('旅程刪除失敗：'+error.message);return;}
  const storageRemoved=await removeStoragePhotos(photos.map(p=>p.path),'deleteTrip.removeStorage');
  showToast(storageRemoved?'旅程已刪除':'旅程已刪除，但部分照片檔案清理失敗');
  await loadTrips();
}
