// ── PAGE SWITCHING ──
function showApp(){ document.getElementById('auth-page').style.display='none'; document.getElementById('app-page').style.display='block'; }
function showAuth(){ document.getElementById('auth-page').style.display='flex'; document.getElementById('app-page').style.display='none'; }

// ── AUTH EVENTS ──


async function applySession(session){
  if(isShareMode)return;
  if(session?.user){
    const already=currentUser?.id===session.user.id&&document.getElementById('app-page').style.display==='block';
    currentUser=session.user; showApp();
    document.getElementById('user-email-display').textContent=session.user.email;
    if(!already) await loadTrips();
  } else { currentUser=null; showAuth(); }
}

function toggleAuth(){
  const l=document.getElementById('auth-form-login'),s=document.getElementById('auth-form-signup');
  l.style.display=l.style.display==='none'?'block':'none';
  s.style.display=s.style.display==='none'?'block':'none';
  setAuthMsg('');
}
function setAuthMsg(text,type){ const m=document.getElementById('auth-msg'); m.textContent=text||''; m.className='auth-msg'+(type?' '+type:''); }
function authRedirectUrl(){ return window.location.href.split('#')[0].split('?')[0]||window.location.origin; }

async function doLogin(){
  const email=document.getElementById('auth-email').value.trim(), pass=document.getElementById('auth-pass').value;
  if(!email||!pass){setAuthMsg('請填寫 Email 和密碼','err');return;}
  setAuthMsg('登入中...');
  try{
    const{data,error}=await sb.auth.signInWithPassword({email,password:pass});
    if(error){ setAuthMsg('登入失敗：'+((/email not confirmed/i.test(error.message))?'請先到信箱點擊驗證信。':(/invalid login credentials/i.test(error.message))?'Email 或密碼不正確。':error.message),'err'); return; }
    if(data?.session) await applySession(data.session);
  }catch(err){ setAuthMsg('登入失敗：無法連線到 Supabase。','err'); }
}

async function doSignup(){
  const email=document.getElementById('su-email').value.trim(), pass=document.getElementById('su-pass').value;
  if(!email||!pass){setAuthMsg('請填寫 Email 和密碼','err');return;}
  if(pass.length<6){setAuthMsg('密碼至少需要 6 個字元','err');return;}
  setAuthMsg('建立帳號中...');
  try{
    const{data,error}=await sb.auth.signUp({email,password:pass,options:{emailRedirectTo:authRedirectUrl()}});
    if(error){setAuthMsg('註冊失敗：'+error.message,'err');return;}
    if(data?.user?.identities?.length===0){setAuthMsg('此 Email 已註冊，請切回登入。','err');return;}
    if(data?.session){await applySession(data.session);return;}
    document.getElementById('auth-email').value=email;
    setAuthMsg('帳號已建立。請先到信箱點擊驗證信，再回來登入。','ok');
  }catch(err){setAuthMsg('註冊失敗：無法連線到 Supabase。','err');}
}

async function doLogout(){
  isManualLogout=true;
  await sb.auth.signOut();
  trips=[];diaries=[];currentUser=null;pendingFiles=[];lbPhotos=[];
  if(mapMarkerGroup)mapMarkerGroup.clearLayers();
  markers={};
  document.getElementById('auth-email').value='';
  document.getElementById('auth-pass').value='';
  document.getElementById('auth-msg').textContent='';
  showAuth(); showToast('已登出');
}
