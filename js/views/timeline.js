// ── TIMELINE ──
function renderTimeline(){
  const sorted=[...trips].sort((a,b)=>{const da=a.date_start||a.created_at||'',db=b.date_start||b.created_at||'';return da<db?-1:da>db?1:0;});
  document.getElementById('tl-sub').textContent=sorted.length+' 趟旅程，依日期排序';
  const emojis=['🗺️','🌅','🏔️','🌊','🌸','🏯','🗼','🏛️'];
  if(sorted.length===0){document.getElementById('timeline-list').innerHTML=`<div class="empty-rich"><b>還沒有旅程</b>新增旅程後會在這裡顯示時間軸。<div class="quick-actions"><button class="quick-btn primary" onclick="openUpload()">新增旅程</button></div></div>`;return;}
  document.getElementById('timeline-list').innerHTML=sorted.map((t,i)=>{
    const em=emojis[Math.abs((t.name||'').charCodeAt(0))%emojis.length], isLast=i===sorted.length-1;
    return`<div class="tl-item"><div class="tl-date-col"><div class="tl-date">${t.date_start||'未知日期'}</div></div><div class="tl-dot-col"><div class="tl-dot"></div>${!isLast?'<div class="tl-line"></div>':''}</div><div class="tl-content"><div class="tl-card" onclick="viewOnMap('${t.id}')"><div class="tl-card-cover">${t.cover_url?`<img src="${esc(t.cover_url)}">`:em}</div><div><div class="tl-card-name">${esc(t.name)}</div><div class="tl-card-meta">📍 ${esc(t.location||'—')} ${t.country?'・'+esc(t.country):''}</div><div class="tl-card-meta">${esc(t.date_start||'')}${t.date_end?' ～ '+esc(t.date_end):''} · ${t.photo_count||0} 張照片</div></div></div></div></div>`;
  }).join('');
}
