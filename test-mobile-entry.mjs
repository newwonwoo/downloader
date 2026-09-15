import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('app.js','utf8');
const manifest=JSON.parse(fs.readFileSync('manifest.webmanifest','utf8'));
if(manifest.share_target?.params?.url!=='url'||manifest.share_target?.params?.text!=='text')throw new Error('share target contract missing');
const listeners={},elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{id,value:'',disabled:false,textContent:'',hidden:false,classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},querySelector(){return{parentElement:{hidden:false},style:{}}}});return elements.get(id)}
const location={search:'?shared=1&text='+encodeURIComponent('공유 https://njavtv.com/dm890/ko/shared-video'),hash:'',pathname:'/',origin:'https://downloader-web-1gqu.onrender.com'};let fetched='';
const navigator={clipboard:{readText:async()=> 'https://njavtv.com/dm890/ko/clip-test'},serviceWorker:{register:async()=>({})},standalone:false};
const window={location,history:{replaceState(){location.search=''}},isSecureContext:true,warmDownloaderWorker:async()=>{},renderResult(){},matchMedia:()=>({matches:false}),addEventListener:(t,f)=>{listeners['window:'+t]=f}};
const sandbox={URL,URLSearchParams,AbortSignal,console,setTimeout,clearTimeout,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000000'},navigator,window,location,history:window.history,document:{getElementById:el,querySelectorAll(){return[]},addEventListener(){},hidden:false},fetch:async(_url,opt)=>{fetched=JSON.parse(opt.body).url;return{ok:true,status:200,json:async()=>({ok:true,title:'x',streams:[{quality:'360',url:'https://surrit.com/x/video.m3u8'}]})}}};window.window=window;window.document=sandbox.document;window.navigator=navigator;window.fetch=sandbox.fetch;
vm.createContext(sandbox);vm.runInContext(source,sandbox);listeners['window:DOMContentLoaded']?.();await new Promise(r=>setTimeout(r,0));
if(fetched!=='https://njavtv.com/dm890/ko/shared-video')throw new Error('share target did not auto-analyze: '+fetched);
const extracted=vm.runInContext("extractPageUrl('공유 https://njavtv.com/dm890/ko/clip-test')",sandbox);if(extracted!=='https://njavtv.com/dm890/ko/clip-test')throw new Error('share text extraction failed');
if(vm.runInContext("extractPageUrl('https://evil.example/video')",sandbox)!==null)throw new Error('foreign URL accepted');
console.log('SAMSUNG_SHARE_TARGET_OK');
