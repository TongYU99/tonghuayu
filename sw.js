/* 彤话屿 Service Worker —— v2.24.4（PWA 安装包核心）
   策略：网络优先 —— 在线时永远拿最新版（更新随构建号自动同步，装到桌面也会跟着更新）；
   断网时回落缓存，桌面图标照常打开。
   构建时 sync_all.py 会把下面 __BUILD__ 替换成实际 build 号：
   build 变 → 缓存名变 → activate 时旧缓存整体清除，不会残留旧文件。 */
const BUILD='346';
const CACHE='tonghua-b'+BUILD;
const CORE=['./','./index.html','./app.js','./data.js','./games.js','./version.json',
            './manifest.webmanifest','./icon-192.png','./icon-180.png','./icon.png','./favicon.ico'];

self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    await Promise.all(CORE.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>{})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const ks=await caches.keys();
    await Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  let url;
  try{ url=new URL(req.url); }catch(_){ return; }
  if(url.origin!==location.origin)return;      /* 只管同源（跨域交给浏览器） */
  e.respondWith((async()=>{
    try{
      const res=await fetch(req);
      if(res&&res.ok){
        const cp=res.clone();
        caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{});
      }
      return res;
    }catch(err){
      const hit=await caches.match(req,{ignoreSearch:true}).catch(()=>null);
      return hit||caches.match('./index.html').then(r=>r||Response.error());
    }
  })());
});

/* ============ 消息通知（v2.24.12） ============
   目的：用户在手机上把网站「放到后台」或切到别的应用时，消息依然能弹系统通知。
   背景知识：网页里的定时器（setTimeout/setInterval）在后台会被浏览器限频甚至冻结，
   所以光靠主线程根本不可靠。这里给主线程提供一个「不在前台时由 Service Worker 定时接管」的通道：
     · 主线程用 postMessage 把「联系人名单 + 通知开关 + 声音开关」同步过来；
     · SW 每 30 秒醒一次，模拟一条新消息（纯本机运算，不联网、不请求任何服务器）；
     · 弹系统通知，5 秒后自动收起 —— 这些提示音/通知都不产生网络流量。
   打开网站（前台）时主线程会通知 SW 暂停，避免和页面自己的回复引擎重复弹。 */
let BK = { on:false, contacts:[], sound:true, lastAt:{}, timer:null, notifyOn:true };
const BK_TICK = 30000;          /* 检查间隔 */
const BK_NAME = '彤话屿';

function bkPick(){
  const list = BK.contacts || [];
  if(!list.length) return null;
  return list[Math.floor(Math.random()*list.length)];
}
function bkFire(){
  if(!BK.on || !BK.notifyOn) return;
  const c = bkPick();
  if(!c) return;
  const key = c.id || c.name || 'x';
  const last = BK.lastAt[key] || 0;
  if(Date.now() - last < 45000) return;              /* 同一个联系人别刷屏 */
  BK.lastAt[key] = Date.now();
  const lines = c.lines && c.lines.length ? c.lines : ['在忙吗？'];
  const body = lines[Math.floor(Math.random()*lines.length)];
  self.registration.showNotification(BK_NAME + (c.name?(' · '+c.name):''), {
    body: body,
    tag: 'thy-bg-' + key,
    renotify: true,
    silent: !!BK.sound,
    badge: './icon-192.png',
    icon: './icon-192.png',
    data: { chatId: c.id || '' }
  }).catch(()=>{});
}
function bkStart(){
  if(BK.timer) return;
  bkFire();
  BK.timer = setInterval(bkFire, BK_TICK);
}
function bkStop(){
  if(BK.timer){ clearInterval(BK.timer); BK.timer = null; }
}
self.addEventListener('message', function(e){
  const d = e && e.data;
  if(!d || d.type !== 'thy-bg') return;
  BK.on = !!d.on;
  BK.contacts = Array.isArray(d.contacts) ? d.contacts : [];
  BK.sound = !!d.sound;
  BK.notifyOn = !!d.notify;
  if(BK.on) bkStart(); else bkStop();
});

/* 用户点通知 → 打开（或聚焦）网站 */
self.addEventListener('notificationclick', function(e){
  try{ e.notification.close(); }catch(_){}
  const chatId = (e.notification && e.notification.data && e.notification.data.chatId) || '';
  e.waitUntil((async()=>{
    const all = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for(const cl of all){
      if(cl.url && cl.url.indexOf(location.origin) === 0){
        try{ await cl.focus(); }catch(_){}
        try{ cl.postMessage({ type:'thy-open-chat', chatId: chatId }); }catch(_){}
        return;
      }
    }
    try{ await self.clients.openWindow('./'); }catch(_){}
  })());
});
