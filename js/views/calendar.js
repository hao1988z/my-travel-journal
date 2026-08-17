// ── CALENDAR ──
function calNav(dir){
  calMonth+=dir;
  if(calMonth>11){calMonth=0;calYear++;}
  if(calMonth<0){calMonth=11;calYear--;}
  renderCalendar();
}
function renderCalendar(){
  const weekDays=['日','一','二','三','四','五','六'];
  document.getElementById('cal-label').textContent=`${calYear} 年 ${calMonth+1} 月`;
  document.getElementById('cal-sub').textContent=trips.length+' 趟旅程';
  const firstDay=new Date(calYear,calMonth,1).getDay();
  const daysInMonth=new Date(calYear,calMonth+1,0).getDate();
  const todayStr=new Date().toISOString().slice(0,10);
  const dayMap={};
  trips.forEach(t=>{
    if(!t.date_start)return;
    const start=new Date(t.date_start), end=t.date_end?new Date(t.date_end):new Date(t.date_start);
    for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
      if(d.getFullYear()===calYear&&d.getMonth()===calMonth){const key=d.getDate();if(!dayMap[key])dayMap[key]=[];if(!dayMap[key].find(x=>x.id===t.id))dayMap[key].push(t);}
    }
  });
  let html=weekDays.map(d=>`<div class="cal-head">${d}</div>`).join('');
  for(let i=0;i<firstDay;i++)html+=`<div class="cal-day empty"></div>`;
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday=dateStr===todayStr, ts=dayMap[d]||[];
    html+=`<div class="cal-day${isToday?' today':''}"><div class="cal-day-num">${d}</div>${ts.slice(0,3).map(t=>`<span class="cal-trip-dot" onclick="openPhotosForTrip('${t.id}')" title="${esc(t.name)}">${esc(t.name)}</span>`).join('')}${ts.length>3?`<span style="font-family:'DM Mono',monospace;font-size:9px;color:var(--ink-muted);">+${ts.length-3}</span>`:''}</div>`;
  }
  document.getElementById('cal-grid').innerHTML=html;
}
