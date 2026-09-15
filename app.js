const FRONTEND_VERSION = 'mobile-entry-v1';
const $ = (id) => document.getElementById(id);
const state = { result: null, analyzing: false };
const HLS_IMPORT_HOSTS = ['surrit.com', 'nineyu.com'];

function setAnalyzing(active) {
  state.analyzing = active;
  $('analyzeButton').disabled = active;
  $('pasteAnalyzeButton').disabled = active;
  $('analyzeButton').textContent = active ? '분석 중…' : '영상 찾기';
  $('pasteAnalyzeButton').textContent = active ? '영상 찾는 중…' : '복사한 주소로 영상 찾기';
  $('status').classList.toggle('show', active);
  if (active) { $('error').classList.remove('show'); $('result').classList.remove('show'); }
}
function showError(message) { $('error').textContent = message; $('error').classList.add('show'); $('status').classList.remove('show'); }
function updateProgress(percent,title,message){$('download').classList.add('show');const p=$('progressBar').parentElement;p.hidden=false;const n=Number(percent);$('progressBar').style.width=Number.isFinite(n)?`${Math.max(0,Math.min(100,n))}%`:'0%';$('downloadPercent').textContent=typeof percent==='number'?`${Math.round(percent)}%`:String(percent||'');$('downloadTitle').textContent=title;$('downloadMessage').textContent=message;}
function isNjavUrl(value){try{const u=new URL(String(value||'').trim());const h=u.hostname.toLowerCase();return u.protocol==='https:'&&(h==='njavtv.com'||h==='www.njavtv.com')}catch{return false}}
function normalizePageUrl(value){const text=String(value||'').trim();if(!text)return null;try{const u=new URL(text);return isNjavUrl(u.href)?u.href:null}catch{return null}}
function errorMessage(data,status){if(typeof data?.detail==='string')return data.detail;if(typeof data?.message==='string')return data.message;const code=data?.detail?.code||data?.code;return {SOURCE_BLOCKED:'원본 사이트의 보안 확인 때문에 서버 분석이 막혔습니다. 필요하면 아래 고급 추출 기능을 사용하세요.',STREAM_NOT_FOUND:'영상 재생 주소를 찾지 못했습니다.',STREAM_UNAVAILABLE:'현재 재생 가능한 화질을 찾지 못했습니다.',MASTER_UNAVAILABLE:'영상 화질 목록을 불러오지 못했습니다.'}[code]||`영상 분석에 실패했습니다. (${status||'network'})`;}
function showHelper(){ $('helperPanel')?.removeAttribute('hidden'); } function hideHelper(){ $('helperPanel')?.setAttribute('hidden',''); }

async function analyzeUrl(value,{source='manual'}={}){
  if(state.analyzing)return false;
  const url=normalizePageUrl(value);
  if(!url){showError(source==='clipboard'?'복사한 내용에서 NJAVTV 영상 주소를 찾지 못했습니다. 영상 페이지에서 링크를 다시 복사해 주세요.':'NJAVTV 영상 페이지 주소를 확인해 주세요.');return false;}
  $('pageUrl').value=url; hideHelper(); setAnalyzing(true); void window.warmDownloaderWorker?.().catch(()=>{});
  try{const response=await fetch('/api/video-resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(errorMessage(data,response.status));state.result=data;if(typeof window.renderResult!=='function')throw new Error('저장 화면을 준비하지 못했습니다.');window.renderResult(data);hideHelper();return true;}catch(error){showError(error?.message||'영상 분석에 실패했습니다.');showHelper();return false;}finally{setAnalyzing(false);}
}
async function analyzeClipboard(){
  if(!navigator.clipboard?.readText){showError('이 브라우저에서는 클립보드를 직접 읽을 수 없습니다. 아래 주소 직접 입력을 사용해 주세요.');return;}
  try{const text=await navigator.clipboard.readText();await analyzeUrl(text,{source:'clipboard'});}catch{showError('클립보드 읽기가 허용되지 않았습니다. 버튼을 다시 누르거나 주소 직접 입력을 사용해 주세요.');}
}
function queryEntry(){const params=new URLSearchParams(window.location.search);const value=params.get('url');if(!value)return false;const normalized=normalizePageUrl(value);window.history.replaceState(null,'',window.location.pathname+window.location.hash);if(!normalized){showError('전달된 영상 주소가 올바르지 않습니다.');return true;}void analyzeUrl(normalized,{source:'query'});return true;}

function allowedImportedHls(value){try{const u=new URL(String(value||'').trim()),h=u.hostname.toLowerCase();if(u.protocol!=='https:'||!/\.m3u8$/i.test(u.pathname))return null;if(!HLS_IMPORT_HOSTS.some(s=>h===s||h.endsWith(`.${s}`)))return null;return u.href}catch{return null}}
function importedQuality(v){return String(v).match(/\/(1920x1080|1280x720|842x480|640x360|1080p|720p|480p|360p)\//i)?.[1]||'자동'}
function importedHeight(q){return {'1920x1080':1080,'1080p':1080,'1280x720':720,'720p':720,'842x480':480,'480p':480,'640x360':360,'360p':360}[q]||0}
function importedVideoId(v){return String(v).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]||null}
function browserHandoffCode(){const target=JSON.stringify(`${window.location.origin}${window.location.pathname}`);return `javascript:(()=>{let n=0;const abs=u=>{try{return new URL(u,location.href).href}catch{return''}};const find=()=>{let u=(window.hls&&window.hls.url)||'';if(!u){for(const v of document.querySelectorAll('video')){u=(v._hls&&v._hls.url)||((/\\.m3u8(?:\\?|$)/i.test(v.currentSrc||''))?v.currentSrc:'')||((/\\.m3u8(?:\\?|$)/i.test(v.src||''))?v.src:'');if(u)break}}if(!u){const a=performance.getEntriesByType('resource').map(e=>e.name).filter(x=>/\\.m3u8(?:\\?|$)/i.test(x));u=a[a.length-1]||''}u=abs(u);if(u){const p=new URLSearchParams({hls:u,title:document.title||'NJAVTV video',source:location.origin+location.pathname});location.href=${target}+'#'+p.toString();return}if(++n<12){setTimeout(find,1000);return}alert('영상 재생 버튼을 한 번 누른 뒤 다시 실행하세요.');};find()})()`;}
function importBrowserHandoff(){if(!window.location.hash||window.location.hash.length<2)return false;const p=new URLSearchParams(window.location.hash.slice(1)),hls=allowedImportedHls(p.get('hls'));if(!hls)return false;const source=String(p.get('source')||'').trim(),title=String(p.get('title')||'NJAVTV 영상').trim().slice(0,180)||'NJAVTV 영상',quality=importedQuality(hls);if(isNjavUrl(source))$('pageUrl').value=source;const result={ok:true,resolver:'browser-handoff-v2',title,videoId:importedVideoId(hls),pageUrl:isNjavUrl(source)?source:'',streams:[{quality,height:importedHeight(quality),url:hls,available:true,manifestType:'hls'}]};state.result=result;if(typeof window.renderResult!=='function')throw new Error('저장 화면을 준비하지 못했습니다.');window.renderResult(result);hideHelper();window.history.replaceState(null,'',window.location.pathname+window.location.search);return true;}

$('analyzeForm').addEventListener('submit',e=>{e.preventDefault();void analyzeUrl($('pageUrl').value,{source:'manual'});});
$('pasteAnalyzeButton').addEventListener('click',()=>void analyzeClipboard());
$('copyHelper')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(browserHandoffCode());$('copyHelper').textContent='복사됨';setTimeout(()=>{$('copyHelper').textContent='고급 추출 코드 복사';},1400)}catch{showError('고급 추출 코드를 복사하지 못했습니다.')}});
window.addEventListener('DOMContentLoaded',()=>{try{if(importBrowserHandoff())return;queryEntry();}catch(error){showError(error?.message||'가져온 영상 주소를 처리하지 못했습니다.')}});
window.addEventListener('pageshow',()=>void window.warmDownloaderWorker?.().catch(()=>{}));
