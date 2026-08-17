// ── NAV ──
function toggleMobileNav(){document.querySelector('nav')?.classList.toggle('open');}

function showView(v){
  const go=()=>{
    document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.mob-nav-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector('nav')?.classList.remove('open');
    document.getElementById(v+'-view').classList.add('active');
    document.getElementById('nb-'+v).classList.add('active');
    document.getElementById('mbn-'+v)?.classList.add('active');
    if(v==='gallery'){restoreFilterState();renderGallery(currentFilter);}
    if(v==='diary')renderDiary();
    if(v==='map'){if(!mapInstance){initMap();renderMapMarkers();renderSidebar();updateStats();}setTimeout(()=>mapInstance?.invalidateSize(),50);}
    if(v==='stats')renderStats();
    if(v==='timeline')renderTimeline();
    if(v==='calendar')renderCalendar();
  };
  if(document.startViewTransition){document.startViewTransition(go);}else{go();}
}


// ── LAZY LOADING ──
function ensureLazy(img) {
  if (!img.hasAttribute('loading')) img.loading = 'lazy';
}
document.querySelectorAll('img').forEach(ensureLazy);
new MutationObserver(mutations => {
  mutations.forEach(m => {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'IMG') ensureLazy(node);
      if (node.querySelectorAll) node.querySelectorAll('img').forEach(ensureLazy);
    });
  });
}).observe(document, {childList:true, subtree:true});


// ── DIARY AUTOSAVE ──
document.getElementById('diary-modal').addEventListener('input',()=>{
  if(!document.getElementById('diary-modal').classList.contains('open'))return;
  saveDiaryDraft();
});



// Start the application only after every service and view has been loaded.

showAuth();

sb.auth.onAuthStateChange(async(event,session)=>{
  if(isShareMode)return;
  if(event==='SIGNED_OUT'){ if(!isManualLogout){currentUser=null;trips=[];diaries=[];showAuth();} isManualLogout=false; }
});
if(isShareMode){
  showAuth();
  document.getElementById('auth-page').style.display='none';
  document.getElementById('share-page').style.display='block';
  loadSharedTrip(shareToken);
} else {
  sb.auth.getSession().then(({data})=>applySession(data?.session||null));
}
