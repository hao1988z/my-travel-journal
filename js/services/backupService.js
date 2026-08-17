// ── EXPORT / IMPORT BACKUP ──
function validateBackup(data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('備份內容不是有效物件');
  if(data.version!=='2.0')throw new Error(`不支援的備份版本：${data.version||'未提供'}`);
  if(!Array.isArray(data.trips)||!Array.isArray(data.diaries))throw new Error('備份缺少有效的旅程或日記陣列');
  for(const trip of data.trips){
    if(!trip||typeof trip!=='object'||typeof trip.name!=='string'||!trip.name.trim())throw new Error('旅程資料格式錯誤：缺少名稱');
    if(!isOptionalCoordinate(trip.lat))throw new Error(`旅程「${trip.name}」的緯度格式錯誤`);
    if(!isOptionalCoordinate(trip.lng))throw new Error(`旅程「${trip.name}」的經度格式錯誤`);
    if(trip.photos_meta!==null&&trip.photos_meta!==undefined){
      const parsed=typeof trip.photos_meta==='string'?JSON.parse(trip.photos_meta):trip.photos_meta;
      if(!Array.isArray(parsed)||parsed.some(photo=>!photo||typeof photo!=='object'||typeof photo.path!=='string'||!photo.path.trim()))throw new Error(`旅程「${trip.name}」的照片資料格式錯誤`);
    }
  }
  for(const diary of data.diaries){
    if(!diary||typeof diary!=='object'||typeof diary.title!=='string'||!diary.title.trim())throw new Error('日記資料格式錯誤：缺少標題');
  }
  return true;
}

async function exportBackup(){
  if(!currentUser)return;
  showToast('正在準備備份...');
  const backup={exported_at:new Date().toISOString(),user_email:currentUser.email,trips,diaries,version:'2.0'};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=`travel-journal-backup-${isoDateOnly()}.json`; a.click();
  URL.revokeObjectURL(url); showToast('備份已下載！');
}

async function importBackup(input){
  const file=input.files[0]; if(!file)return; input.value='';
  try{
    const text=await file.text(), backup=JSON.parse(text);
    validateBackup(backup);
    if(!confirm(`確定匯入備份？\n包含 ${backup.trips?.length||0} 個旅程、${backup.diaries?.length||0} 篇日記。\n注意：照片檔案需重新上傳。`))return;
    let ok=0,fail=0;
    for(const t of(backup.trips||[])){const{error}=await sb.from('trips').upsert({id:t.id,user_id:currentUser.id,name:t.name,location:t.location,country:t.country,lat:t.lat,lng:t.lng,date_start:t.date_start,date_end:t.date_end,photo_count:t.photo_count||0,is_shared:false,share_token:t.share_token||crypto.randomUUID(),expenses:t.expenses||null,cover_path:t.cover_path||null,photos_meta:t.photos_meta||null,created_at:t.created_at},{onConflict:'id'});error?fail++:ok++;}
    for(const d of(backup.diaries||[])){const{error}=await sb.from('diaries').upsert({id:d.id,user_id:currentUser.id,title:d.title,content:d.content,mood:d.mood,diary_date:d.diary_date,trip_id:d.trip_id,created_at:d.created_at},{onConflict:'id'});error?fail++:ok++;}
    showToast(`匯入完成！成功 ${ok} 筆${fail>0?`，失敗 ${fail} 筆`:''}。`);
    await loadTrips();
  }catch(e){reportClientError('importBackup',e);showToast('匯入失敗：'+e.message);}
}

// ── ZIP EXPORT ──
async function exportZip(){
  if(!currentUser)return;
  if(typeof JSZip==='undefined'){showToast('JSZip 尚未載入，請重新整理後再試');return;}
  const totalPhotos=trips.reduce((s,t)=>s+parsePhotosMeta(t.photos_meta).length,0);
  if(totalPhotos===0){showToast('沒有照片可以匯出');return;}
  showToast('開始打包，照片多時需要一點時間...');
  const zip=new JSZip();
  const meta={exported_at:new Date().toISOString(),user_email:currentUser.email,trips,diaries,version:'2.0'};
  zip.file('data.json',JSON.stringify(meta,null,2));
  const photoFolder=zip.folder('photos');
  let done=0;
  for(const trip of trips){
    const photos=parsePhotosMeta(trip.photos_meta);
    if(!photos.length)continue;
    const folderName=(trip.name||'未命名').replace(/[^\w一-鿿]/g,'_').slice(0,30);
    const folder=photoFolder.folder(folderName);
    for(const p of photos){
      try{
        const url=await signPhoto(p.path,300); if(!url)continue;
        const res=await fetch(url); if(!res.ok)continue;
        folder.file(p.path.split('/').pop()||'photo.jpg',await res.blob());
        done++;
        if(done%5===0)showToast(`打包中 ${done}/${totalPhotos} 張...`);
      }catch(e){reportClientError('exportZip.photo',e);}
    }
  }
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url;
  a.download=`travel-journal-${isoDateOnly()}.zip`; a.click();
  URL.revokeObjectURL(url);
  showToast(`ZIP 已下載！共 ${done} 張照片`);
}
