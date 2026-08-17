async function fetchJsonChecked(url,options={},context='fetchJsonChecked'){
  const response=await fetch(url,options);
  if(!response.ok)throw new Error(`${context} 回應 ${response.status}`);
  return response.json();
}
