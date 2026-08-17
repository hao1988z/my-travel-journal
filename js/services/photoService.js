async function signPhoto(path,exp=3600){
  if(!path)return null;
  const{data,error}=await sb.storage.from('photos').createSignedUrl(path,exp);
  if(error){reportClientError('signPhoto',error);return null;}
  return data?.signedUrl||null;
}
async function removeStoragePhotos(paths,context='removeStoragePhotos'){
  const cleanPaths=[...new Set((paths||[]).filter(Boolean))];
  if(cleanPaths.length===0)return true;
  const{error}=await sb.storage.from('photos').remove(cleanPaths);
  if(error){
    cleanPaths.forEach(path=>console.warn('[ORPHAN PHOTO]',{context,path}));
    reportClientError(context,error);
    return false;
  }
  return true;
}

// ── UPLOAD ──
function openUpload(tripId){
  editingTripId=tripId||null;
  document.getElementById('upload-modal').classList.add('open');
  pendingFiles=[]; pendingCaptions=[]; editingExistingPhotos=[]; photoHashCache.clear();
  document.getElementById('prev-grid').innerHTML='';
  document.getElementById('upload-progress').textContent='';
  document.getElementById('geo-status').textContent='';
  document.querySelector('#upload-modal .modal-head-title').textContent=editingTripId?'編輯旅程':'新增旅程';
  document.getElementById('save-btn').textContent=editingTripId?'更新旅程':'儲存旅程';
  const t=trips.find(x=>x.id===editingTripId);
  if(t){
    document.getElementById('f-name').value=t.name||'';
    document.getElementById('f-loc').value=t.location||'';
    document.getElementById('f-country').value=t.country||'';
    document.getElementById('f-lat').value=t.lat||'';
    document.getElementById('f-lng').value=t.lng||'';
    document.getElementById('f-ds').value=t.date_start||'';
    document.getElementById('f-de').value=t.date_end||'';
    try{const exp=t.expenses?(typeof t.expenses==='string'?JSON.parse(t.expenses):t.expenses):{};const original=exp.original||{};document.getElementById('f-exp-transport').value=original.transport??exp.transport??'';document.getElementById('f-exp-hotel').value=original.hotel??exp.hotel??'';document.getElementById('f-exp-food').value=original.food??exp.food??'';document.getElementById('f-exp-other').value=original.other??exp.other??'';if(exp.orig_currency&&document.getElementById('f-exp-currency'))document.getElementById('f-exp-currency').value=exp.orig_currency;updateExchangeRate();}catch(e){reportClientError('loadTripExpenses',e);}
    editingExistingPhotos=parsePhotosMeta(t.photos_meta);
    loadExistingPhotos(editingTripId);
  } else {
    document.getElementById('existing-photos-row').style.display='none';
    ['f-exp-transport','f-exp-hotel','f-exp-food','f-exp-other'].forEach(id=>document.getElementById(id).value='');
    const draft=loadDraft();
    document.getElementById('f-name').value=draft?.name||'';
    document.getElementById('f-loc').value=draft?.loc||'';
    document.getElementById('f-country').value=draft?.country||'';
    document.getElementById('f-lat').value=draft?.lat||'';
    document.getElementById('f-lng').value=draft?.lng||'';
    document.getElementById('f-ds').value=draft?.ds||'';
    document.getElementById('f-de').value=draft?.de||'';
    if(draft?.name)showToast('已還原未完成的草稿');
  }
  document.getElementById('file-input').value='';
  ['f-name','f-loc','f-country','f-lat','f-lng','f-ds','f-de'].forEach(id=>document.getElementById(id).addEventListener('input',saveDraft));
}
function closeUpload(){document.getElementById('upload-modal').classList.remove('open');editingTripId=null;}

async function loadExistingPhotos(tripId){
  const t=trips.find(x=>x.id===tripId); if(!t)return;
  const photos=parsePhotosMeta(t.photos_meta);
  if(photos.length===0){document.getElementById('existing-photos-row').style.display='none';return;}
  editingExistingPhotos=[...photos];
  document.getElementById('existing-photos-row').style.display='block';
  document.getElementById('existing-count').textContent=`（${photos.length} 張）`;
  const grid=document.getElementById('existing-photos-grid');
  const withUrls=await Promise.all(photos.map(async(p,i)=>({...p,url:await signPhoto(p.path,1800),idx:i})));
  grid.innerHTML=withUrls.map((p,i)=>`<div class="prev-thumb existing-thumb" id="ep-${i}"><img src="${esc(p.url)}" alt=""><div style="position:absolute;top:2px;right:2px;"><button style="background:rgba(0,0,0,.65);color:#fff;border:none;border-radius:2px;width:18px;height:18px;font-size:11px;cursor:pointer;" onclick="removeExistingPhoto(${i})">×</button></div></div>`).join('');
}

async function removeExistingPhoto(idx){
  if(!confirm('確定從這趟旅程移除這張照片？'))return;
  const p=editingExistingPhotos[idx];
  const t=trips.find(x=>x.id===editingTripId);
  if(!p||!t)return;
  const nextPhotos=normalizePhotoMeta(editingExistingPhotos).filter((_,i)=>i!==idx);
  const nextCoverPath=t.cover_path===p.path?(nextPhotos[0]?.path||null):t.cover_path||null;
  const{error}=await sb.from('trips').update({
    photos_meta:nextPhotos.length?JSON.stringify(nextPhotos):null,
    photo_count:nextPhotos.length,
    cover_path:nextCoverPath
  }).eq('id',editingTripId);
  if(error){reportClientError('removeExistingPhoto.updateTrip',error);showToast('照片資料更新失敗，未刪除照片');return;}
  editingExistingPhotos=nextPhotos;
  t.photos_meta=nextPhotos.length?JSON.stringify(nextPhotos):null;
  t.photo_count=nextPhotos.length;
  t.cover_path=nextCoverPath;
  t._coverHydrated=false;
  const storageRemoved=await removeStoragePhotos([p.path],'removeExistingPhoto.removeStorage');
  await loadExistingPhotos(editingTripId);
  showToast(storageRemoved?'照片已移除':'照片資料已移除，但 Storage 檔案清理失敗');
}

function compressImage(file,maxWidth=1600,quality=0.82){
  return new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        const scale=Math.min(1,maxWidth/Math.max(img.width,img.height));
        const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
        const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        canvas.toBlob(blob=>resolve(new File([blob],file.name,{type:'image/jpeg'})),'image/jpeg',quality);
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── PHOTO HASH DEDUP ──
const photoHashCache=new Set();
async function fileHash(file){
  const buf=await file.arrayBuffer();
  const h=await crypto.subtle.digest('SHA-256',buf);
  return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function handleFiles(files){
  const all=Array.from(files);
  const deduped=[...pendingFiles];
  const nextCaptions=[...pendingCaptions];
  let dups=0;
  for(const f of all){
    const h=await fileHash(f);
    if(photoHashCache.has(h)){dups++;continue;}
    photoHashCache.add(h); deduped.push(f);
    nextCaptions.push('');
  }
  if(dups>0)showToast(`已跳過 ${dups} 張重複照片`);
  pendingFiles=deduped;
  pendingCaptions=nextCaptions;
  const grid=document.getElementById('prev-grid'); grid.innerHTML='';
  pendingFiles.slice(0,8).forEach((file,i)=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const div=document.createElement('div'); div.className='prev-thumb';
      div.innerHTML=`<img src="${e.target.result}" alt="" loading="lazy"><div class="prev-thumb-caption"><input type="text" placeholder="說明文字" value="${esc(pendingCaptions[i]||'')}" oninput="pendingCaptions[${i}]=this.value"></div>`;
      grid.appendChild(div);
    };
    reader.readAsDataURL(file);
    readExif(file).then(exif => {
      if (!exif) return;
      if (i === 0 && hasCoordinates(exif.lat,exif.lng) && !document.getElementById('f-lat').value) {
        document.getElementById('f-lat').value = exif.lat.toFixed(6);
        document.getElementById('f-lng').value = exif.lng.toFixed(6);
        document.getElementById('geo-status').textContent = `📍 已從照片 EXIF 讀取 GPS 座標`;
      }
    });
  });
  if(pendingFiles.length>8){const more=document.createElement('div');more.className='prev-thumb';more.style.cssText='display:flex;align-items:center;justify-content:center;font-family:DM Mono,monospace;font-size:11px;color:var(--ink-muted);background:var(--sand-dark)';more.textContent='+'+(pendingFiles.length-8);grid.appendChild(more);}
}

const dz=document.getElementById('drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');handleFiles(e.dataTransfer.files);});

async function saveTrip(){
  if(!currentUser)return;
  const wasEditing=Boolean(editingTripId);
  const name=document.getElementById('f-name').value.trim();
  if(!name){showToast('請填寫旅程名稱');return;}
  const btn=document.getElementById('save-btn'); btn.disabled=true; btn.textContent='儲存中...';
  const oldPhotos=editingTripId?normalizePhotoMeta(editingExistingPhotos):[];
  let coverPath=trips.find(t=>t.id===editingTripId)?.cover_path||null;
  let uploadedPaths=[];
  let committed=false;
  const wrap=document.getElementById('upload-prog-wrap'), bar=document.getElementById('upload-prog-bar'), txt=document.getElementById('upload-progress');
  try{
    if(pendingFiles.length>0){
      wrap.classList.add('show');
      for(let i=0;i<pendingFiles.length;i++){
        const file=pendingFiles[i];
        const compressed=(file.type==='image/jpeg'||file.type==='image/png')?await compressImage(file):file;
        const path=`${currentUser.id}/${Date.now()}_${i}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        txt.textContent=`上傳中 ${i+1} / ${pendingFiles.length}：${file.name.slice(0,20)}`;
        bar.style.width=`${Math.round((i/pendingFiles.length)*100)}%`;
        uploadedPaths.push({path,caption:pendingCaptions[i]||''});
        const{error}=await sb.storage.from('photos').upload(path,compressed,{cacheControl:'3600',upsert:false});
        if(error)throw new Error(`照片上傳失敗：${error.message}`);
        if(i===0&&!editingTripId)coverPath=path;
      }
      bar.style.width='100%'; txt.textContent=`✅ ${pendingFiles.length} 張照片上傳完成`;
      setTimeout(()=>{wrap.classList.remove('show');bar.style.width='0%';txt.textContent='';},1500);
    }
    const mergedPhotos=[...oldPhotos,...uploadedPaths];
    if(!coverPath&&mergedPhotos.length>0)coverPath=mergedPhotos[0].path;
    const tripData={
      name, location:document.getElementById('f-loc').value.trim()||null,
      country:document.getElementById('f-country').value.trim()||null,
      lat:Number.isFinite(parseFloat(document.getElementById('f-lat').value))?parseFloat(document.getElementById('f-lat').value):null,
      lng:Number.isFinite(parseFloat(document.getElementById('f-lng').value))?parseFloat(document.getElementById('f-lng').value):null,
      date_start:document.getElementById('f-ds').value||null,
      date_end:document.getElementById('f-de').value||null,
      photo_count:mergedPhotos.length, cover_path:coverPath,
      photos_meta:mergedPhotos.length>0?JSON.stringify(mergedPhotos):null,
      expenses:JSON.stringify(getExpensesInTWD())
    };
    if(!editingTripId)tripData.user_id=currentUser.id;
    const result=editingTripId?await sb.from('trips').update(tripData).eq('id',editingTripId):await sb.from('trips').insert([tripData]).select().single();
    if(result.error)throw new Error(`旅程儲存失敗：${result.error.message}`);
    committed=true;
    btn.disabled=false; btn.textContent=wasEditing?'更新旅程':'儲存旅程';
    closeUpload(); clearDraft(); showToast(wasEditing?'旅程已更新！':'旅程已儲存！'); await loadTrips();
  }catch(error){
    reportClientError('saveTrip',error);
    if(!committed)await removeStoragePhotos(uploadedPaths.map(p=>p.path),'saveTrip.rollback');
    wrap.classList.remove('show'); bar.style.width='0%'; txt.textContent='';
    btn.disabled=false; btn.textContent=wasEditing?'更新旅程':'儲存旅程';
    showToast(error.message||`旅程儲存失敗${committed?'，但資料已保存':'，已清理本次上傳檔案'}`);
  }
}

// ── LIGHTBOX ──
async function openPhotosForTrip(tripId){
  const t=trips.find(x=>x.id===tripId); if(!t)return;
  document.getElementById('lb-trip-name').textContent=t.name; lbTripId=tripId;
  let photos=parsePhotosMeta(t.photos_meta);
  if(photos.length===0&&t.photo_count>0){showToast('此旅程的照片索引遺失，請重新編輯旅程以恢復照片。');return;}
  if(photos.length===0){showToast('這趟旅程還沒有照片');return;}
  const withUrls=await Promise.all(photos.map(async p=>{const{data,error}=await sb.storage.from('photos').createSignedUrl(p.path,3600);if(error)reportClientError('openPhotosForTrip.signUrl',error);return{...p,url:data?.signedUrl||''};}));
  lbPhotos=withUrls.filter(p=>p.url); lbIdx=0;
  renderLightbox(); document.getElementById('lightbox').classList.add('open');
  // 非同步讀取所有照片的 EXIF（用 signed URL fetch）
  lbPhotos.forEach(async (p, i) => {
    try {
      const res = await fetch(p.url);
      if(!res.ok)throw new Error(`照片讀取失敗：${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], p.path?.split('/').pop()||'photo.jpg', {type: blob.type});
      p.exif = await readExif(file);
      if (i === lbIdx) renderLbExif(p.exif);
    } catch(e) { reportClientError('openPhotosForTrip.exif',e); }
  });
}

function renderLightbox(){
  if(lbPhotos.length===0)return;
  const p=lbPhotos[lbIdx];
  document.getElementById('lb-img').src=p.url;
  document.getElementById('lb-caption').value=p.caption||'';
  document.getElementById('lb-counter').textContent=`${lbIdx+1} / ${lbPhotos.length}`;
  const dl=document.getElementById('lb-download'); dl.href=p.url; dl.download=(p.path||'travel-photo.jpg').split('/').pop();
  // 顯示 EXIF（若已快取）
  renderLbExif(p.exif || null);
  const strip=document.getElementById('lb-thumbstrip');
  if(strip.children.length!==lbPhotos.length){
    strip.innerHTML=lbPhotos.map((ph,i)=>`<img class="lb-thumb${i===lbIdx?' active':''}" src="${ph.url}" onclick="lbGoTo(${i})">`).join('');
  } else { strip.querySelectorAll('.lb-thumb').forEach((el,i)=>el.classList.toggle('active',i===lbIdx)); }
  const activeThumb=strip.querySelectorAll('.lb-thumb')[lbIdx];
  if(activeThumb)activeThumb.scrollIntoView({inline:'center',behavior:'smooth'});
}

function lbNav(dir){
  lbIdx=(lbIdx+dir+lbPhotos.length)%lbPhotos.length;
  const img=document.getElementById('lb-img');
  img.style.opacity='0';
  setTimeout(()=>{renderLightbox();img.style.opacity='';},150);
}
function lbGoTo(i){
  lbIdx=i;
  const img=document.getElementById('lb-img');
  img.style.opacity='0';
  setTimeout(()=>{renderLightbox();img.style.opacity='';},150);
}
function closeLightbox(){document.getElementById('lightbox').classList.remove('open');}

async function saveCaption(){
  if(!currentUser||lbPhotos.length===0)return;
  const nextCaption=document.getElementById('lb-caption').value;
  const previousCaption=lbPhotos[lbIdx].caption||'';
  lbPhotos[lbIdx].caption=nextCaption;
  const t=trips.find(x=>x.id===lbTripId); if(!t)return;
  const meta=lbPhotos.map(p=>({path:p.path,caption:p.caption}));
  const{error}=await sb.from('trips').update({photos_meta:JSON.stringify(meta)}).eq('id',lbTripId);
  if(error){lbPhotos[lbIdx].caption=previousCaption;reportClientError('saveCaption',error);showToast('說明文字儲存失敗');return;}
  t.photos_meta=JSON.stringify(meta);showToast('說明文字已儲存');
}

async function lbDeletePhoto(){
  if(!currentUser||lbPhotos.length===0)return;
  if(!confirm('確定刪除這張照片？此操作無法還原。'))return;
  const p=lbPhotos[lbIdx];
  const t=trips.find(x=>x.id===lbTripId); if(!p||!t)return;
  const nextPhotos=lbPhotos.filter((_,i)=>i!==lbIdx).map(photo=>({path:photo.path,caption:photo.caption||''}));
  const nextCoverPath=t.cover_path===p.path?(nextPhotos[0]?.path||null):t.cover_path||null;
  const{error}=await sb.from('trips').update({
    photos_meta:nextPhotos.length?JSON.stringify(nextPhotos):null,
    photo_count:nextPhotos.length,
    cover_path:nextCoverPath
  }).eq('id',lbTripId);
  if(error){reportClientError('lbDeletePhoto.updateTrip',error);showToast('照片資料更新失敗，未刪除照片');return;}
  lbPhotos.splice(lbIdx,1);
  t.photos_meta=nextPhotos.length?JSON.stringify(nextPhotos):null;
  t.photo_count=nextPhotos.length;
  t.cover_path=nextCoverPath;
  t._coverHydrated=false;
  const storageRemoved=await removeStoragePhotos([p.path],'lbDeletePhoto.removeStorage');
  if(lbPhotos.length===0){closeLightbox();}else{lbIdx=Math.min(lbIdx,lbPhotos.length-1);document.getElementById('lb-thumbstrip').innerHTML='';renderLightbox();}
  showToast(storageRemoved?'照片已刪除':'照片資料已刪除，但 Storage 檔案清理失敗');
}

async function lbMovePhoto(dir){
  if(lbPhotos.length<2)return;
  const newIdx=lbIdx+dir;
  if(newIdx<0||newIdx>=lbPhotos.length)return;
  const previousPhotos=lbPhotos.slice();
  [lbPhotos[lbIdx],lbPhotos[newIdx]]=[lbPhotos[newIdx],lbPhotos[lbIdx]];
  lbIdx=newIdx; document.getElementById('lb-thumbstrip').innerHTML='';
  renderLightbox();
  if(await saveLbMeta())showToast(dir<0?'已前移':'已後移');
  else{lbPhotos=previousPhotos;lbIdx=Math.max(0,Math.min(lbIdx,lbPhotos.length-1));document.getElementById('lb-thumbstrip').innerHTML='';renderLightbox();showToast('照片排序儲存失敗');}
}

async function saveLbMeta(){
  const t=trips.find(x=>x.id===lbTripId); if(!t)return;
  const meta=lbPhotos.map(p=>({path:p.path,caption:p.caption||''}));
  const{error}=await sb.from('trips').update({photos_meta:JSON.stringify(meta),photo_count:meta.length}).eq('id',lbTripId);
  if(error){reportClientError('saveLbMeta',error);return false;}
  t.photos_meta=JSON.stringify(meta); t.photo_count=meta.length; t._coverHydrated=false;
  return true;
}

document.addEventListener('keydown',e=>{
  if(!document.getElementById('lightbox').classList.contains('open'))return;
  if(e.key==='ArrowLeft')lbNav(-1);
  if(e.key==='ArrowRight')lbNav(1);
  if(e.key==='Escape')closeLightbox();
});

// ── LIGHTBOX TOUCH SWIPE ──
let lbTouchX=null,lbTouchY=null;
const lbEl=document.getElementById('lightbox');
lbEl.addEventListener('touchstart',e=>{lbTouchX=e.touches[0].clientX;lbTouchY=e.touches[0].clientY;},{passive:true});
lbEl.addEventListener('touchend',e=>{
  if(lbTouchX===null)return;
  const dx=e.changedTouches[0].clientX-lbTouchX,dy=e.changedTouches[0].clientY-lbTouchY;
  lbTouchX=null;lbTouchY=null;
  if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>50)lbNav(dx<0?1:-1);
},{passive:true});
