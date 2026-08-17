// ── 外幣匯率 ──
let exchangeRates = {};
let exchangeRateFetchedAt = {};
async function updateExchangeRate() {
  const cur = document.getElementById('f-exp-currency')?.value||'TWD';
  const display = document.getElementById('currency-rate-display'); if (!display) return;
  if (cur==='TWD') { display.textContent=''; return; }
  if (Number.isFinite(exchangeRates[cur]) && exchangeRates[cur]>0) { display.textContent=`1 ${cur} ≈ ${exchangeRates[cur].toFixed(2)} TWD`; return; }
  display.textContent='查詢匯率中...';
  try {
    const res = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(cur)}/TWD`);
    if (!res.ok) throw new Error(`匯率服務回應 ${res.status}`);
    const data = await res.json();
    const rate = Number(data.rate);
    if (!Number.isFinite(rate) || rate<=0) throw new Error(`匯率資料缺少 ${cur} → TWD`);
    exchangeRates[cur]=rate;
    exchangeRateFetchedAt[cur]=new Date().toISOString();
    display.textContent=`1 ${cur} ≈ ${rate.toFixed(2)} TWD`;
  } catch(e) { reportClientError('updateExchangeRate',e); display.textContent='無法取得匯率，儲存前請重試'; }
}

function getExpensesInTWD() {
  const cur = document.getElementById('f-exp-currency')?.value||'TWD';
  const rate = cur==='TWD' ? 1 : exchangeRates[cur];
  if (!Number.isFinite(rate) || rate<=0) throw new Error(`尚未取得 ${cur} 匯率，請先重新查詢`);
  const original={
    transport:Number(document.getElementById('f-exp-transport').value)||0,
    hotel:Number(document.getElementById('f-exp-hotel').value)||0,
    food:Number(document.getElementById('f-exp-food').value)||0,
    other:Number(document.getElementById('f-exp-other').value)||0
  };
  return {
    currency: cur, rate, rateFetchedAt: cur==='TWD'?new Date().toISOString():(exchangeRateFetchedAt[cur]||null), original,
    transport: Math.round(original.transport*rate),
    hotel:     Math.round(original.hotel*rate),
    food:      Math.round(original.food*rate),
    other:     Math.round(original.other*rate),
    orig_currency: cur,
  };
}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
