// ── STATS ──
function renderStats(){
  const moodDefs=[{emoji:'😄',label:'開心'},{emoji:'🥰',label:'感動'},{emoji:'😌',label:'平靜'},{emoji:'🤩',label:'驚喜'},{emoji:'😴',label:'疲憊'},{emoji:'😢',label:'難過'},{emoji:'🤔',label:'思念'},{emoji:'🔥',label:'興奮'}];
  const counts={}; moodDefs.forEach(m=>counts[m.emoji]=0);
  diaries.forEach(d=>{if(d.mood&&counts[d.mood]!==undefined)counts[d.mood]++;});
  const maxCount=Math.max(1,...Object.values(counts));
  document.getElementById('mood-stat-grid').innerHTML=moodDefs.sort((a,b)=>counts[b.emoji]-counts[a.emoji]).map(m=>{const c=counts[m.emoji],pct=Math.round((c/maxCount)*100);return`<div class="mood-stat-card"><div class="mood-stat-emoji">${m.emoji}</div><div class="mood-stat-label">${m.label}</div><div class="mood-stat-count">${c}</div><div class="mood-stat-bar-wrap"><div class="mood-stat-bar" style="width:${pct}%"></div></div></div>`;}).join('');
  const cntryCount={};
  trips.forEach(t=>{if(t.country)cntryCount[t.country]=(cntryCount[t.country]||0)+1;});
  const maxC=Math.max(1,...Object.values(cntryCount));
  document.getElementById('country-stat-grid').innerHTML=Object.entries(cntryCount).sort((a,b)=>b[1]-a[1]).length>0?Object.entries(cntryCount).sort((a,b)=>b[1]-a[1]).map(([c,n])=>{const pct=Math.round((n/maxC)*100);return`<div class="mood-stat-card"><div class="mood-stat-emoji">🌍</div><div class="mood-stat-label">${esc(c)}</div><div class="mood-stat-count">${n}</div><div class="mood-stat-bar-wrap"><div class="mood-stat-bar" style="width:${pct}%"></div></div></div>`;}).join(''):'<div style="color:var(--ink-muted);font-size:13px;">還沒有旅程資料</div>';
  renderExpenseStats();
}

function renderExpenseStats(){
  const el=document.getElementById('expense-stat-bar'); if(!el)return;
  let transport=0,hotel=0,food=0,other=0;
  trips.forEach(t=>{if(!t.expenses)return;try{const e=typeof t.expenses==='string'?JSON.parse(t.expenses):t.expenses;transport+=Number(e.transport)||0;hotel+=Number(e.hotel)||0;food+=Number(e.food)||0;other+=Number(e.other)||0;}catch(e){reportClientError('renderExpenseStats',e);}});
  const total=transport+hotel+food+other;
  const chart=document.getElementById('expense-chart');
  if(total===0){
    el.innerHTML='<div style="color:var(--ink-muted);font-size:13px;">還沒有花費記錄，新增旅程時可填入各項費用。</div>';
    if(chart)chart.innerHTML=''; return;
  }
  el.innerHTML=[['總花費','💰',total],['交通','✈️',transport],['住宿','🏨',hotel],['餐飲','🍜',food],['門票/其他','🎫',other]].map(([label,icon,val])=>`<div class="exp-chip"><b>${icon} ${val.toLocaleString()}</b><span>${label}</span></div>`).join('');
  if(!chart)return;
  const cats=[
    {label:'交通',icon:'✈️',val:transport,color:'var(--accent)'},
    {label:'住宿',icon:'🏨',val:hotel,color:'var(--green)'},
    {label:'餐飲',icon:'🍜',val:food,color:'#8a6d3a'},
    {label:'門票/其他',icon:'🎫',val:other,color:'#4a6b8a'},
  ].filter(c=>c.val>0);
  chart.innerHTML=`<div style="background:#fff;border:1px solid var(--sand-dark);border-radius:10px;padding:18px 22px;">`
    +cats.map(c=>{
      const pct=Math.round((c.val/total)*100);
      return`<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;"><span style="font-size:15px;">${c.icon}</span><span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink-muted);min-width:58px;">${c.label}</span><div style="flex:1;height:8px;background:var(--sand-dark);border-radius:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${c.color};border-radius:4px;transition:width .8s ease;"></div></div><span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink-muted);min-width:32px;text-align:right;">${pct}%</span><span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink-muted);min-width:72px;text-align:right;">${c.val.toLocaleString()}</span></div>`;
    }).join('')+`</div>`;
}
