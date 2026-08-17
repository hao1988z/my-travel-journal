// ── LOAD DATA ──
async function loadTrips(){
  const{data,error}=await sb.from('trips').select('*').order('created_at',{ascending:false});
  if(error){reportClientError('loadTrips',error);showToast('旅程載入失敗：'+error.message);return;}
  trips=data||[];
  await hydrateTripCovers();
  renderSidebar(); updateStats();
  if(mapInstance) renderMapMarkers();
  renderGallery(currentFilter);
  await loadDiaries();
}

async function hydrateTripCovers(){
  await Promise.all(trips.map(async t=>{
    const photos=parsePhotosMeta(t.photos_meta);
    if(!t._coverHydrated){
      const path=t.cover_path||photos[0]?.path;
      if(path){const url=await signPhoto(path,3600);if(url)t.cover_url=url;}
      t._coverHydrated=true;
    }
    t.photo_count=photos.length||t.photo_count||0;
  }));
}
