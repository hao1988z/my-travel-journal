// ── DIARY ──
async function loadDiaries(){
  const{data,error}=await sb.from('diaries').select('*').order('diary_date',{ascending:false});
  if(error){reportClientError('loadDiaries',error);showToast('日記載入失敗：'+error.message);return;}
  diaries=data||[]; renderDiary();
}

function renderDiary(){
  const sub=document.getElementById('diary-sub'); if(sub)sub.textContent=diaries.length+' 篇日記';
  const list=document.getElementById('diary-list'); if(!list)return;
  if(diaries.length===0){list.innerHTML=`<div class="empty-rich"><b>還沒有日記</b>旅程是照片和地點，日記是當下的自己。<div class="quick-actions"><button class="quick-btn primary" onclick="openDiary()">新增日記</button></div></div>`;return;}
  list.innerHTML=diaries.map(d=>{
    const trip=trips.find(t=>t.id===d.trip_id), preview=(d.content||'').slice(0,120)+((d.content||'').length>120?'...':'');
    return`<div class="diary-card" onclick="openDiaryDetail('${d.id}')"><div class="dc-top"><div class="dc-mood">${d.mood||'📝'}</div><div class="dc-info"><div class="dc-title">${esc(d.title)}</div><div class="dc-meta">${d.diary_date?'📅 '+d.diary_date:''}${trip?'  ✈️ '+esc(trip.name):''}</div></div></div>${preview?`<div class="dc-content">${esc(preview)}</div>`:''}<div class="dc-actions"><button class="act-btn" onclick="event.stopPropagation();editDiary('${d.id}')">編輯</button><button class="act-btn" style="color:#c0392b;" onclick="event.stopPropagation();deleteDiary('${d.id}')">刪除</button></div></div>`;
  }).join('');
}

function openDiary(tripId){
  editingDiaryId=null; selectedMood='';
  document.getElementById('diary-modal-title').textContent='新增日記';
  document.getElementById('d-title').value=''; document.getElementById('d-content').value='';
  document.getElementById('d-date').value=isoDateOnly();
  document.getElementById('d-trip').value=tripId||'';
  document.querySelectorAll('.mood-btn').forEach(b=>b.classList.remove('selected'));
  populateTripSelect();
  try{
    const draft=JSON.parse(localStorage.getItem('diary_draft')||'null');
    if(draft&&(draft.title||draft.content)){
      document.getElementById('d-title').value=draft.title||'';
      document.getElementById('d-content').value=draft.content||'';
      if(draft.date)document.getElementById('d-date').value=draft.date;
      if(draft.tripId)document.getElementById('d-trip').value=draft.tripId;
      if(draft.mood){selectedMood=draft.mood;document.querySelectorAll('.mood-btn').forEach(b=>b.classList.toggle('selected',b.dataset.mood===draft.mood));}
      showToast('已還原本地草稿');
    }
  }catch(e){reportClientError('loadDiaryDraft',e);}
  document.getElementById('diary-modal').classList.add('open');
}
function closeDiary(){document.getElementById('diary-modal').classList.remove('open');}
function populateTripSelect(){const sel=document.getElementById('d-trip');const cur=sel.value;sel.innerHTML='<option value="">不關聯旅程</option>'+trips.map(t=>'<option value="'+t.id+'"'+(cur===t.id?' selected':'')+'>'+esc(t.name)+'</option>').join('');}
function selectMood(btn){document.querySelectorAll('.mood-btn').forEach(b=>b.classList.remove('selected'));btn.classList.add('selected');selectedMood=btn.dataset.mood;}

function saveDiaryDraft(){
  try{localStorage.setItem('diary_draft',JSON.stringify({title:document.getElementById('d-title').value,content:document.getElementById('d-content').value||'',mood:selectedMood||'',date:document.getElementById('d-date').value||'',tripId:document.getElementById('d-trip').value||''}));}catch(e){reportClientError('saveDiaryDraft',e);}
}

async function saveDiary(){
  if(!currentUser)return;
  const title=document.getElementById('d-title').value.trim(); if(!title){showToast('請填寫日記標題');return;}
  const btn=document.getElementById('diary-save-btn'); btn.disabled=true; btn.textContent='儲存中...';
  if(!navigator.onLine){
    saveDiaryDraft();
    btn.disabled=false; btn.textContent='儲存日記';
    showToast('網路已斷線，已存為本地草稿，待恢復後再試');
    return;
  }
  const payload={user_id:currentUser.id,title,content:document.getElementById('d-content').value||null,mood:selectedMood||null,diary_date:document.getElementById('d-date').value||null,trip_id:document.getElementById('d-trip').value||null};
  let err;
  if(editingDiaryId){const res=await sb.from('diaries').update(payload).eq('id',editingDiaryId);err=res.error;}
  else{const res=await sb.from('diaries').insert([payload]);err=res.error;}
  btn.disabled=false; btn.textContent='儲存日記';
  if(err){saveDiaryDraft();showToast('儲存失敗，已存為本地草稿：'+err.message);return;}
  try{localStorage.removeItem('diary_draft');}catch(e){reportClientError('clearDiaryDraft',e);}
  closeDiary(); showToast(editingDiaryId?'日記已更新！':'日記已儲存！'); await loadDiaries();
}

function editDiary(id){
  const d=diaries.find(x=>x.id===id); if(!d)return;
  editingDiaryId=id; selectedMood=d.mood||'';
  document.getElementById('diary-modal-title').textContent='編輯日記';
  document.getElementById('d-title').value=d.title||''; document.getElementById('d-content').value=d.content||'';
  document.getElementById('d-date').value=d.diary_date||''; populateTripSelect();
  document.getElementById('d-trip').value=d.trip_id||'';
  document.querySelectorAll('.mood-btn').forEach(b=>b.classList.toggle('selected',b.dataset.mood===selectedMood));
  document.getElementById('diary-modal').classList.add('open');
}

async function deleteDiary(id){
  if(!confirm('確定要刪除這篇日記嗎？'))return;
  const{error}=await sb.from('diaries').delete().eq('id',id);
  if(error){reportClientError('deleteDiary',error);showToast('日記刪除失敗：'+error.message);return;}
  showToast('日記已刪除'); await loadDiaries();
}

function openDiaryDetail(id){
  const d=diaries.find(x=>x.id===id); if(!d)return;
  viewingDiaryId=id;
  const trip=trips.find(t=>t.id===d.trip_id);
  document.getElementById('detail-title-bar').textContent=d.title;
  document.getElementById('detail-mood').textContent=d.mood||'📝';
  document.getElementById('detail-title').textContent=d.title;
  document.getElementById('detail-meta').textContent=[d.diary_date,trip?'✈️ '+trip.name:''].filter(Boolean).join('  ·  ');
  document.getElementById('detail-content').textContent=d.content||'（無內容）';
  document.getElementById('diary-detail-modal').classList.add('open');
}
function editDiaryFromDetail(){document.getElementById('diary-detail-modal').classList.remove('open');if(viewingDiaryId)editDiary(viewingDiaryId);}
async function deleteDiaryFromDetail(){document.getElementById('diary-detail-modal').classList.remove('open');if(viewingDiaryId)await deleteDiary(viewingDiaryId);}
