import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app.js', 'utf8');
const listeners = {};
const elements = new Map();
function el(id){ if(!elements.has(id)) elements.set(id,{id,value:'',disabled:false,textContent:'',hidden:false,classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},querySelector(){return {parentElement:{hidden:false},style:{}}}}); return elements.get(id); }
const location = {search:'?url='+encodeURIComponent('https://njavtv.com/dm890/ko/abc'),hash:'',pathname:'/',origin:'https://downloader-web-1gqu.onrender.com'};
let fetched='';
const sandbox={URL,URLSearchParams,AbortSignal,console,setTimeout,clearTimeout,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000000'},navigator:{clipboard:{readText:async()=> '공유 https://njavtv.com/dm890/ko/clip-test'}},window:{location,history:{replaceState(_a,_b,url){location.search='';location.replaced=url}},isSecureContext:true,warmDownloaderWorker:async()=>{},renderResult(){}},document:{getElementById:el,querySelectorAll(){return []},addEventListener(type,fn){listeners[type]=fn},hidden:false},fetch:async(_url,opt)=>{fetched=JSON.parse(opt.body).url;return {ok:true,status:200,json:async()=>({ok:true,title:'x',streams:[{quality:'360',url:'https://surrit.com/x/video.m3u8'}]})}},state:undefined};
sandbox.window.window=sandbox.window; sandbox.window.document=sandbox.document; sandbox.window.navigator=sandbox.navigator; sandbox.window.fetch=sandbox.fetch; sandbox.window.addEventListener=(t,f)=>{listeners['window:'+t]=f};
vm.createContext(sandbox); vm.runInContext(source,sandbox);
listeners['window:DOMContentLoaded']?.();
await new Promise(r=>setTimeout(r,0));
if(fetched!=='https://njavtv.com/dm890/ko/abc') throw new Error('query URL did not auto-analyze: '+fetched);
location.search=''; fetched='';
await sandbox.navigator.clipboard.readText();
const extracted=vm.runInContext("extractPageUrl('공유 https://njavtv.com/dm890/ko/clip-test')",sandbox);
if(extracted!=='https://njavtv.com/dm890/ko/clip-test') throw new Error('clipboard share text extraction failed');
const evil=vm.runInContext("extractPageUrl('https://evil.example/video')",sandbox);
if(evil!==null) throw new Error('foreign URL accepted');
console.log('MOBILE_ENTRY_OK');
