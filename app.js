/* =====================================================================
 * 彤话世界 · 核心逻辑
 * 模拟手机系统：桌面 + 应用。全部数据存于 localStorage，无网络请求。
 * ===================================================================== */
'use strict';

const LS_KEY = 'tonghua_world_v2';

/* =====================================================================
 * v2.24.9 大容量主库（IndexedDB）—— 存储扩容
 * localStorage 同源只有约 5MB，是浏览器硬上限，扩不了。
 * 从本版起：完整存档同时写入 IndexedDB（大容量主库），localStorage 降级为「开机快取」：
 *   - Edge/Chrome 下 IndexedDB 额度按磁盘动态分配，通常几百 MB 起步（是 5MB 的上百倍）；
 *   - 启动仍先读快取（同步、秒开），随后异步比对大库：谁新用谁；
 *   - 快取写满不再致命 —— 大库才是数据之家（根治 v2.24.8「快取写满丢数据」）；
 *   - 所有 IDB 操作全部容错：环境不支持（旧 WebView / 隐私模式 / 测试环境）时
 *     自动退回纯 localStorage 行为，与 v2.24.8 完全一致。
 * ===================================================================== */
const IDB_NAME='tonghuayu', IDB_STORE='state';
let idbDb=null, idbBroken=false, idbVerified=false;   /* idbVerified：大库至少成功写入过一次 */
let idbGateDone=false, idbPendingSave=false;          /* 启动校时闸门：完成前不许写大库 */
function idbOpen(){
  return new Promise(function(res){
    if(idbDb) return res(idbDb);
    if(idbBroken) return res(null);
    try{
      if(typeof window==='undefined' || !window.indexedDB){ idbBroken=true; return res(null); }
      let settled=false;
      const finish=function(db){ if(!settled){ settled=true; res(db); } };
      const rq=window.indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded=function(){ try{ rq.result.createObjectStore(IDB_STORE); }catch(e){} };
      rq.onsuccess=function(){ idbDb=rq.result; finish(idbDb); };
      rq.onerror=function(){ idbBroken=true; finish(null); };
      rq.onblocked=function(){ finish(null); };
      setTimeout(function(){ finish(null); }, 3000);   /* 兜底：个别环境 open 可能挂起 */
    }catch(e){ idbBroken=true; res(null); }
  });
}
function idbPut(str){
  return idbOpen().then(function(db){
    if(!db) return false;
    return new Promise(function(res){
      try{
        const tx=db.transaction(IDB_STORE,'readwrite');
        tx.objectStore(IDB_STORE).put(str,'main');
        tx.oncomplete=function(){ idbVerified=true; res(true); };
        tx.onerror=function(){ res(false); };
        tx.onabort=function(){ res(false); };
      }catch(e){ res(false); }
    });
  }).catch(function(){ return false; });
}
function idbGet(){
  return idbOpen().then(function(db){
    if(!db) return null;
    return new Promise(function(res){
      try{
        const rq=db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get('main');
        rq.onsuccess=function(){ res(typeof rq.result==='string'?rq.result:null); };
        rq.onerror=function(){ res(null); };
      }catch(e){ res(null); }
    });
  }).catch(function(){ return null; });
}
function idbWipe(){
  return idbOpen().then(function(db){
    if(!db) return false;
    return new Promise(function(res){
      try{
        const tx=db.transaction(IDB_STORE,'readwrite');
        tx.objectStore(IDB_STORE).delete('main');
        tx.oncomplete=function(){ res(true); };
        tx.onerror=function(){ res(false); };
        tx.onabort=function(){ res(false); };
      }catch(e){ res(false); }
    });
  }).catch(function(){ return false; });
}
/* 启动校时：大库 vs 快取，谁新用谁。
   ⚠️ 必须在任何大库写入之前完成 —— 否则启动首存会把「可能过期的快取」
   盖掉大库里更新的存档（比如上次快取写满、只有大库写成功的场景）。
   另：?fresh=1 / 「重新开始」会留 tonghuayu_idb_wipe=1 口令，这里负责清库。 */
function idbBootCheck(){
  return idbGet().then(function(str){
    let wantWipe=false;
    try{ wantWipe = localStorage.getItem('tonghuayu_idb_wipe')==='1'; }catch(e){}
    if(wantWipe){
      try{ localStorage.removeItem('tonghuayu_idb_wipe'); }catch(e){}
      idbWipe().then(function(){
        idbGateDone=true;
        if(idbPendingSave){ idbPendingSave=false; save(); }   /* 把全新档写进已清空的大库 */
      });
      return;
    }
    idbGateDone=true;
    const hadPending=idbPendingSave; idbPendingSave=false;
    if(str){
      let s2=null;
      try{ s2=JSON.parse(str); }catch(e){ s2=null; }
      if(s2 && typeof s2==='object' && s2.settings && typeof s2.settings==='object'){
        const idbAt=s2.savedAt||0, curAt=(state&&state.savedAt)||0;
        if(idbAt>curAt){
          /* 大库更新（典型：上次快取写满没写成，只有大库救住了）→ 采用大库版本 */
          try{
            migrate(s2); state=s2;
            applyTheme(); renderDesktop();
            save();               /* 同步回快取，下次开机秒读 */
            try{ toast('已从大容量库恢复最近的存档'); }catch(e){}
          }catch(e){ try{ console.warn('[彤话屿] 大库存档启用失败', e); }catch(_){} }
          return;
        }
        idbVerified=true;         /* 大库里有像样的存档，视为可用 */
      }
    }else if(state){
      /* 大库还空着（首次升级到本版）→ 把现有数据搬进去 */
      idbPut(JSON.stringify(state));
      return;
    }
    if(hadPending) save();        /* 校时期间有改动排队 → 补写大库 */
  }).catch(function(){
    idbGateDone=true;
    if(idbPendingSave){ idbPendingSave=false; save(); }
  });
}

/* ================= 气泡预设库 & 字体预设 =================
   内置气泡用 CSS 变量写，夜/昼与主题色都能自动跟随；
   用户粘贴的 CSS 原样保存（custom:true），可改名、可删除。
   注意：这些定义必须在 defaultState() 之前，因为默认状态要初始化预设库。 */
const BUBBLE_R_VAR='var(--bubble-radius)';
const BUB_R_SMALL='calc(var(--bubble-radius) - 12px)';

/* 内置气泡：名称可在「主题 → 聊天气泡」里自行修改（改名后不被重置） */
function defaultBubblePresets(){
  const r=BUBBLE_R_VAR, small=BUB_R_SMALL;
  return [
    { id:'bp-classic', name:'经典', builtin:true, css:'' },
    { id:'bp-glass',   name:'发光玻璃', builtin:true, css:`
.bubble{background:var(--bp-glass-bg,rgba(255,255,255,.78)) !important;color:var(--bp-glass-ink,#6a6a70) !important;
  border:.5px solid var(--bp-glass-line,#fff) !important;
  box-shadow:0 2px 6px var(--bp-glass-sh,rgba(0,0,0,.10)),inset 0 0 0 .5px var(--bp-glass-line,#fff),
  0 0 10px rgba(255,255,255,.85),0 0 26px rgba(255,255,255,.45) !important;
  backdrop-filter:blur(17px) !important;-webkit-backdrop-filter:blur(17px) !important;
  position:relative !important;overflow:visible !important;}
.row.me .bubble{border-radius:`+r+` `+r+` `+small+` `+r+` !important;}
.row:not(.me) .bubble{border-radius:`+r+` `+r+` `+r+` `+small+` !important;}` },
    { id:'bp-letter',  name:'信纸薄边', builtin:true, css:`
.bubble{background:var(--bp-letter-bg,var(--panel)) !important;color:var(--ink) !important;
  border:1.5px dashed var(--bp-letter-line,var(--ink-2)) !important;box-shadow:none !important;border-radius:10px !important;
  background-image:var(--bp-letter-lines,repeating-linear-gradient(transparent,transparent 21px,var(--line) 21px,var(--line) 22px)) !important;
  background-origin:border-box !important;}
.row.me .bubble{background-color:var(--accent) !important;background-image:none !important;color:var(--accent-ink) !important;
  border-style:solid !important;border-color:var(--accent) !important;}` },
    /* ↓↓↓ 带图案装饰气泡（猫爪/颜文字/云朵/星河/草莓） ↓↓↓
       v2.24.11：按作者要求移除「兔耳光雾」预设（CSS 已单独导出留档） */
    { id:'bp-catpaw', name:'猫爪软垫', builtin:true, css:`
.bubble{background:var(--bp-cat-bg,rgba(255,240,244,.94)) !important;color:var(--bp-cat-ink,#7a5a66) !important;
  border:1.5px solid rgba(255,182,193,.6) !important;border-radius:20px !important;
  box-shadow:0 2px 8px rgba(255,182,193,.35) !important;
  position:relative !important;overflow:visible !important;z-index:9;}
.row.me .bubble{background:var(--bp-cat-me,rgba(255,214,224,.95)) !important;}
.row .bubble::before{content:'🐾' !important;position:absolute !important;font-size:14px !important;top:-10px !important;opacity:.9 !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::before{left:-7px !important;transform:rotate(-20deg) !important;}
.row:not(.me) .bubble::before{right:-7px !important;transform:rotate(18deg) !important;}
.row .bubble::after{content:'🐾' !important;position:absolute !important;font-size:10px !important;bottom:-6px !important;opacity:.5 !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::after{right:-4px !important;}
.row:not(.me) .bubble::after{left:-4px !important;}` },
    { id:'bp-kaomoji', name:'颜文字日记', builtin:true, css:`
.bubble{background:var(--bp-kao-bg,#fffdf6) !important;color:var(--bp-kao-ink,#6b5d43) !important;
  border:1px solid #f0e6d2 !important;border-radius:14px !important;
  box-shadow:0 2px 6px rgba(0,0,0,.06) !important;
  position:relative !important;overflow:visible !important;z-index:9;}
.row.me .bubble{background:var(--bp-kao-me,#fff3e0) !important;border-color:#ffd9a0 !important;}
.row .bubble::before{content:'(｡•ᴗ•｡)' !important;position:absolute !important;font-size:11px !important;color:#c9a86a !important;top:-17px !important;pointer-events:none !important;white-space:nowrap !important;z-index:9;}
.row.me .bubble::before{left:6px !important;}
.row:not(.me) .bubble::before{right:6px !important;}
.row .bubble::after{content:'♪' !important;position:absolute !important;font-size:12px !important;color:#e8c98f !important;bottom:-15px !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::after{right:2px !important;}
.row:not(.me) .bubble::after{left:2px !important;}` },
    { id:'bp-strawberry', name:'草莓奶昔', builtin:true, css:`
.bubble{background:linear-gradient(135deg,#ffe3ec,#ffd0de) !important;color:#9a5a72 !important;
  border:1px solid rgba(255,255,255,.85) !important;border-radius:18px !important;
  box-shadow:0 3px 9px rgba(255,150,180,.35) !important;
  position:relative !important;overflow:visible !important;z-index:9;}
.row.me .bubble{background:linear-gradient(135deg,#ffb8cd,#ff9db8) !important;color:#fff !important;}
.row .bubble::before{content:'🍓' !important;position:absolute !important;font-size:14px !important;top:-10px !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::before{right:-6px !important;transform:rotate(15deg) !important;}
.row:not(.me) .bubble::before{left:-6px !important;transform:rotate(-12deg) !important;}
.row .bubble::after{content:'🥛' !important;position:absolute !important;font-size:10px !important;bottom:-9px !important;opacity:.85 !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::after{left:8px !important;}
.row:not(.me) .bubble::after{right:8px !important;}` },
    { id:'bp-cloud', name:'云朵绵绵', builtin:true, css:`
.bubble{background:linear-gradient(180deg,#ffffff,#eef6ff) !important;color:#5a7a9a !important;
  border:1px solid rgba(255,255,255,.9) !important;border-radius:22px !important;
  box-shadow:0 3px 10px rgba(150,190,230,.35),inset 0 0 0 .5px #fff !important;
  position:relative !important;overflow:visible !important;z-index:9;}
.row.me .bubble{background:linear-gradient(180deg,#e3f0ff,#d0e6ff) !important;}
.row .bubble::before{content:'☁️' !important;position:absolute !important;font-size:16px !important;top:-13px !important;opacity:.9 !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::before{right:-9px !important;}
.row:not(.me) .bubble::before{left:-9px !important;}
.row .bubble::after{content:'' !important;position:absolute !important;width:14px !important;height:14px !important;border-radius:50% !important;background:rgba(255,255,255,.95) !important;bottom:-7px !important;box-shadow:0 1px 3px rgba(150,190,230,.4) !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::after{left:14px !important;}
.row:not(.me) .bubble::after{right:14px !important;}` },
    { id:'bp-star', name:'星河许愿', builtin:true, css:`.bubble{background:linear-gradient(135deg,#3b3b6d,#6a5b9e) !important;color:#f0ecff !important;
  border:1px solid rgba(255,255,255,.25) !important;border-radius:18px !important;
  box-shadow:0 3px 12px rgba(80,70,160,.45) !important;
  position:relative !important;overflow:visible !important;z-index:9;}
.row.me .bubble{background:linear-gradient(135deg,#5b4a8f,#8a6fc0) !important;}
.row .bubble::before{content:'✦' !important;position:absolute !important;font-size:13px !important;color:#ffe9a0 !important;top:-11px !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::before{left:-5px !important;}
.row:not(.me) .bubble::before{right:-5px !important;}
.row .bubble::after{content:'✧' !important;position:absolute !important;font-size:10px !important;color:#c9b8ff !important;bottom:-13px !important;pointer-events:none !important;z-index:9;}
.row.me .bubble::after{right:6px !important;}
.row:not(.me) .bubble::after{left:6px !important;}` },
    /* 仿微信气泡：绿/白 + 小三角角标，适合想要「像微信那样」的清爽对话感 */
    { id:'bp-wechat', name:'仿微信', builtin:true, css:`
/* 仿微信对话气泡：我=微信绿 #95ec69，ta=白底；右侧/左侧小尖角
   角标用 9×9 小方块旋转 45°，贴在同色气泡边缘形成尖角 */
.bubble{position:relative !important;overflow:visible !important;
  border:none !important;box-shadow:none !important;border-radius:4px !important;
  padding:9px 12px !important;line-height:1.45 !important;
  max-width:62% !important;font-size:15px !important;
  background-color:#ffffff !important;color:#191919 !important;}
.row.me .bubble{background-color:#95ec69 !important;color:#191919 !important;}
.row:not(.me) .bubble{background-color:#ffffff !important;color:#191919 !important;}
.row .bubble::after{content:'' !important;position:absolute !important;display:block !important;
  width:9px !important;height:9px !important;border-radius:1.5px !important;
  top:18px !important;transform:translateY(-50%) rotate(45deg) !important;
  pointer-events:none !important;}
.row.me .bubble::after{right:-3.8px !important;background-color:#95ec69 !important;}
.row:not(.me) .bubble::after{left:-3.8px !important;background-color:#ffffff !important;}
/* 微信气泡四角都是小圆角，拉平默认的尾巴圆角 */
.row .bubble{border-bottom-left-radius:4px !important;border-bottom-right-radius:4px !important;}` },
    { id:'bp-wechat-dark', name:'仿微信·夜间', builtin:true, css:`
/* 仿微信夜间模式：深色底 + 深绿气泡 */
.bubble{background:var(--bp-wxd-in,#2c2c2e) !important;color:#ededed !important;
  border:none !important;border-radius:5px !important;box-shadow:none !important;
  padding:9px 12px !important;line-height:1.45 !important;
  position:relative !important;overflow:visible !important;}
.row.me .bubble{background:var(--bp-wxd-out,#3eb575) !important;color:#0d0d0d !important;
  border-radius:5px !important;}
.row .bubble::after{content:'' !important;position:absolute !important;
  width:9px !important;height:9px !important;border-radius:1.5px !important;
  background:var(--bp-wxd-in,#2c2c2e) !important;top:13px !important;pointer-events:none !important;}
.row.me .bubble::after{right:-4px !important;background:var(--bp-wxd-out,#3eb575) !important;
  transform:rotate(45deg) !important;}
.row:not(.me) .bubble::after{left:-4px !important;background:var(--bp-wxd-in,#2c2c2e) !important;
  transform:rotate(45deg) !important;}
.row .bubble{border-bottom-left-radius:5px !important;border-bottom-right-radius:5px !important;}` },
  ];
}
/* 内置气泡的展示用色块（管理页预览） */
function bubPreviewStyle(p){
  if(p.id==='bp-glass') return 'background:var(--bp-glass-bg,rgba(255,255,255,.78));border:.5px solid var(--bp-glass-line,#fff);box-shadow:0 2px 8px rgba(0,0,0,.1);';
  if(p.id==='bp-letter') return 'background:var(--bp-letter-bg,var(--panel));border:1.5px dashed var(--ink-2);color:var(--ink);background-image:repeating-linear-gradient(transparent,transparent 6px,var(--line) 6px,var(--line) 7px);';
  if(p.id==='bp-rabbit') return 'background:rgba(255,255,255,.85);border:.5px solid #fff;border-radius:14px 14px 4px 14px;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#666;';
  if(p.id==='bp-catpaw') return 'background:rgba(255,240,244,.95);border:1.5px solid rgba(255,182,193,.6);border-radius:18px;color:#7a5a66;';
  if(p.id==='bp-kaomoji') return 'background:#fffdf6;border:1px solid #f0e6d2;border-radius:12px;color:#6b5d43;';
  if(p.id==='bp-strawberry') return 'background:linear-gradient(135deg,#ffe3ec,#ffd0de);border-radius:16px;color:#9a5a72;';
  if(p.id==='bp-cloud') return 'background:linear-gradient(180deg,#ffffff,#eef6ff);border-radius:18px;color:#5a7a9a;';
  if(p.id==='bp-star') return 'background:linear-gradient(135deg,#3b3b6d,#6a5b9e);border-radius:16px;color:#f0ecff;';
  if(p.id==='bp-wechat') return 'background:#95ec69;border-radius:5px;color:#191919;position:relative;';
  if(p.id==='bp-wechat-dark') return 'background:#3eb575;border-radius:5px;color:#0d0d0d;position:relative;';
  return 'background:var(--accent);color:var(--accent-ink);';
}
/* 字体预设：作用于聊天气泡（.bubble） */
const FONTS=[
  { id:'',             name:'系统默认', css:'' },
  { id:'f-serif',      name:'宋体·书卷', css:`.bubble{font-family:"Songti SC","STSong","Source Han Serif SC","Noto Serif SC",Georgia,serif !important;letter-spacing:.03em !important;}` },
  { id:'f-kai',        name:'楷体·手写', css:`.bubble{font-family:"Kaiti SC","STKaiti",KaiTi,"Kaiti TC",serif !important;font-size:16.5px !important;letter-spacing:.05em !important;}` },
  { id:'f-round',      name:'圆体·软糯', css:`.bubble{font-family:"Yuanti SC","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif !important;border-radius:22px !important;letter-spacing:.02em !important;}` },
  { id:'f-mono',       name:'等宽·手账', css:`.bubble{font-family:"SFMono-Regular",Menlo,Consolas,"Courier New",monospace !important;font-size:13.5px !important;letter-spacing:.01em !important;}` },
  { id:'f-thin',       name:'细体·清淡', css:`.bubble{font-weight:300 !important;letter-spacing:.06em !important;}` },
];
function fontCss(id){ const f=FONTS.find(x=>x.id===id); return f?f.css:''; }
/* 取某个预设的 CSS（内置 / 自定义统一） */
function bubCss(id){
  const list=(typeof state!=='undefined'&&state&&state.bubblePresets)||[];
  const p=list.find(x=>x.id===id);
  return p?p.css:'';
}
function curBubblePreset(){
  const list=(typeof state!=='undefined'&&state&&state.bubblePresets)||[];
  return list.find(p=>p.id===state.settings.bubbleStyle)||null;
}

/* ================= 状态 ================= */
function defaultState(){
  const c1 = 'c' + Date.now();
  return {
    settings:{
      myName:'我', taName:'梦角',
      replyMin:5, replyMax:50, gapMin:3, gapMax:5,
      autoReply:true, deskCheck:false,
      proactiveMsg:true,   /* 联系人主动发消息（每 30 分钟 40% 概率，v2.20.0） */
      /* 概率控制（0-100） */
      callInProb:25,        /* 联系人主动来电概率 */
      callAnswer:85,        /* 打电话被接通概率 */
      stickerProb:20,       /* 回复时发表情包概率 */
      patProb:20,           /* 拍一拍后对方回应概率 */
      deskCheckProb:50,     /* 挂桌面查岗触发概率 */
      readNoReply:false,    /* 已读不回模式 */
      readNoProb:60,        /* 已读后不回复的概率 */
      groupReplyProb:70,    /* 群聊里每位成员在我发消息后独立回复的概率（v2.22.0） */
      callHangProb:20,      /* 通话中联系人在线挂断的概率（v2.22.0，默认 20%） */
      privWeight:1,         /* 专用字卡加权倍率：每张专用卡按 N 张公用卡参与抽取（1=按张数比例，v2.22.0） */
      momentProb:40,        /* 联系人每日发朋友圈概率（命中后发 1~2 条） */
      letterProb:50,        /* 联系人每日写信概率（v2.24.15 由 12% 上调；连续 2 天没写自动抬到 80%） */
      surveyAskProb:37,     /* 联系人每日主动向我提问的概率（v2.23.0，默认 37%） */
      listenAcceptProb:85,  /* 邀请一起听时 ta 应邀的概率（v2.23.0） */
      momentLikeProb:70,    /* 联系人给我朋友圈点赞的概率 */
      momentCommentProb:35, /* 联系人给我朋友圈评论的概率 */
      gameInviteProb:50,    /* 邀请联系人玩游戏时 ta 应邀的概率 */
      soundOn:true,         /* 消息提示音（WebAudio 风铃音，无外部文件） */
      soundVol:0.5,         /* 提示音音量 0~1 */
      notifyOn:true,        /* 系统推送通知（Notification API） */
      bgNotify:true,        /* v2.24.12 后台消息通知：退出网站但没清后台时，手机仍收到通知 */
      momentWall:{type:'grad',data:''},  /* 朋友圈背景 */
      cardMax:3,            /* 单次回复字卡上限（1~4） */
      myAvatar:'',          /* 我的头像（avatarLib 里的 id） */
      accent:'#1c1c1e', bubbleR:18,
      wallpaper:{ type:'dots', data:'' },
      chatWallpaper:{ type:'plain', data:'' },
      userCss:'',
      darkMode:false,            /* 夜间模式：全界面深色 */
      bubbleFont:'',             /* 聊天字体预设 id（见 FONTS，空=系统默认） */
      inputCollapsed:true,       /* 聊天输入栏默认收起 */
    },
    cats: defaultLibrary(),
    /* 拍一拍库：独立功能组件，双向两组文案（共用同一批词卡，按方向自动套「xx拍了xx」）
       me = 我拍ta 时可用；ta = ta拍我 时可用 */
    patLib: { me:[...DEFAULT_PAT_LINES], ta:[...DEFAULT_PAT_LINES] },
    /* v2.24.11：标记「默认拍一拍词卡已播种」—— 新用户即视为已播种（默认库本就为空），
       用户后续自行清空时不再被 migrate 回填。 */
    patDefaultsSeeded: true, patPlaceholderSeeded: true,
    privLibs:{},                       /* 专用字卡库：{ [contactId]: { enabled, cats:[{name,enabled,cards}] } } */
    marketItems: MARKET_ITEMS.map(i=>({...i})),  /* 闲屿小集货品（可自行增删） */
    wishes:[],                         /* 心愿单 */
    stickers: DEFAULT_STICKERS.map(s=>({...s})),
    myStickers: [],                    /* 我的表情包：只有我能发送，ta 不会使用 */
    avatarLib: DEFAULT_AVATARS.map(a=>({...a})),
    /* 气泡预设库：内置若干 + 用户粘贴 CSS 保存的自定义气泡（可改名 / 可删除） */
    bubblePresets: defaultBubblePresets(),
    coins: 66,
    contacts:[{ id:c1, name:'梦角', avatar:'a1', avatarLib:DEFAULT_AVATARS.map(a=>({...a})), stickers:[] }],
    groups:[],
    chats:{ [c1]:[{ role:'ta', text:'链接上了', t:Date.now() }] },
    moments:[
      { id:'m'+Date.now(), author:c1, text:'今天天气好舒服，想和你一起晒太阳☀️', t:Date.now()-3600e3, likes:[], comments:[] }
    ],
    letters:[], diary:[], calNotes:{}, anniversaries:[],
    survey:{ bank:[...DEFAULT_QUESTIONS], records:[] },
    music:{ tracks:[], cur:null, playing:false },      /* v2.23.0：音乐（网易云外链歌单）；v2.24.0 加 playing（未播放时组件不律动） */
    widgets:{ cal:{note:''}, photo:{img:'',cap:''} },  /* v2.23.0：桌面小组件内容 */
    listen:null,                                       /* v2.23.0：一起听会话 {name,artist,with,since,ncId} */
    desk:[],                                           /* v2.24.0：桌面布局顺序 ['wdg:photo','app:chat',…]；空数组=首次自动生成 */
    period:{ records:[], cycle:28 },
    cart:[], cabinet:[],
    lastSign:'', tracking:[],
    dailyRoll:'', letterStreak:0, avatarRollDay:''
  };
}
/* URL 参数：
   ?fresh=1  清空本机数据，回到全新初始状态（用于「新设备体验」/重新开始）
   ?pass=xxx 配合口令门做一次性访问（不落盘） */
function handleUrlFlags(){
  let q=null; try{ q=new URLSearchParams(location.search); }catch(e){ return; }
  if(q.get('fresh')==='1'){
    try{
      localStorage.setItem('tonghuayu_idb_wipe','1');   /* v2.24.9：大库也要清（开机校时见 idbBootCheck） */
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem('tonghuayu_skip_splash');
      localStorage.removeItem('tonghuayu_notice_ok');   /* v2.24.12：?fresh=1 也要重看须知 */
      localStorage.removeItem('th_miniPos');
      localStorage.removeItem('th_pass_ok_v');          /* v2.24.12：连同「本设备已通过口令」一起清掉 */
      sessionStorage.removeItem('th_pass_ok');
    }catch(e){}
    try{ history.replaceState(null,'',location.pathname+(q.get('v')?('?v='+q.get('v')):'')); }catch(e){}
  }
}
handleUrlFlags();
let state = load();
function load(){
  let raw=null;
  try{ raw = localStorage.getItem(LS_KEY); }catch(e){}
  if(raw){
    let s=null;
    try{ s=JSON.parse(raw); }catch(e){ s=null; }
    /* 兼容判定放宽：只要像个存档就拿来用（旧版只认 settings+cats+contacts 三件套，
       老备份缺 cats 时会被静默丢弃 → 整份重置，v2.24.1 修复） */
    if(s && typeof s==='object' && (s.settings || Array.isArray(s.cats) || Array.isArray(s.contacts))){
      try{
        if(!Array.isArray(s.cats)) s.cats=[];
        if(!Array.isArray(s.contacts)) s.contacts=[];
        if(!s.settings||typeof s.settings!=='object') s.settings=defaultState().settings;
        migrate(s);
        return s;
      }catch(e){
        try{ console.warn('[彤话屿] 存档迁移失败，改为原样载入', e); }catch(_){}
        /* 迁移炸了也要把用户数据留在屏幕上；用默认值兜住缺失字段（只改内存，不落盘覆盖） */
        try{
          const d=defaultState();
          Object.keys(d).forEach(k=>{ if(s[k]===undefined) s[k]=d[k]; });
          Object.keys(d.settings).forEach(k=>{ if(s.settings[k]===undefined) s.settings[k]=d.settings[k]; });
          return s;
        }catch(_){
          try{
            if(localStorage.getItem(LS_KEY+'_bak')) return loadRaw(localStorage.getItem(LS_KEY+'_bak'));
          }catch(_){}
        }
      }
    }else{
      /* 内容不像存档（例如被截断）——先试「最近一次正常存档」 */
      try{
        const bak=localStorage.getItem(LS_KEY+'_bak');
        if(bak) return loadRaw(bak);
      }catch(e){}
    }
  }
  return defaultState();
}
function loadRaw(raw){
  const s=JSON.parse(raw);
  if(typeof s!=='object'||s===null) throw new Error('bad');
  if(!Array.isArray(s.cats)) s.cats=[];
  if(!Array.isArray(s.contacts)) s.contacts=[];
  if(!s.settings||typeof s.settings!=='object') s.settings=defaultState().settings;
  try{ migrate(s); }catch(e){}
  return s;
}
/* 旧版本数据补齐新增字段 */
function migrate(s){
  const d = defaultState();
  const keys = ['callInProb','callAnswer','stickerProb','patProb','deskCheckProb','accent','bubbleR','userCss','readNoReply','readNoProb','myAvatar','soundOn','soundVol','notifyOn'];
  keys.forEach(k=>{ if(s.settings[k]===undefined) s.settings[k]=d.settings[k]; });
  /* v2.22.0：专用字卡由「命中闸门（privProb）」改为「公用+专用合并大池 + 加权倍率」。
     老存档的 privProb 语义已被取代（它会让只有几张的专用库占 70% 抽取量），整键移除。 */
  delete s.settings.privProb;
  if(s.settings.privWeight===undefined||s.settings.privWeight===null||s.settings.privWeight==='') s.settings.privWeight=1;
  if(s.settings.groupReplyProb===undefined||s.settings.groupReplyProb===null||s.settings.groupReplyProb==='') s.settings.groupReplyProb=70;
  if(s.settings.callHangProb===undefined||s.settings.callHangProb===null||s.settings.callHangProb==='') s.settings.callHangProb=20;
  /* v2.15 新增概率项：动态/来信/朋友圈互动/游戏邀请（老存档补默认值） */
  [['momentProb',40],['letterProb',50],['momentLikeProb',70],['momentCommentProb',35],['gameInviteProb',50]]
    .forEach(([k,def])=>{ if(s.settings[k]===undefined||s.settings[k]===null||s.settings[k]==='')s.settings[k]=def; });
  /* v2.24.15：写信概率基准 12% → 50%。老存档「没动过」的典型值就是旧默认 12
     （以及 slider 落点可能产生的 11~19 邻近值）→ 抬到 50。
     ⚠️ 只认 12 本身，不做区间猜测：区间会误伤用户自己调过的值
     （比如用户主动设成 30 想"少写点"，区间迁移会把它顶回 50，那是改用户的数据）。
     0（永不写信）与其它自定义值一律保持不动。 */
  { const lp=parseInt(s.settings.letterProb,10);
    if(lp===12) s.settings.letterProb=50; }
  /* v2.23.0：问卷主动提问概率 / 一起听应邀概率（老存档补默认值） */
  if(s.settings.surveyAskProb===undefined||s.settings.surveyAskProb===null||s.settings.surveyAskProb==='') s.settings.surveyAskProb=37;
  if(s.settings.listenAcceptProb===undefined||s.settings.listenAcceptProb===null||s.settings.listenAcceptProb==='') s.settings.listenAcceptProb=85;
  /* v2.23.0：音乐歌单 + 桌面小组件 + 一起听会话 */
  if(!s.music||typeof s.music!=='object') s.music={tracks:[],cur:null,playing:false};
  if(!Array.isArray(s.music.tracks)) s.music.tracks=[];
  if(s.music.cur===undefined) s.music.cur=null;
  if(s.music.playing===undefined) s.music.playing=false;   /* v2.24.0：老存档默认未播放 */
  if(!s.widgets||typeof s.widgets!=='object') s.widgets={cal:{note:''},photo:{img:'',cap:''}};
  if(!s.widgets.cal||typeof s.widgets.cal!=='object') s.widgets.cal={note:''};
  if(!s.widgets.photo||typeof s.widgets.photo!=='object') s.widgets.photo={img:'',cap:''};
  if(s.listen===undefined) s.listen=null;
  if(s.listen&&s.listen.ncId===undefined) s.listen.ncId=''; /* v2.24.0：一起听带歌曲 ID，聊天横幅可播 */
  /* v2.24.0：桌面布局顺序（小组件+应用混排，可拖拽）。
     ⚠️ 关键：这里不能调用 deskEnsure（它依赖 APPS / DESK_WIDGETS），
     而 load() 在模块顶层执行，那些 const 还在暂时性死区里，
     一调用就抛 ReferenceError → 被外层 try 吞掉 → 整份存档被判废、直接重置。
     v2.24.1 修复：载入期只做「是数组」的规整，真正的补全交给启动后的 deskEnsure。 */
  if(!Array.isArray(s.desk)) s.desk=[];
  /* v2.24.2：桌面布局版本号 —— 旧存档没有该字段，标记为 1（旧布局），
     启动后由 renderDesktop 一次性迁移到 DESK_VER=2 的新默认布局。
     注意：这里不能引用 DESK_VER 常量（TDZ），只能写数字字面量。 */
  if(s.deskVer===undefined||s.deskVer===null) s.deskVer=1;
  /* v2.24.7：一起听悬浮播放器的拖动位置（null = 用默认右下角） */
  if(s.muPos===undefined) s.muPos=null;
  if(!Array.isArray(s.myStickers)) s.myStickers=[];
  if(!s.settings.momentWall) s.settings.momentWall={type:'grad',data:''};
  if(!s.settings.wallpaper) s.settings.wallpaper={type:'dots',data:''};
  if(!s.settings.chatWallpaper) s.settings.chatWallpaper={type:'plain',data:''};
  if(!Array.isArray(s.stickers)) s.stickers=DEFAULT_STICKERS.map(x=>({...x}));
  if(!Array.isArray(s.groups)) s.groups=[];
  /* v2.18.0：群聊头像字段（emoji 或 null=默认首字） */
  s.groups.forEach(g=>{ if(g.avatar===undefined)g.avatar=null; });
  /* v2.21.0：群头像库（自建库，支持自定义 emoji / 上传图片）；预设仍直接存字符串 */
  s.groups.forEach(g=>{ if(!Array.isArray(g.avatarLib)) g.avatarLib=[]; });
  /* ⚠️ v2.24.12：这里以前是「空了就回填默认库」—— 默认库既已清空（DEFAULT_AVATARS=[]），
     这个回填就变成了「用户清空头像库后又被判定为空 → 死循环清不干净」的坑。
     改为「只在字段不存在时初始化一次」，用户自己清空就是真的清空。 */
  if(!Array.isArray(s.avatarLib)) s.avatarLib=DEFAULT_AVATARS.map(a=>({...a}));
  if(s.dailyRoll===undefined) s.dailyRoll='';
  if(s.letterStreak===undefined) s.letterStreak=0;
  if(s.avatarRollDay===undefined) s.avatarRollDay='';
  if(!s.settings.cardMax) s.settings.cardMax=3;
  if(!s.settings.bubbleStyle) s.settings.bubbleStyle='default';
  if(s.settings.darkMode===undefined) s.settings.darkMode=false;
  if(s.settings.bubbleFont===undefined) s.settings.bubbleFont='';
  if(s.settings.inputCollapsed===undefined) s.settings.inputCollapsed=true;
  /* v2.20.0：联系人主动发消息开关（老存档补默认开启） */
  if(s.settings.proactiveMsg===undefined) s.settings.proactiveMsg=true;
  /* 气泡预设库：旧版本用 'default'/'glass'/'outline' 作为 id，这里统一映射到 bp-* */
  const BP_OLD={ default:'bp-classic', glass:'bp-glass', outline:'bp-outline', '':'bp-classic' };
  if(BP_OLD[s.settings.bubbleStyle]!==undefined) s.settings.bubbleStyle=BP_OLD[s.settings.bubbleStyle];
  if(!Array.isArray(s.bubblePresets)||!s.bubblePresets.length) s.bubblePresets=defaultBubblePresets();
  else{
    /* 内置预设始终存在（保证可用）；但用户改过的名字要保留 —— 只补缺失的 id */
    const defs=defaultBubblePresets();
    defs.forEach(d=>{
      const cur=s.bubblePresets.find(x=>x.id===d.id);
      if(!cur) s.bubblePresets.push(d);
      else if(!cur.builtin) cur.builtin=true;
    });
  }
  /* v2.12.2 起移除的内置款（描边素白/水墨宣纸/圆软气泡）：从库里清掉，引用自动回落 */
  const BP_GONE=['bp-outline','bp-ink','bp-bubble2'];
  if(Array.isArray(s.bubblePresets)){
    s.bubblePresets=s.bubblePresets.filter(p=>!(p.builtin&&BP_GONE.indexOf(p.id)>=0));
    s.contacts.forEach(c=>{ if(BP_GONE.indexOf(c.bubbleId)>=0)c.bubbleId=''; });
    (s.groups||[]).forEach(g=>{ if(BP_GONE.indexOf(g.bubbleId)>=0)g.bubbleId=''; });
  }
  if(BP_GONE.indexOf(s.settings.bubbleStyle)>=0) s.settings.bubbleStyle='bp-classic';
  if(!s.bubblePresets.some(p=>p.id===s.settings.bubbleStyle)) s.settings.bubbleStyle='bp-classic';
  /* 老用户：data-theme 未设置时按系统偏好来一次 */
  if(s.__themeInit!==1){
    s.__themeInit=1;
    if(!localStorage.getItem('tonghua_world_v2')){
      /* 全新用户才跟随系统，避免老用户被突然切成深色 */
      try{ if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches) s.settings.darkMode=true; }catch(e){}
    }
  }
  /* 专用字卡库（每位联系人独立） */
  if(!s.privLibs||typeof s.privLibs!=='object') s.privLibs={};
  /* 拍一拍库：独立功能组件（旧版本存于字卡库「拍一拍」分类，自动迁移）
     v2.13.0 起改为双向两组 {me:[], ta:[]}；旧扁平数组合并到两组 */
  if(Array.isArray(s.patLib)){
    const flat=s.patLib.slice();
    s.patLib={ me:flat.slice(), ta:flat.slice() };
  }
  if(!s.patLib||typeof s.patLib!=='object') s.patLib={ me:[], ta:[] };
  if(!Array.isArray(s.patLib.me)) s.patLib.me=[];
  if(!Array.isArray(s.patLib.ta)) s.patLib.ta=[];
  /* v2.24.11：默认词卡只给「全新用户」注入一次，并立 flag。
     用户（含作者）后来把拍一拍库清空 → 视为有意清空，不再补回（否则删了又回来）。 */
  if(!s.patDefaultsSeeded){
    if(!s.patLib.me.length&&!s.patLib.ta.length){
      s.patLib={ me:[...DEFAULT_PAT_LINES], ta:[...DEFAULT_PAT_LINES] };
    }
    s.patDefaultsSeeded=true;
  }
  {
    const pc=s.cats.find(c=>c.name==='拍一拍');
    if(pc){ pc.cards.forEach(l=>{ if(!s.patLib.me.includes(l))s.patLib.me.push(l);
                                 if(!s.patLib.ta.includes(l))s.patLib.ta.push(l); });
            s.cats=s.cats.filter(c=>c.name!=='拍一拍'); }
    if(Array.isArray(s.settings.patLines)) s.settings.patLines.forEach(l=>{
      if(!s.patLib.me.includes(l))s.patLib.me.push(l);
      if(!s.patLib.ta.includes(l))s.patLib.ta.push(l);
    });
  }
  delete s.settings.patLines;
  /* v2.24.1：问卷（题库 + 记录）——老存档缺这个字段时问卷页会直接崩，必须补 */
  if(!s.survey||typeof s.survey!=='object') s.survey={};
  if(!Array.isArray(s.survey.bank)) s.survey.bank=[...DEFAULT_QUESTIONS];
  if(!Array.isArray(s.survey.records)) s.survey.records=[];
  /* v2.24.1：其余列表型字段统一兜底（缺了会白屏的功能库） */
  if(!Array.isArray(s.diary)) s.diary=[];
  if(!s.calNotes||typeof s.calNotes!=='object') s.calNotes={};
  if(!Array.isArray(s.anniversaries)) s.anniversaries=[];
  if(!s.period||typeof s.period!=='object') s.period={};
  if(!Array.isArray(s.period.records)) s.period.records=[];
  if(!s.period.cycle) s.period.cycle=28;
  if(!Array.isArray(s.cart)) s.cart=[];
  if(!Array.isArray(s.cabinet)) s.cabinet=[];
  if(!Array.isArray(s.tracking)) s.tracking=[];
  /* v2.15：新增「双向占位句」示例词卡（{ta}/{me} 占位，两个方向都通）。
     只在用户还没加过同类词卡时补一次，不覆盖用户自己的编辑。
     v2.24.11：仅在默认词卡「本次注入」时随之补占位句 —— 用户清空后不再自动回填。 */
  if(s.patDefaultsSeeded && !s.patPlaceholderSeeded){
    const hasPlaceholder=()=>['me','ta'].some(k=>(s.patLib[k]||[]).some(t=>/\{(ta|me)\}/.test(t)));
    if(!hasPlaceholder()){
      const samples=['戳了戳{ta}的脸颊','拉了拉{ta}的衣角','拍了拍{ta}的肩膀','揉了揉{ta}的头发',
                     '轻轻弹了下{ta}的额头','捏了捏{ta}的脸','把{ta}的碎发别到耳后'];
      ['me','ta'].forEach(k=>{
        samples.forEach(t=>{ if(!s.patLib[k].includes(t)) s.patLib[k].push(t); });
      });
    }
    s.patPlaceholderSeeded=true;
  }
  /* 闲屿小集货品：可自行增删的独立列表（旧数据用默认货品初始化） */
  if(!Array.isArray(s.marketItems)||!s.marketItems.length) s.marketItems=MARKET_ITEMS.map(i=>({...i}));
  if(!Array.isArray(s.wishes)) s.wishes=[];
  /* 联系人头像字段：专属头像库 + 专属表情包库（每人独立，互不互通） */
  s.contacts.forEach(c=>{
    if(c.avatar===undefined)c.avatar='';
    /* v2.24.12：同上 —— 只在字段缺失时初始化，用户清空的库不再被回填 */
    if(!Array.isArray(c.avatarLib))c.avatarLib=DEFAULT_AVATARS.map(a=>({...a}));
    if(!Array.isArray(c.stickers))c.stickers=[];
  });
  /* v2.17.0：朋友圈互动通知（右上角铃铛） */
  if(!Array.isArray(s.momNotices)) s.momNotices=[];
  if(!Number.isFinite(+s.momUnread)) s.momUnread=0; else s.momUnread=+s.momUnread;
  /* v2.24.21：还没到点的朋友圈互动待办（关掉网页后重新进站也要能补上） */
  if(!Array.isArray(s.momPending)) s.momPending=[];
  /* v2.22.0：信件新增「收藏 star」「我的回信 myReply」字段（老存档补齐） */
  if(!Array.isArray(s.letters)) s.letters=[];
  s.letters.forEach(l=>{ if(l.star===undefined) l.star=false; });
  /* v2.22.0：问卷「向谁提问 / 谁向我提问」——curQ / curQ2 由字符串升级为 {q, who} */
  if(typeof s.curQ2==='string') s.curQ2={q:s.curQ2, who:''};
  if(s.curQ&&typeof s.curQ==='object'&&s.curQ.who===undefined) s.curQ.who='';
  return s;
}
/* ================= 存档写入（v2.24.8 重写：根治「保存失败 → 数据丢失」） =================

   【旧版致命缺陷】v2.24.7 及以前：
     try{ localStorage.setItem(LS_KEY, str); }
     catch(e){ toast('保存失败：本地存储不可用'); return; }   ← 直接 return
     try{ localStorage.setItem(LS_KEY+'_bak', str); }catch(e){}  ← 备份也没写成

   写入超限（QuotaExceededError）时主键与 _bak **双双没更新**，用户新存的字卡 / 表情包 /
   聊天记录全部只存在于内存里，一刷新就回滚到很久以前的旧档 —— 也就是「数据没了」。

   【新版策略】四道保险：
     1. 顺序反过来：**先写 _bak 兜底快照，再写主键**（主键失败也留得住退路）
     2. 主键失败 → 自动**瘦身重试**（压缩历史图片、砍最旧聊天记录），最多重试 3 轮
     3. 瘦身成功后**明确告知**用户「已自动清理，数据保住了」
     4. 彻底写不进 → 只弹一次提示 + 给「导出备份」入口，**绝不静默丢弃** */

/* 估算 localStorage 已用字节数（含所有键） */
function lsUsedBytes(){
  let n=0;
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k==null) continue;
      const v=localStorage.getItem(k)||'';
      n += k.length + v.length;      /* UTF-16 粗估：字符数 ≈ 字节数（中文略高，够用） */
    }
  }catch(e){}
  return n;
}
/* localStorage 配额（多数浏览器 5MB，按字符估） */
const LS_QUOTA = 5*1024*1024;
/* 图片压缩开关：保留原图会让存档迅速膨胀，这里统一走压缩 */
function shrinkStateForSave(s){
  let freed=0;
  const tryShrink=(obj,key,maxW,q)=>{
    const v=obj&&obj[key];
    if(typeof v!=='string'||v.indexOf('data:image')!==0) return;
    if(v.length<40*1024) return;                 /* 小于 40KB 不值得压 */
    /* 同步压缩：用 canvas 生成更小的 dataURL（压缩是异步的，这里退而求其次 —— 只在
       明确超限时才做，且失败就保留原样。真正的异步压缩在图片入口处已做） */
    try{
      const before=v.length;
      /* 无法同步压缩时，至少把超大的图片库条目降级为空（保功能不保画质） */
      if(obj.__imgShrinkable!==false && typeof obj[key]==='string'){
        // 保守做法：交给 pruneImages 处理，这里只统计
      }
      freed += 0;
      if(before){ /* noop */ }
    }catch(e){}
  };
  void tryShrink;
  /* 真正的瘦身：清超龄图片缓存 */
  freed += pruneImages(s, true);
  return freed;
}
/* 清理最旧的非在用图片（头像库 / 表情包库 / 我的表情包），返回释放的字符数。
   aggressive=true 时下手更狠（超限重试才用）。 */
function pruneImages(s, aggressive){
  let freed=0;
  const keepId=(lib,aid)=>aid;   /* 正在使用的 id 必须保留 */
  const pruneLib=(lib,limit,usedIds)=>{
    if(!Array.isArray(lib)) return 0;
    const imgs=lib.filter(x=>x&&x.type==='img'&&typeof x.data==='string');
    if(imgs.length<=limit) return 0;
    let f=0;
    /* 从最旧（数组前部）开始淘汰，但跳过正在使用的 */
    const overflow=imgs.length-limit;
    let removed=0;
    for(let i=0;i<lib.length&&removed<overflow;i++){
      const it=lib[i];
      if(!it||it.type!=='img') continue;
      if(usedIds&&usedIds.indexOf(it.id)>=0) continue;
      f += it.data.length;
      lib.splice(i,1); i--; removed++;
    }
    return f;
  };
  const avaLimit   = aggressive? 20 : 40;
  const stkLimit   = aggressive? 30 : 60;
  /* ⚠️ 关键：先把「全局正在使用的头像 id」都收集起来。
     头像 id（如 a1）在各库里是**共享引用**的 —— 顶层的 s.avatarLib 里的一张，
     可能正被某位联系人当头像用。只保护 settings.myAvatar 会把别人在用的图删掉。
     v2.24.8：改为收集全部在用 id 后再逐个库清理。 */
  const usedAvaIds=[];
  if(s.settings&&s.settings.myAvatar) usedAvaIds.push(s.settings.myAvatar);
  (s.contacts||[]).forEach(c=>{ if(c&&c.avatar) usedAvaIds.push(c.avatar); });
  (s.groups||[]).forEach(g=>{ if(g&&g.avatar) usedAvaIds.push(g.avatar); });
  /* 我的头像库：保护所有在用头像 */
  freed += pruneLib(s.avatarLib, avaLimit, usedAvaIds);
  /* 我的表情包库 */
  freed += pruneLib(s.myStickers, stkLimit, null);
  /* 每位联系人：专属头像库 + 专属表情包 */
  (s.contacts||[]).forEach(c=>{
    freed += pruneLib(c.avatarLib, avaLimit, [c.avatar]);
    freed += pruneLib(c.stickers, stkLimit, null);
  });
  /* 群聊头像库 */
  (s.groups||[]).forEach(g=>{
    freed += pruneLib(g.avatarLib, avaLimit, [g.avatar]);
  });
  /* 朋友圈配图：最多保留最近 40 张 */
  if(Array.isArray(s.moments)){
    const withImg=s.moments.filter(m=>m&&typeof m.img==='string'&&m.img.indexOf('data:')===0);
    if(withImg.length>(aggressive?20:40)){
      let removed=0, need=withImg.length-(aggressive?20:40);
      for(let i=0;i<s.moments.length&&removed<need;i++){
        const m=s.moments[i];
        if(m&&typeof m.img==='string'&&m.img.indexOf('data:')===0){
          freed += m.img.length; m.img=''; removed++;
        }
      }
    }
  }
  /* 聊天记录里的图片消息：只保留最近 60 条 */
  const chatImgLimit = aggressive? 30 : 60;
  Object.keys(s.chats||{}).forEach(cid=>{
    const arr=s.chats[cid];
    if(!Array.isArray(arr)) return;
    const imgIdx=[];
    arr.forEach((m,i)=>{ if(m&&typeof m.img==='string'&&m.img.indexOf('data:')===0) imgIdx.push(i); });
    if(imgIdx.length>chatImgLimit){
      const need=imgIdx.length-chatImgLimit;
      for(let k=0;k<need;k++){ const i=imgIdx[k]; freed += arr[i].img.length; arr[i].img=''; }
    }
  });
  return freed;
}
let saveFailToastAt=0, saveMirrorToastAt=0, idbFailStreakSave=0;
/* v2.24.12：两条「存储类」提示都改成「每次会话最多一次」
   —— 以前是 6 秒 / 30 秒节流，写满之后一天能弹上百回，用户受不了。 */
let saveFailToasted=false, mirrorFullToasted=false;
function save(){
  if(!state) return false;                 /* v2.24.1：迁移失败时 state 可能为 null，禁止把空值写回 */

  /* v2.24.9 ⓪ 启动校时未完成：只写快取、不碰大库、不盖时间戳。
     否则启动首存会把「可能过期的快取」提前盖进大库，把大库里更新的存档冲掉
     （典型场景：上次快取写满没写成、只有大库救住了 —— 那正是本版要根治的路径）。 */
  const gating = !idbGateDone;
  if(gating) idbPendingSave=true;
  else{ try{ state.savedAt=Date.now(); }catch(e){} }   /* 「大库 vs 快取谁新用谁」全靠它 */

  let str;
  try{ str=JSON.stringify(state); }
  catch(e){
    try{ console.warn('[彤话屿] 存档序列化失败', e); }catch(_){}
    return false;
  }

  /* ⓪·五 大容量主库（IndexedDB）：完整存档进大库，快取写满也丢不了。
     校时完成才写（闸门见 idbBootCheck）；写失败自动限次重试，不致命。 */
  if(!gating){
    try{
      idbPut(str).then(function(v){
        if(v===false){
          idbFailStreakSave++;
          if(idbFailStreakSave<=3){ const d=idbFailStreakSave*600; setTimeout(function(){ try{ save(); }catch(_){} }, d); }
        }else{ idbFailStreakSave=0; }
      });
    }catch(e){}
  }

  /* ① 先写兜底快照（即使主键写失败，下次启动仍能从这里恢复）。
     ⚠️ 注意：主键与 _bak 共享同一份配额（同源 5MB），所以 _bak 不能一直留着
     瘦身前的「大版本」占地方 —— 瘦身后会在下面重写一次。 */
  let mStr=str, shrankTotal=0, wroteBak=true;
  try{ localStorage.setItem(LS_KEY+'_bak', str); }catch(e){ wroteBak=false; }

  /* ② 写主键（快取）；失败 → 用「瘦身副本」重试（最多 3 轮，逐轮加大力度）。
     ⚠️ v2.24.9 关键变化：瘦身只瘦「写进快取的副本」，绝不动内存里的正式数据 ——
     正式数据住大容量库，一分都不会删（快取只是下次开机秒读用的镜像）。 */
  let ok=false, lastErr=null;
  for(let round=0; round<3 && !ok; round++){
    try{ localStorage.setItem(LS_KEY, str); ok=true; break; }
    catch(e){
      lastErr=e;
      /* 只对「配额超限」做瘦身；其它错误（如隐私模式禁用）不折腾 */
      const isQuota = e && (e.name==='QuotaExceededError' ||
                            e.name==='NS_ERROR_DOM_QUOTA_REACHED' ||
                            e.code===22 || e.code===1014);
      if(!isQuota) break;
      /* 瘦身副本：砍掉超龄图片 / 旧聊天记录（只动副本） */
      let copy=null;
      try{ copy=JSON.parse(mStr); }catch(_){ break; }
      if(!copy || typeof copy!=='object') break;
      const before=mStr.length;
      shrankTotal += pruneImages(copy, round>=1);
      /* 第二轮起再砍最旧的聊天记录（每条会话最少留 120 条） */
      if(round>=1){
        Object.keys(copy.chats||{}).forEach(cid=>{
          const arr=copy.chats[cid];
          if(Array.isArray(arr)&&arr.length>120){
            const cut=arr.length-120;
            copy.chats[cid]=arr.slice(cut);
            shrankTotal += cut*80;   /* 粗估 */
          }
        });
      }
      let nStr;
      try{ nStr=JSON.stringify(copy); }catch(_){ break; }
      if(nStr.length>=before) break;   /* 瘦不动了，别死循环 */
      mStr=nStr;
      /* 🔑 关键：立即用「瘦身后的版本」刷新 _bak。
         否则 _bak 一直是瘦身前的大版本，与主键一起把配额占满，
         主键永远写不进去 —— 这正是「怎么重试都保存失败」的死结。
         先删旧 _bak 再写，避免删改瞬间的中间态也超限。 */
      try{ localStorage.removeItem(LS_KEY+'_bak'); }catch(_){}
      try{ localStorage.setItem(LS_KEY+'_bak', mStr); }catch(_){}
      /* 瘦身副本立即试写主键（完整版写不下，副本通常能写下） */
      try{ localStorage.setItem(LS_KEY, mStr); ok=true; break; }catch(e2){ lastErr=e2; }
    }
  }

  if(ok){
    if(shrankTotal>0){
      /* 快取瘦身成功 —— 明确告知（正式数据在大库，一条不少） */
      const now=Date.now();
      if(now-saveFailToastAt>8000){
        saveFailToastAt=now;
        toast('快取已自动整理（省 '+Math.round(shrankTotal/1024)+'KB），完整数据都在大容量库');
      }
    }
    /* ③ 落盘成功后刷新设置页快照（避免误报「有改动没保存」） */
    if(currentApp!=='set') snapSaved();
    /* ④ 主键写成功后再补一次 _bak，保证「主键与备份内容一致」。
       放在最后是因为配额紧张时，主键优先（它才是启动读取的那份）；
       _bak 只作兜底，写不进也无妨（try 吞掉即可）。 */
    if(shrankTotal>0 && wroteBak){
      try{ localStorage.removeItem(LS_KEY+'_bak'); }catch(_){}
      try{ localStorage.setItem(LS_KEY+'_bak', mStr); }catch(_){}
    }
    return true;
  }

  /* ⑤ 快取彻底写不进 —— v2.24.9：先看大容量库接没接住 */
  if(gating || idbBroken || !idbVerified){
    /* 校时未完成 / 环境没有大库 / 大库还没验证可用 → 按旧口径处理：
       明确告知 + 只弹一次，绝不静默丢数据 */
    try{ console.error('[彤话屿] 存档写入失败', lastErr); }catch(_){}
    /* v2.24.12：同样从「6 秒一次」改成「每次会话最多一次」——这条是真·需要用户处理的告警，
       但反复弹只会让人麻木，第一次看到就够了。 */
    if(!saveFailToasted){
      saveFailToasted=true;
      saveFailToastAt=Date.now();
      toast('存储已满，这次改动没能存下 —— 请去设置导出备份后清理');
      /* 内存里的 state 仍在，本次会话照常可用；只是刷新后可能回滚到上一次成功存档。 */
    }
    return false;
  }
  /* 大库已验证可用：完整数据已提交（或正在提交）大库，快取满了也不丢 */
  try{ console.warn('[彤话屿] 快取已满，本次改动由大容量库接管', lastErr); }catch(_){}
  /* v2.24.12：这条「快取已满」以前每 30 秒就冒一次，一天下来能弹几十回，很吵。
     现在改成「每次会话最多提示一次」，并且自动帮用户把快取整理一遍
     —— 整理完之后快取就能正常写入了，本来也不会再触发这条提示。 */
  const now2=Date.now();
  if(!mirrorFullToasted){
    mirrorFullToasted=true;
    saveMirrorToastAt=now2;
    toast('本机快取已满，数据已由大容量库接管（不会丢失）· 正在自动整理快取');
    /* 立刻自动整理一次快取镜像，让后续保存恢复正常 */
    setTimeout(function(){
      try{
        const freed=rebuildMirror();
        if(freed>0){
          try{ console.info('[彤话屿] 快取已自动整理，释放约 '+Math.round(freed/1024)+'KB'); }catch(_){}
        }
      }catch(e){}
    }, 400);
  }
  if(currentApp!=='set') snapSaved();
  return true;
}
/* 一键瘦身（旧口径，仅在大库不可用的环境用）：把超龄图片缓存清掉并落盘。
   返回释放的字符数（供 UI 展示）。v2.24.9 起「一键整理快取」走 rebuildMirror，
   不再删内存正式数据 —— 正式数据住大库。 */
function purgeOldImages(){
  if(!state) return 0;
  const before=lsUsedBytes();
  pruneImages(state, false);
  /* 再压一轮更狠的（第二轮力度） */
  pruneImages(state, true);
  save();
  const after=lsUsedBytes();
  return Math.max(0, before-after);
}
/* v2.24.9 一键整理开机快取：只重写「快取副本」，绝不动正式数据。
   正式数据住大容量库；快取只是下次开机秒读用的镜像，满了会自动整理，
   这个按钮用来手动强制整理一次。返回释放的字符数（供 UI 展示） */
function rebuildMirror(){
  if(!state) return 0;
  const before=lsUsedBytes();
  let copy=null;
  try{ copy=JSON.parse(JSON.stringify(state)); }catch(e){ return 0; }
  pruneImages(copy, false);
  pruneImages(copy, true);
  const str2=JSON.stringify(copy);
  try{ localStorage.removeItem(LS_KEY+'_bak'); }catch(_){}
  try{ localStorage.setItem(LS_KEY+'_bak', str2); }catch(_){}
  try{ localStorage.setItem(LS_KEY, str2); }catch(_){}
  const after=lsUsedBytes();
  return Math.max(0, before-after);
}
/* 存储用量（供设置页展示）：{used, quota, pct, warn} */
function storageStat(){
  const used=lsUsedBytes();
  return { used, quota:LS_QUOTA, pct:Math.min(100, Math.round(used/LS_QUOTA*100)), warn:used/LS_QUOTA>0.8 };
}
/* v2.24.9：大容量库用量（异步取 navigator.storage.estimate；取不到就给说明文案） */
function fillIdbUsage(){
  const el=$('idbStatLine');
  if(!el) return;
  const fallback=function(){ try{ el.textContent='大容量库（IndexedDB）：已启用 —— 完整数据都在这里'; }catch(_){} };
  try{
    if(!navigator.storage || !navigator.storage.estimate) return fallback();
    navigator.storage.estimate().then(function(est){
      if(!$('idbStatLine')) return;
      try{
        const usedB=(est&&est.usage)||0, quotaB=(est&&est.quota)||0;
        const fmt=function(b){ return b>=1073741824 ? (b/1073741824).toFixed(1)+' GB' : b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB'; };
        el.innerHTML = quotaB>0
          ? '大容量库（IndexedDB）：已存 <b>'+fmt(usedB)+'</b>，可用约 <b>'+fmt(quotaB)+'</b> —— 完整数据都在这里，一般用不完'
          : '大容量库（IndexedDB）：已启用 —— 完整数据都在这里';
      }catch(e){ fallback(); }
    }).catch(fallback);
  }catch(e){ fallback(); }
}

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const rand = (a,b) => a + Math.random()*(b-a);
const randInt = (a,b) => Math.floor(rand(a,b+1));
const pick = arr => arr[randInt(0,arr.length-1)];
function fmtTime(t){ const d=new Date(t),h=d.getHours(),m=d.getMinutes(); return (h<10?'0':'')+h+':'+(m<10?'0':'')+m; }
function fmtDate(t){ const d=new Date(t); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
let toastTimer=null;
function toast(msg){ const el=$('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),1800); }

/* ---------- 音效（WebAudio 合成清脆风铃音，无需外部文件） ---------- */
let audioCtx=null;
function playDing(kind){
  if(!state.settings.soundOn)return;
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended')audioCtx.resume();
    const t0=audioCtx.currentTime;
    const vol=Math.min(1,Math.max(0,state.settings.soundVol??0.5));
    const notes=(kind==='send')?[660,990]:[1046.5,1568];  /* 收到：清脆双音上行；发送：短促确认音 */
    notes.forEach((f,i)=>{
      const o=audioCtx.createOscillator(),g=audioCtx.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t0+i*0.09);
      g.gain.exponentialRampToValueAtTime(0.22*vol,t0+i*0.09+0.015);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+i*0.09+0.4);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0+i*0.09); o.stop(t0+i*0.09+0.45);
    });
  }catch(e){}
}
/* ---------- 系统推送通知（像聊天软件一样，离开会话页也能收到） ---------- */
function notifyMsg(chatId,nm,preview){
  const s=state.settings;
  if(!s.notifyOn||!('Notification' in window))return;
  if(Notification.permission!=='granted')return;
  try{
    const n=new Notification(nm,{body:preview,tag:'thy-'+chatId,silent:!!s.soundOn});
    n.onclick=()=>{
      try{ window.focus(); }catch(e){}
      openApp('chat'); openChat(chatId);
      try{ n.close(); }catch(e){}
    };
  }catch(e){}
}

/* ================= 后台消息通知（v2.24.12） =================
   用户诉求：先把网站退出（但没清后台），手机照样能收到消息通知。
   做法：主线程把「联系人名单 + 通知/声音开关」同步给 Service Worker，
   页面一旦进入后台（切走 App / 息屏 / 切标签页），就由 SW 定时接管弹通知。
   —— 纯本机模拟，不联网、不给任何服务器发数据；前台时 SW 停手，避免重复提示。
   注意：SW 的定时器同样会被浏览器限频，能做到的是「后台仍会隔一段时间收到消息」，
   不保证秒级准时；这是所有网页应用的共同上限（原生 App 才走系统推送通道）。 */
let bgNotifyWired = false;
function bgNotifyContacts(){
  const out=[];
  (state.contacts||[]).forEach(c=>{
    /* 只挑平时会主动发消息的联系人，附上几句常用话术，SW 那边随机挑一句 */
    out.push({ id:c.id, name:c.name, lines:['在忙吗？','想到你了','在干嘛呀','今天过得怎么样','刚看到个东西想给你看'] });
  });
  return out.slice(0, 8);
}
function bgNotifyPayload(){
  const s=state.settings||{};
  /* v2.24.12：三个条件缺一不可 —— 设置里的「后台消息通知」开关打开、
     已拿到系统通知权限、且页面确实处于后台。任一不满足就让 SW 停手。 */
  const on = (s.bgNotify!==false) && !!s.notifyOn && ('Notification' in window) && Notification.permission==='granted'
             && typeof document!=='undefined' && document.visibilityState==='hidden';
  return { type:'thy-bg', on:on, notify:!!s.notifyOn, sound:!!s.soundOn, contacts:bgNotifyContacts() };
}
function pushBgNotifyState(){
  try{
    if(!navigator.serviceWorker) return;
    const send=(reg)=>{
      try{
        const sw = (reg && (reg.active || reg.waiting || reg.installing)) || navigator.serviceWorker.controller;
        if(sw && sw.postMessage) sw.postMessage(bgNotifyPayload());
      }catch(e){}
    };
    if(navigator.serviceWorker.controller) send(null);
    navigator.serviceWorker.ready.then(send).catch(()=>{});
  }catch(e){}
}
function initBgNotify(){
  if(bgNotifyWired) return;
  bgNotifyWired = true;
  /* 页面可见性变化：切后台 → 交给 SW；回前台 → 让 SW 停手 */
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible') pushBgNotifyState();
    else setTimeout(pushBgNotifyState, 60);
  });
  /* 息屏 / 切到别的 App（部分内核支持 pagehide / freeze） */
  window.addEventListener('pagehide', ()=>{ try{ pushBgNotifyState(); }catch(e){} });
  window.addEventListener('pageshow', ()=>{ try{ pushBgNotifyState(); }catch(e){} });
  /* SW 里点了通知 → 回到对应会话 */
  try{
    if(navigator.serviceWorker){
      navigator.serviceWorker.addEventListener('message', ev=>{
        const d=ev && ev.data;
        if(d && d.type==='thy-open-chat' && d.chatId){
          try{ openApp('chat'); openChat(d.chatId); }catch(e){}
        }
      });
    }
  }catch(e){}
  pushBgNotifyState();
  /* 联系人 / 开关变了就同步一次（低频，开销可忽略） */
  setInterval(()=>{ try{ pushBgNotifyState(); }catch(e){} }, 25000);
}
/* 站内弹窗（替代 prompt/confirm，部分预览环境会拦截原生弹窗）
   onOk 返回 false 则不关闭弹窗 */
function openModal(title,bodyHtml,onOk,onCancel,okText,cancelText){
  const phone=$('phone');
  const mask=document.createElement('div'); mask.className='modal-mask';
  mask.innerHTML=`<div class="modal"><div class="m-title">${title}</div><div class="m-body">${bodyHtml}</div>
    <div class="m-btns"><button class="m-cancel">${cancelText||'取消'}</button><button class="m-ok">${okText||'确定'}</button></div></div>`;
  phone.appendChild(mask);
  const close=()=>mask.remove();
  mask.addEventListener('click',e=>{ if(e.target===mask)close(); });
  mask.querySelector('.m-cancel').addEventListener('click',()=>{
    close();
    if(onCancel)onCancel(mask);
  });
  mask.querySelector('.m-ok').addEventListener('click',()=>{
    if(!onOk||onOk(mask)!==false)close();
  });
  return mask;
}
/* 联系人编辑器（新建 / 编辑共用）：昵称 + 从ta的专属头像库选头像 */
function openContactEditor(existing,after){
  const isNew=!existing;
  const c=existing||{name:'',avatar:'',avatarLib:DEFAULT_AVATARS.map(a=>({...a})),stickers:[]};
  c.avatarLib=c.avatarLib||[];
  let picked=c.avatar||'';
  /* v2.24.12：默认头像库已清空，编辑器里大概率一个可选头像都没有 ——
     与其显示一片空白让人发懵，不如直接把新增入口亮出来。 */
  const EMPTY_AVA_HINT = c.avatarLib.length ? '' :
    '<div class="desc" style="margin:2px 0 0;text-align:center;color:var(--ink-3)">还没有头像 · 在下面输入一个 emoji，或上传一张图片</div>';
  const mask=openModal(isNew?'新建联系人':'编辑联系人',`
    <div class="field"><label>昵称</label><input id="ceName" value="${escapeHtml(c.name)}" maxlength="12" placeholder="给ta一个称呼"></div>
    <div class="field"><label>ta 的回复概率（留空 = 跟随全局设置）</label>
      <input id="ceReplyProb" type="number" min="0" max="100" value="${c.replyProb===undefined||c.replyProb===null?'':c.replyProb}" placeholder="如 80（%）">
      <div class="desc" style="margin-top:6px">填了之后，只有 ta 按这个概率回你消息，优先于设置里的全局概率。<br>删除 ta 时，这个概率会自动转成「ta 使用拍一拍」的概率。</div>
    </div>
    <div class="field" style="margin-bottom:0"><label>头像 · 点击选择（ta 的专属头像库）</label>
      ${EMPTY_AVA_HINT}
      <div class="stk-grid" id="ceAvas" style="margin-top:8px">
        ${c.avatarLib.map(a=>`<div class="stk ${picked===a.id?'sel':''}" data-ava="${a.id}">${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}</div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <input id="ceEmoji" placeholder="输入一个 emoji" maxlength="4" style="flex:1">
        <button class="btn small ghost" id="ceAddEmoji" style="margin:0">添加</button>
        <button class="btn small ghost" id="ceUpload" style="margin:0">上传图片</button>
      </div>
      <input type="file" id="ceFile" accept="image/*" style="display:none">
    </div>`,()=>{
    const name=mask.querySelector('#ceName').value.trim();
    if(!name){ toast('先给ta起个名字吧'); return false; }
    /* 回复概率：空 = 跟随全局（存 undefined） */
    const rpRaw=mask.querySelector('#ceReplyProb').value.trim();
    let rp;
    if(rpRaw===''){ rp=undefined; }
    else{ const v=parseInt(rpRaw); rp=isNaN(v)?undefined:Math.min(100,Math.max(0,v)); }
    if(isNew){
      const id='c'+Date.now();
      const nc={id,name,avatar:picked,avatarLib:c.avatarLib,stickers:[]};
      if(rp!==undefined)nc.replyProb=rp;
      state.contacts.push(nc);
      state.chats[id]=[{role:'ta',text:'链接上了',t:Date.now()}];
      toast('已添加「'+name+'」');
    }else{
      existing.name=name; existing.avatar=picked; existing.avatarLib=c.avatarLib;
      if(rp===undefined) delete existing.replyProb; else existing.replyProb=rp;
      toast('已保存');
    }
    save(); renderDesktop();
    if(after)after();
  });
  const grid=mask.querySelector('#ceAvas');
  const nameInput=mask.querySelector('#ceName');
  /* 自动聚焦昵称框（防止移动端键盘弹出后错位 / 点击无响应） */
  setTimeout(()=>{ try{ nameInput.focus({preventScroll:true}); }catch(e){ nameInput.focus(); } },80);
  nameInput.addEventListener('click',e=>e.stopPropagation());
  const bindGrid=()=>grid.querySelectorAll('[data-ava]').forEach(el=>el.addEventListener('click',()=>{
    picked=el.dataset.ava;
    grid.querySelectorAll('.stk').forEach(x=>x.classList.toggle('sel',x.dataset.ava===picked));
  }));
  const redraw=()=>{
    grid.innerHTML=c.avatarLib.map(a=>`<div class="stk ${picked===a.id?'sel':''}" data-ava="${a.id}">${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}</div>`).join('');
    bindGrid();
  };
  bindGrid();
  mask.querySelector('#ceAddEmoji').addEventListener('click',()=>{
    const e=mask.querySelector('#ceEmoji').value.trim();
    if(!e)return toast('先输入一个 emoji');
    const id='a'+Date.now();
    c.avatarLib.push({id,type:'emoji',data:e}); picked=id;
    mask.querySelector('#ceEmoji').value='';
    redraw(); toast('已加入头像库');
  });
  mask.querySelector('#ceUpload').addEventListener('click',()=>mask.querySelector('#ceFile').click());
  mask.querySelector('#ceFile').addEventListener('change',e=>{
    const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=()=>compressImage(r.result,200,url=>{
      const id='a'+Date.now();
      c.avatarLib.push({id,type:'img',data:url}); picked=id; redraw();
    });
    r.readAsDataURL(f); e.target.value='';
  });
}
const AVA_COLORS=['#7a9dd6','#d67a9d','#7ad6a0','#d6b07a','#9d7ad6','#7ac0d6','#d68a7a'];
function avaColor(name){ let h=0; for(const ch of name)h=(h*31+ch.charCodeAt(0))>>>0; return AVA_COLORS[h%AVA_COLORS.length]; }
function avatarHtml(name,cls,id){
  const av = id!==undefined ? getAvatar(id) : null;
  if(av){
    if(av.type==='img') return `<div class="avatar ${cls||''}" style="background:#ececef;padding:0;overflow:hidden"><img src="${av.data}" style="width:100%;height:100%;object-fit:cover" alt=""></div>`;
    return `<div class="avatar ${cls||''}" style="background:${avaColor(name)}">${escapeHtml(av.data)}</div>`;
  }
  return `<div class="avatar ${cls||''}" style="background:${avaColor(name)}">${escapeHtml(name.slice(0,1))}</div>`;
}
/* 取头像：owner 为 'me'（设置里的我的头像库）或联系人 id（联系人专属头像库） */
function getAvatar(owner){
  let lib,aid;
  if(owner==='me'){ lib=state.avatarLib; aid=state.settings.myAvatar; }
  else{
    const c=state.contacts.find(x=>x.id===owner);
    if(!c)return null;
    lib=c.avatarLib||[]; aid=c.avatar;
  }
  if(!aid)return null;
  return lib.find(a=>a.id===aid)||null;
}
/* 群聊头像（v2.21.0）：g.avatar 三种取值 —— null=默认首字色块；
   库引用（g.avatarLib 里 {id,type:'emoji'|'img',data} 的 id，图片走 <img>）；
   预设/旧版直接存 emoji 字符串（兼容 v2.18 老存档，不用迁移） */
function groupAvatarHtml(g,cls){
  const nm=(g&&g.name)||'群';
  let inner=nm.slice(0,1), img='';
  if(g&&g.avatar){
    const lib=Array.isArray(g.avatarLib)?g.avatarLib:[];
    const av=lib.find(a=>a.id===g.avatar);
    if(av&&av.type==='img'){
      return `<div class="avatar ${cls||''}" style="background:#ececef;padding:0;overflow:hidden"><img src="${av.data}" style="width:100%;height:100%;object-fit:cover" alt=""></div>`;
    }
    inner=av?av.data:g.avatar;   /* 库内 emoji / 直接字符串 */
  }
  return `<div class="avatar ${cls||''}" style="background:${avaColor(nm)}">${escapeHtml(inner)}</div>`;
}
/* 联系人状态副标题：每 2 小时随机切换一个状态（时段+联系人哈希；撞到同一状态 = 这个时段没换）（v2.19.0） */
const TA_STATUSES=['在工作','在休息','出门散步','想念你','在忙','发呆中','听歌中','追剧中','在学习','刚睡醒','吃饭中','逛街中','喝咖啡中','看电影中','打扫房间','敷面膜'];
function contactStatus(cid){
  const d=new Date();
  const slot=Math.floor(d.getHours()/2);   /* 每 2 小时一个时段：0~11 */
  const key=cid+'|'+d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()+'#'+slot;
  let h=0; for(const ch of key)h=(h*31+ch.charCodeAt(0))>>>0;
  return TA_STATUSES[h%TA_STATUSES.length];
}
/* 聊天页头副标题：联系人=状态文案；群聊=不显示任何字（v2.18.0） */
function chatSubOf(chatId){
  return isGroup(chatId)?'':contactStatus(chatId);
}
function totalCards(){ return state.cats.reduce((n,c)=>n+c.cards.length,0); }
/* 专用字卡库：每位联系人独立一套分类（可整体开关）。
   v2.22.0 起：不再是「先掷闸门决定走专用还是公用」——
   改为把公用 + 专用合成成**一个大卡池**一起抽，专用库不会因为只有几张就占据大半抽取量。
   每张专用卡按「加权倍率 privWeight」参与（1 = 与公用卡同权，即纯按张数比例）。
   公用池按分类过滤；专用卡全部入池（专用库即 ta 的专属语料，不要求分类名对齐）。
   任一边没有可用词就整体回落另一边；两边都空才返回 null */
function privLibOf(id){ return (id&&state.privLibs&&state.privLibs[id])||null; }
function clampPrivWeight(v){
  const n=Number(v);
  if(!isFinite(n)||n<1)return 1;
  return Math.min(50,Math.max(1,Math.round(n)));
}
/* 专用字卡加权倍率：优先该联系人的专用库单独设置，其次全局设置，默认 1（按张数比例） */
function privWeightOf(who){
  const lib=privLibOf(who);
  if(lib&&lib.weight!==undefined&&lib.weight!==null&&lib.weight!=='') return clampPrivWeight(lib.weight);
  const g=state.settings?state.settings.privWeight:undefined;
  return clampPrivWeight(g===undefined||g===null||g===''?1:g);
}
function drawCard(catName, who){
  const want = Array.isArray(catName)?catName:(catName?[catName]:null);
  const pub=[], priv=[];
  /* 公用字卡（按分类过滤） */
  state.cats.forEach(c=>{ if(c.enabled&&(!want||want.includes(c.name))) pub.push(...c.cards); });
  /* 专用字卡 */
  const lib=privLibOf(who);
  if(lib&&lib.enabled) (lib.cats||[]).forEach(c=>{ if(c.enabled) priv.push(...(c.cards||[])); });
  /* 无专用库 / 专用库空 → 纯公用 */
  if(!priv.length) return pub.length?pick(pub):null;
  /* 公用池空 → 只能用专用 */
  if(!pub.length) return pick(priv);
  /* 合并成一个大卡池：公用每张权重 1，专用每张权重 w */
  const w=privWeightOf(who);
  const r=Math.random()*(pub.length+priv.length*w);
  if(r<pub.length) return pub[Math.floor(r)];
  return priv[Math.floor((r-pub.length)/w)];
}
function contactName(id){ const c=state.contacts.find(x=>x.id===id); return c?c.name:'?'; }
/* v2.24.19：潮汐石显示统一走 fmtCoins —— 最多两位小数、去尾零（旧版 1856.0500000000002 这种浮点尾数直接糊脸） */
function fmtCoins(n){
  const v=Math.round((Number(n)||0)*100)/100;
  return (v%1===0)?String(v):v.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
}
function refreshCoins(){ const el=$('coinMiniVal'); if(el) el.textContent=fmtCoins(state.coins); const ic=$('coinMiniIco'); if(ic)ic.innerHTML=I('tide',12); }

/* ================= 主题与壁纸 ================= */
function applyTheme(){
  const s=state.settings;
  document.documentElement.style.setProperty('--accent', s.accent);
  document.documentElement.style.setProperty('--bubble-radius', s.bubbleR+'px');
  /* 夜间模式：全界面深色（用 data-theme 切换 CSS 变量） */
  const dark = s.darkMode===true;
  try{ document.documentElement.setAttribute('data-theme', dark?'dark':'light'); }catch(e){}
  const mtc=document.querySelector('meta[name="theme-color"]');
  if(mtc)mtc.setAttribute('content', dark?'#0f0f11':'#1c1c1e');
  const dk=$('desktop');
  dk.className='';
  if(s.wallpaper.type==='img' && s.wallpaper.data){
    dk.classList.add('wp-img');
    dk.style.backgroundImage=`url(${s.wallpaper.data})`;
    $('wallTint').style.background=dark?'rgba(0,0,0,.35)':'rgba(241,241,243,.25)';
  }else{
    dk.style.backgroundImage='';
    dk.classList.add('wp-'+s.wallpaper.type);
    $('wallTint').style.background=dark?'rgba(0,0,0,.35)':'rgba(241,241,243,.35)';
  }
  /* 气泡：内置预设 / 用户保存的自定义预设 + 全局字体 + 当前会话联系人的专属气泡
     顺序很关键 —— 全局 → 字体 → 联系人专属（后者优先级最高覆盖前者）
     ⚠️ 联系人款不能只靠顺序取胜：给 #msgList 挂 .scope-personal 把选择器特异性提到 (0,3,1)，
        这样无论两条 CSS 谁先谁后、页面何时重绘，联系人款都稳定覆盖全局款（修「气泡混乱」） */
  const parts=[];
  const g=bubCss(s.bubbleStyle||'');
  if(g)parts.push(g);
  parts.push(fontCss(s.bubbleFont||''));
  const o=chatBubbleOverride();
  if(o){ if(o.css)parts.push(prefixPersonal(o.css)); parts.push(prefixPersonalFont(o.font)); }
  parts.push(s.userCss||'');
  $('userCss').textContent = parts.filter(Boolean).join('\n');
  /* 只有当前会话「确实设了专属气泡/字体」时才挂 .scope-personal，
     否则全局款会跟着享受同一特异性，同特异性下就靠顺序取胜 → 表现为「气泡混乱」 */
  const ml=$('msgList');
  if(ml){
    const hasOwn = !!(o && (o.css || o.font));
    ml.classList.toggle('scope-personal', hasOwn);
  }
}
/* 给联系人/群聊专属气泡的每条规则加 .scope-personal 前缀，提升特异性到稳定胜出。
   v2.24.7 修复「联系人气泡和全局气泡重叠/串味」：
   旧实现只给 `.row` 开头的选择器加前缀，于是 `bp-wechat` 这类预设里
   **`.bubble{...}`（不带 .row）的规则保持原样 (0,1,0)**，
   碰到全局款的 `.row.me .bubble{...}` (0,3,0) 就输 —— 同一个气泡里
   背景来自全局、圆角来自联系人，混成一片。
   现在：只要是气泡库里的选择器（.bubble / .row / 纯 .bubble::after 等）**一律加前缀**，
   `:root`、`@media`、纯变量定义等非气泡规则才原样保留。 */
function prefixPersonal(css){
  if(!css)return '';
  /* @media 块单独处理：里面再递归加前缀 */
  let out=String(css);
  out=out.replace(/@media([^{]+)\{([\s\S]*?)\n\}/g,(m,cond,inner)=>{
    return '@media'+cond+'{\n'+prefixPersonal(inner)+'\n}';
  });
  out=out.replace(/(^|\})(\s*)([^{}]+)\{/g,(m,close,ws,sel)=>{
    const one=sel.split(',').map(x=>{
      const t=x.trim();
      if(!t)return t;
      /* 已经带前缀的不重复加 */
      if(t.indexOf('.scope-personal')===0)return t;
      /* :root / html / body 这类只设变量的规则不碰 */
      if(/^(:root|html|body)\b/.test(t))return t;
      /* 气泡相关的选择器（.bubble / .row / 其它带 bubble 的）加前缀 */
      if(/\.bubble|\.row\b|\.stk-b|\.rp-env/.test(t))return '.scope-personal '+t;
      return t;
    }).join(',');
    return close+ws+one+'{';
  });
  return out;
}
function prefixPersonalFont(id){
  const f=fontCss(id);
  return f?prefixPersonal(f):'';
}
/* 当前聊天会话的专属气泡（联系人级 / 群聊为各自独立设置） */
function chatBubbleOverride(){
  const id=currentChatId;
  if(!id)return null;
  if(isGroup(id)){
    const g=state.groups.find(x=>x.id===id);
    if(!g)return null;
    if(!g.bubbleId&&!g.fontId)return null;
    return { css:g.bubbleId?bubCss(g.bubbleId):'', font:g.fontId||'' };
  }
  const c=state.contacts.find(x=>x.id===id);
  if(!c)return null;
  if(!c.bubbleId&&!c.fontId)return null;
  return { css:c.bubbleId?bubCss(c.bubbleId):'', font:c.fontId||'' };
}
/* 聊天窗口壁纸 */
function applyChatWallpaper(){
  const list=$('msgList'); if(!list)return;
  const w=state.settings.chatWallpaper;
  if(w.type==='img' && w.data){
    list.style.backgroundImage=`url(${w.data})`;
    list.style.backgroundSize='cover'; list.style.backgroundPosition='center';
  }else if(w.type==='dots'){
    list.style.backgroundImage='radial-gradient(rgba(0,0,0,.08) 1.2px, transparent 1.4px)';
    list.style.backgroundSize='20px 20px';
  }else if(w.type==='stripe'){
    list.style.backgroundImage='repeating-linear-gradient(45deg,rgba(0,0,0,.03) 0 12px,transparent 12px 24px)';
    list.style.backgroundSize='auto';
  }else{
    list.style.backgroundImage=''; list.style.backgroundSize='auto';
  }
}

/* ================= 时钟 ================= */
function tickClock(){
  const d=new Date();
  const t=fmtTime(d.getTime());
  $('sbTime').textContent=t; $('deskClock').textContent=t;
  const week='日一二三四五六'[d.getDay()];
  $('deskDate').textContent=`${d.getMonth()+1}月${d.getDate()}日 星期${week}`;
  if(typeof listenExpireCheck==='function')listenExpireCheck();  /* v2.23.0：一起听超时收尾 */
}
setInterval(tickClock, 20e3);

/* ================= 桌面 ================= */
/* 极简线性图标（stroke SVG，跟随文字颜色） */
const IC = (p)=>`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS={
  chat:   IC('<path d="M4 5.5h16v11H9.5L5 20.5z"/>'),
  group:  IC('<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5S13.9 16 14.5 19"/><circle cx="16.8" cy="9.6" r="2.6"/><path d="M15.6 14.6c2.4.1 4.2 1.5 4.8 4.4"/>'),
  moments:IC('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4"/>'),
  mail:   IC('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  diary:  IC('<path d="M6 4h11.5v16H7.5A1.5 1.5 0 0 1 6 18.5z"/><path d="M6 16.5h11.5"/><path d="M9.5 4v16" stroke-dasharray="0"/>'),
  cal:    IC('<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  ann:    IC('<path d="M12 20s-7.2-4.7-9.2-8.8A5 5 0 0 1 12 6.7 5 5 0 0 1 21.2 11.2C19.2 15.3 12 20 12 20z"/>'),
  fort:   IC('<path d="M12 4l1.7 4.8L18.5 10.5l-4.8 1.7L12 17l-1.7-4.8L5.5 10.5l4.8-1.7z"/><path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  market: IC('<path d="M12 4.5 3.5 19.5h17z"/><path d="M12 11.5 8.7 19.5M12 11.5l3.3 8"/>'),  /* v2.24.18：闲屿小集 —— 小帐篷（极简线条，贴合海岛露营意象） */
  survey: IC('<rect x="5" y="4" width="14" height="16.5" rx="2"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>'),
  track:  IC('<path d="M12 21s-6.2-5.6-6.2-10.2a6.2 6.2 0 1 1 12.4 0C18.2 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>'),
  games:  IC('<rect x="3" y="8" width="18" height="9.5" rx="4.5"/><path d="M8 11v3.5M6.2 12.8h3.6"/><circle cx="16" cy="11.5" r=".6"/><circle cx="18.2" cy="13.8" r=".6"/>'),
  period: IC('<path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.3 6.3 0 0 0 9.7 9.7z"/>'),
  cards:  IC('<rect x="7.5" y="5" width="11.5" height="14" rx="2"/><path d="M4.5 7v12.5a2 2 0 0 0 2 2h8.5"/>'),
  pat:    IC('<path d="M8 12.5V6.8a1.4 1.4 0 0 1 2.8 0v4.4m0-2.7a1.4 1.4 0 0 1 2.8 0v2.7m0-1.6a1.4 1.4 0 0 1 2.8 0v3.9c0 3.3-2 5.5-5.2 5.5-2.6 0-3.9-1.2-5.2-3.4L4.4 13c-.7-1.2.9-2.5 2-1.5l1.6 1.6z"/>'),
  theme:  IC('<path d="M12 3.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.5 12 3.5 12 3.5z"/>'),
  set:    IC('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9"/>'),
  rps:    IC('<path d="M4.5 8.5H18l-2.8-2.8M19.5 15.5H6l2.8 2.8"/>'),
  memory: IC('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  gomoku: IC('<circle cx="8.5" cy="8.5" r="3.2"/><circle cx="15.5" cy="15.5" r="3.2"/><path d="M3 21L21 3" opacity=".25"/>'),
  snake:  IC('<path d="M4 17c0-3.2 3.2-3.2 5.5-3.2s5.5 0 5.5-3.3-3.2-3.3-5.5-3.3H7"/><circle cx="17.5" cy="7.2" r="1.4"/>'),
  /* v2.24.20：双人合作俄罗斯方块 —— 两块不同颜色的方块一起下落 */
  tetris: IC('<rect x="3" y="3.5" width="6" height="6" rx="1"/><rect x="9" y="3.5" width="6" height="6" rx="1" opacity=".45"/><rect x="15" y="3.5" width="6" height="6" rx="1"/><rect x="3" y="9.5" width="6" height="6" rx="1" opacity=".45"/><rect x="9" y="9.5" width="6" height="6" rx="1"/><rect x="3" y="15.5" width="6" height="6" rx="1"/><rect x="15" y="15.5" width="6" height="6" rx="1" opacity=".45"/>'),
  /* ===== v2.23.0：全站线性图标扩充（替换 emoji 图标） ===== */
  music:  IC('<path d="M9 18.5V6.6l10-2.1v11.4"/><circle cx="6.8" cy="18.5" r="2.3"/><circle cx="16.8" cy="15.9" r="2.3"/>'),
  listen: IC('<path d="M4 13.5a8 8 0 0 1 16 0"/><rect x="3" y="13" width="4.4" height="6.8" rx="2"/><rect x="16.6" y="13" width="4.4" height="6.8" rx="2"/>'),
  gift:   IC('<rect x="4" y="9.5" width="16" height="11" rx="2"/><path d="M3.5 6.5h17v3h-17zM12 6.5v14M12 6.3S10.8 3.5 8.6 3.5a2 2 0 0 0 0 3h3.4zm0 0s1.2-2.8 3.4-2.8a2 2 0 0 1 0 3H12z"/>'),
  rp:     IC('<path d="M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M4 8.2c5.3 2.6 10.7 2.6 16 0M12 10.6v3.2"/><path d="M9.6 16.4c1.5.9 3.3.9 4.8 0" opacity=".55"/>'),
  decide: IC('<circle cx="7" cy="7.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="17" cy="16.5" r="1.1"/><path d="M4 16.5h6.2M13.8 7.5H20" opacity=".4"/>'),
  eyes:   IC('<path d="M3.5 12s3-5.5 8.5-5.5S20.5 12 20.5 12s-3 5.5-8.5 5.5S3.5 12 3.5 12z"/><circle cx="12" cy="12" r="2.4"/>'),
  wish:   IC('<path d="M12 3.5l2.3 5.4 5.9.5-4.5 3.9 1.4 5.8L12 16l-5.1 3.1 1.4-5.8-4.5-3.9 5.9-.5z"/>'),
  fontIc: IC('<path d="M5 19.5L11 5h2l6 14.5M7.6 14h8.8"/>'),
  bubble: IC('<path d="M4 5.5h16v11H9.5L5 20.5z"/><path d="M8.5 12.5h7" opacity=".5"/>'),
  image:  IC('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.6-4.2 3.4 3 2.8-2.5 4.2 3.7"/>'),
  users:  IC('<circle cx="9.2" cy="8.6" r="3.1"/><path d="M3.8 19c.5-3.1 2.7-4.7 5.4-4.7s4.9 1.6 5.4 4.7"/><circle cx="16.9" cy="9.4" r="2.5"/><path d="M15.8 14.4c2.3.2 4 1.5 4.6 4.3"/>'),
  person: IC('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5"/>'),
  camera: IC('<rect x="3.5" y="7" width="17" height="13" rx="2.5"/><path d="M8.5 7l1.4-2.3h4.2L15.5 7"/><circle cx="12" cy="13.4" r="3.1"/>'),
  trash:  IC('<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M7 6.5l.8 12.6a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 6.5"/>'),
  plus:   IC('<path d="M12 5.5v13M5.5 12h13"/>'),
  check:  IC('<path d="M5 12.8l4.3 4.2L19 7.5"/>'),
  search: IC('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  sun:    IC('<circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>'),
  moon:   IC('<path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.3 6.3 0 0 0 9.7 9.7z"/>'),
  moonHalf:IC('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>'),
  bulb:   IC('<path d="M9 18.5c-.2-2.2-1.4-3.3-2.4-4.6a5.8 5.8 0 1 1 10.8 0c-1 1.3-2.2 2.4-2.4 4.6z"/><path d="M9.5 21h5"/>'),
  scale:  IC('<path d="M12 4v16M7 20h10M12 6.5L6 8m12-1.5L12 8M6 8l-2.4 5a2.9 2.9 0 0 0 4.8 0zM18 8l-2.4 5a2.9 2.9 0 0 0 4.8 0z"/>'),
  dice:   IC('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>'),
  /* 潮汐石（v2.24.17 由旧「硬币」重绘）：一颗圆润卵石 + 石面两道浪线 —— 极简黑白线条 */
  tide:   IC('<path d="M12 4.6c4.2 0 7.4 3 7.4 7 0 4.4-3.4 7.8-7.4 7.8s-7.4-3.4-7.4-7.8c0-4 3.2-7 7.4-7z"/><path d="M7.8 12.4c1.4-1.3 2.9-1.3 4.2 0s2.8 1.3 4.2 0" stroke-width="1.4"/><path d="M8.7 15.2c1.1-1 2.2-1 3.3 0s2.2 1 3.3 0" stroke-width="1.2"/>'),
  heart:  IC('<path d="M12 20s-7.2-4.7-9.2-8.8A5 5 0 0 1 12 6.7 5 5 0 0 1 21.2 11.2C19.2 15.3 12 20 12 20z"/>'),
  gamepad:IC('<rect x="3" y="8" width="18" height="9.5" rx="4.5"/><path d="M8 11v3.5M6.2 12.8h3.6"/><circle cx="16" cy="11.5" r=".6"/><circle cx="18.2" cy="13.8" r=".6"/>'),
  bell:   IC('<path d="M12 4a5.6 5.6 0 0 1 5.6 5.6c0 3.2.7 5 1.6 6.1H4.8c.9-1.1 1.6-2.9 1.6-6.1A5.6 5.6 0 0 1 12 4z"/><path d="M10.2 19.4a1.9 1.9 0 0 0 3.6 0"/>'),
  sound:  IC('<path d="M4 9.5v5h3.4L12 19V5L7.4 9.5z"/><path d="M15.5 9a4.4 4.4 0 0 1 0 6M18 6.6a8 8 0 0 1 0 10.8"/>'),
  save:   IC('<path d="M5 4.5h11L19.5 8v11a.9.9 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M8 4.5V9h7V4.5M8 20v-6h8v6"/>'),
  shield: IC('<path d="M12 3.5l7 2.6v5.4c0 4.6-3 8-7 9.5-4-1.5-7-4.9-7-9.5V6.1z"/><path d="M9.2 12l2 2 3.6-3.8"/>'),
  refresh:IC('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3.5v3.7h-3.7"/>'),
  clock:  IC('<circle cx="12" cy="12" r="8.2"/><path d="M12 7.2v4.8l3.2 1.9"/>'),
  doc:    IC('<path d="M6.5 3.5h7L18 8v12a.9.9 0 0 1-1 1H7a.9.9 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5V8H18M9 12.5h6M9 16h4"/>'),
  folder: IC('<path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2.3h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>'),
  pen:    IC('<path d="M4.5 19.5l.9-3.6L16.7 4.6a1.6 1.6 0 0 1 2.3 0l.4.4a1.6 1.6 0 0 1 0 2.3L8.1 18.6z"/><path d="M14.5 6.8l2.7 2.7"/>'),
  announce:IC('<path d="M4 10v4l10 4.5v-13z"/><path d="M14 8.5c2.8.4 4.7 1.7 5.5 3.5-.8 1.8-2.7 3.1-5.5 3.5M6.5 14.8l1 4.2"/>'),
  star:   IC('<path d="M12 3.5l2.3 5.4 5.9.5-4.5 3.9 1.4 5.8L12 16l-5.1 3.1 1.4-5.8-4.5-3.9 5.9-.5z"/>'),
  starFill:IC('<path d="M12 3.5l2.3 5.4 5.9.5-4.5 3.9 1.4 5.8L12 16l-5.1 3.1 1.4-5.8-4.5-3.9 5.9-.5z" fill="currentColor" stroke="none"/>'),
  spark:  IC('<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>'),
  calPlus:IC('<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4M12 13v4M10 15h4"/>'),
  smile:  IC('<circle cx="12" cy="12" r="8.5"/><path d="M8.8 13.5a4.3 4.3 0 0 0 6.4 0M9.3 9.5h.01M14.7 9.5h.01"/>'),
  mailOpen:IC('<path d="M4 11l8-6 8 6"/><rect x="4" y="11" width="16" height="9.5" rx="2"/><path d="M4.5 12l7.5 5 7.5-5" opacity=".6"/>'),
  letter: IC('<rect x="3.5" y="6.5" width="17" height="12.5" rx="2.5"/><path d="M4.5 8.5 12 14l7.5-5.5"/>'),  /* v2.24.0：写信入口图标 */
  muPause:IC('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2"/>'),          /* v2.24.3：桌面播放器 */
  muPrev: IC('<path d="M18 6v12L9.5 12z"/><path d="M7 6v12" stroke-width="1.6"/>'),
  muNext: IC('<path d="M6 6v12l8.5-6z"/><path d="M17 6v12" stroke-width="1.6"/>'),
  headset:IC('<path d="M4.5 13.5a7.5 7.5 0 0 1 15 0"/><rect x="3.5" y="13.5" width="4" height="6" rx="1.6"/><rect x="16.5" y="13.5" width="4" height="6" rx="1.6"/>'),
  play:   IC('<path d="M8 5.5v13l10-6.5z"/>'),
  /* v2.24.15b：音乐自检用图标 */
  screen: IC('<rect x="3" y="5" width="18" height="12.5" rx="2.2"/><path d="M8.5 20.5h7M12 17.5v3"/><path d="M7.5 11.6l2.2 2.2 4-4.6 3 3"/>'),
  stop:   IC('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
  hand2:  IC('<path d="M9.5 12V6.2a1.3 1.3 0 0 1 2.6 0v4.6m0-2.4a1.3 1.3 0 0 1 2.6 0v3.4m0-1.2a1.3 1.3 0 0 1 2.6 0v3.2c0 3.4-1.9 5.7-5 5.7-2.5 0-3.8-1.1-5-3.2l-1.5-2.6c-.6-1 .8-2.3 1.8-1.4l1.9 1.7"/>'),
  palette:IC('<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.3 0 1.9-.7 1.9-1.5 0-.7-.4-1-.8-1.5-.4-.4-.7-.8-.7-1.4 0-1 .8-1.7 1.9-1.7h1.6c2.2 0 4.1-1.8 4.1-4A8.3 8.3 0 0 0 12 3.8z"/><circle cx="8" cy="10.2" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="10.2" r="1" fill="currentColor" stroke="none"/><circle cx="7.4" cy="14.6" r="1" fill="currentColor" stroke="none"/>'),
};
/* 通用小图标（尺寸可调，默认 15px，stroke 跟随文字颜色）—— v2.23.0 用于替换全站 emoji 图标 */
const I=(k,s)=>{ const inner=(ICONS[k]||'').replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,''); const z=s||15;
  return `<svg viewBox="0 0 24 24" width="${z}" height="${z}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2.5px;flex:none">${inner}</svg>`; };
const APPS=[
  { id:'chat',    icon:'chat',    label:'聊天',    dock:true, badge:()=>totalUnread() },
  { id:'moments', icon:'moments', label:'邻屿圈' },
  { id:'mail',    icon:'mail',    label:'信箱' },
  { id:'music',   icon:'music',   label:'音乐' },   /* v2.24.0：移出 dock，上桌面网格（dock 只留 4 个不挤） */
  { id:'diary',   icon:'diary',   label:'心情手札' },
  { id:'cal',     icon:'cal',     label:'日历' },
  { id:'ann',     icon:'ann',     label:'纪念日' },
  { id:'fort',    icon:'fort',    label:'占卜' },
  { id:'market',  icon:'market',  label:'闲屿小集' },
  { id:'survey',  icon:'survey',  label:'问卷' },
  { id:'track',   icon:'track',   label:'灯塔' },
  { id:'games',   icon:'games',   label:'游戏' },
  { id:'period',  icon:'period',  label:'经期记录' },
  { id:'cards',   icon:'cards',   label:'字卡库',  dock:true },
  /* v2.24.5：桌面「拍一拍」图标已删 —— 字卡库里已有拍一拍页签，重复入口没必要 */
  { id:'theme',   icon:'theme',   label:'主题',    dock:true },
  { id:'set',     icon:'set',     label:'设置',    dock:true },
];
function iconHtml(app){
  const b=app.badge?app.badge():0;
  return `<div class="app-icon" data-app="${app.id}">
    <div class="tile">${ICONS[app.icon]||app.icon}${b?`<span class="badge">${b>99?'99+':b}</span>`:''}</div>
    <span class="label">${app.label}</span></div>`;
}
/* ===== 真实手机桌面 —— 小组件+应用混排，长按拖拽自由放置 =====
   v2.24.7：用户原提「页2 音乐提到最上 + 桌面整体下移」，后用 Edge 重装后发现
   322 的布局是合适的，明确撤回 —— 布局维持 v2.24.5 定稿：
   页1 = 照片 2×2（时间栏正下方）+ 8 应用；
   页2 = 备忘（待办）2×2 + 4 应用 + 音乐 4×2 全宽播放器（最下）。
   桌面两页，组件下方带 widgets 小字标注。 */
const DESK_WIDGETS={photo:{w:2,h:2},cal:{w:2,h:2},music:{w:4,h:2}};   /* 各组件占格 */
const DESK_ROWS=4;                                                     /* 每页装 4 行 */
const DESK_VER=5;                                                      /* 桌面默认布局版本（322 的布局保持不变） */
function deskDefault(){
  const ids=APPS.filter(a=>!a.dock).map(a=>'app:'+a.id);   /* 删掉 pat 后为 12 个 */
  const arr=['wdg:photo'];
  arr.push(...ids.slice(0,8));            /* 页1：照片占 2×2，8 应用从右侧流动排满 3 行 */
  arr.push('wdg:cal');                    /* 页2：备忘（待办）组件，占左侧 2×2 */
  arr.push(...ids.slice(8,12));           /* 页2：4 应用排在备忘右侧两列 */
  arr.push('wdg:music');                  /* 页2：音乐 4×2 全宽播放器，放最下方 */
  arr.push(...ids.slice(12));             /* 兜底：万一以后再加应用，追加到末页 */
  return arr;
}
/* 装箱：按 CSS 网格自动流模拟。
   v2.24.1：第二页不再无限向下排，而是先算「整张桌面需要几页」再继续分页——
   否则一页里应用太多时，最后的组件会被挤到很靠下，看起来像“乱放”。 */
const deskWOf=key=>DESK_WIDGETS[key.replace(/^wdg:/,'')];   /* 'wdg:photo' → photo 占格 */
function deskEnsure(desk){
  const valid=new Set(['wdg:photo','wdg:cal','wdg:music',...APPS.filter(a=>!a.dock).map(a=>'app:'+a.id)]);
  for(let i=desk.length-1;i>=0;i--) if(!valid.has(desk[i])) desk.splice(i,1);
  if(!desk.length) desk.push(...deskDefault());   /* 空布局才铺默认，避免被应用“顶”出奇怪顺序 */
  else deskDefault().forEach(k=>{ if(!desk.includes(k)) desk.push(k); });
  return desk;
}
/* 装箱：游标推进 + 占用矩阵（与 CSS grid auto-flow: row 行为一致）。
   v2.24.2：旧光标状态机不认识 2×2 占用——照片放完后，后续 1×1 会被分到
   (1,0)(1,1) 这些被照片压住的格子，页1 塞 11 项、视觉上和照片重叠。
   现在：放不下的格子游标逐格前进（可跨行），被占的格子自动跳过；
   整页都放不下才翻页。照片置顶后页1 = 照片 4 格 + 8 应用 = 恰好 12 格。 */
function deskPack(){
  const COLS=4;
  const run=(onPlace)=>{
    let page=0, row=0, col=0, pages=[[]];
    const blank=()=>Array.from({length:DESK_ROWS},()=>Array(COLS).fill(false));
    let used=[blank()];
    const fits=(r,c,w,h)=>{
      if(r+h>DESK_ROWS||c+w>COLS) return false;
      for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++) if(used[page][r+dy][c+dx]) return false;
      return true;
    };
    state.desk.forEach(key=>{
      const d=deskWOf(key);
      const w=d?d.w:1,h=d?d.h:1;
      for(let guard=0;guard<400;guard++){
        if(fits(row,col,w,h)){
          if(onPlace) pages[page].push(key);
          for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++) used[page][row+dy][col+dx]=true;
          col+=w;
          if(col>=COLS){ col=0; row++; }
          break;
        }
        col++;                                   /* 当前位置被占/放不下 → 游标前进 */
        if(col>=COLS){ col=0; row++; }
        if(row+h>DESK_ROWS){                     /* 本页剩余空间不够 → 翻新页 */
          page++; pages.push([]); used.push(blank());
          row=0; col=0;
        }
      }
    });
    return pages;
  };
  return run(true);
}
function deskItemHtml(key){
  if(key.indexOf('app:')===0){
    const app=APPS.find(a=>a.id===key.slice(4));
    if(!app)return '';
    return `<div class="desk-item" data-key="${key}" data-app="${app.id}">${iconHtml(app)}</div>`;
  }
  const d=deskWOf(key); if(!d)return '';
  const wcls=d.w===4?'w4':(d.w===2?'w2':'');
  const hcls=d.h===2?'h2':'';
  /* v2.24.3：组件下方带 widgets 小字标注（参考用户截图） */
  return `<div class="desk-item wcap ${wcls} ${hcls}" data-key="${key}">${widgetInner(key)}<div class="wdg-cap">widgets</div></div>`;
}
/* v2.24.18：备忘录「当日键」—— YYYY-M-D，同一天的任务归为一组 */
function calDayKeyOf(d){ d=d||new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function widgetInner(key){
  const w=state.widgets=state.widgets||{cal:{note:''},photo:{img:'',cap:''}};
  if(!w.cal)w.cal={note:''};
  if(!Array.isArray(w.cal.items))w.cal.items=[];      /* v2.24.5：老存档补待办数组 */
  if(!w.photo)w.photo={img:'',cap:''};
  const d=new Date();
  const week='日一二三四五六'[d.getDay()];
  /* v2.24.18：备忘录按「当日」归属 —— 只显示今天记的任务，跨天自动清空 */
  const calDayKey=calDayKeyOf(d);
  const M=state.music||{tracks:[],cur:null,playing:false};
  const track=(M.cur!=null&&M.tracks[M.cur])?M.tracks[M.cur]:null;
  /* v2.24.5：备忘组件 —— 手机待办事项卡片（2×2）。
     有待办：按「未完成在前」列出（最多 3 条，带勾选框）；
     没待办：退化成当日日期显示（大日期 + 星期）。 */
  if(key==='wdg:cal'){
    /* v2.24.18：只取今天的任务（旧存档无 day 标记 / 昨天的任务跨天不再显示） */
    const items=(w.cal.items||[]).filter(x=>x&&x.day===calDayKey);
    const undone=items.filter(x=>!x.done), done=items.filter(x=>x.done);
    const show=undone.concat(done).slice(0,3);
    const left=undone.length;
    if(!items.length){
      return `
        <div class="wdg wdg-cal2 wdg-todo" id="wdgCal" title="点击添加待办">
          <div class="wdg-t">${I('cal',13)} 备忘录</div>
          <div class="cal2-big">${d.getMonth()+1}<small>月</small>${d.getDate()}<small>日</small></div>
          <div class="cal2-week">星期${week}</div>
          <div class="cal2-empty">${I('plus',12)} 轻点添加今天要做的事</div>
        </div>`;
    }
    return `
      <div class="wdg wdg-cal2 wdg-todo" id="wdgCal" title="点击管理待办">
        <div class="wdg-t">${I('cal',13)} 备忘录${left?`<span class="todo-left">${left}</span>`:''}</div>
        <div class="cal2-list">
          ${show.map(x=>`
            <div class="cal2-item ${x.done?'done':''}" data-tg="${escapeHtml(x.id)}">
              <span class="cal2-box">${x.done?I('check',11):''}</span>
              <span class="cal2-txt">${escapeHtml(x.text)}</span>
            </div>`).join('')}
          ${items.length>3?`<div class="cal2-more">还有 ${items.length-3} 条…</div>`:''}
        </div>
      </div>`;
  }
  if(key==='wdg:photo')return `
    <div class="wdg wdg-photo" id="wdgPhoto" title="点击更换照片">
      ${w.photo.img?`<img src="${w.photo.img}" alt=""><div class="ph-cap">${escapeHtml(w.photo.cap||'')}</div>`
        :`<div class="wdg-ph">${I('image',22)}<span>轻点放一张照片</span></div>`}
    </div>`;
  /* v2.24.3：音乐 4×2 全宽播放器横条（图一）—— 封面 + 歌名 + 进度条 + 控制键 */
  if(key==='wdg:music')return `
    <div class="wdg wdg-music2 ${track&&M.playing?'playing':''}" id="wdgMusic" title="打开音乐">
      <div class="mu2-top">
        <div class="mu2-art">${I('music',20)}</div>
        <div class="mu2-info">
          <div class="mu2-name">${track?escapeHtml(track.name):'还没在听'}</div>
          <div class="mu2-sub">${track?escapeHtml(track.artist||'网易云音乐'):(M.tracks.length?'去音乐 App 点一首歌':'去音乐 App 导入歌曲')}</div>
        </div>
        <div class="mu2-eq"><i></i><i></i><i></i></div>
      </div>
      <div class="mu2-bar">
        <div class="mu2-track"><i class="mu2-fill" data-muprog></i></div>
      </div>
      <div class="mu2-ctl">
        <button class="mu2-btn" data-act="app" title="打开音乐">${I('star',16)}</button>
        <span class="mu2-gap"></span>
        <button class="mu2-btn" data-act="prev" title="上一首">${I('muPrev',16)}</button>
        <button class="mu2-btn mu2-main" data-act="toggle" title="播放/暂停">${M.playing?I('muPause',18):I('play',18)}</button>
        <button class="mu2-btn" data-act="next" title="下一首">${I('muNext',16)}</button>
        <span class="mu2-gap"></span>
        <button class="mu2-btn" data-act="app" title="打开音乐">${I('headset',16)}</button>
      </div>
      ${track&&M.playing?`<div class="mu2-now">${I('headset',12)} 正在播放 · 点这里到音乐页看播放器</div>`:''}
    </div>`;
  return '';
}
function renderDesktop(){
  $('dock').innerHTML = APPS.filter(a=>a.dock).map(iconHtml).join('');
  document.querySelectorAll('#dock .app-icon').forEach(el=>{
    el.addEventListener('click',()=>openApp(el.dataset.app));
  });
  /* 载入期不碰 deskEnsure（TDZ 风险），真正的补全放在这里 —— 每次渲染都保证布局完整 */
  /* v2.24.2：老存档（deskVer<DESK_VER）一次性迁移到新版默认布局；
     之后用户拖拽会写 deskVer=DESK_VER，自定义布局不会被升级覆盖 */
  if((state.deskVer|0)<DESK_VER){ state.desk=deskDefault(); state.deskVer=DESK_VER; }
  deskEnsure(state.desk=state.desk||[]);
  const pages=deskPack();
  /* v2.24.5：桌面回到两页（删掉拍一拍 + 备忘/音乐并入页2）。
     这里按 DOM 里实际存在的 .hp-page 数量渲染，多出来的分页数据不再静默丢弃，
     并且以后增删页面不用改这段代码。 */
  const grids=[...document.querySelectorAll('#homePages .hp-page .desk-grid')];
  grids.forEach((g,i)=>{ g.innerHTML=(pages[i]||[]).map(deskItemHtml).join(''); });
  bindDesk();
  $('deskQuote').textContent = '°☆+. ' + pick(DESK_QUOTES) + ' .+';
  refreshCoins();
  renderPageDots();
}
function bindDesk(){
  document.querySelectorAll('#homePages .hp-page .desk-item').forEach(el=>{
    el.addEventListener('click',()=>{
      if(Date.now()<deskDragUntil)return;      /* 拖拽结束后的误触不当作点击 */
      const a=el.dataset.app; if(a)openApp(a);
    });
    el.addEventListener('pointerdown',e=>onDeskDown(e,el));
    /* v2.24.3：长按别弹系统菜单/选择，避免干扰拖拽起手 */
    el.addEventListener('contextmenu',e=>e.preventDefault());
  });
  const cal=$('wdgCal');
  if(cal){
    /* v2.24.5：待办行可直接在组件上勾选（勾掉即完成），点空白处才打开编辑面板 */
    cal.querySelectorAll('.cal2-item[data-tg]').forEach(row=>{
      row.addEventListener('click',e=>{
        e.stopPropagation();
        if(Date.now()<deskDragUntil)return;
        const it=(state.widgets.cal.items||[]).find(x=>x.id===row.dataset.tg);
        if(!it)return;
        it.done=!it.done;
        save(); renderWidgets();
        if(it.done)toast('已完成：'+it.text);
      });
    });
    cal.addEventListener('click',editWidgetCal);
  }
  const ph=$('wdgPhoto'); if(ph)ph.addEventListener('click',editWidgetPhoto);
  const mu=$('wdgMusic'); if(mu)mu.addEventListener('click',()=>openApp('music'));
  /* v2.24.3：桌面播放器控制键（阻止冒泡，别再触发「打开音乐 App」）
     v2.24.5：歌单为空时给明确提示并进音乐页（原先静默无反应）；
     toggle 交由 muTogglePlay 处理 —— 它现在会自动播第一首，且不会静默 return */
  document.querySelectorAll('#wdgMusic .mu2-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const act=btn.dataset.act;
      if(act==='app'){ openApp('music'); return; }
      const m=state.music;
      if(!m||!m.tracks||!m.tracks.length){
        toast('歌单还是空的，先去音乐导入一首吧');
        openApp('music');
        return;
      }
      if(act==='toggle'){ muTogglePlay(true); return; }   /* true = 用户主动点 */
      const cur=m.cur==null?0:m.cur;
      if(act==='prev') muPlay((cur-1+m.tracks.length)%m.tracks.length);
      if(act==='next') muPlay((cur+1)%m.tracks.length);
    });
  });
}
/* 拖拽换位：长按 300ms 起拖，松手落到目标格（跨格换位自动持久化）。
   v2.24.2 修复：起拖后的 pointermove / pointerup 此前没有接到 deskDragMove / deskDragEnd——
   ghost 不跟手、松手不落位，且 deskDrag 永久占用导致之后再也无法开始新的拖拽。
   v2.24.3 灵敏度：长按 360→300ms；位移阈值放宽（横 18 / 竖 24px，水平大幅位移仍让给翻页）；
   配合 CSS touch-action:pan-x，浏览器不再因手指微动发 pointercancel 杀掉长按。 */
let deskDrag=null, deskDragUntil=0;
function onDeskDown(e,el){
  if(deskDrag)return;
  if(e.button!==undefined&&e.button!==0)return;
  const sx=e.clientX, sy=e.clientY;
  const st=setTimeout(()=>{ try{ deskDragStart(e,el); }catch(err){ deskDrag=null; } },300);
  const done=()=>{ window.removeEventListener('pointermove',mv); window.removeEventListener('pointerup',up); window.removeEventListener('pointercancel',upc); };
  const mv=ev=>{
    if(!deskDrag){
      const dx=Math.abs(ev.clientX-sx), dy=Math.abs(ev.clientY-sy);
      if(dx>18||dy>24){ clearTimeout(st); done(); }   /* 没起拖就大幅移动 → 当滑动翻页 */
    }else{ deskDragMove(ev); }                         /* 起拖后 ghost 跟手 */
  };
  const up=ev=>{ clearTimeout(st); if(deskDrag){ try{ deskDragEnd(ev,false); }catch(err){} } done(); };
  const upc=ev=>{ clearTimeout(st); if(deskDrag){ try{ deskDragEnd(ev,true); }catch(err){} } done(); };
  window.addEventListener('pointermove',mv,{passive:true});
  window.addEventListener('pointerup',up);
  window.addEventListener('pointercancel',upc);
}
function deskDragStart(e,el){
  const r=el.getBoundingClientRect();
  const g=el.cloneNode(true);
  g.removeAttribute('id');
  /* v2.24.4 关键修复：ghost 必须命中 #dragGhost 规则（position:fixed + pointer-events:none）。
     此前 ghost 只是克隆的 .desk-item（position:relative）—— left/top 相对原位置偏移，完全不跟手；
     更糟的是 pointer-events 未关闭，elementFromPoint 一直命中 ghost 自己，
     drop-hint 永远不出现、松手经常不落位 —— 这就是「拖不动 / 像只能互换」的元凶。 */
  g.id='dragGhost';
  g.style.width=r.width+'px'; g.style.height=r.height+'px';
  g.style.left=e.clientX+'px'; g.style.top=e.clientY+'px';
  document.getElementById('phone').appendChild(g);
  el.classList.add('dragging');
  document.body.classList.add('dragging');
  deskDrag={key:el.dataset.key,el,ghost:g,started:true};
  try{ if(navigator.vibrate)navigator.vibrate(12); }catch(_){}
  /* 拖动期间挡掉触摸滚动，避免拖拽和滑页打架 */
  deskDrag.block=ev=>{ if(deskDrag&&deskDrag.started)ev.preventDefault(); };
  document.addEventListener('touchmove',deskDrag.block,{passive:false});
  deskDragMove(e);
}
function deskDragMove(e){
  if(!deskDrag||!deskDrag.started)return;
  deskDrag.ghost.style.left=e.clientX+'px';
  deskDrag.ghost.style.top=e.clientY+'px';
  const under=document.elementFromPoint(e.clientX,e.clientY);
  const tgt=under&&under.closest?under.closest('.desk-item'):null;
  document.querySelectorAll('.desk-item.drop-hint').forEach(x=>x.classList.remove('drop-hint'));
  if(tgt&&tgt.dataset.key&&tgt.dataset.key!==deskDrag.key)tgt.classList.add('drop-hint');
}
function deskDragEnd(e,cancelled){
  if(!deskDrag)return;
  const d=deskDrag;
  if(d.block)document.removeEventListener('touchmove',d.block);
  let moved=false;
  if(d.started){
    /* pointercancel 或拿不到坐标时只清理、不落位，避免东西飞到 (0,0) */
    if(!cancelled&&e&&typeof e.clientX==='number'){
      const under=document.elementFromPoint(e.clientX,e.clientY);
      const tgt=under&&under.closest?under.closest('.desk-item'):null;
      if(tgt&&tgt.dataset.key&&tgt.dataset.key!==d.key){
        deskReorder(d.key,tgt.dataset.key);
        deskDragUntil=Date.now()+450;
        moved=true;
      }
    }
    if(d.ghost)d.ghost.remove();
    d.el.classList.remove('dragging');
    document.body.classList.remove('dragging');
    document.querySelectorAll('.desk-item.drop-hint').forEach(x=>x.classList.remove('drop-hint'));
  }
  deskDrag=null;
  if(moved)renderDesktop();
}
function deskReorder(fromKey,toKey){
  const d=state.desk;
  const fi=d.indexOf(fromKey);
  if(fi<0)return;
  d.splice(fi,1);
  const tj=d.indexOf(toKey);
  if(tj<0){ d.push(fromKey); } else { d.splice(tj,0,fromKey); }
  state.deskVer=DESK_VER;   /* 用户自定义过布局，后续升级不再重排 */
  save();
}
/* ================= 桌面分页：左右滑动 + 页点（v2.23.0） ================= */
function renderPageDots(){
  const wrap=$('homePages'), dots=$('pageDots');
  if(!wrap||!dots)return;
  const pages=[...wrap.querySelectorAll('.hp-page')];
  if(dots.children.length!==pages.length){
    dots.innerHTML=pages.map((_,i)=>`<i class="${i===0?'on':''}" data-pg="${i}"></i>`).join('');
    dots.querySelectorAll('i').forEach(el=>el.addEventListener('click',()=>{
      wrap.scrollTo({left:(+el.dataset.pg)*wrap.clientWidth,behavior:'smooth'});
    }));
  }
  const sync=()=>{
    const idx=Math.round(wrap.scrollLeft/Math.max(1,wrap.clientWidth));
    [...dots.children].forEach((el,i)=>el.classList.toggle('on',i===idx));
  };
  if(!wrap.__pgBound){ wrap.__pgBound=true; wrap.addEventListener('scroll',sync,{passive:true}); }
}
/* 兼容入口：老代码里 renderWidgets() 一律整桌重绘（v2.24.0 起组件混排在两页里） */
function renderWidgets(){ renderDesktop(); }
/* 拖拽的全局收尾（pointermove/up 绑在 window 上，桌面重建后依然有效） */
window.addEventListener('pointermove',e=>{ if(deskDrag&&deskDrag.started)deskDragMove(e); },{passive:false});
window.addEventListener('pointerup',e=>{ if(deskDrag)deskDragEnd(e); });
window.addEventListener('pointercancel',e=>{ if(deskDrag)deskDragEnd(e); });
/* v2.24.5：备忘组件编辑面板 —— 增删待办、勾选完成（仿手机待办事项 App）
   底部一个输入框 + 回车/加号添加；每条可勾选、可删除。 */
function editWidgetCal(){
  const w=state.widgets;
  if(!Array.isArray(w.cal.items))w.cal.items=[];
  /* v2.24.18：备忘录只保留当天的 —— 打开编辑面板时顺手清掉往日任务（跨天自动清空） */
  const tk=calDayKeyOf();
  w.cal.items=w.cal.items.filter(x=>x&&x.day===tk);
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  const render=()=>{
    const items=w.cal.items;
    const undone=items.filter(x=>!x.done), done=items.filter(x=>x.done);
    const list=undone.concat(done);
    const panel=sheet.querySelector('.sheet-panel');
    panel.innerHTML=`
      <div style="font-weight:800;font-size:15px;margin-bottom:4px">${I('cal',15)} 备忘录</div>
      <div class="desc" style="margin-bottom:10px">记下今天要做的事；勾掉的就完成了。只显示当天的任务，第二天会自动清空，桌面组件随之显示日期。</div>
      <div class="todo-list">
        ${list.length?list.map(x=>`
          <div class="todo-row ${x.done?'done':''}">
            <span class="todo-box" data-todo-tg="${escapeHtml(x.id)}">${x.done?I('check',12):''}</span>
            <span class="todo-tx">${escapeHtml(x.text)}</span>
            <span class="todo-x" data-todo-del="${escapeHtml(x.id)}" title="删除">✕</span>
          </div>`).join(''):'<div class="desc" style="text-align:center;padding:14px 0">还没有待办，在下面加一条吧</div>'}
      </div>
      <div class="todo-add">
        <input id="todoIn" maxlength="24" placeholder="添加一条待办…">
        <button class="btn" id="todoAdd">${I('plus',15)}</button>
      </div>
      <button class="btn ghost block" id="todoClose" style="margin-top:10px">完成</button>`;
    bind();
  };
  const bind=()=>{
    const panel=sheet.querySelector('.sheet-panel');
    panel.querySelectorAll('[data-todo-tg]').forEach(el=>el.addEventListener('click',()=>{
      const it=w.cal.items.find(x=>x.id===el.dataset.todoTg);
      if(!it)return;
      it.done=!it.done;
      save(); render(); renderWidgets();
      if(it.done)toast('已完成：'+it.text);
    }));
    panel.querySelectorAll('[data-todo-del]').forEach(el=>el.addEventListener('click',()=>{
      const i=w.cal.items.findIndex(x=>x.id===el.dataset.todoDel);
      if(i<0)return;
      w.cal.items.splice(i,1);
      save(); render(); renderWidgets();
    }));
    const inp=panel.querySelector('#todoIn');
    const addOne=()=>{
      const v=(inp.value||'').trim();
      if(!v)return;
      w.cal.items.push({id:'td'+Date.now()+Math.floor(Math.random()*1000),text:v,done:false,day:tk});
      inp.value='';
      save(); render(); renderWidgets();
      const nx=sheet.querySelector('#todoIn'); if(nx)nx.focus();
    };
    panel.querySelector('#todoAdd').addEventListener('click',addOne);
    if(inp)inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); addOne(); } });
    panel.querySelector('#todoClose').addEventListener('click',()=>sheet.remove());
  };
  sheet.innerHTML=`<div class="sheet-mask"></div><div class="sheet-panel"></div>`;
  document.getElementById('phone').appendChild(sheet);
  sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
  render();
  setTimeout(()=>{ const i=sheet.querySelector('#todoIn'); if(i)i.focus(); },80);
}
function editWidgetPhoto(){
  const w=state.widgets;
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  sheet.innerHTML=`
    <div class="sheet-mask"></div>
    <div class="sheet-panel">
      <div style="font-weight:800;font-size:15px;margin-bottom:4px">照片小组件</div>
      <div class="desc" style="margin-bottom:12px">换一张照片并配一句话；大图会自动压缩到适合组件的尺寸。</div>
      <div style="display:flex;gap:10px">
        <button class="btn block" id="wdgPhUp">${I('image',15)} 选择照片</button>
        ${w.photo.img?`<button class="btn ghost block" id="wdgPhRm">移除照片</button>`:''}
      </div>
      <input type="file" id="wdgPhFile" accept="image/*" style="display:none">
      <div class="desc" style="margin-top:10px">小组件可以在桌面<b>长按拖动</b>换位置；照片是最大的 2×2 组件。</div>
    </div>`;
  document.getElementById('phone').appendChild(sheet);
  sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
  sheet.querySelector('#wdgPhUp').addEventListener('click',()=>sheet.querySelector('#wdgPhFile').click());
  const rm=sheet.querySelector('#wdgPhRm');
  if(rm)rm.addEventListener('click',()=>{ w.photo={img:'',cap:''}; save(); sheet.remove(); renderWidgets(); });
  sheet.querySelector('#wdgPhFile').addEventListener('change',e=>{
    const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=()=>compressImage(r.result,720,url=>{
      sheet.remove();
      const mk=openModal('给照片配句话（可留空）',`<div class="field" style="margin-bottom:0"><input id="wdgPhCap" maxlength="24" value="${escapeHtml(w.photo.cap||'')}" placeholder="一句话…"></div>`,()=>{
        w.photo={img:url,cap:mk.querySelector('#wdgPhCap').value.trim()};
        save(); renderWidgets(); toast('照片组件已更新');
      });
    },0.85);
    r.readAsDataURL(f);
    e.target.value='';
  });
}
function totalUnread(){
  let n=0;
  for(const id in state.chats){
    const arr=state.chats[id];
    if(arr.length && arr[arr.length-1].role==='ta') { /* 最近一条是ta → 计为未读 */ }
  }
  // 简化：维护显式未读计数
  for(const k in unreadMap) n+=unreadMap[k];
  return n;
}
const unreadMap = {};
function markUnread(id){ unreadMap[id]=(unreadMap[id]||0)+1; renderDesktop(); }
function clearUnread(id){ if(unreadMap[id]){ delete unreadMap[id]; renderDesktop(); } }

/* ================= 应用路由 ================= */
let currentApp=null, currentChatId=null;
const APP_TITLES={chat:'聊天',moments:'邻屿圈',mail:'信箱',music:'音乐',diary:'心情手札',cal:'日历',ann:'纪念日',fort:'占卜',market:'闲屿小集',survey:'问卷',track:'灯塔',games:'游戏',period:'经期记录',cards:'字卡库',pat:'拍一拍',theme:'主题',set:'设置'};
function openApp(id, param){
  currentApp=id;
  $('appWindow').classList.remove('hide');
  $('appTitle').textContent = APP_TITLES[id]||'';
  $('appSub').textContent='';
  const bell=$('appBell');
  if(bell)bell.classList.add('hide');   /* 朋友圈页再单独显示 */
  const body=$('appBody');
  body.classList.remove('chat-mode');
  const extra=$('appExtra');
  extra.classList.add('hide');
  extra.onclick=null;
  currentChatId=null;
  const R={
    chat:  ()=>renderChatList(body,extra),
    moments:()=>renderMoments(body,extra),
    mail:  ()=>renderMail(body,extra),
    music: ()=>renderMusic(body,extra),
    diary: ()=>renderDiary(body,extra),
    cal:   ()=>renderCal(body,extra),
    ann:   ()=>renderAnn(body,extra),
    fort:  ()=>renderFort(body,extra),
    market:()=>renderMarket(body,extra),
    survey:()=>renderSurvey(body,extra),
    track: ()=>renderTrack(body,extra),
    games: ()=>renderGames(body,extra),
    period:()=>renderPeriod(body,extra),
    cards: ()=>renderCards(body,extra),
    /* v2.24.5：'pat' 路由已移除 —— 桌面不再有拍一拍图标（字卡库里有该页签） */
    theme: ()=>renderTheme(body,extra),
    set:   ()=>renderSet(body,extra),
  };
  (R[id]||(()=>{}))();
  if(id==='chat' && param) openChat(param);
  /* v2.24.6：切页后再决定全局播放器的可见性 —— 只有聊天横幅里才亮着，其他页面藏起来继续放 */
  parkMuPlayer();
  syncSaveBar();   /* 只有设置页且有未保存改动时才升起保存条 */
}
function closeApp(){
  /* 防误触：设置页有未保存改动时，先问一句再离开 */
  if(currentApp==='set' && draftDirty() && !setUnlocked){
    openModal('还有改动没保存',`<div style="font-size:14px;line-height:1.7">设置里有改动还没保存。<br>要保存后离开，还是丢弃这些改动？</div>`,()=>{
      save(); snapSaved(); syncSaveBar();
      $('appWindow').classList.add('hide');
      currentApp=null; currentChatId=null;
      renderDesktop();
      toast('已保存并返回');
    },()=>{
      /* 直接离开 = 丢弃改动：state 回到快照，再关页 */
      const snap=setSavedSnap?JSON.parse(setSavedSnap):null;
      if(snap){ state.settings=snap; save(); applyTheme(); }
      $('appWindow').classList.add('hide');
      currentApp=null; currentChatId=null;
      syncSaveBar();
      renderDesktop();
      toast('已丢弃未保存的改动');
    },'保存并返回','直接离开');
    return;
  }
  $('appWindow').classList.add('hide');
  currentApp=null; currentChatId=null;
  syncSaveBar();
  renderDesktop();
  parkMuPlayer();   /* v2.24.6：回桌面也照样不停播，只是把播放器收到幕后 */
}
$('appBack').addEventListener('click',()=>{
  // 聊天页内返回 → 回联系人列表
  if(currentApp==='chat' && currentChatId){
    currentChatId=null;
    renderListenBar();     /* v2.24.7：回到会话列表，横幅清掉；悬浮播放器原地不动、继续放 */
    openApp(currentApp);
  }else closeApp();
});

/* ================= 聊天：会话列表（联系人 / 群聊） ================= */
function lastPreview(id){
  const arr=state.chats[id];
  if(!arr||!arr.length) return '…';
  const m=arr[arr.length-1];
  return (m.role==='me'?'我: ':'')+(m.type==='rp'?'[红包]':m.type==='sticker'?'[表情包]':m.text).slice(0,20);
}
let chatTab='single';
function renderChatList(body,extra){
  currentChatId=null;
  let manage=false;
  function draw(){
    const isG=chatTab==='group';
    /* v2.22.0：群人数要把「我」算上（成员列表里只有联系人） */
    const list = isG? state.groups.map(g=>({id:g.id,name:g.name,sub:`${(g.members||[]).length+1}人`,isG:true,g}))
                    : state.contacts.map(c=>({id:c.id,name:c.name,sub:lastPreview(c.id),isG:false}));
    const rows = list.map(c=>`
      <div class="contact-item" data-id="${c.id}">
        ${c.isG?groupAvatarHtml(c.g,''):avatarHtml(c.name,'',c.id)}
        <div class="info"><div class="nm">${escapeHtml(c.name)}${c.isG?` <span class="count">(${c.sub})</span>`:''}</div>
        ${c.isG?'':`<div class="pv">${escapeHtml(c.sub)}</div>`}</div>
        ${unreadMap[c.id]?`<span class="unread">${unreadMap[c.id]}</span>`:''}
        ${manage?`<span class="delx edtx" data-edit="${c.id}" style="display:flex;align-items:center" title="${c.isG?'修改群名称':'编辑'}">${I('pen',14)}</span>`:''}
        ${manage?`<span class="delx" data-del="${c.id}">✕</span>`:''}
      </div>`).join('');
    body.innerHTML = `
      <div class="seg">
        <button class="${!isG?'on':''}" data-tab="single">联系人</button>
        <button class="${isG?'on':''}" data-tab="group">群聊</button>
      </div>
      <div class="card" style="padding:6px 16px">${rows||`<div class="empty">还没有${isG?'群聊':'联系人'}${isG?'':'，点右上角＋添加'}</div>`}</div>
      <button class="btn ghost block" id="addContactBtn">＋ ${isG?'创建群聊':'新建联系人'}</button>`;
    body.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>{ chatTab=el.dataset.tab; draw(); }));
    body.querySelectorAll('.contact-item').forEach(el=>{
      el.addEventListener('click',e=>{
        const editBtn=e.target.closest('[data-edit]');
        if(editBtn){
          e.stopPropagation();
          const editId=editBtn.dataset.edit;
          if(isG){
            /* v2.24.18：群名称可修改（管理模式 ✎ 铅笔） */
            const g=state.groups.find(x=>x.id===editId);
            if(!g)return;
            openModal('修改群名称',`
              <div class="field"><label>群名称</label><input id="gnName" maxlength="12" value="${escapeHtml(g.name)}" placeholder="给群起个名字"></div>`,mk=>{
              const v=mk.querySelector('#gnName').value.trim();
              if(!v){ toast('群名称不能为空'); return false; }
              if(v===g.name)return true;
              g.name=v;
              save(); draw(); renderDesktop();
              toast('群名称已改为「'+v+'」');
            });
          }else{
            openContactEditor(state.contacts.find(c=>c.id===editId),draw);
          }
          return;
        }
        openChat(el.dataset.id);
      });
    });
    /* 删除只绑定在 ✕ 上（✎ 是编辑，两者都带 delx 样式，此前误绑导致点编辑弹删除） */
    body.querySelectorAll('[data-del]').forEach(el=>el.addEventListener('click',e=>{
      e.stopPropagation();
      const id=el.dataset.del;
      if(!isG){
        const name=contactName(id);
        const target=state.contacts.find(c=>c.id===id);
        const hasRp=target&&target.replyProb!==undefined&&target.replyProb!==null;
        openModal('删除联系人',`<div style="font-size:14px;line-height:1.7">确定删除联系人「${escapeHtml(name)}」及其聊天记录？</div>`+
          (hasRp?`<div class="desc" style="margin-top:10px">ta 的回复概率（${target.replyProb}%）将转为<b>「ta 使用拍一拍」的概率</b>。</div>`:''),()=>{
          /* 删除前：把该联系人的「回复概率」迁移为「拍一拍概率」 */
          if(hasRp){ state.settings.patProb=Math.min(100,Math.max(0,target.replyProb)); }
          state.contacts=state.contacts.filter(c=>c.id!==id);
          delete state.chats[id]; delete unreadMap[id]; delete state.privLibs[id];
          save(); draw(); renderDesktop();
          toast(hasRp?`已删除 · 回复概率转为拍一拍概率 ${state.settings.patProb}%`:'已删除');
        });
      }else{
        openModal('删除群聊','<div style="font-size:14px;line-height:1.7">确定删除该群聊及其聊天记录？</div>',()=>{
          state.groups=state.groups.filter(g=>g.id!==id);
          delete state.chats[id]; delete unreadMap[id];
          save(); draw(); renderDesktop(); toast('已删除');
        });
      }
    }));
    $('addContactBtn').addEventListener('click',()=>{
      if(isG){
        if(state.contacts.length<2)return toast('先切到「联系人」添加至少2人');
        const mask=openModal('创建群聊',`
          <div class="field"><label>群名称</label><input id="geName" maxlength="12" placeholder="给群起个名字"></div>
          <div class="field" style="margin-bottom:0"><label>选择成员（至少 2 人）</label>
            <div style="margin-top:6px">${state.contacts.map(ct=>`<label class="gm-row"><input type="checkbox" value="${ct.id}"> ${escapeHtml(ct.name)}</label>`).join('')}</div>
          </div>`,mk=>{
          const name=mk.querySelector('#geName').value.trim();
          const ids=[...mk.querySelectorAll('input[type=checkbox]:checked')].map(x=>x.value);
          if(!name){ toast('先给群起个名字'); return false; }
          if(ids.length<2){ toast('至少选择2个成员'); return false; }
          state.groups.push({id:'g'+Date.now(),name,members:ids,avatar:null,avatarLib:[]});
          save(); draw(); renderDesktop(); toast('群聊已创建');
        });
      }else{
        openContactEditor(null,draw);
      }
    });
  }
  extra.classList.remove('hide');
  extra.classList.add('dots');
  extra.innerHTML='···';
  extra.title='管理';
  extra.onclick=()=>{ manage=!manage; draw(); };
  draw();
}

/* ================= 聊天：会话窗口 ================= */
function fmtClock(t){ const d=new Date(t); return fmtTime(t)+':'+String(d.getSeconds()).padStart(2,'0'); }
function renderChatMsgs(){
  const list=$('msgList');
  const arr=state.chats[currentChatId]||[];
  let html='',lastT=0,lastDay='';
  for(const m of arr){
    const day=fmtDate(m.t);
    if(day!==lastDay){
      const d=new Date(m.t);
      html+=`<div class="divider">${d.getMonth()+1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}</div>`;
      lastDay=day;
    }else if(m.t-lastT>5*60e3) html+=`<div class="divider">${fmtTime(m.t)}</div>`;
    lastT=m.t;
    if(m.role==='sys'){ html+=`<div class="sysline">${escapeHtml(m.text)}</div>`; continue; }
    const who = m.role==='ta' ? (isGroup(currentChatId)?contactName(m.by||''):'') : '';
    const ava = m.role==='ta'
      ? avatarHtml(who||state.contacts.find(c=>c.id===currentChatId)?.name||'梦','sm', isGroup(currentChatId)?(m.by||currentChatId):currentChatId)
      : avatarHtml(state.settings.myName,'sm','me');
    let bub;
    if(m.type==='rp'){
      /* v2.24.7：红包**不再套对话气泡**（用户反馈「直接就是一个单红包样式」）。
         旧版外层节点带气泡类名，会被气泡预设（尤其带 !important 的仿微信款）
         抢到背景/圆角/内边距，红包外圈出现一层多余的气泡壳。
         现在外层改名 rp-wrap，气泡预设的选择器全部匹配不到。 */
      const env=(opt)=>{
        const cls=opt.claimable?'rp-wrap rp claimable':(opt.claimed?'rp-wrap rp claimed':'rp-wrap rp');
        const attrs=opt.claimable?` data-claim="${arr.indexOf(m)}"`:'';
        const badge=opt.claimed?'✓':'開';
        const txt=opt.title||'';
        const sub=opt.sub||'';
        return `<div class="${cls}"${attrs}>
          <div class="rp-env">
            <div class="rp-flap"></div>
            <div class="rp-head">${I('gift',13)}<span class="rp-from">${opt.from}</span></div>
            <div class="rp-body">
              <div class="rp-open"><b>${badge}</b></div>
              ${txt?`<div class="rp-txt">${txt}</div>`:''}
              ${sub?`<div class="rp-sub">${sub}</div>`:''}
            </div>
            <div class="rp-bot">微信红包</div>
          </div>
        </div>`;
      };
      if(m.role==='ta'){
        const fromName=isGroup(currentChatId)?escapeHtml(contactName(m.by||'')):'ta';
        bub=m.claimed
          ?env({claimed:true,from:fromName+' 的红包',title:'已领取 ¥'+escapeHtml(m.text),sub:'手气不错～'})
          :env({claimable:true,from:fromName+' 发来一个红包',title:'',sub:'点开信封领取'});
      }else{
        /* 我自己发的红包：未领完的那份挂成可点「领取」，领过了则显示金额 */
        if(m.claimable && !m.claimed){
          bub=env({claimable:true,from:'我的红包',title:'还剩 ¥'+escapeHtml(m.text),sub:'点开领回自己那份'});
        }else if(m.mine && m.claimed){
          bub=env({claimed:true,from:'我的红包',title:'你领回了 ¥'+escapeHtml(m.text),sub:'已领取'});
        }else{
          bub=env({from:'我发的红包',title:'¥'+escapeHtml(m.text),sub:'等你来领'});
        }
      }
    }else if(m.type==='sticker'){
      let st=state.stickers.find(s=>s.id===m.text);
      if(!st)state.contacts.forEach(c=>{ if(!st&&c.stickers)st=c.stickers.find(s=>s.id===m.text); });
      if(!st&&state.myStickers)st=state.myStickers.find(s=>s.id===m.text);
      const body = st ? (st.type==='emoji'?`<span class="stk-em">${escapeHtml(st.data)}</span>`:`<img src="${st.data}" alt="">`) : '[表情包]';
      /* v2.22.0：表情包不再套气泡背景，直接展示表情本身 */
      bub=`<div class="stk-b" data-mi="${arr.indexOf(m)}">${body}</div>`;
    }else{
      const q = m.quote?`<div class="quote-block">${escapeHtml(m.quote)}</div>`:'';
      const at = m.at?`<span class="at-tag">@${escapeHtml(m.at)}</span> `:'';
      /* 文本中的 @提及 也高亮（我 @ 群成员 / ta @人） */
      const txt = escapeHtml(m.text).replace(/@([^\s@，。,,]{1,12})/g,'<span class="at-tag">@$1</span>');
      bub=`<div class="bubble" data-mi="${arr.indexOf(m)}">${q}${at}${txt}</div>`;
    }
    const readTag = m.role==='me'&&m.read ? '<span class="read-tag">已读</span>' : '';
    const mts = `<span class="mts">${fmtClock(m.t)}</span>`;
    const nameTag = isGroup(currentChatId)&&m.role==='ta' ? `<div style="font-size:10px;color:var(--ink-3);margin:0 0 1px 42px">${escapeHtml(who)}</div>`:'';
    html+= nameTag + `<div class="row ${m.role==='me'?'me':''}">${ava}${bub}${readTag}${mts}</div>`;
  }
  list.innerHTML=html;
  list.scrollTop=list.scrollHeight;
  /* 领取红包（ta 发的 / 我自己发但剩给我的那份） */
  list.querySelectorAll('[data-claim]').forEach(el=>el.addEventListener('click',()=>{
    const m=arr[+el.dataset.claim];
    if(!m||m.claimed)return;
    m.claimed=true;
    const amt=parseFloat(m.text)||0;
    state.coins=+(state.coins+amt).toFixed(2);
    const from=isGroup(currentChatId)?contactName(m.by||''):contactName(currentChatId);
    if(m.mine){
      pushChatMsg(currentChatId,'sys',`你领回了自己红包的 ¥${m.text}`);
    }else{
      pushChatMsg(currentChatId,'sys',`你领取了「${from}」的红包 ¥${m.text}`);
    }
    save(); refreshCoins(); renderChatMsgs();
    toast('收到红包 ¥'+m.text);
    if(!m.mine && Math.random()<0.6)setTimeout(()=>{ const c=drawCard('撒娇 · 粘人',m.by||currentChatId)||drawCard(null,m.by||currentChatId); if(c)pushChatMsg(currentChatId,'ta',c,null,m.by||currentChatId); },2500);
  }));
  /* 长按消息 → 操作菜单（引用回复）；桌面端右键同样可用 */
  function msgPreview(m){
    if(!m)return '';
    return m.type==='sticker'?'[表情包]':m.type==='rp'?'[红包]':String(m.text).slice(0,30);
  }
  function showMsgMenu(i){
    const m=arr[i];
    if(!m||m.type==='rp')return;
    const who=m.role==='me'?'我':(isGroup(currentChatId)?contactName(m.by||''):contactName(currentChatId));
    const sheet=document.createElement('div');
    sheet.className='action-sheet';
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div class="chip msg-act" data-quote="1" style="padding:13px 15px;font-size:14px;cursor:pointer;border-radius:12px;background:#f6f6f8">↩︎ 引用${m.role==='me'?'自己':escapeHtml(who)}的话</div>
        </div>
      </div>`;
    document.getElementById('phone').appendChild(sheet);
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelector('[data-quote]').addEventListener('click',()=>{
      sheet.remove();
      setReplyQuote({who,text:msgPreview(m)});
      $('msgInput').focus();
    });
  }
  list.querySelectorAll('[data-mi]').forEach(el=>{
    let lpTimer=null;
    const start=()=>{ lpTimer=setTimeout(()=>showMsgMenu(+el.dataset.mi),450); };
    const cancel=()=>clearTimeout(lpTimer);
    el.addEventListener('touchstart',start,{passive:true});
    el.addEventListener('touchend',cancel);
    el.addEventListener('touchmove',cancel);
    el.addEventListener('touchcancel',cancel);
    el.addEventListener('contextmenu',e=>{ e.preventDefault(); showMsgMenu(+el.dataset.mi); });
  });
}
function isGroup(id){ return id && id[0]==='g'; }

function openChat(id){
  currentChatId=id;
  clearUnread(id);
  const isG=isGroup(id);
  const g=isG?state.groups.find(x=>x.id===id):null;
  const name=isG?g.name:contactName(id);
  $('appTitle').textContent=name;
  /* v2.18.0：联系人显示当天状态（在工作/在休息/出门散步/想念你…），群聊不显示 */
  $('appSub').textContent=chatSubOf(id);
  const body=$('appBody');
  body.classList.add('chat-mode');
  $('appExtra').classList.add('hide');
  body.innerHTML=`
    <div id="msgList"></div>
    <div id="quoteBar" class="quote-bar hide"></div>
    <div class="inputbar-wrap" id="ibWrap">
      <div class="inputbar" id="ibBar">
        <input id="msgInput" type="text" placeholder="发消息…" maxlength="500">
        <button class="sendbtn" id="sendBtn" title="发送">发送</button>
        <button class="plusbtn" id="plusBtn" title="表情 · 互动">${IC('<path d="M12 5.5v13M5.5 12h13"/>')}</button>
      </div>
    </div>`;
  renderChatMsgs();
  renderListenBar();       /* v2.23.0：一起听横幅 */
  syncListenBar();         /* v2.24.6：横幅渲染完后把全局播放器停靠进来 */
  applyChatWallpaper();
  applyTheme();          /* 会话级气泡 / 字体：进入聊天时重算注入的 CSS */
  setReplyQuote(null);
  /* v2.19.0：输入栏常驻（微信式），不再有把手 / 收起 / 点空白收起那一行的功能 */
  closePanels();
  const ibInput=$('msgInput');
  const sendBtnEl=$('sendBtn');
  /* v2.24.0：发送按钮空闲/激活双态 —— 没打字时幽灵样式融入输入栏，打字点亮 */
  const syncSendBtn=()=>{
    if(!sendBtnEl)return;
    const has=!!(ibInput&&ibInput.value.trim());
    sendBtnEl.classList.toggle('idle',!has);
  };
  if(sendBtnEl)sendBtnEl.classList.add('idle');
  if(ibInput)ibInput.addEventListener('input',syncSendBtn);
  sendBtnEl.addEventListener('click',sendCurrent);
  $('msgInput').addEventListener('keydown',e=>{ if(e.key==='Enter'){ sendCurrent(); } });
  /* 点击空白处收起底部面板（表情 / 表情包 / 加号面板）——输入栏本身不再收起 */
  function closePanels(){
    document.querySelectorAll('.stk-panel,.emoji-panel,.plus-panel').forEach(p=>p.remove());
    const pb=$('plusBtn'); if(pb)pb.classList.remove('on');
  }
  $('msgList').addEventListener('click',closePanels);
  $('quoteBar').addEventListener('click',closePanels);
  const ibBar=$('ibBar');
  if(ibBar)ibBar.addEventListener('click',e=>{
    if(e.target.closest('#sendBtn')||e.target.closest('#plusBtn'))return;
    if(e.target.classList.contains('inputbar'))closePanels();
  });
  /* 加号面板（微信风格格子）：表情 / 表情包 / 拍一拍 / 通话 / @ / 更多 */
  const plusBtn=$('plusBtn');
  if(plusBtn)plusBtn.addEventListener('click',()=>{
    const existing=document.querySelector('.plus-panel');
    closePanels();
    if(existing)return;                       /* 再点一次 = 收起 */
    plusBtn.classList.add('on');
    const p=document.createElement('div');
    p.className='plus-panel';
    const items=[
      ['emoji','表情','<circle cx="12" cy="12" r="8.5"/><path d="M8.8 13.5a4.3 4.3 0 0 0 6.4 0M9.3 9.5h.01M14.7 9.5h.01"/>'],
      ['stk','表情包','<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>'],
      ['pat','拍一拍','<path d="M8 12.5V6.8a1.4 1.4 0 0 1 2.8 0v4.4m0-2.7a1.4 1.4 0 0 1 2.8 0v2.7m0-1.6a1.4 1.4 0 0 1 2.8 0v3.9c0 3.3-2 5.5-5.2 5.5-2.6 0-3.9-1.2-5.2-3.4L4.4 13c-.7-1.2.9-2.5 2-1.5l1.6 1.6z"/>'],
      ['call','通话','<path d="M5.5 4h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5L16 14l4 1.5v3a1.8 1.8 0 0 1-2 1.8C10.6 19.6 4.4 13.4 3.7 6a1.8 1.8 0 0 1 1.8-2z"/>'],
    ];
    /* v2.24.5：发红包从「更多互动」二级菜单提到这里 —— 单聊高频动作，顺手就能点
       v2.24.10：群聊也恢复「发红包」入口（群红包：可选金额与个数 · 全员拼手气 · 我自己也有一份可抢） */
    items.push(['rp','发红包','<rect x="3" y="6" width="18" height="13" rx="2.6"/><path d="M3 9.8 12 14.4l9-4.6"/><path d="M12 3.4v3.4"/>']);
    if(isG)items.push(['at','@','<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>']);
    items.push(['more','更多','<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>']);
    p.innerHTML=items.map(([t,nm,ic])=>`<div class="plus-item" data-pp="${t}"><div class="pi-ic">${IC(ic)}</div><b>${nm}</b></div>`).join('');
    p.querySelectorAll('.plus-item').forEach(el=>el.addEventListener('click',()=>{
      const t=el.dataset.pp;
      p.remove(); plusBtn.classList.remove('on');   /* 进功能前先收起面板 */
      if(t==='emoji'){ stkTab='emoji'; toggleStickerPanel(); }
      else if(t==='stk'){ stkTab='stk'; toggleStickerPanel(); }
      else if(t==='pat')openPatPicker();
      else if(t==='call')startCall(name);
      else if(t==='rp')doRedPacket(currentChatId);
      else if(t==='at')pickGroupAt();
      else if(t==='more')showActionSheet(id);   /* v2.18.0：群聊也传 id（群聊头像入口在 sheet 内判断） */
    }));
    document.querySelector('.inputbar-wrap').after(p);
  });
}
/* 群聊：我 @ 群成员 —— v2.24.19 支持多选 + 「全体成员」，被 @ 的成员 80% 概率回 1~2 条 */
function pickGroupAt(){
  const g=state.groups.find(x=>x.id===currentChatId);
  if(!g)return;
  const names=[state.settings.myName,...g.members.map(id=>contactName(id))];
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  sheet.innerHTML=`
    <div class="sheet-mask"></div>
    <div class="sheet-panel">
      <div style="font-weight:800;font-size:15px;margin-bottom:4px">@ 群成员</div>
      <div class="desc" style="margin-bottom:10px">可点多个成员一起 @；选「全体成员」则 @ 所有人。被 @ 的成员大概率会回你。</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <span class="chip at-chip at-all" data-n="全体成员" style="background:#f4f4f6;border-radius:14px;padding:8px 13px;font-size:13px;cursor:pointer">📣 全体成员</span>
        ${names.map(n=>`<span class="chip at-chip" data-n="${escapeHtml(n)}" style="background:#f4f4f6;border-radius:14px;padding:8px 13px;font-size:13px;cursor:pointer">@ ${escapeHtml(n)}</span>`).join('')}
      </div>
      <button class="btn block" id="atOk" style="margin-top:12px" disabled>确定（未选择）</button>
    </div>`;
  document.getElementById('phone').appendChild(sheet);
  const sel=[];
  const okBtn=sheet.querySelector('#atOk');
  const syncOk=()=>{
    okBtn.disabled=!sel.length;
    okBtn.textContent=sel.length?('确定 @ '+sel.join('、')):'确定（未选择）';
  };
  sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
  sheet.querySelectorAll('.at-chip').forEach(el=>el.addEventListener('click',()=>{
    const n=el.dataset.n;
    /* 点「全体成员」= 只 @ 全体（清掉其它单选）；再点一次取消 */
    if(el.classList.contains('at-all')){
      if(sel.length===1&&sel[0]==='全体成员'){ sel.length=0; el.style.background='#f4f4f6'; }
      else{ sel.length=0; sel.push('全体成员');
        sheet.querySelectorAll('.at-chip').forEach(c=>{ c.style.background='#f4f4f6'; });
        el.style.background='var(--accent,#1c1c1e)'; el.style.color='#fff'; }
    }else{
      /* 已选了全体成员 → 先清掉它 */
      const i=sel.indexOf(n);
      if(i>=0){ sel.splice(i,1); el.style.background='#f4f4f6'; el.style.color=''; }
      else{
        if(sel[0]==='全体成员'){ sel.length=0;
          const all=sheet.querySelector('.at-all'); if(all){ all.style.background='#f4f4f6'; all.style.color=''; } }
        sel.push(n); el.style.background='var(--accent,#1c1c1e)'; el.style.color='#fff';
      }
    }
    syncOk();
  }));
  okBtn.addEventListener('click',()=>{
    if(!sel.length)return;
    sheet.remove();
    const input=$('msgInput');
    const prefix=(input.value&&!input.value.endsWith(' ')?input.value+' ':'');
    input.value=prefix+sel.map(n=>'@'+n).join(' ')+' ';
    input.focus();
  });
}
/* v2.24.19：解析我发的群消息里 @ 了谁 —— 返回 {all:true} 或 {ids:[联系人id]} 或 null */
function parseAtMentions(text,g){
  if(!text||!g)return null;
  const t=' '+String(text)+' ';
  if(t.indexOf('@全体成员')>=0||t.indexOf('@所有人')>=0||t.indexOf('@全体')>=0)return {all:true};
  const ids=(g.members||[]).filter(id=>t.indexOf('@'+contactName(id))>=0);
  return ids.length?{ids}:null;
}
/* ---------- 表情 / 表情包面板（公用库 + 联系人专属库） ---------- */
let stkManage=false, stkTab='emoji', stkScope='common';
function curStkLib(){
  if(stkScope==='mine') return state.myStickers;   /* 我的表情包：只有我能发送 */
  if(stkScope==='private'&&!isGroup(currentChatId)){
    const c=state.contacts.find(x=>x.id===currentChatId);
    if(c)return c.stickers;
  }
  return state.stickers;
}
function toggleStickerPanel(){
  const existing=document.querySelector('.emoji-panel,.stk-panel');
  if(existing){ existing.remove(); return; }
  const p=document.createElement('div');
  p.className='stk-panel';
  function draw(){
    const isG=isGroup(currentChatId);
    if(stkScope==='private'&&isG)stkScope='common';
    const emos=EMOJI_PANEL.map(e=>`<div class="stk" data-em="${e}">${e}</div>`).join('');
    const lib=curStkLib();
    const stks=lib.map(s=>`
      <div class="stk" data-stk="${s.id}" title="表情包">
        ${s.type==='emoji'?escapeHtml(s.data):`<img src="${s.data}" alt="">`}
        ${stkManage&&stkTab!=='emoji'?`<span class="delx" data-delstk="${s.id}">✕</span>`:''}
      </div>`).join('');
    const add=`<div class="stk add" id="stkAdd">＋</div>`;
    p.innerHTML=`
      <div class="stk-head">
        <div>
          <button class="${stkTab==='emoji'?'on':''}" data-stab="emoji">表情</button>
          <span style="color:var(--ink-3)">／</span>
          <button class="${stkTab!=='emoji'&&stkScope==='common'?'on':''}" data-scope="common">公用表情包</button>
          ${isG?'':`<span style="color:var(--ink-3)">／</span>
          <button class="${stkTab!=='emoji'&&stkScope==='private'?'on':''}" data-scope="private">专用表情包</button>`}
          <span style="color:var(--ink-3)">／</span>
          <button class="${stkTab!=='emoji'&&stkScope==='mine'?'on':''}" data-scope="mine">我的表情包</button>
        </div>
        <div>
          ${stkTab!=='emoji'?`<button class="${stkManage?'on':''}" id="stkManageBtn">${stkManage?'完成':'管理'}</button>`:''}
        </div>
      </div>
      <div class="stk-grid">${stkTab==='emoji'?emos:stks+(stkManage?'':add)}</div>
      ${stkTab!=='emoji'&&stkScope==='private'?'<div class="desc" style="margin-top:8px">专用表情包仅在与「'+escapeHtml(contactName(currentChatId))+'」的聊天中使用</div>':''}
      ${stkTab!=='emoji'&&stkScope==='mine'?'<div class="desc" style="margin-top:8px">我的表情包只有你能发送，ta 不会使用</div>':''}
      <input type="file" id="stkFile" accept="image/*" multiple style="display:none">`;
    p.querySelectorAll('[data-stab]').forEach(el=>el.addEventListener('click',()=>{ stkTab=el.dataset.stab; draw(); }));
    p.querySelectorAll('[data-scope]').forEach(el=>el.addEventListener('click',()=>{ stkTab='pack'; stkScope=el.dataset.scope; draw(); }));
    const mb=$('stkManageBtn');
    if(mb)mb.addEventListener('click',()=>{ stkManage=!stkManage; draw(); });
    p.querySelectorAll('[data-em]').forEach(el=>el.addEventListener('click',()=>{
      $('msgInput').value+=el.dataset.em; $('msgInput').focus();
    }));
    p.querySelectorAll('[data-stk]').forEach(el=>el.addEventListener('click',e=>{
      if(e.target.dataset.delstk)return;
      sendSticker(el.dataset.stk,stkScope);
    }));
    p.querySelectorAll('[data-delstk]').forEach(el=>el.addEventListener('click',()=>{
      const lib=curStkLib();
      const idx=lib.findIndex(s=>s.id===el.dataset.delstk);
      if(idx>=0){ lib.splice(idx,1); save(); draw(); toast('已删除表情包'); }
    }));
    const addBtn=$('stkAdd');
    if(addBtn)addBtn.addEventListener('click',()=>{
      /* 添加方式二选一：上传图片 / 直接输入 emoji（v2.23.0：图片可选自动压缩） */
      const sheet=document.createElement('div');
      sheet.className='action-sheet';
      sheet.innerHTML=`
        <div class="sheet-mask"></div>
        <div class="sheet-panel">
          <div style="font-weight:800;font-size:15px;margin-bottom:4px">${I('plus',16)} 添加表情包</div>
          <div class="desc" style="margin-bottom:10px">将添加到「${stkScope==='private'?'专用':stkScope==='mine'?'我的':'公用'}表情包」${stkScope==='private'?'（仅与 '+escapeHtml(contactName(currentChatId))+' 的聊天）':stkScope==='mine'?'（只有你能发送）':''}</div>
          <div style="display:flex;gap:10px;margin-bottom:10px">
            <button class="btn block" id="stkAddImg">${I('image',15)} 上传图片</button>
            <button class="btn ghost block" id="stkAddEmoji">${I('smile',15)} 输入 emoji</button>
          </div>
          <div class="rowline" style="padding:10px 0 2px;border-bottom:none">
            <div><div class="name" style="font-size:13px">自动压缩大图</div>
            <div class="meta">超过 300KB 自动压到 480px（推荐，省空间）</div></div>
            <button class="switch ${stkCompress?'on':''}" id="stkCompressSw"></button>
          </div>
        </div>`;
      document.getElementById('phone').appendChild(sheet);
      sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
      sheet.querySelector('#stkCompressSw').addEventListener('click',e=>{
        stkCompress=!stkCompress; e.currentTarget.classList.toggle('on',stkCompress);
      });
      sheet.querySelector('#stkAddImg').addEventListener('click',()=>{ sheet.remove(); $('stkFile').click(); });
      sheet.querySelector('#stkAddEmoji').addEventListener('click',()=>{
        sheet.remove();
        const mk=openModal('添加 emoji 表情包',`<div class="field" style="margin-bottom:0"><input id="stkEmojiIn" maxlength="8" placeholder="输入一个 emoji，如 🐻"></div>`,()=>{
          const v=mk.querySelector('#stkEmojiIn').value.trim();
          if(!v){ toast('先输入一个 emoji'); return false; }
          curStkLib().push({id:'s'+Date.now()+Math.random().toString(36).slice(2,6),type:'emoji',data:v});
          save(); draw(); toast('已添加到表情包');
        });
        setTimeout(()=>{ const i=mk.querySelector('#stkEmojiIn'); if(i)i.focus(); },60);
      });
    });
    const fi=$('stkFile');
    if(fi)fi.addEventListener('change',e=>{
      const files=[...e.target.files]; if(!files.length)return;
      const lib=curStkLib();
      let done=0;
      files.forEach(f=>{
        const r=new FileReader();
        r.onload=()=>smartStickerData(r.result,url=>{
          lib.push({id:'s'+Date.now()+Math.random().toString(36).slice(2,6),type:'img',data:url});
          if(++done===files.length){ save(); draw(); toast('已添加 '+files.length+' 个表情包'); }
        });
        r.readAsDataURL(f);
      });
      e.target.value='';
    });
  }
  draw();
  document.querySelector('.inputbar').after(p);
}
function sendSticker(id,scope){
  /* 发送时记录来源库，渲染时统一查找（公用 + 全部联系人专属） */
  pushChatMsg(currentChatId,'me',id,'sticker');
  scheduleReply(currentChatId);
}
/* 引用回复：长按消息后设置，随下一条消息一起发出 */
let replyQuote=null;
function setReplyQuote(q){
  replyQuote=q;
  const bar=$('quoteBar');
  if(!bar)return;
  if(!q){ bar.classList.add('hide'); bar.innerHTML=''; return; }
  bar.innerHTML=`<div class="qb-inner"><span class="qb-txt">↩︎ 引用 <b>${escapeHtml(q.who)}</b>：${escapeHtml(q.text)}</span><span class="qb-x" id="quoteClear">✕</span></div>`;
  bar.classList.remove('hide');
  $('quoteClear').addEventListener('click',()=>setReplyQuote(null));
}
function sendCurrent(){
  const input=$('msgInput');
  const text=input.value.trim();
  if(!text)return;
  input.value='';
  const sb=$('sendBtn'); if(sb)sb.classList.add('idle');   /* v2.24.0：发完回到幽灵态 */
  const q=replyQuote; setReplyQuote(null);
  const m=pushChatMsg(currentChatId,'me',text,null,null,{quote:q?q.text:null});
  playDing('send');
  /* 已读不回模式：15-60 秒后标记已读，按「已读不回概率」决定是否回复 */
  if(m && state.settings.readNoReply){
    const chatId=currentChatId;
    setTimeout(()=>{
      m.read=true; save();
      if(currentChatId===chatId)renderChatMsgs();
    },randInt(15,60)*1000);
    if(Math.random()*100 < (state.settings.readNoProb??60))return;
  }
  /* v2.24.19：群聊 @ 了成员/全体 → 先解析出来，scheduleReply 里给被 @ 者升级成 80% 回复概率 */
  scheduleReply(currentChatId, isGroup(currentChatId)
    ? parseAtMentions(text,state.groups.find(x=>x.id===currentChatId)) : null);
}
function pushChatMsg(chatId,role,text,type,by,extra){
  state.chats[chatId]=state.chats[chatId]||[];
  const m={role,text,t:Date.now(),type,by};
  if(extra)Object.assign(m,extra);
  state.chats[chatId].push(m);
  if(state.chats[chatId].length>400)state.chats[chatId]=state.chats[chatId].slice(-400);
  save();
  if(currentChatId===chatId && $('msgList')){ renderChatMsgs(); if(role==='ta')playDing(); }
  else if(role==='ta'){
    markUnread(chatId);
    /* 不在该会话页时，桌面弹提示 + 系统推送通知（退出聊天后 ta 依然会回复） */
    const preview = type==='sticker'?'[表情包]':type==='rp'?'[红包]':String(text).slice(0,40);
    let nm;
    if(isGroup(chatId)){
      const gname=(state.groups.find(g=>g.id===chatId)||{}).name||'群聊';
      nm = by ? contactName(by)+' @ '+gname : gname;
    }else nm=contactName(chatId);
    playDing();
    setTimeout(()=>toast(nm+'：'+preview),200);
    notifyMsg(chatId,nm,preview);
  }
  renderDesktop();
  return m;
}

/* ---------- 回复引擎 ---------- */
const pending={};
function clearPending(chatId){
  const p=pending[chatId]; if(!p)return;
  clearTimeout(p.main); (p.timers||[]).forEach(clearTimeout);
  delete pending[chatId];
}
/* 取某联系人「是否回复」的概率：优先用联系人专属 replyProb，否则用全局 100（即必回） */
function replyProbOf(contactId){
  const c=state.contacts.find(x=>x.id===contactId);
  if(c && c.replyProb!==undefined && c.replyProb!==null && c.replyProb!=='') return Math.min(100,Math.max(0,Number(c.replyProb)||0));
  return 100;
}
/* 判定：这一次消息 ta 到底回不回 */
function shouldReply(contactId){
  const p=replyProbOf(contactId);
  if(p>=100)return true;
  if(p<=0)return false;
  return Math.random()*100 < p;
}
/* 群聊里某位成员「回不回」的概率（v2.22.0）：
   优先该联系人的专属 replyProb；没设过就用全局「群聊回复概率」（默认 70%） */
function groupReplyProbOf(contactId){
  const c=state.contacts.find(x=>x.id===contactId);
  if(c && c.replyProb!==undefined && c.replyProb!==null && c.replyProb!=='') return Math.min(100,Math.max(0,Number(c.replyProb)||0));
  const g=state.settings?state.settings.groupReplyProb:undefined;
  const v=(g===undefined||g===null||g==='')?70:g;
  return Math.min(100,Math.max(0,Number(v)||0));
}
function scheduleReply(chatId,atInfo){
  clearPending(chatId);
  if(!state.settings.autoReply)return;
  const s=state.settings;
  const delay=randInt(Math.min(s.replyMin,s.replyMax),Math.max(s.replyMin,s.replyMax));
  pending[chatId]={main:null,timers:[]};
  /* v2.18.0：微信式「正在输入中」提示（不再显示倒计时秒数） */
  if(currentChatId===chatId)$('appSub')&&($('appSub').textContent=isGroup(chatId)?'群成员正在输入中…':'对方正在输入中…');
  pending[chatId].main=setTimeout(()=>{
    let responders=[];
    const atSet=(atInfo&&atInfo.all)?null:(atInfo&&atInfo.ids?new Set(atInfo.ids):null);
    const atHit=id=>!!(atInfo&&(atInfo.all||atSet.has(id)));   /* v2.24.19：被 @ 到的成员 */
    if(isGroup(chatId)){
      const g=state.groups.find(x=>x.id===chatId);
      const members=(g?g.members:[]).slice();
      /* v2.22.0：群里每位成员各自独立掷一次概率（默认 70%，可在「设置 → 概率」调整），
         命中就回、没命中就不回——不再固定只挑 1~2 人回。
         v2.24.19：被 @ 的成员概率固定升为 80%。 */
      responders=members.filter(id=>{
        const p=atHit(id)?80:groupReplyProbOf(id);
        if(p>=100)return true;
        if(p<=0)return false;
        return Math.random()*100 < p;
      });
      if(!responders.length){
        if(currentChatId===chatId&&$('appSub'))$('appSub').textContent=chatSubOf(chatId);
        return;
      }
    }else{
      /* 单聊：联系人专属回复概率决定 ta 是否回你 */
      if(shouldReply(chatId)){
        responders=[chatId];
      }else{
        if(currentChatId===chatId&&$('appSub'))$('appSub').textContent=chatSubOf(chatId);
        return;
      }
    }
    /* v2.23.0：群聊命中者各回 1~3 条（仍受「单次回复字卡上限」约束），既热闹又不至于刷屏
       v2.24.19：被 @ 命中的成员只回 1~2 条（用户口径） */
    responders.forEach(cid=>sendCardBatch(chatId,cid,isGroup(chatId)?(atHit(cid)?randInt(1,2):randInt(1,3)):null));
  },delay*1000);
}
function sendCardBatch(chatId,contactId,maxN){
  const s=state.settings;
  /* v2.20.0：允许回复引擎之外直接调用（拍一拍回复 / 联系人主动消息）——队列不存在就自建 */
  if(!pending[chatId])pending[chatId]={main:null,timers:[]};
  const cap=Math.max(1,Math.min(4,s.cardMax||3));
  /* v2.22.0：maxN 可指定本次条数上限（群聊多人回复时压成 1 张） */
  const n=maxN?Math.min(cap,Math.max(1,maxN)):randInt(1,cap);
  /* 引用回复：20% 概率引用你最近一条消息 */
  const myMsgs=(state.chats[chatId]||[]).filter(m=>m.role==='me'&&m.type!=='rp');
  const quoteMsg = (Math.random()<0.2&&myMsgs.length)?myMsgs[myMsgs.length-1]:null;
  const quoteText = quoteMsg ? (quoteMsg.type==='sticker'?'[表情包]':String(quoteMsg.text).slice(0,30)) : null;
  let acc=0;
  for(let i=0;i<n;i++){
    acc+=(i===0)?0:randInt(Math.min(s.gapMin,s.gapMax),Math.max(s.gapMin,s.gapMax))*1000;
    pending[chatId]&&pending[chatId].timers.push(setTimeout(()=>{
      if(currentChatId===chatId)showTyping(chatId,contactId);
      pending[chatId]&&pending[chatId].timers.push(setTimeout(()=>{
        hideTyping();
        /* 按概率发表情包：优先联系人专属表情包库，其次公用库 */
        const cObj=state.contacts.find(c=>c.id===contactId);
        const stkPool=(cObj&&cObj.stickers&&cObj.stickers.length&&Math.random()<0.5)
          ? cObj.stickers : state.stickers;
        if(Math.random()*100 < (s.stickerProb||0) && stkPool.length){
          const st=pick(stkPool);
          pushChatMsg(chatId,'ta',st.id,'sticker',contactId);
        }else{
          const card=drawCard(null,contactId);
          if(card){
            /* 群聊 10% 概率 @一位成员（含我） */
            let at=null;
            if(isGroup(chatId)&&Math.random()<0.1){
              const g=state.groups.find(x=>x.id===chatId);
              if(g){
                const names=[state.settings.myName,...g.members.map(id=>contactName(id))];
                at=pick(names);
              }
            }
            pushChatMsg(chatId,'ta',card,null,contactId,{quote:i===0?quoteText:null,at});
          }
        }
        /* v2.18.0：回完恢复为状态文案（群聊为空） */
        if(currentChatId===chatId&&$('appSub'))$('appSub').textContent=chatSubOf(chatId);
      },randInt(900,1800)));
    },acc));
  }
}
function showTyping(chatId,contactId){
  if(currentChatId!==chatId)return;
  hideTyping();
  const list=$('msgList'); if(!list)return;
  const nm = isGroup(chatId)?contactName(contactId||''):(state.contacts.find(c=>c.id===chatId)||{}).name||'梦';
  const div=document.createElement('div');
  div.className='row'; div.id='typingRow';
  div.innerHTML=`${avatarHtml(nm,'sm',contactId)}<div class="bubble" style="padding:0"><div class="typing"><i></i><i></i><i></i></div></div>`;
  list.appendChild(div); list.scrollTop=list.scrollHeight;
}
function hideTyping(){ const el=$('typingRow'); if(el)el.remove(); }

/* ---------- 聊天互动 ---------- */
/* 拍一拍：从「拍一拍库」（独立组件）选词卡；支持双向（我拍ta / ta拍我）
   词卡有 3 种写法，展示时自动套成「A拍B…」，双方名字与人称自动适配：

   ① 纯动作片段      「的脑门」「一下」          → 「彤拍了梦角的脑门」
   ② 完整动作句      「拍了拍你的肩膀」          → 「彤拍了拍你的肩膀」（含「你/我」会自动换向）
   ③ 带占位符的双向句 「戳了戳{ta}的脸颊」        → 「彤戳了戳梦角的脸颊」
                      「拉了拉{ta}的衣角」        → 「梦角拉了拉彤的衣角」

   占位符：{ta} = 对方显示名、{me} = 自己显示名。
   若没写占位符但句中出现「你/我」，也会按说话方向自动互换
   （ta 说 → 把「你」换成我的名字；我说 → 把「你」换成 ta 的名字）。 */
/* ================= 拍一拍 =================
   占位符：{ta} = 对方显示名、{me} = 我的显示名（与方向无关，两方向都通）。
   无占位符的句子按说话方向自动换向人称：
   「你」→ 对方名字；「我」（说话方自称）→ 说话方名字
   （v2.19.0 修复：ta 拍我时句中的「我」此前被错换成我的名字）。
   纯动作片段（如「的脑门」）自动补「拍了拍」；
   完整动作句（动词开头或含「了」等，如「发送了一个爱心」「敲了敲木鱼，功德加一」）直接原样套用，不再补「拍了拍」。 */
function patText(who,action,other){
  const a=String(action||'').trim();
  const me=state.settings.myName||'我';
  /* other = 另一方显示名；调用方没给就退化成「你」 */
  const oth=other||'你';
  /* ① 占位符替换（最明确，优先） */
  if(/\{(ta|me)\}/.test(a)){
    const filled=a.replace(/\{ta\}/g,oth).replace(/\{me\}/g,me);
    return who+filled.replace(/\s+/g,' ').trim();
  }
  /* ② 完整动作句：按「说话方是谁」换向人称后原样使用 */
  if(patIsFullAction(a)){
    let b=a.replace(/你/g,oth).replace(/我/g,who);
    /* 句首「我」= 说话方自称（如「我想你了」），换向后与前缀重名 → 去掉句首避免「彤彤想…」 */
    if(b.startsWith(who)) b=b.slice(who.length);
    return who+b;
  }
  /* ③ 纯动作片段：补「拍了拍」（片段里的代词同样换向） */
  return who+'拍了拍'+a.replace(/你/g,oth).replace(/我/g,who);
}
/* 拍一拍词卡是否为「完整动作句」（动词开头 / 动词重叠 / 含「了」等完成态）：
   完整句原样套用（支持「发送了一个爱心」「敲了敲木鱼，功德加一」这类单方动作）；
   否则视为纯动作片段，发送时补「拍了拍」。 */
function patIsFullAction(t){
  const a=String(t||'').trim();
  if(!a)return false;
  if(/\{(ta|me)\}/.test(a))return false;
  if(/^拍/.test(a))return true;
  /* 常见动词开头 → 完整句（覆盖互动动作 + 单方动作：发送/敲/吃/看…） */
  if(/^(戳|拉|摸|揉|捏|弹|敲|拍|推|拽|勾|点|晃|抱|亲|发|送|递|给|扔|投|抛|丢|画|写|唱|说|喊|叫|吃|喝|咬|吹|吸|眨|瞪|望|看|听|踩|踢|跑|走|跳|转|举|扛|背|搂|挽|牵|按|压|拧|掰|撕|扯|折|叠|卷|铺|盖|埋|挖|铲|扫|擦|洗|冲|浇|泼|洒|喷|吐|打|捶|挠|抓|搔|搓|掐|揪|拔|抽|撸|捆|绑|系|扎|穿|脱|戴|摘|梳|剪|裁|割|切|剁|砍|劈|砸|锤|撞|磕|顶|挑|抬|搬|挪|移|端|捧|托|睁|闭|张|伸|缩|弯|仰|低|垂|歪|靠|倚|躺|趴|站|坐|蹲|跪|迈|跨|蹬|攀|爬|追|赶|躲|藏|寻|找|捡|拾|拎|提|握|攥|撑|扶|守|盯|瞧|敷|泡|冲|晒|晾|发呆|功德|在)/.test(a))return true;
  /* 含完成态 / 动量结构（「了」「一个」「一下」「一番」）→ 完整句 */
  return /了|一个|一下|一番/.test(a);
}
function openPatPicker(){
  const id=currentChatId; if(!id)return;
  const isG=isGroup(id);
  const taName=isG?state.groups.find(g=>g.id===id).name:contactName(id);
  let dir='me';   /* me = 我拍ta；ta = ta拍我 */
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  function draw(){
    const cards=(state.patLib&&state.patLib[dir])||[];
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel">
        <div style="font-weight:800;font-size:15px;margin-bottom:4px;display:flex;align-items:center;gap:7px">${I('pat',16)} 拍一拍</div>
        <div class="seg" style="margin:8px 0 10px">
          <button class="${dir==='me'?'on':''}" data-pdir="me">我拍${isG?'群友':taName}</button>
          <button class="${dir==='ta'?'on':''}" data-pdir="ta">${isG?'群友':taName}拍我</button>
        </div>
        <div class="desc" style="margin-bottom:12px">词卡在「字卡库 → 拍一拍库」里增删；文案会自动套成「${dir==='me'?(state.settings.myName||'我'):(isG?'群友':taName)}拍了…」</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;max-height:44vh;overflow-y:auto">
          ${cards.map(c=>`<span class="chip pat-chip" data-pat="${escapeHtml(c)}" style="background:#f4f4f6;border-radius:14px;padding:8px 13px;font-size:13px;cursor:pointer">${escapeHtml(patText(dir==='me'?(state.settings.myName||'我'):(isG?'群友':taName),c,dir==='me'?(isG?'群友':taName):(state.settings.myName||'我')))}</span>`).join('')||'<div class="empty">拍一拍库还是空的，去「字卡库 → 拍一拍库」添加</div>'}
        </div>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelectorAll('[data-pdir]').forEach(el=>el.addEventListener('click',()=>{ dir=el.dataset.pdir; draw(); }));
    sheet.querySelectorAll('.pat-chip').forEach(el=>el.addEventListener('click',()=>{
      sheet.remove(); doPat(el.dataset.pat,dir);
    }));
  }
  document.getElementById('phone').appendChild(sheet);
  draw();
}
/* card: 指定词卡（空=随机）；dir: 'me' 我拍ta / 'ta' ta拍我 */
function doPat(card,dir){
  const id=currentChatId;
  if(!id)return;
  dir=dir||'me';
  const isG=isGroup(id);
  const group=isG?state.groups.find(g=>g.id===id):null;
  const taName=isG?group.name:contactName(id);
  const myName=state.settings.myName||'我';
  const libMe=(state.patLib&&state.patLib.me)||[];
  const libTa=(state.patLib&&state.patLib.ta)||[];
  const line = card || (dir==='ta'?(libTa.length?pick(libTa):'拍了拍你'):(libMe.length?pick(libMe):'拍了拍你'));

  if(dir==='ta'){
    /* ta 拍我：ta 是说话方，我是对方 → other=我的名字 */
    const who = isG?pick(group.members):id;
    const fromName = isG?contactName(who):taName;
    pushChatMsg(id,'sys',patText(fromName,line,myName));
    /* 我是否回拍：用同一个拍一拍概率 */
    const s=state.settings;
    if(Math.random()*100 < (s.patProb??20)){
      setTimeout(()=>{
        const back = libMe.length?pick(libMe):'拍了拍你';
        /* 我回拍：我是说话方，对方是 ta */
        pushChatMsg(id,'sys',patText(myName,back,fromName));
      },randInt(2000,5000));
    }
    return;
  }

  /* 我拍 ta */
  pushChatMsg(id,'sys',patText(myName,line,taName));
  const s=state.settings;
  if(Math.random()*100 < (s.patProb??20)){
    setTimeout(()=>{
      const who = isG?pick(group.members):id;
      const fromName = isG?contactName(who):taName;
      /* 对方也用词卡拍回来，或用字卡回应 */
      if(libTa.length&&Math.random()<0.6){
        pushChatMsg(id,'sys',patText(fromName,pick(libTa),myName));
      }else{
        const c=drawCard('撒娇 · 粘人',who)||drawCard(null,who);
        if(c)pushChatMsg(id,'ta',c,null,who);
      }
    },randInt(2000,5000));
  }
  /* v2.20.0：拍一拍视同发消息 —— ta 随后会回复消息，而不是拍完没反应。
     自动回复开关关闭时同样静默；该会话已有回复队列在跑就不重复触发；群聊随机一位成员回。 */
  if(s.autoReply!==false && !pending[id]){
    setTimeout(()=>{
      if(pending[id])return;
      if(isG){ if(group.members&&group.members.length)sendCardBatch(id,pick(group.members)); }
      else sendCardBatch(id,id);
    },randInt(1500,3500));
  }
}
/* ================= 通话（统一会话：可最小化） ================= */
let callSess=null;
const callFmt=()=>{ const s=callSess?callSess.secs:0; return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
function callRenderFull(){
  if(!callSess||callSess.minimized)return;
  const ov=$('callOverlay');
  ov.classList.remove('hide');
  const s=callSess;
  let stateTxt = s.mode==='outgoing' ? (s.isGroup?'正在邀请成员加入群通话…':'正在等待对方接听…')
    : s.mode==='incoming' ? '邀请你语音通话…'
    : (s.isGroup?`群通话中 ${callFmt()}`:`通话中 ${callFmt()}`);
  /* 群通话：成员头像墙（含「我」）；单聊：大头像 */
  const avaBlock = s.isGroup
    ? `<div class="call-members" id="callMembers">
        <div class="call-mem call-mem-me">${avatarHtml(state.settings.myName||'我','md','me')}<span>${escapeHtml(state.settings.myName||'我')}（我）</span></div>
        ${(s.joined||[]).map(cid=>`
        <div class="call-mem">${avatarHtml(contactName(cid),'md',cid)}<span>${escapeHtml(contactName(cid))}</span></div>`).join('')}
      </div>`
    : `<div class="call-bg-avatar">${isGroup(s.chatId)?groupAvatarHtml(state.groups.find(x=>x.id===s.chatId),'lg'):avatarHtml(s.name,'lg',s.chatId)}</div>`;
  ov.innerHTML=`
    ${avaBlock}
    <div class="call-name">${escapeHtml(s.name)}${s.isGroup?` <span style="font-size:12px;font-weight:500;color:rgba(255,255,255,.5)">(${(s.joined||[]).length+1}/${(s.members||[]).length+1})</span>`:''}</div>
    <div class="call-state" id="callState">${stateTxt}</div>
    <div class="call-lines" id="callLines"></div>
    ${s.mode==='incoming'
      ?`<div class="call-btns">
          <div class="call-col"><button class="ring no" id="callNo" title="挂断"><svg viewBox="0 0 24 24"><path d="M5.5 4h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5L16 14l4 1.5v3a1.8 1.8 0 0 1-2 1.8C10.6 19.6 4.4 13.4 3.7 6a1.8 1.8 0 0 1 1.8-2z" transform="rotate(135 12 12)"/></svg></button><small>挂断</small></div>
          <div class="call-col"><button class="ring ok" id="callYes"><svg viewBox="0 0 24 24"><path d="M5.5 4h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5L16 14l4 1.5v3a1.8 1.8 0 0 1-2 1.8C10.6 19.6 4.4 13.4 3.7 6a1.8 1.8 0 0 1 1.8-2z"/></svg></button><small>接听</small></div>
        </div>`
      :`<div class="call-controls">
          <div class="call-ctl-col"><button class="call-ctl" id="callMute" title="静音"><svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M16 9l5 6M21 9l-5 6"/></svg></button><small>静音</small></div>
          <div class="call-ctl-col"><button class="call-ctl" id="callMiniBtn" title="最小化"><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5.5 5.5 12 12 18.5" transform="rotate(-45 12 12)"/></svg></button><small>最小化</small></div>
          <div class="call-ctl-col"><button class="hangup" id="hangBtn" title="挂断"><svg viewBox="0 0 24 24"><path d="M5.5 4h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5L16 14l4 1.5v3a1.8 1.8 0 0 1-2 1.8C10.6 19.6 4.4 13.4 3.7 6a1.8 1.8 0 0 1 1.8-2z" transform="rotate(135 12 12)"/></svg></button><small>挂断</small></div>
        </div>`}`;
  const yes=$('callYes'), no=$('callNo');
  if(yes){
    const t=s.ringTimer;
    yes.addEventListener('click',()=>{ clearTimeout(t); s.mode='active'; s.answered=true; callRenderFull(); startCallClock(); if(!s.isGroup)scheduleCallHangCheck(); });
    no.addEventListener('click',()=>{ clearTimeout(t); endCall(false,'refuse'); });
  }else{
    $('hangBtn').addEventListener('click',()=>endCall(true));
    const mb=$('callMiniBtn');
    if(mb)mb.addEventListener('click',callMinimize);
    const mu=$('callMute');
    if(mu)mu.addEventListener('click',()=>{ mu.classList.toggle('off'); });
  }
}
function startCallClock(){
  if(callSess.clockTimer)return;
  callSess.clockTimer=setInterval(()=>{
    if(!callSess)return;
    callSess.secs++;
    const st=$('callState'); if(st&&!callSess.minimized)st.textContent=`${callSess.isGroup?'群通话中':'通话中'} ${callFmt()}`;
    const mini=$('callMiniT'); if(mini)mini.textContent=callFmt();
  },1000);
  callSess.lineTimer=setTimeout(callSayLine,1500);
}
function callSayLine(){
  if(!callSess)return;
  const lines=$('callLines');
  if(lines){
    const s=callSess;
    if(s.isGroup&&s.joined.length){
      /* 群通话：随机一位已加入的成员发言 */
      const cid=pick(s.joined);
      const c=drawCard(['关心 · 叮嘱','撒娇 · 粘人','亲昵 · 情话','日常'].filter(n=>state.cats.some(x=>x.name===n&&x.enabled)),cid)||drawCard(null,cid);
      if(c)addCallLine(`「${contactName(cid)}」 ${c}`);
    }else{
      const c=drawCard(['关心 · 叮嘱','撒娇 · 粘人','亲昵 · 情话','日常'].filter(n=>state.cats.some(x=>x.name===n&&x.enabled)),s.chatId)||drawCard(null,s.chatId);
      if(c){ const d=document.createElement('div'); d.textContent=c; lines.appendChild(d); if(lines.children.length>3)lines.removeChild(lines.firstChild); }
    }
  }
  callSess.lineTimer=setTimeout(callSayLine,randInt(4000,9000));
}
/* 最小化悬浮气泡：可任意拖动，位置记忆 */
let miniDragged=false;
function callMinimize(){
  if(!callSess)return;
  callSess.minimized=true;
  $('callOverlay').classList.add('hide');
  let mini=$('callMini');
  if(!mini){
    mini=document.createElement('div');
    mini.id='callMini';
    bindMiniDrag(mini);
    mini.addEventListener('click',()=>{ if(miniDragged){ miniDragged=false; return; } callRestore(); });
    document.getElementById('phone').appendChild(mini);
  }
  mini.innerHTML=`${callSess.isGroup?'<div class="avatar mini-ava" style="background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center">'+I('users',15)+'</div>':avatarHtml(callSess.name,'',callSess.chatId).replace('class="avatar "','class="avatar mini-ava"')}<b id="callMiniT">${callFmt()}</b>`;
  mini.style.display='flex';
  /* 恢复上次拖动的位置（无记录时默认右下角） */
  let pos=null;
  try{ pos=JSON.parse(localStorage.getItem('th_miniPos')||'null'); }catch(e){}
  if(pos&&typeof pos.x==='number'){
    mini.style.right='auto'; mini.style.bottom='auto';
    mini.style.left=pos.x+'px'; mini.style.top=pos.y+'px';
  }else{
    mini.style.left='auto'; mini.style.top='auto';
    mini.style.right='14px'; mini.style.bottom='110px';
  }
}
function bindMiniDrag(mini){
  let drag=null;
  mini.addEventListener('pointerdown',e=>{
    if(e.button!==undefined&&e.button!==0)return;
    drag={sx:e.clientX,sy:e.clientY,ox:mini.offsetLeft,oy:mini.offsetTop};
    try{ mini.setPointerCapture(e.pointerId); }catch(err){}
    const r=mini.getBoundingClientRect();
    mini.style.right='auto'; mini.style.bottom='auto';
    mini.style.left=r.left+'px'; mini.style.top=r.top+'px';
    e.preventDefault();
  });
  mini.addEventListener('pointermove',e=>{
    if(!drag)return;
    const dx=e.clientX-drag.sx, dy=e.clientY-drag.sy;
    if(!miniDragged&&Math.abs(dx)<4&&Math.abs(dy)<4)return;
    miniDragged=true;
    const phone=document.getElementById('phone').getBoundingClientRect();
    const nx=Math.min(Math.max(0,drag.ox+dx),phone.width-58);
    const ny=Math.min(Math.max(0,drag.oy+dy),phone.height-58);
    mini.style.left=nx+'px'; mini.style.top=ny+'px';
  });
  const drop=()=>{
    if(drag&&miniDragged){
      try{ localStorage.setItem('th_miniPos',JSON.stringify({x:mini.offsetLeft,y:mini.offsetTop})); }catch(e){}
    }
    drag=null;
  };
  mini.addEventListener('pointerup',drop);
  mini.addEventListener('pointercancel',drop);
}
function callRestore(){
  if(!callSess)return;
  callSess.minimized=false;
  miniDragged=false;
  const mini=$('callMini'); if(mini)mini.style.display='none';
  callRenderFull();
}
/* v2.22.0：通话中联系人可能主动挂断——接通后按设置概率（默认 20%）掷一次，
   命中则在 20~60 秒之间随机一个时间点挂断（0 可关闭）
   v2.24.15 ⚠️ BUG 修复：这个定时器必须挂到「本次通话对象」上并在重入时先清掉。
   旧版的 timer id 只存在 `callSess.hangTimer`，而 `callSess` 是个全局变量：
   联系人主动来电（incomingCall）会直接把它换成新会话，**新会话的 hangTimer 是 null**，
   上一个会话那个「20~60 秒挂断」的定时器就此没人再能 clearTimeout —— 它到点后
   `if(!callSess||!callSess.answered)return;` 看到的却是**新会话**（已接听），
   于是把用户刚接起来的电话挂掉。观感就是「接起来没一会儿（23 秒左右）就自动断了」。 */
function scheduleCallHangCheck(){
  const s=callSess; if(!s)return;
  clearTimeout(s.hangTimer); s.hangTimer=null;
  const p=Math.min(100,Math.max(0,Number(state.settings.callHangProb===undefined?20:state.settings.callHangProb)||0));
  if(Math.random()*100>=p)return;
  s.hangTimer=setTimeout(()=>{
    /* 定时器只认自己那次通话：会话已经被换掉 / 不是接听态 → 什么都不做 */
    if(!s||callSess!==s||!s.answered)return;
    s.hangTimer=null;
    const nm=s.name;
    endCall(false,'remote');
    toast('「'+nm+'」挂断了通话');
  },randInt(20000,60000));
}
function endCall(byUser,reason){
  if(!callSess)return;
  const s=callSess;
  /* v2.24.15：把当前会话立刻摘下来 —— 任何「旧会话的延迟回调」随后检查
     `callSess!==s` 就会自行让路，不会再误挂新通话。 */
  callSess=null;
  clearTimeout(s.ringTimer); clearTimeout(s.lineTimer); clearTimeout(s.hangTimer); clearInterval(s.clockTimer);
  (s.joinTimers||[]).forEach(clearTimeout); clearTimeout(s.noJoinTimer);
  $('callOverlay').classList.add('hide');
  const mini=$('callMini'); if(mini)mini.remove();
  if(reason==='refuse'){
    pushChatMsg(s.chatId,'sys',`你拒接了「${s.name}」的来电`);
    setTimeout(()=>{ const c=drawCard('撒娇 · 粘人',s.chatId)||drawCard(null,s.chatId); if(c)pushChatMsg(s.chatId,'ta',c,null,s.chatId); },2500);
  }else if(reason==='remote'&&s.answered){
    /* 联系人主动挂断 */
    pushChatMsg(s.chatId,'sys',`「${s.name}」挂断了通话，时长 ${Math.max(1,Math.round(s.secs))} 秒`);
    if(Math.random()<0.5)setTimeout(()=>{ const c=drawCard('撒娇 · 粘人',s.chatId)||drawCard(null,s.chatId); if(c)pushChatMsg(s.chatId,'ta',c,null,s.chatId); },3000);
  }else if(s.answered){
    pushChatMsg(s.chatId,'sys',s.isGroup?`群通话结束，时长 ${Math.max(1,Math.round(s.secs))} 秒，${(s.joined||[]).length+1} 位成员参与`:`通话结束，时长 ${Math.max(1,Math.round(s.secs))} 秒`);
    if(Math.random()<0.6){
      const who=s.isGroup&&s.joined.length?pick(s.joined):s.chatId;
      setTimeout(()=>{ const c=drawCard('撒娇 · 粘人',who); if(c)pushChatMsg(s.chatId,'ta',c,null,who); },3000);
    }
  }else if(s.mode==='outgoing'){
    pushChatMsg(s.chatId,'sys',s.isGroup?`你发起了群通话，但没有成员加入`:`你呼叫了「${s.name}」，对方未接听`);
    if(!s.isGroup)setTimeout(()=>{ const c=drawCard(null,s.chatId); if(c)pushChatMsg(s.chatId,'ta',c,null,s.chatId); },randInt(4000,8000));
  }
}
function startCall(name){
  const chatId=currentChatId; if(!chatId)return;
  endCall(true); /* 结束旧通话 */
  const isG=isGroup(chatId);
  const g=isG?state.groups.find(x=>x.id===chatId):null;
  const s={name,chatId,isGroup:isG,members:isG?(g?g.members:[]):[],joined:[],joinTimers:[],noJoinTimer:null,
    mode:'outgoing',secs:0,answered:false,minimized:false,clockTimer:null,lineTimer:null,ringTimer:null,hangTimer:null};
  callSess=s;
  callRenderFull();
  /* v2.24.15：铃声回调同样只认自己这一次通话（换会话后旧回调会自动让路） */
  s.ringTimer=setTimeout(()=>{
    if(!s||callSess!==s)return;
    /* 按设置概率决定是否接通 */
    if(Math.random()*100 >= (state.settings.callAnswer??85)){
      const st=$('callState'); if(st)st.textContent='无人接听…';
      setTimeout(()=>{ if(s&&callSess===s)endCall(false); },1800);
      return;
    }
    s.mode='active'; s.answered=true;
    callRenderFull(); startCallClock();
    if(!s.isGroup)scheduleCallHangCheck();
    if(s.isGroup){
      /* 通话接通后，「我」先进入通话 */
      addCallLine('「'+(state.settings.myName||'我')+'」加入了通话');
      scheduleGroupJoin();
    }
  },randInt(1500,3000));
}
/* 群通话：成员陆续加入（每人 85% 概率加入），全都没来则超时结束 */
function scheduleGroupJoin(){
  const s=callSess; if(!s)return;
  (s.members||[]).forEach(cid=>{
    if(Math.random()<0.85){
      s.joinTimers.push(setTimeout(()=>{
        if(!s||callSess!==s)return;
        if(!s.joined.includes(cid)){
          s.joined.push(cid);
          addCallLine('「'+contactName(cid)+'」加入了通话');
          callRenderFull();
        }
      },randInt(1200,8000)));
    }
  });
  s.noJoinTimer=setTimeout(()=>{
    if(!s||callSess!==s||s.joined.length)return;
    const st=$('callState'); if(st)st.textContent='没有成员加入…';
    setTimeout(()=>{ if(s&&callSess===s)endCall(false); },1500);
  },11000);
}
function addCallLine(text){
  const lines=$('callLines'); if(!lines)return;
  const d=document.createElement('div'); d.textContent=text;
  lines.appendChild(d); if(lines.children.length>3)lines.removeChild(lines.firstChild);
}
/* ---------- 联系人主动来电 ---------- */
function incomingCall(contactId){
  endCall(true);
  const s={name:contactName(contactId),chatId:contactId,isGroup:false,mode:'incoming',secs:0,answered:false,minimized:false,
    clockTimer:null,lineTimer:null,ringTimer:null,hangTimer:null};
  callSess=s;
  callRenderFull();
  /* v2.24.15：铃声超时改为「只结束自己这一次来电」。
     旧版直接调 endCall(false) —— 如果期间用户已接听、或又来了新通话，
     这个到点的回调会把**不属于它的通话**挂断。 */
  s.ringTimer=setTimeout(()=>{
    if(!s||callSess!==s||s.answered)return;
    endCall(false);
  },25000); /* 25 秒未接自动挂断 */
}
function showActionSheet(contactId){
  const g=isGroup(contactId)?state.groups.find(x=>x.id===contactId):null;   /* v2.18.0：群聊传入群 id */
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  const acts=[
    /* v2.24.5：发红包已移到聊天「+」面板，这里不再重复（高频动作不进二级菜单） */
    ['gift','送礼物',()=>{ openApp('market'); }],
    ['decide','帮我决定',()=>{ doDecision(contactId); }],
    ['eyes','查岗',()=>{ doCheckOn(contactId); }],
    ['letter','写信',()=>{ openApp('mail'); }],
    ['wish','许愿',()=>{ openWishModal(); }],
  ];
  if(g)acts.push(['users','群聊头像',()=>{ openGroupAvatarEditor(g); }]);       /* v2.18.0：群聊头像更改 */
  else if(contactId)acts.push(['image','ta的头像库',()=>{ openAvatarManager(contactId); }]);
  acts.push(['bubble','ta的气泡',()=>{ openBubbleManager(contactId); }]);
  acts.push(['fontIc','ta的字体',()=>{ openFontManager(contactId); }]);
  /* v2.23.0：单人聊天支持邀请一起听音乐 */
  if(!g&&contactId)acts.push(['music','一起听',()=>{ inviteListenPicker(contactId); }]);
  sheet.innerHTML=`
    <div class="sheet-mask"></div>
    <div class="sheet-panel">
      <div style="font-weight:800;margin-bottom:4px">更多互动</div>
      <div class="sheet-grid">
        ${acts.map((a,i)=>`<div class="act" data-i="${i}"><div class="ic">${I(a[0],22)}</div>${a[1]}</div>`).join('')}
      </div>
    </div>`;
  document.getElementById('phone').appendChild(sheet);
  sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
  sheet.querySelectorAll('.act').forEach(el=>el.addEventListener('click',()=>{ sheet.remove(); acts[+el.dataset.i][2](); }));
}
/* ---------- 群聊头像编辑器（v2.18.0 预设网格；v2.21.0 对齐联系人能力：
   本群头像库（自建，可管理删除）+ 自定义 emoji + 上传图片（compressImage 200）+ 20 预设 + 恢复默认 ---------- */
const GROUP_AVATARS=['👥','🏠','🌸','🌙','⭐','🎉','🍵','📚','🐱','🐶','🍰','🎬','⚽','🌿','💎','🔥','🌊','🍀','🎈','🍜'];
function openGroupAvatarEditor(g){
  g.avatarLib=g.avatarLib||[];
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  let avaManage=false;
  function draw(){
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel" style="max-height:76vh;overflow-y:auto">
        <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px">${I('users',16)} 群聊头像</div>
        <div class="desc" style="margin-bottom:10px">给「${escapeHtml(g.name)}」挑头像：预设 emoji、自定义 emoji、上传图片都可以；「恢复默认」换回首字色块。</div>

        ${g.avatarLib.length?`
        <div style="display:flex;align-items:center;margin-bottom:6px">
          <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:5px">${I('image',14)} 本群头像库 <span class="count">${g.avatarLib.length} 个</span></div>
          <button class="btn small ghost" data-gmg style="margin:0 0 0 auto">${avaManage?'完成':'管理'}</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px">
          ${g.avatarLib.map(a=>`<div style="cursor:pointer;text-align:center;position:relative">
            <div class="avatar" data-guse="${a.id}" style="width:48px;height:48px;margin:0 auto;font-size:24px;${a.type==='img'?'background:#ececef;padding:0;overflow:hidden;':''}${g.avatar===a.id?'outline:2.5px solid var(--ink);outline-offset:2px;':''}">${a.type==='img'?`<img src="${a.data}" style="width:100%;height:100%;object-fit:cover" alt="">`:escapeHtml(a.data)}</div>
            ${avaManage?`<span class="delx" data-gdel="${a.id}" style="position:absolute;top:-4px;right:6px">✕</span>`:''}
          </div>`).join('')}
        </div>`:''}

        <div style="font-weight:700;font-size:13px;margin-bottom:6px;display:flex;align-items:center;gap:5px">${I('spark',14)} 预设 emoji</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:12px">
          ${GROUP_AVATARS.map(e=>`<div data-gav="${e}" style="cursor:pointer;text-align:center">
            <div class="avatar" style="width:48px;height:48px;margin:0 auto;background:${avaColor(g.name)};font-size:24px;${g.avatar===e?'outline:2.5px solid var(--ink);outline-offset:2px;':''}">${e}</div>
          </div>`).join('')}
        </div>

        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input id="gAvaEmoji" placeholder="输入一个 emoji，如 🐻" maxlength="4" style="flex:1;min-width:0">
          <button class="btn small ghost" id="gAvaAdd" style="margin:0">添加</button>
          <button class="btn small ghost" id="gAvaUpload" style="margin:0">上传图片</button>
        </div>
        <input type="file" id="gAvaFile" accept="image/*" style="display:none">
        <div style="display:flex;gap:10px">
          <button class="btn ghost block" data-gav="">恢复默认</button>
          <button class="btn block" data-gclose="1">关闭</button>
        </div>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    /* 使用 / 删除 本群头像库里的头像 */
    sheet.querySelectorAll('[data-guse]').forEach(el=>el.addEventListener('click',()=>{
      g.avatar=el.dataset.guse; save(); toast('群头像已更新'); draw();
    }));
    sheet.querySelectorAll('[data-gdel]').forEach(el=>el.addEventListener('click',()=>{
      const id=el.dataset.gdel;
      g.avatarLib=g.avatarLib.filter(a=>a.id!==id);
      if(g.avatar===id)g.avatar=null;
      save(); draw(); toast('已删除');
    }));
    const mg=sheet.querySelector('[data-gmg]');
    if(mg)mg.addEventListener('click',()=>{ avaManage=!avaManage; draw(); });
    /* 预设选择 / 恢复默认（data-gav="" → null） */
    sheet.querySelectorAll('[data-gav]').forEach(el=>el.addEventListener('click',()=>{
      g.avatar=el.dataset.gav||null; save();
      toast(el.dataset.gav?'群头像已更新':'已恢复默认头像');
      draw();
    }));
    /* 自定义 emoji 入库 */
    const addEm=()=>{
      const e=(sheet.querySelector('#gAvaEmoji').value||'').trim();
      if(!e){ toast('先输入一个 emoji'); return; }
      const id='ga'+Date.now();
      g.avatarLib.push({id,type:'emoji',data:e}); g.avatar=id;
      sheet.querySelector('#gAvaEmoji').value=''; save(); draw(); toast('已加入群头像库');
    };
    sheet.querySelector('#gAvaAdd').addEventListener('click',addEm);
    sheet.querySelector('#gAvaEmoji').addEventListener('keydown',e=>{ if(e.key==='Enter')addEm(); });
    /* 上传图片入库（压缩到 200px，与联系人头像一致） */
    sheet.querySelector('#gAvaUpload').addEventListener('click',()=>sheet.querySelector('#gAvaFile').click());
    sheet.querySelector('#gAvaFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=()=>compressImage(r.result,200,url=>{
        const id='ga'+Date.now();
        g.avatarLib.push({id,type:'img',data:url}); g.avatar=id;
        save(); draw(); toast('已加入群头像库');
      });
      r.readAsDataURL(f); e.target.value='';
    });
    sheet.querySelector('[data-gclose]').addEventListener('click',()=>sheet.remove());
  }
  document.getElementById('phone').appendChild(sheet);
  draw();
}
/* ---------- 气泡 / 字体选择面板：scope='global' 或联系人 id / 群聊 id ---------- */
function scopeLabel(scope){
  if(scope==='global')return '全局默认';
  if(isGroup(scope)){ const g=state.groups.find(x=>x.id===scope); return g?('「'+g.name+'」专属'):'专属'; }
  return '「'+contactName(scope)+'」专属';
}
function scopeGet(scope,key){
  /* 全局作用域的字段名映射：面板统一用 bubbleId/fontId，全局真身是 bubbleStyle/bubbleFont */
  if(scope==='global'){
    if(key==='bubbleId')return state.settings.bubbleStyle;
    if(key==='fontId')return state.settings.bubbleFont;
    return state.settings[key];
  }
  const o=isGroup(scope)?state.groups.find(x=>x.id===scope):state.contacts.find(x=>x.id===scope);
  return o?o[key]:undefined;
}
function scopeSet(scope,key,val){
  if(scope==='global'){
    if(key==='bubbleId') state.settings.bubbleStyle=val;
    else if(key==='fontId') state.settings.bubbleFont=val;
    else state.settings[key]=val;
    return;
  }
  const o=isGroup(scope)?state.groups.find(x=>x.id===scope):state.contacts.find(x=>x.id===scope);
  if(o)o[key]=val;
}
/* 气泡选择：全局 / 单个联系人（每个联系人都能设不同气泡） */
function openBubbleManager(scope){
  scope=scope||'global';
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  let pending=scopeGet(scope,'bubbleId')||'';   /* 空 = 跟随全局 */
  function draw(){
    const list=state.bubblePresets||[];
    const active=scopeGet(scope,'bubbleId')||'';   /* 当前真正生效的气泡（用于「使用中」徽章） */
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel" style="max-height:76vh;overflow-y:auto">
        <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px">${I('bubble',16)} 聊天气泡 · ${escapeHtml(scopeLabel(scope))}</div>
        <div class="desc" style="margin-bottom:10px">
          ${scope==='global'
            ?'这里设置的是全局默认气泡；想让某个人用不一样的气泡，在聊天页「更多互动 → ta的气泡」里单独设置。'
            :'仅对这个会话生效，优先级高于全局设置。选「跟随全局」即恢复默认。'}
        </div>
        <div class="bub-grid">
          <div class="bub-card ${!pending?'sel':''}" data-pick="">
            ${!active?'<span class="bub-on">使用中</span>':''}
            <div class="bub-demo" style="background:var(--soft);border:1px dashed var(--ink-3);color:var(--ink-2)">跟随全局的效果</div>
            <div class="bub-nm">跟随全局</div>
          </div>
          ${list.map(p=>`
            <div class="bub-card ${pending===p.id?'sel':''}" data-pick="${p.id}">
              ${active===p.id?'<span class="bub-on">使用中</span>':''}
              <div class="bub-demo" style="${bubPreviewStyle(p)}">你好呀，今天也要开心哦</div>
              <div class="bub-nm">${escapeHtml(p.name)}${p.builtin?'':'<span class="count">自定</span>'}</div>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
          <button class="btn small" id="bubApply">应用</button>
          <button class="btn small ghost" id="bubRename" ${pending?'':'disabled style="opacity:.45"'}>重命名</button>
          <button class="btn small ghost" id="bubDel" ${(pending&&!(list.find(p=>p.id===pending)||{}).builtin)?'':'disabled style="opacity:.45"'}>删除</button>
          <button class="btn small ghost" id="bubPaste">粘贴 CSS 新建</button>
          <button class="btn small ghost" id="bubClose">关闭</button>
        </div>
        ${scope==='global'?'':'<div class="desc" style="margin-top:8px">提示：气泡预设库（重命名 / 删除 / 粘贴新增）是全局共享的，这里只改这个会话用哪一个。</div>'}
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelectorAll('[data-pick]').forEach(el=>el.addEventListener('click',()=>{
      pending=el.dataset.pick;
      sheet.querySelectorAll('.bub-card').forEach(x=>x.classList.toggle('sel',x.dataset.pick===pending));
      $('bubRename').disabled=!pending;
      const p=(state.bubblePresets||[]).find(x=>x.id===pending);
      $('bubDel').disabled=!(pending&&p&&!p.builtin);
    }));
    $('bubClose').addEventListener('click',()=>sheet.remove());
    $('bubApply').addEventListener('click',()=>{
      scopeSet(scope,'bubbleId',pending);
      save(); applyTheme(); renderChatMsgs && currentChatId && renderChatMsgs();
      toast(pending?('气泡已应用「'+((state.bubblePresets||[]).find(x=>x.id===pending)||{}).name+'」'):'已改为跟随全局');
      draw();   /* 不关面板，让「使用中」徽章立刻移到新款上 */
    });
    $('bubRename').addEventListener('click',()=>{
      const p=(state.bubblePresets||[]).find(x=>x.id===pending); if(!p)return;
      openModal('重命名气泡','<div class="field" style="margin-bottom:0"><label>气泡名称</label><input id="bubNm" maxlength="14" value="'+escapeHtml(p.name)+'"></div>',()=>{
        const n=document.querySelector('#bubNm').value.trim();
        if(!n){ toast('名称不能为空'); return false; }
        p.name=n; save(); toast('已重命名为「'+n+'」'); draw();
      });
    });
    $('bubDel').addEventListener('click',()=>{
      const p=(state.bubblePresets||[]).find(x=>x.id===pending); if(!p||p.builtin)return;
      openModal('删除气泡',`<div style="font-size:14px;line-height:1.7">确定删除自定义气泡「${escapeHtml(p.name)}」？<br>用到它的联系人会自动回到「跟随全局」。</div>`,()=>{
        state.bubblePresets=state.bubblePresets.filter(x=>x.id!==p.id);
        state.contacts.forEach(c=>{ if(c.bubbleId===p.id)c.bubbleId=''; });
        (state.groups||[]).forEach(g=>{ if(g.bubbleId===p.id)g.bubbleId=''; });
        if(state.settings.bubbleStyle===p.id)state.settings.bubbleStyle='bp-classic';
        if(pending===p.id)pending='';
        save(); applyTheme(); toast('已删除'); draw();
      });
    });
    $('bubPaste').addEventListener('click',()=>pasteBubbleCss(()=>draw()));
  }
  document.getElementById('phone').appendChild(sheet);
  draw();
}
/* 粘贴 CSS 自动转换：把常见模板类名换成站内类名，压平过高 z-index，返回 {css,n} */
function normalizeBubbleCss(raw){
  const MAP=[
    [/\.message-sent\b/g,'.row.me .bubble'],   [/\.message-received\b/g,'.row:not(.me) .bubble'],
    [/\.message-out\b/g,'.row.me .bubble'],    [/\.message-in\b/g,'.row:not(.me) .bubble'],
    [/\.msg-out\b/g,'.row.me .bubble'],        [/\.msg-in\b/g,'.row:not(.me) .bubble'],
    [/\.msg-sent\b/g,'.row.me .bubble'],       [/\.msg-received\b/g,'.row:not(.me) .bubble'],
    [/\.chat-out\b/g,'.row.me .bubble'],       [/\.chat-in\b/g,'.row:not(.me) .bubble'],
    [/\.from-me\b/g,'.row.me .bubble'],        [/\.from-them\b/g,'.row:not(.me) .bubble'],
    [/\.mine\b/g,'.row.me .bubble'],           [/\.theirs\b/g,'.row:not(.me) .bubble'],
  ];
  let css=String(raw||''), n=0;
  /* 微信风复合类：.message.message-sent → 先剥掉公共前缀 .message，交给 MAP 转换 */
  css=css.replace(/\.message(?=\.message-(?:sent|received|out|in)\b)/g,()=>{ n++; return ''; });
  MAP.forEach(([re,to])=>{ css=css.replace(re,()=>{ n++; return to; }); });
  /* 孤立的 .message（微信模板公共样式，如 .message{...} / .message::after）→ .bubble
     注意要放在 MAP 之后，且 (?![-\w]) 防止误伤 .message-sent 这类连字符类 */
  css=css.replace(/\.message(?![-\w])/g,()=>{ n++; return '.bubble'; });
  /* z-index 过高（>=100）压到 9，避免盖住弹层 */
  css=css.replace(/z-index\s*:\s*(\d+)/g,(m,v)=>{ v=parseInt(v,10); if(v>=100){ n++; return 'z-index:9'; } return m; });
  return {css:css.trim(), n};
}
/* 粘贴 CSS 新建气泡（可保存 / 可删除；支持模板类名自动转换） */
function pasteBubbleCss(after){
  const mk=openModal('粘贴 CSS 存为气泡',`
    <div class="field"><label>气泡名称</label><input id="pbName" maxlength="14" placeholder="如：我的星星气泡"></div>
    <div class="field" style="margin-bottom:0"><label>CSS 代码（作用于 <code>.bubble</code>）</label>
      <textarea id="pbCss" style="min-height:150px;font-family:monospace;font-size:12px" placeholder=".row.me .bubble{ ... }&#10;.row:not(.me) .bubble{ ... }"></textarea>
    </div>
    <div class="desc" style="margin-top:8px">
      我发的是 <code>.row.me .bubble</code>，ta 发的是 <code>.row:not(.me) .bubble</code>。<br>
      直接粘贴别家模板的 <code>.message-sent / .message-received</code> 等类名也可以，<b>保存时会自动转换</b>；过高的 z-index 会自动压平。<br>
      建议关键的属性后面加 <code>!important</code>，否则可能被默认样式盖掉。
    </div>`,()=>{
    const nm=(document.querySelector('#pbName').value||'').trim();
    const raw=(document.querySelector('#pbCss').value||'').trim();
    if(!nm){ toast('先给气泡起个名字'); return false; }
    if(!raw){ toast('CSS 不能为空'); return false; }
    const cv=normalizeBubbleCss(raw);
    state.bubblePresets=state.bubblePresets||[];
    const id='bpu'+Date.now();
    state.bubblePresets.push({id,name:nm,builtin:false,css:cv.css,createdAt:Date.now()});
    save(); toast('已保存「'+nm+'」'+(cv.n?(' · 自动转换 '+cv.n+' 处'):''));
    if(after)after();
  });
  const ta=mk.querySelector('#pbCss');
  if(ta)setTimeout(()=>{ try{ ta.focus({preventScroll:true}); }catch(e){} },80);
}
/* 字体选择：全局 / 单个联系人 */
function openFontManager(scope){
  scope=scope||'global';
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  let pending=scopeGet(scope,'fontId')||'';
  function draw(){
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel" style="max-height:74vh;overflow-y:auto">
        <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px">${I('fontIc',16)} 聊天字体 · ${escapeHtml(scopeLabel(scope))}</div>
        <div class="desc" style="margin-bottom:10px">${scope==='global'?'全局默认字体，作用于聊天气泡里的文字。':'仅这个会话生效，优先级高于全局。'}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${FONTS.map(f=>`
            <div class="font-row ${pending===f.id?'sel':''}" data-font="${f.id}">
              <div class="font-demo" style="${f.id?f.css.replace('.bubble{','').replace('}',''):''}">今天也很想你 · 晚安</div>
              <div class="font-nm">${f.name}</div>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn small" id="fontApply">应用</button>
          <button class="btn small ghost" id="fontClose">关闭</button>
        </div>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelectorAll('[data-font]').forEach(el=>el.addEventListener('click',()=>{
      pending=el.dataset.font;
      sheet.querySelectorAll('.font-row').forEach(x=>x.classList.toggle('sel',x.dataset.font===pending));
    }));
    $('fontClose').addEventListener('click',()=>sheet.remove());
    $('fontApply').addEventListener('click',()=>{
      scopeSet(scope,'fontId',pending);
      save(); applyTheme();
      sheet.remove(); toast('字体已应用');
    });
  }
  document.getElementById('phone').appendChild(sheet);
  draw();
}
/* ---------- 联系人专属头像库管理（在单人聊天页打开，每个联系人不互通） ---------- */
let cavaManage=false;
function openAvatarManager(contactId){
  const c=state.contacts.find(x=>x.id===contactId);
  if(!c)return;
  c.avatarLib=c.avatarLib||[];
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  function draw(){
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel">
        <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px">${I('image',16)} 「${escapeHtml(c.name)}」的头像库</div>
        <div class="desc" style="margin-bottom:10px">点选设为当前头像 · 此头像库仅属于该联系人</div>
        <div class="stk-grid">
          ${c.avatarLib.map(a=>`
            <div class="stk" data-setava="${a.id}" style="${c.avatar===a.id?'outline:2.5px solid var(--accent);outline-offset:-2.5px':''}">
              ${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}
              ${cavaManage?`<span class="delx" data-delava="${a.id}">✕</span>`:''}
            </div>`).join('')}
          <div class="stk add" id="cavaEmoji">＋</div>
          <div class="stk add" id="cavaImg" style="display:flex;align-items:center;justify-content:center">${I('image',22)}</div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn small ghost" id="cavaManageBtn">${cavaManage?'完成':'管理'}</button>
          <button class="btn small ghost" id="cavaClose">关闭</button>
          <input type="file" id="cavaFile" accept="image/*" style="display:none">
        </div>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    $('cavaClose').addEventListener('click',()=>sheet.remove());
    $('cavaManageBtn').addEventListener('click',()=>{ cavaManage=!cavaManage; draw(); });
    sheet.querySelectorAll('[data-setava]').forEach(el=>el.addEventListener('click',e=>{
      if(e.target.dataset.delava)return;
      c.avatar=el.dataset.setava; save(); draw(); renderChatListRefresh(); toast('已更换头像');
    }));
    sheet.querySelectorAll('[data-delava]').forEach(el=>el.addEventListener('click',()=>{
      c.avatarLib=c.avatarLib.filter(a=>a.id!==el.dataset.delava);
      if(c.avatar===el.dataset.delava)c.avatar='';
      save(); draw();
    }));
    $('cavaEmoji').addEventListener('click',()=>{
      const mk=openModal('添加 emoji 头像','<div class="field" style="margin-bottom:0"><input id="cavaEm" maxlength="4" placeholder="如 🐻"></div>',()=>{
        const e=mk.querySelector('#cavaEm').value.trim();
        if(!e){ toast('先输入一个 emoji'); return false; }
        c.avatarLib.push({id:'a'+Date.now()+Math.random().toString(36).slice(2,5),type:'emoji',data:e});
        save(); draw();
      });
    });
    $('cavaImg').addEventListener('click',()=>$('cavaFile').click());
    $('cavaFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=()=>compressImage(r.result,200,url=>{
        c.avatarLib.push({id:'a'+Date.now()+Math.random().toString(36).slice(2,5),type:'img',data:url});
        save(); draw(); toast('已添加图片头像');
      });
      r.readAsDataURL(f); e.target.value='';
    });
  }
  document.getElementById('phone').appendChild(sheet);
  draw();
}

/* ---------- 红包（站内弹窗 · 双向 · 金额无上限，不足自动向系统申请；群聊可选红包个数=拼手气） ---------- */
function doRedPacket(contactId){
  const id=currentChatId; if(!id)return;
  const isG=isGroup(id);
  const g=isG?state.groups.find(x=>x.id===id):null;
  const maxCnt=isG?Math.max(1,g.members.length+1):1;   /* v2.24.10：含我自己，全员每人一份 */
  const mask=openModal('发红包',`
    <div class="field"><label>总金额（潮汐石 · 不设上限，余额不足时自动向系统申请）</label>
      <input id="rpAmt" type="number" min="0.01" step="0.01" placeholder="0.00" style="font-size:20px;text-align:center"></div>
    ${isG?`<div class="field"><label>红包个数（1 ~ ${maxCnt} 个 · 全员拼手气，你自己也有一份）</label>
      <input id="rpCnt" type="number" min="1" max="${maxCnt}" value="${Math.min(3,maxCnt)}" style="text-align:center"></div>`:''}
    <div class="field" style="margin-bottom:0"><label>留言（可选）</label>
      <input id="rpNote" maxlength="20" placeholder="恭喜发财，大吉大利"></div>`,()=>{
    const n=parseFloat(mask.querySelector('#rpAmt').value);
    if(isNaN(n)||n<=0){ toast('请输入正确的金额'); return false; }
    const amt=Math.round(n*100)/100;
    let cnt=1;
    if(isG){
      cnt=Math.floor(parseFloat(mask.querySelector('#rpCnt').value));
      if(isNaN(cnt)||cnt<1)cnt=1;
      if(cnt>maxCnt)cnt=maxCnt;
    }
    if(amt/cnt<0.01){ toast('单个红包至少 0.01 潮汐石'); return false; }
    if(amt>state.coins){
      const need=+(amt-state.coins).toFixed(2);
      state.coins+=need;
      toast('已向系统申请 '+need+' 潮汐石');
    }
    state.coins=+(state.coins-amt).toFixed(2);
    save(); refreshCoins();
    pushChatMsg(id,'me',String(amt),'rp');
    if(!isG){
      setTimeout(()=>{
        pushChatMsg(id,'sys',`「${contactName(contactId)}」领取了你的红包`);
        setTimeout(()=>{ const c=drawCard('互动 · 动作',contactId)||drawCard(null,contactId); if(c)pushChatMsg(id,'ta',c,null,contactId); },1500);
      },randInt(2000,4000));
      return;
    }
    /* 群红包：拆成 cnt 份，成员随机顺序领取；发送者自己也参与抢（可抢回部分） */
    const shares=[]; let rest=amt;
    for(let i=0;i<cnt-1;i++){
      const safeMin=0.01, safeMax=rest-safeMin*(cnt-1-i);
      const v=+(Math.random()*safeMax).toFixed(2);
      const share=Math.max(safeMin,v);
      shares.push(share); rest=+(rest-share).toFixed(2);
    }
    shares.push(+rest.toFixed(2));
    const best=Math.max(...shares);
    /* v2.24.10：包含我自己 —— 必留一份给我抢（点「领取」后才入账），成员随机抢剩下的 */
    const myIdx=shares.length?Math.floor(Math.random()*shares.length):-1;
    /* 抢红包顺序：成员随机，且跳过留给我自己的那一份 */
    const others=[...g.members].sort(()=>Math.random()-0.5);
    let slot=0;
    others.forEach(who=>{
      while(slot===myIdx)slot++;            /* 跳过我的名额 */
      if(slot>=shares.length)return;        /* 红包份数已分完 */
      const share=shares[slot]; slot++;
      setTimeout(()=>{
        pushChatMsg(id,'sys',`「${contactName(who)}」领取了你的红包 ¥${share}${share===best&&cnt>1?'（手气最佳）':''}`);
        if(Math.random()<0.5)setTimeout(()=>{ const c=drawCard('互动 · 动作',who)||drawCard(null,who); if(c)pushChatMsg(id,'ta',c,null,who); },1200);
      },2500+Math.random()*3000);
    });
    /* 留给我自己那份：挂成可点击的红包，我点「领取」后才入账
       （v2.24.10 修正：不再在发送时提前退回，避免点领取时重复入账） */
    if(myIdx>=0){
      const myShare=shares[myIdx];
      const tip=myShare===best&&cnt>1 ? '「手气最佳」¥'+myShare : '¥'+myShare;
      pushChatMsg(id,'me',String(myShare),'rp',null,{claimable:true,mine:true});
      pushChatMsg(id,'sys','红包还剩 '+tip+' 没人领，你可以自己领走');
    }
  });
  setTimeout(()=>{ const inp=mask.querySelector('#rpAmt'); if(inp)inp.focus({preventScroll:true}); },60);
}

/* ---------- 群红包 · 群成员发群红包（v2.24.10）：每日每群 20% 概率触发；
   随机一位成员发出拼手气红包（份数 ≤ 全员含我），其他成员陆续抢，
   必留一份挂成「点开信封领取」等我入账 —— 领取走既有 claim 链路，一次入账。 ---------- */
function groupMemberRedPacket(g){
  if(!g||!g.id||!Array.isArray(g.members)||!g.members.length)return;
  const members=g.members.filter(Boolean);
  if(!members.length)return;
  const who=pick(members);
  const amt=Math.round(rand(1.68,88.88)*100)/100;              /* 金额随机（气氛向），系统出钱 */
  const maxCnt=Math.max(1,members.length+1);                    /* 上限 = 全员（含我） */
  const cnt=Math.max(2,Math.min(maxCnt,randInt(2,Math.min(maxCnt,6))));
  const shares=[]; let rest=amt;
  for(let i=0;i<cnt-1;i++){
    const safeMin=0.01, safeMax=rest-safeMin*(cnt-1-i);
    const v=Math.max(safeMin,+(Math.random()*safeMax).toFixed(2));
    shares.push(v); rest=+(rest-v).toFixed(2);
  }
  shares.push(+rest.toFixed(2));
  const best=Math.max(...shares);
  const myIdx=Math.floor(Math.random()*shares.length);          /* 必留一份给我 */
  const myShare=shares[myIdx];
  pushChatMsg(g.id,'ta',String(myShare),'rp',who);
  setTimeout(()=>toast(contactName(who)+' 在群里发了一个群红包'),5000);
  /* 其他成员随机顺序抢剩下的份额（排除发送者本人） */
  const grabbers=members.filter(x=>x!==who).sort(()=>Math.random()-0.5);
  let gi=0, si=0;
  shares.forEach((share,idx)=>{
    if(idx===myIdx)return;
    const g2=grabbers.length?grabbers[gi++%grabbers.length]:who;
    si++;
    setTimeout(()=>{
      pushChatMsg(g.id,'sys',`「${contactName(g2)}」领取了 ${contactName(who)} 的红包 ¥${share}${share===best&&cnt>1?'（手气最佳）':''}`);
    },1200+si*900+Math.random()*800);
  });
}
/* ---------- 帮我决定（站内弹窗：问题 + 选项可自行添加 / 删除，ta 随机选一个） ---------- */
function doDecision(contactId){
  const id=currentChatId; if(!id)return;
  const opts=[];
  const mask=openModal('帮我决定',`
    <div class="field"><label>问题（可选）</label>
      <input id="dcQ" maxlength="30" placeholder="例如：中午吃什么"></div>
    <div class="field" style="margin-bottom:0"><label>选项（至少 2 个，可自行添加 / 删除）</label>
      <div id="dcList" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input id="dcOpt" maxlength="20" placeholder="输入一个选项" style="flex:1">
        <button class="btn small ghost" id="dcAdd" style="margin:0">添加</button>
      </div>
    </div>`,()=>{
    if(opts.length<2){ toast('至少需要 2 个选项'); return false; }
    const q=mask.querySelector('#dcQ').value.trim();
    const who=isGroup(id)?pick(state.groups.find(g=>g.id===id).members):contactId;
    pushChatMsg(id,'sys','你发起了「帮我决定」'+(q?`（${q}）`:'')+'：'+opts.join(' / '));
    setTimeout(()=>{
      const choice=pick(opts);
      pushChatMsg(id,'ta',`我帮你选好了：〔${choice}〕听我的没错⌯oᴗo⌯`,null,who);
      setTimeout(()=>{ const c=drawCard(null,who); if(c)pushChatMsg(id,'ta',c,null,who); },2500);
    },randInt(2500,5000));
  });
  const list=mask.querySelector('#dcList');
  function redraw(){
    list.innerHTML=opts.map((o,i)=>`
      <div style="display:flex;justify-content:space-between;align-items:center;background:#f7f7f9;border-radius:12px;padding:8px 12px;font-size:13px">
        <span>${escapeHtml(o)}</span><span class="delx" data-i="${i}" style="font-size:12px;padding:2px 6px">✕</span>
      </div>`).join('')||'<div class="desc" style="padding:4px 2px">还没有选项，在下方添加</div>';
    list.querySelectorAll('.delx').forEach(el=>el.addEventListener('click',()=>{ opts.splice(+el.dataset.i,1); redraw(); }));
  }
  redraw();
  mask.querySelector('#dcAdd').addEventListener('click',()=>{
    const v=mask.querySelector('#dcOpt').value.trim();
    if(!v)return toast('先输入选项内容');
    if(opts.includes(v))return toast('这个选项已经加了');
    opts.push(v); mask.querySelector('#dcOpt').value=''; redraw();
  });
  mask.querySelector('#dcOpt').addEventListener('keydown',e=>{ if(e.key==='Enter')mask.querySelector('#dcAdd').click(); });
}
function doCheckOn(contactId){
  const id=currentChatId;
  const who=isGroup(id)?pick(state.groups.find(g=>g.id===id).members):contactId;
  pushChatMsg(id,'sys','你查岗了：现在在干什么？');
  setTimeout(()=>{
    const c=drawCard('日常',who)||drawCard(null,who);
    if(c)pushChatMsg(id,'ta',c,null,who);
  },randInt(1500,3500));
}

/* ================= 朋友圈（模拟微信朋友圈） ================= */
function wmAvatar(owner,name,cls){
  const id = owner==='me'?'me':owner;
  const av=getAvatar(id);
  if(av){
    if(av.type==='img')return `<div class="avatar ${cls}" style="border-radius:10px;background:#ececef;padding:0"><img src="${av.data}" style="width:100%;height:100%;object-fit:cover" alt=""></div>`;
    return `<div class="avatar ${cls}" style="border-radius:10px;background:${avaColor(name)}">${escapeHtml(av.data)}</div>`;
  }
  return `<div class="avatar ${cls}" style="border-radius:10px;background:${avaColor(name)}">${escapeHtml(name.slice(0,1))}</div>`;
}
function renderMoments(body,extra){
  function draw(){
    const posts=state.moments.slice().sort((a,b)=>b.t-a.t);
    const me=state.settings.myName;
    const mw=state.settings.momentWall||{type:'grad',data:''};
    const coverStyle=mw.type==='img'&&mw.data?`background-image:url(${mw.data});background-size:cover;background-position:center;`:`
      background:${mw.data||'linear-gradient(135deg,#ececef 0%,#dcdce2 55%,#cbcbd3 100%)'};`;
    body.innerHTML=`
      <div style="margin:-16px -16px 0;padding-bottom:2px">
        <div class="wm-head">
          <div class="wm-cover" style="${coverStyle}">
            <div class="cover-edit" id="coverEdit" title="更换背景图" style="display:inline-flex;align-items:center;gap:4px">${I('image',12)} 换背景</div>
          </div>
          <div class="wm-me"><span class="nm">${escapeHtml(me)}</span>${wmAvatar('me',me,'lg')}</div>
        </div>
        <div class="wm-feed" style="padding:34px 16px 20px">
          ${posts.map(p=>{
            const author=p.author==='me'?me:contactName(p.author);
            let content;
            if(p.sticker){
              let st=state.stickers.find(s=>s.id===p.sticker);
              if(!st)state.contacts.forEach(c=>{ if(!st&&c.stickers)st=c.stickers.find(s=>s.id===p.sticker); });
              if(!st&&state.myStickers)st=state.myStickers.find(s=>s.id===p.sticker);
              content = st ? (st.type==='emoji'?`<div class="wm-stk">${escapeHtml(st.data)}</div>`:`<div class="wm-stk"><img src="${st.data}" alt=""></div>`) : '';
            }else content=`<div class="wm-txt">${escapeHtml(p.text)}</div>`;
            return `<div class="wm-post">
              ${wmAvatar(p.author,author,'md')}
              <div style="flex:1;min-width:0">
                <div class="wm-nm">${escapeHtml(author)}</div>
                ${content}
                <div class="wm-time">
                  <span>${fmtTime(p.t)}</span>
                  <span data-delmom="${p.id}" style="cursor:pointer">删除</span>
                </div>
                <div class="wm-ops">
                  <span data-like="${p.id}" class="${p.likes.includes(me)?'liked':''}">${IC('<path d="M12 20s-7.2-4.7-9.2-8.8A5 5 0 0 1 12 6.7 5 5 0 0 1 21.2 11.2C19.2 15.3 12 20 12 20z"/>')} 赞${p.likes.length?` ${p.likes.length}`:''}</span>
                  <span data-cmt="${p.id}">${IC('<path d="M4 5.5h16v11H9.5L5 20.5z"/>')} 评论${p.comments.length?` ${p.comments.length}`:''}</span>
                </div>
                ${(p.likes.length||p.comments.length)?`<div class="cmt">
                  ${p.likes.length?`<div class="cmt-like">${I('heart',12)} ${p.likes.map(n=>escapeHtml(n)).join('、')} 觉得很赞</div>`:''}
                  ${p.comments.map((c,ci)=>{
                    let bodyHtml;
                    if(c.sticker){
                      let st=state.stickers.find(s=>s.id===c.sticker);
                      if(!st)state.contacts.forEach(x=>{ if(!st&&x.stickers)st=x.stickers.find(s=>s.id===c.sticker); });
                      if(!st&&state.myStickers)st=state.myStickers.find(s=>s.id===c.sticker);
                      bodyHtml = st ? (st.type==='emoji'?`<span style="font-size:22px;line-height:1">${escapeHtml(st.data)}</span>`:`<img src="${st.data}" alt="" style="max-width:56px;max-height:56px;border-radius:8px;vertical-align:middle;display:block">`) : '[表情包]';
                    }else bodyHtml=escapeHtml(c.text||'');
                    return `<div class="cmt-line"><b>${escapeHtml(c.by)}</b>${c.replyTo?`<i class="cmt-rp"> 回复 </i><b>${escapeHtml(c.replyTo)}</b>`:''}：${bodyHtml}<span class="cmt-ract" data-mr="${p.id}|${ci}">回复</span></div>`;
                  }).join('')}
                </div>`:''}
              </div>
            </div>`;
          }).join('')||'<div class="empty">还没有动态</div>'}
        </div>
      </div>`;
    /* v2.17.0：发表框移到右上角「＋」（原 feed 顶部大输入卡弃用） */
    extra.classList.remove('hide');
    extra.onclick=()=>openMomComposer(draw);
    /* 右上角互动通知：联系人点赞 / 评论我的动态时累计未读，点开列表并清零 */
    const bell=$('appBell');
    if(bell){
      bell.classList.remove('hide');
      updateMomBell();
      bell.onclick=()=>{
        const list=(state.momNotices||[]).slice().sort((a,b)=>b.t-a.t).slice(0,30);
        state.momUnread=0; save(); updateMomBell();
        openModal('互动通知',
          list.length?list.map(n=>`
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--ink)">
              <span style="display:inline-flex;align-items:center;gap:4px">${n.type==='like'?I('heart',12):I('bubble',12)} <b>${escapeHtml(n.by)}</b>${n.type==='like'?' 赞了你的动态':' 评论了你的动态'}</span>
              <span class="count" style="flex:none">${fmtTime(n.t)}</span>
            </div>`).join(''):'<div class="empty" style="padding:20px 0">还没有新互动，发条动态等待回应吧</div>',
          null,null,'知道了');
      };
    }
    body.querySelectorAll('[data-like]').forEach(el=>el.addEventListener('click',()=>{
      const p=state.moments.find(x=>x.id===el.dataset.like);
      if(p.likes.includes(me)){ p.likes=p.likes.filter(n=>n!==me); } else p.likes.push(me);
      save(); draw();
    }));
    body.querySelectorAll('[data-cmt]').forEach(el=>el.addEventListener('click',()=>{
      const p=state.moments.find(x=>x.id===el.dataset.cmt);
      if(!p)return;
      const mk=openModal('写评论','<div class="field" style="margin-bottom:0"><input id="cmtInput" maxlength="60" placeholder="说点什么…"></div>',()=>{
        const t=mk.querySelector('#cmtInput').value.trim();
        if(!t){ toast('先写点内容'); return false; }
        p.comments.push({by:me,text:t}); save(); draw();
      });
    }));
    /* v2.18.0：楼中楼回复 —— 点某条评论的「回复」回他，之后对方 10% 概率再回一句 */
    body.querySelectorAll('[data-mr]').forEach(el=>el.addEventListener('click',ev=>{
      ev.stopPropagation();
      const parts=el.dataset.mr.split('|');
      const p=state.moments.find(x=>x.id===parts[0]);
      const c=p&&p.comments[+parts[1]];
      if(!c)return;
      const mk=openModal('回复 '+c.by,'<div class="field" style="margin-bottom:0"><input id="mrInput" maxlength="60" placeholder="回复 '+escapeHtml(c.by)+'…"></div>',()=>{
        const t=mk.querySelector('#mrInput').value.trim();
        if(!t){ toast('先写点内容'); return false; }
        p.comments.push({by:me,text:t,replyTo:c.by}); save(); draw();
        scheduleMomCommentBack(p,c.by);
      });
    }));
    body.querySelectorAll('[data-delmom]').forEach(el=>el.addEventListener('click',()=>{
      state.moments=state.moments.filter(x=>x.id!==el.dataset.delmom);
      save(); draw();
    }));
    /* 朋友圈背景图：预设渐变 + 上传图片 */
    $('coverEdit').addEventListener('click',()=>{
      const PRESETS=[
        ['薄暮','linear-gradient(135deg,#f6d5c3 0%,#e8a9a0 55%,#a4738f 100%)'],
        ['海屿','linear-gradient(135deg,#cfe3ec 0%,#9db9c9 55%,#5b7a9d 100%)'],
        ['抹茶','linear-gradient(135deg,#e4efdc 0%,#b9d3ae 55%,#7a9d7f 100%)'],
        ['暮紫','linear-gradient(135deg,#e8dff0 0%,#b9a6cf 55%,#8a7f9d 100%)'],
      ];
      const mk=openModal('邻屿圈背景',`
        <div class="field"><label>预设背景</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${PRESETS.map(([n,g])=>`<div data-grad="${g}" style="cursor:pointer;text-align:center">
              <div style="width:56px;height:40px;border-radius:10px;background:${g};border:2.5px solid var(--ink-3);box-shadow:var(--shadow)"></div>
              <div style="font-size:11px;margin-top:3px;color:var(--ink-2)">${n}</div></div>`).join('')}
          </div></div>
        <div class="field" style="margin-bottom:0"><label>或上传图片</label>
          <button class="btn ghost block" id="coverUpload">选择图片</button>
          <input type="file" id="coverFile" accept="image/*" style="display:none"></div>`,()=>{
        save(); draw(); toast('邻屿圈背景已更新');
      });
      mk.querySelectorAll('[data-grad]').forEach(el=>el.addEventListener('click',()=>{
        state.settings.momentWall={type:'grad',data:el.dataset.grad};
        mk.querySelectorAll('[data-grad]').forEach(x=>{ const d=x.querySelector('div'); if(d)d.style.border='2.5px solid var(--ink-3)'; });
        const sel=el.querySelector('div'); if(sel)sel.style.border='2.5px solid var(--accent)';
      }));
      mk.querySelector('#coverUpload').addEventListener('click',()=>mk.querySelector('#coverFile').click());
      mk.querySelector('#coverFile').addEventListener('change',function(){
        const f=this.files[0]; if(!f)return;
        if(f.size>3*1024*1024)return toast('图片太大，请选 3MB 以内的');
        const r=new FileReader();
        r.onload=()=>{
          state.settings.momentWall={type:'img',data:r.result};
          mk.querySelector('#coverFile').value='';
          toast('已选择图片，点「确定」生效');
        };
        r.readAsDataURL(f);
      });
    });
  }
  extra.classList.add('hide');
  draw();
}
/* v2.17.0：朋友圈发表弹窗（原 feed 顶部大输入卡移到这里，从右上角「＋」唤起） */
function openMomComposer(after){
  const mk=openModal('发表动态',
    `<div class="field" style="margin-bottom:0"><textarea id="momText" style="min-height:96px" placeholder="这一刻的想法…"></textarea></div>`,
    ()=>{
      const txt=mk.querySelector('#momText').value.trim();
      if(!txt){ toast('写点什么再发吧'); return false; }
      state.moments.push({id:'m'+Date.now(),author:'me',text:txt,t:Date.now(),likes:[],comments:[]});
      save(); after(); scheduleMomentReactions();
    },null,'发表');
  setTimeout(()=>{ const t=mk.querySelector('#momText'); if(t)t.focus(); },80);
}
/* 朋友圈右上角铃铛徽标：未读互动数 */
function updateMomBell(){
  const b=$('appBell'); if(!b)return;
  const n=state.momUnread||0;
  let badge=b.querySelector('.badge');
  if(n>0){
    if(!badge){ badge=document.createElement('i'); badge.className='badge'; b.appendChild(badge); }
    badge.textContent=n>9?'9+':String(n);
  }else if(badge)badge.remove();
}
/* 记一条朋友圈互动通知（点赞 / 评论） */
function pushMomNotice(by,type){
  state.momNotices=state.momNotices||[];
  state.momNotices.push({t:Date.now(),by,type});
  if(state.momNotices.length>60)state.momNotices=state.momNotices.slice(-60);
  state.momUnread=(state.momUnread||0)+1;
  save();
  if(currentApp==='moments')updateMomBell();
}
/* 联系人发一条朋友圈：内容从「字卡库 + 表情包库」随机挑 1~5 条拼成。
   挑到的字卡按行排；挑到表情包则作为配图表情（最多 1 个）。 */
/* 朋友圈取词偏好的分类（不合适就退回全库兜底） */
const MOMENT_CATS=['日常','天气 · 环境','心语 · 长句','撒娇 · 粘人','亲昵 · 情话','情绪'];
function composeMomentByContact(cid){
  const cObj=state.contacts.find(c=>c.id===cid);
  /* 表情包池：v2.19.0 起 50% 概率优先用该联系人的专属表情包（原 7%），其余用公用（ta 不会用「我的表情包」） */
  const stkPool=(cObj&&Array.isArray(cObj.stickers)&&cObj.stickers.length&&Math.random()<0.5)?cObj.stickers:(state.stickers||[]);

  const n=randInt(1,5);            /* 总条数 1~5 */
  const lines=[];
  let sticker=undefined;
  for(let i=0;i<n;i++){
    /* 第 1 条有 30% 概率直接给表情包；其余位置 15% 概率给表情包（最多 1 个） */
    const wantStk = stkPool.length && (i===0?Math.random()<0.3:Math.random()<0.15);
    if(wantStk && !sticker){
      const sp=pick(stkPool);
      if(sp&&sp.id){ sticker=sp.id; continue; }
    }
    const s=drawCard(MOMENT_CATS,cid)||drawCard(null,cid);
    if(s && !lines.includes(s)) lines.push(s);
  }
  /* 兜底：一条内容都没有时补一句 */
  if(!lines.length && !sticker) lines.push(drawCard(null,cid)||'想你了');

  return {
    id:'m'+Date.now(), author:cid,
    text: lines.join('\n'),
    sticker,
    t:Date.now(), likes:[], comments:[]
  };
}
function addMomentByContact(cid){
  state.moments.push(composeMomentByContact(cid));
  save();
}
/* 我发布朋友圈后：每位联系人独立判定 —— 点赞 / 评论（概率可在设置页调整） */
function scheduleMomentReactions(){
  const post=state.moments.filter(p=>p.author==='me').sort((a,b)=>b.t-a.t)[0];
  if(!post||!state.contacts.length)return;
  const likeP=state.settings.momentLikeProb??70;      /* 默认 70% 点赞 */
  const cmtP =state.settings.momentCommentProb??35;   /* 默认 35% 评论 */
  state.contacts.forEach(c=>{
    const lt = Math.random()*100<likeP ? Date.now()+momReactDelay() : 0;   /* v2.24.21：5 分钟~10 小时 */
    if(lt) queueMomReaction(post.id,c.id,'like',lt);
    if(Math.random()*100<cmtP) queueMomReaction(post.id,c.id,'cmt',Date.now()+momReactDelay());
  });
}
/* v2.18.0：我在朋友圈回复联系人后 —— 对方 10% 概率再回我一句（楼中楼，带互动通知）
   v2.24.15：延迟由 4~20 秒改成 5 分钟~10 小时随机（同 scheduleMomentReactions，别显得守在手机旁） */
function scheduleMomCommentBack(post,byName){
  if(Math.random()>=0.1)return;
  const c=state.contacts.find(x=>x.name===byName);
  if(!c)return;
  queueMomReaction(post.id,c.id,'back',Date.now()+momReactDelay());
}

/* ---------- 朋友圈互动的延迟调度（v2.24.15 引入 · v2.24.21 补持久化） ----------
   用户反馈「我刚发，联系人立刻就回了」太假。真实的朋友圈是「各忙各的，想起来才刷到」，
   所以评论 / 点赞 / 楼中楼回覆统一推迟到 5 分钟~10 小时之间的随机时间
   （下限 5 分钟避免刚放下手机就响，上限 10 小时保证「发出去当天总能等到回应」）。

   ⚠️ v2.24.21 修的真实 bug：旧版只用裸 setTimeout —— 用户发完动态关掉网页，
   那个 5 分钟~10 小时的定时器随页面一起死掉，这条点赞/评论**永远不会出现**
   （旧注释里写「见 flushPendingMomLikes」，但那个函数从来没被实现过）。
   现在凡是延迟超过 90 秒的，都先在存档里挂一条 state.momPending；
   启动时 scanPendingMomReactions() 把已到点的补上、没到点的重新计时。 */
const MOM_LIKE_DELAY_MIN = 5*60e3;              /* 最早 5 分钟 */
const MOM_LIKE_DELAY_MAX = 10*60*60e3;          /* 最晚 10 小时（v2.24.21：由 24 小时收紧到 10 小时） */
const MOM_PENDING_MAX_AGE = 36*60*60e3;         /* 超过 36 小时的陈年待办直接丢掉，不再补 */
function momReactDelay(){ return randInt(MOM_LIKE_DELAY_MIN, MOM_LIKE_DELAY_MAX); }

/* 挂一条待办（写进存档）+ 起一个定时器 */
function queueMomReaction(postId,cid,kind,at){
  state.momPending=state.momPending||[];
  state.momPending.push({postId,cid,kind,at});
  save();
  armMomReaction({postId,cid,kind,at});
}
function armMomReaction(rec){
  const wait=Math.max(0,rec.at-Date.now());
  setTimeout(()=>applyMomReaction(rec),Math.min(wait,2147483000));   /* 超过 24.8 天 setTimeout 会溢出，钳一下 */
}
/* 真正落地一条朋友圈互动；做完就从待办里摘掉 */
function applyMomReaction(rec){
  const pend=state.momPending;
  if(Array.isArray(pend)){
    const i=pend.findIndex(x=>x.postId===rec.postId&&x.cid===rec.cid&&x.kind===rec.kind&&x.at===rec.at);
    if(i>=0){ pend.splice(i,1); save(); }
  }
  const post=state.moments.find(p=>p.id===rec.postId);
  const c=state.contacts.find(x=>x.id===rec.cid);
  if(!post||!c)return;
  if(rec.kind==='like'){
    if(post.likes.includes(c.name))return;
    post.likes.push(c.name); pushMomNotice(c.name,'like'); save();
    if(currentApp==='moments')renderMoments($('appBody'),$('appExtra'));
    return;
  }
  if(rec.kind==='back'){
    const txt=drawCard(['亲昵 · 情话','撒娇 · 粘人','日常'],c.id)||drawCard(null,c.id);
    if(!txt)return;
    post.comments.push({by:c.name,text:txt,replyTo:state.settings.myName});
    pushMomNotice(c.name,'cmt'); save();
    if(currentApp==='moments')renderMoments($('appBody'),$('appExtra'));
    toast(c.name+' 回复了你的评论');
    return;
  }
  /* kind === 'cmt'：v2.19.0 起 30% 概率用该联系人专属表情包评论（有库才走），否则文字评论 */
  if(Array.isArray(c.stickers)&&c.stickers.length&&Math.random()<0.3){
    const sp=pick(c.stickers);
    if(sp&&sp.id){
      post.comments.push({by:c.name,sticker:sp.id});
      pushMomNotice(c.name,'cmt'); save();
      if(currentApp==='moments')renderMoments($('appBody'),$('appExtra'));
      toast(c.name+' 用表情包评论了你');
      return;
    }
  }
  const txt=drawCard(['亲昵 · 情话','撒娇 · 粘人','日常','表情'],c.id)||drawCard(null,c.id);
  if(!txt)return;
  post.comments.push({by:c.name,text:txt});
  pushMomNotice(c.name,'cmt'); save();
  if(currentApp==='moments')renderMoments($('appBody'),$('appExtra'));
  toast(c.name+' 评论了你的动态');
}
/* 启动时扫尾：离站期间攒下的朋友圈互动，这次进站补上（到点的立刻，没到点的继续等） */
function scanPendingMomReactions(){
  if(!Array.isArray(state.momPending)||!state.momPending.length)return;
  const now=Date.now(), rest=[];
  state.momPending.forEach(rec=>{
    if(!rec||!rec.postId||!rec.cid)return;
    /* 陈年待办 / 动态已被删掉的，直接丢 */
    const post=state.moments.find(p=>p.id===rec.postId);
    if(!post||now-post.t>MOM_PENDING_MAX_AGE)return;
    if(rec.at-now<=90e3){
      const r=Object.assign({},rec);                 /* 快照，避免后续 splice 影响 */
      setTimeout(()=>applyMomReaction(r),randInt(800,3000));
    }else{
      rest.push(rec);
      armMomReaction(rec);
    }
  });
  state.momPending=rest;
  save();
}

/* ================= 信箱 ================= */
let mailStarOnly=false;   /* v2.22.0：只看收藏的信 */
let mailBox='in';         /* v2.23.0：in=收件箱（ta 写给我的）· out=寄件箱（我寄出的） */
function renderMail(body,extra){
  function draw(){
    const all=state.letters.slice().sort((a,b)=>b.t-a.t);
    const nIn=all.filter(l=>l.from!=='me').length, nOut=all.filter(l=>l.from==='me').length;
    const boxList=mailBox==='in'?all.filter(l=>l.from!=='me'):all.filter(l=>l.from==='me');
    const letters=mailStarOnly?boxList.filter(l=>l.star):boxList;
    const nStar=all.filter(l=>l.star).length;
    body.innerHTML=`
      <div class="seg" style="margin-bottom:12px">
        <button class="${mailBox==='in'?'on':''}" data-mbox="in">${I('mailOpen',14)} 收件箱 <span class="count">${nIn}</span></button>
        <button class="${mailBox==='out'?'on':''}" data-mbox="out">${I('mail',14)} 寄件箱 <span class="count">${nOut}</span></button>
      </div>
      <div class="card">
        <div class="field"><label>收信人</label><select id="mailTo">${state.contacts.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div>
        <div class="field"><input id="mailTitle" placeholder="信的标题" maxlength="20"></div>
        <div class="field"><textarea id="mailBody" placeholder="写下你想说的…"></textarea></div>
        <button class="btn block" id="mailSend">寄出这封信</button>
      </div>
      <div class="section-label" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span>${mailBox==='in'?'收到的信':'寄出的信'} <span class="count">${boxList.length}</span></span>
        <button class="btn small ghost" id="mailStarFilter" style="margin:0;display:inline-flex;align-items:center;gap:5px">${mailStarOnly?I('starFill',13)+' 只看收藏（'+nStar+'）':I('star',13)+' 只看收藏'}</button>
      </div>
      ${letters.map(l=>{
        const isMine=l.from==='me';
        const other=isMine?contactName(l.to):contactName(l.from);
        /* v2.22.0：ta 写给我的信不再显示「等待回信中」，而是「待你回信」+ 点开回信 */
        const st=isMine
          ?(l.reply?`<span style="color:#2f9e63;display:inline-flex;align-items:center;gap:4px">${I('mailOpen',12)} 已收到回信</span>`:`<span style="color:var(--ink-3)">…等待回信中</span>`)
          :(l.myReply?`<span style="color:#2f9e63;display:inline-flex;align-items:center;gap:4px">${I('check',12)} 你已回信</span>`:`<span style="color:#576b95;display:inline-flex;align-items:center;gap:4px">${I('pen',12)} 待你回信</span>`);
        const raw=String(l.body||'');
        const brief=raw.slice(0,48);
        return `<div class="card mail-card" data-lid="${l.id}" style="cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <div style="font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px">${I('mail',14)} ${escapeHtml(l.title||'（无标题）')}</div>
            <span class="mail-star" data-star="${l.id}" title="收藏" style="cursor:pointer;display:flex;color:${l.star?'#e0a03f':'var(--ink-3)'}">${I(l.star?'starFill':'star',17)}</span>
          </div>
          <div class="desc" style="margin:6px 0">${isMine?'寄给':'来自'}：${escapeHtml(other)} · ${fmtDate(l.t)}</div>
          <div style="font-size:13px;line-height:1.7;color:var(--ink-2)">${escapeHtml(brief)}${raw.length>48?'…':''}</div>
          <div class="desc" style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">${st}<span style="color:#576b95;font-size:12px">点开查看 ›</span></div>
        </div>`;
      }).join('')||`<div class="empty">${mailStarOnly?'还没有收藏的信':(mailBox==='in'?'收件箱还空着，等一封信来':'还没有写过信，写第一封吧')}</div>`}`;
    body.querySelectorAll('[data-mbox]').forEach(el=>el.addEventListener('click',()=>{ mailBox=el.dataset.mbox; draw(); }));
    $('mailSend').addEventListener('click',()=>{
      const title=$('mailTitle').value.trim(), body=$('mailBody').value.trim();
      if(!body)return toast('信的内容不能为空');
      if(!state.contacts.length)return toast('先添加联系人');
      state.letters.push({id:'l'+Date.now(),from:'me',to:$('mailTo').value,title,body,t:Date.now(),reply:null,replyRolled:false,star:false});
      save(); mailBox='out'; draw(); scheduleMailReply();
      toast('信已寄出（回信需要一点时间）');
    });
    $('mailStarFilter').addEventListener('click',()=>{ mailStarOnly=!mailStarOnly; draw(); });
    body.querySelectorAll('[data-star]').forEach(el=>el.addEventListener('click',e=>{
      e.stopPropagation();
      const l=state.letters.find(x=>x.id===el.dataset.star); if(!l)return;
      l.star=!l.star; save(); draw();
      toast(l.star?'已收藏这封信':'已取消收藏');
    }));
    body.querySelectorAll('.mail-card').forEach(el=>el.addEventListener('click',()=>{
      const l=state.letters.find(x=>x.id===el.dataset.lid); if(!l)return;
      openMailDetail(l,()=>{ if(currentApp==='mail')renderMail($('appBody'),$('appExtra')); });
    }));
  }
  extra.classList.add('hide');
  draw();
}
/* 信件详情（v2.22.0）：点开查看全文 · 收藏 · 回信（ta 写给我的信可点按钮回信） */
function openMailDetail(l,refresh){
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  const refreshAll=()=>{ if(refresh)refresh(); };
  function listPanel(){
    const mine=l.from==='me';
    const other=mine?contactName(l.to):contactName(l.from);
    const myName=state.settings.myName||'我';
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel" style="max-height:84vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="font-weight:800;font-size:16px;min-width:0;word-break:break-all;display:flex;align-items:center;gap:7px">${I('mail',16)} ${escapeHtml(l.title||'（无标题）')}</div>
          <span id="mdStar" style="cursor:pointer;flex:none;display:flex;color:${l.star?'#e0a03f':'var(--ink-3)'}">${I(l.star?'starFill':'star',20)}</span>
        </div>
        <div class="desc" style="margin:5px 0 12px">${mine?escapeHtml(myName)+' → '+escapeHtml(other):escapeHtml(other)+' → '+escapeHtml(myName)} · ${fmtDate(l.t)}</div>
        <div style="font-size:14px;line-height:1.85;white-space:pre-wrap;word-break:break-word">${escapeHtml(l.body||'')}</div>
        ${l.reply?`<div style="background:#f6f6f8;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.75;margin-top:12px;white-space:pre-wrap">${escapeHtml(other)} 的回信：<br>${escapeHtml(l.reply)}</div>`:''}
        ${l.myReply?`<div style="background:#eef6ff;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.75;margin-top:12px;white-space:pre-wrap">你的回信：<br>${escapeHtml(l.myReply)}</div>`:''}
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn small ghost" id="mdStarBtn" style="margin:0;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px">${l.star?I('starFill',13)+' 取消收藏':I('star',13)+' 收藏'}</button>
          ${(!mine&&!l.myReply)?`<button class="btn small" id="mdReply" style="margin:0;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px">${I('pen',13)} 回信</button>`:''}
        </div>
        <button class="btn ghost block" id="mdClose" style="margin-top:10px">关闭</button>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelector('#mdClose').addEventListener('click',()=>sheet.remove());
    sheet.querySelector('#mdStar').addEventListener('click',()=>{ l.star=!l.star; save(); listPanel(); refreshAll(); toast(l.star?'已收藏':'已取消收藏'); });
    sheet.querySelector('#mdStarBtn').addEventListener('click',()=>{ l.star=!l.star; save(); listPanel(); refreshAll(); toast(l.star?'已收藏':'已取消收藏'); });
    const rp=sheet.querySelector('#mdReply');
    if(rp)rp.addEventListener('click',()=>replyPanel());
  }
  function replyPanel(){
    const other=contactName(l.from);
    sheet.innerHTML=`
      <div class="sheet-mask"></div>
      <div class="sheet-panel" style="max-height:84vh;overflow-y:auto">
        <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px">${I('pen',15)} 回信给「${escapeHtml(other)}」</div>
        <div class="desc" style="margin:4px 0 10px">回应这封《${escapeHtml(l.title||'无标题')}》</div>
        <div class="field"><textarea id="mdReplyText" maxlength="600" style="min-height:130px" placeholder="写下你的回信…"></textarea></div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost" id="mdReplyBack" style="margin:0;flex:1">返回</button>
          <button class="btn" id="mdReplySend" style="margin:0;flex:1">寄出回信</button>
        </div>
      </div>`;
    sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
    sheet.querySelector('#mdReplyBack').addEventListener('click',()=>listPanel());
    sheet.querySelector('#mdReplySend').addEventListener('click',()=>{
      const txt=sheet.querySelector('#mdReplyText').value.trim();
      if(!txt)return toast('回信内容不能为空');
      l.myReply=txt; l.myReplyT=Date.now(); save();
      toast('回信已寄出');
      /* 30% 概率：ta 过一阵子再写一封给你 */
      if(Math.random()<0.3){
        const cid=l.from;
        setTimeout(()=>{
          state.letters.push({id:'l'+Date.now(),from:cid,to:'me',
            title:pick(['看完你的回信','想继续和你说','今天的第二封信','写给你的下一封']),
            body:buildLetterBody(cid),t:Date.now(),reply:null,star:false});
          save(); toast('收到一封来自「'+contactName(cid)+'」的信');
          if(currentApp==='mail')renderMail($('appBody'),$('appExtra'));
        },randInt(6*3600e3,48*3600e3));
      }
      listPanel(); refreshAll();
    });
  }
  document.getElementById('phone').appendChild(sheet);
  listPanel();
}
/* 回信内容：从字卡库挑 3~15 句（v2.18.0 由单句上调） */
function mailReplyContent(cid){
  const n=randInt(3,15);
  const lines=[];
  for(let i=0;i<n;i++){
    const s=drawCard(['心语 · 长句','亲昵 · 情话','撒娇 · 粘人','关心 · 叮嘱'],cid)||drawCard(null,cid);
    if(s&&!lines.includes(s))lines.push(s);
  }
  return lines.join('\n')||'见字如面，一切安好。';
}
/* 我寄出信后：1~3 天内必定收到回信（v2.18.0：由 1h~4d+40% 调整） */
function scheduleMailReply(){
  const letter=state.letters.filter(l=>l.from==='me'&&!l.reply&&!l.replyRolled).sort((a,b)=>b.t-a.t)[0];
  if(!letter)return;
  const delay=randInt(24*3600e3,72*3600e3);
  setTimeout(()=>{
    if(!letter.reply&&!letter.replyRolled){
      letter.replyRolled=true;
      letter.reply=mailReplyContent(letter.to); save();
      toast('收到一封回信！');
      if(currentApp==='mail')renderMail($('appBody'),$('appExtra'));
    }
  },delay);
}
/* 页面加载时扫描：上次寄出的信已超过 1 小时且未回 → 本次会话内安排回信（最迟不超过寄出后 3 天） */
function scanPendingReplies(){
  const now=Date.now();
  state.letters.filter(l=>l.from==='me'&&!l.reply&&!l.replyRolled&&now-l.t>3600e3).forEach(l=>{
    l.replyRolled=true;
    const remain=Math.max(0,72*3600e3-(now-l.t));   /* 距 3 天期限还剩多少 */
    const wait=Math.min(remain,randInt(20000,90000));
    setTimeout(()=>{
      if(!l.reply){
        l.reply=mailReplyContent(l.to); save();
        toast('收到一封回信！');
        if(currentApp==='mail')renderMail($('appBody'),$('appExtra'));
      }
    },wait);
  });
  save();
}

/* ================= 心情日记 ================= */
function renderDiary(body,extra){
  let mood='';
  function draw(){
    body.innerHTML=`
      <div class="card">
        <div class="title" style="margin-bottom:10px">今天的心情</div>
        <div class="mood-pick">${MOODS.map(m=>`<span data-m="${m}">${m}</span>`).join('')}</div>
        <div class="field"><textarea id="diaryText" style="min-height:80px" placeholder="记录今天…"></textarea></div>
        <button class="btn block" id="diarySave">保存日记</button>
      </div>
      <div class="section-label">日记本</div>
      ${state.diary.slice().sort((a,b)=>b.t-a.t).map(d=>{
        const isMe=!d.author||d.author==='me';
        const nm=isMe?state.settings.myName:contactName(d.author);
        return `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px">
              ${wmAvatar(isMe?'me':d.author,nm,'sm')}
              <div><div style="font-weight:700;font-size:13px">${escapeHtml(nm)}</div>
              <div class="count">${isMe?'我':'来自ta的日记'}</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:8px"><span style="font-size:20px">${d.mood}</span>${isMe?`<span class="delx" data-del="${d.id}">✕</span>`:''}</div>
          </div>
          <div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${escapeHtml(d.text)}</div>
          <div class="count" style="margin-top:6px;text-align:right">${fmtDate(d.t)}</div>
        </div>`;}).join('')||'<div class="empty">还没有写过日记</div>'}`;
    body.querySelectorAll('.mood-pick span').forEach(el=>el.addEventListener('click',()=>{
      mood=el.dataset.m;
      body.querySelectorAll('.mood-pick span').forEach(x=>x.classList.toggle('sel',x===el));
    }));
    $('diarySave').addEventListener('click',()=>{
      const text=$('diaryText').value.trim();
      if(!mood)return toast('先选一个心情');
      if(!text)return toast('写点什么吧');
      state.diary.push({id:'d'+Date.now(),mood,text,t:Date.now()});
      save(); draw(); toast('日记已保存');
    });
    body.querySelectorAll('.delx').forEach(el=>el.addEventListener('click',()=>{
      state.diary=state.diary.filter(d=>d.id!==el.dataset.del);
      save(); draw();
    }));
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 日历 ================= */
let calY,calM,calSelDay=null;
function renderCal(body,extra){
  if(calY===undefined){ const d=new Date(); calY=d.getFullYear(); calM=d.getMonth(); }
  function draw(){
    const first=new Date(calY,calM,1);
    const days=new Date(calY,calM+1,0).getDate();
    const startWd=first.getDay();
    const today=new Date(); const todayStr=fmtDate(today.getTime());
    let cells='';
    for(let i=0;i<startWd;i++)cells+='<div></div>';
    for(let d=1;d<=days;d++){
      const ds=`${calY}-${String(calM+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const cls=(ds===todayStr?'today':'')+(state.calNotes[ds]?' hasnote':'')+(ds===calSelDay?' sel':'');
      cells+=`<button class="cal-day ${cls}" data-d="${ds}">${d}</button>`;
    }
    const selNote = calSelDay?(state.calNotes[calSelDay]||''):'';
    body.innerHTML=`
      <div class="card">
        <div class="cal-head">
          <button class="iconbtn" id="calPrev">‹</button>
          <div class="mon">${calY}年${calM+1}月</div>
          <button class="iconbtn" id="calNext">›</button>
        </div>
        <div class="cal-grid">
          ${'一二三四五六日'.split('').map(w=>`<div class="wd">${w}</div>`).join('')}
          ${cells}
        </div>
      </div>
      ${calSelDay?`
      <div class="card">
        <div class="title" style="margin-bottom:8px">${I('pen',15)} ${calSelDay} 的备忘</div>
        <textarea id="calNoteInput" style="min-height:90px" placeholder="写点什么…">${escapeHtml(selNote)}</textarea>
        <div style="display:flex;gap:10px;margin-top:10px">
          <button class="btn block" id="calNoteSave">保存</button>
          ${selNote?'<button class="btn danger block" id="calNoteDel">删除</button>':''}
        </div>
      </div>`
      :`<div class="desc" style="text-align:center">点击日期添加或查看备忘 · 带圆点的日子有记录</div>`}`;
    $('calPrev').addEventListener('click',()=>{ calM--; if(calM<0){calM=11;calY--;} calSelDay=null; draw(); });
    $('calNext').addEventListener('click',()=>{ calM++; if(calM>11){calM=0;calY++;} calSelDay=null; draw(); });
    body.querySelectorAll('.cal-day').forEach(el=>el.addEventListener('click',()=>{
      calSelDay = calSelDay===el.dataset.d ? null : el.dataset.d;
      draw();
    }));
    const sv=$('calNoteSave');
    if(sv)sv.addEventListener('click',()=>{
      const v=$('calNoteInput').value.trim();
      if(v)state.calNotes[calSelDay]=v; else delete state.calNotes[calSelDay];
      save(); draw(); toast('备忘已保存');
    });
    const dl=$('calNoteDel');
    if(dl)dl.addEventListener('click',()=>{
      delete state.calNotes[calSelDay]; save(); calSelDay=null; draw(); toast('已删除');
    });
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 纪念日 ================= */
function renderAnn(body,extra){
  function draw(){
    const today=new Date(); today.setHours(0,0,0,0);
    const rows=state.anniversaries.slice().sort((a,b)=>a.date<b.date?-1:1).map(a=>{
      const d=new Date(a.date+'T00:00:00');
      let label;
      const diff=Math.round((d-today)/864e5);
      if(a.repeat){
        let next=new Date(d);
        while(next<today){ next=new Date(next.getFullYear()+1,next.getMonth(),next.getDate()); }
        label=Math.round((next-today)/864e5);
        label=(label===0?'就是今天！':'还有 '+label+' 天');
      }else{
        label=diff>=0?('还有 '+diff+' 天'):(-diff+' 天前');
      }
      return `<div class="rowline">
        <div><div class="name">${escapeHtml(a.name)}</div><div class="meta">${a.date}${a.repeat?' · 每年':''}</div></div>
        <div class="right"><div class="ann-days" style="font-size:16px">${label}</div><span class="delx" data-del="${a.id}">✕</span></div>
      </div>`;
    }).join('');
    body.innerHTML=`
      <div class="card" style="padding:6px 16px">${rows||'<div class="empty">还没有纪念日</div>'}</div>
      <div class="card">
        <div class="field"><input id="annName" placeholder="名称，如：在一起纪念日" maxlength="15"></div>
        <div class="field"><label>日期</label><input id="annDate" type="date"></div>
        <label style="font-size:13px;display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="annRepeat"> 每年重复</label>
        <button class="btn block" id="annAdd">添加纪念日</button>
      </div>`;
    $('annAdd').addEventListener('click',()=>{
      const name=$('annName').value.trim(), date=$('annDate').value;
      if(!name||!date)return toast('填写名称和日期');
      state.anniversaries.push({id:'a'+Date.now(),name,date,repeat:$('annRepeat').checked});
      save(); draw(); toast('纪念日已添加');
    });
    body.querySelectorAll('.delx').forEach(el=>el.addEventListener('click',()=>{
      state.anniversaries=state.anniversaries.filter(a=>a.id!==el.dataset.del);
      save(); draw();
    }));
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 占卜（今日签 + 韦特塔罗·三牌阵） ================= */
let fortTab='luck', tarotSpread='daily';
function renderFort(body,extra){
  function draw(){
    const f=state.lastFortune;
    const t=state.lastTarotDraw;
    body.innerHTML=`
      <div class="seg">
        <button class="${fortTab==='luck'?'on':''}" data-ft="luck">今日签</button>
        <button class="${fortTab==='tarot'?'on':''}" data-ft="tarot">塔罗牌</button>
      </div>
      ${fortTab==='luck'?`
        <div class="card fortune">
          <div style="display:flex;justify-content:center;color:var(--ink)">${I('fort',40)}</div>
          ${f?`<div class="lv">${f.lv}</div><div class="tx">${escapeHtml(f.tx)}</div>
            <div class="desc" style="margin-top:10px">${pick(FORTUNE_ADVICE)}</div>`
          :`<div class="desc" style="margin:10px 0">抽取今日运势</div>`}
        </div>
        <button class="btn block" id="fortBtn">抽一签</button>`
      :`
        <div class="card">
          <div class="title" style="margin-bottom:10px">${I('cards',15)} 选择牌阵</div>
          ${TAROT_SPREADS.map(sp=>`
            <div class="rowline" style="cursor:pointer" data-sp="${sp.id}">
              <div><div class="name">${sp.name} <span class="count">${sp.pos.length} 张</span></div>
              <div class="meta">${sp.desc}</div></div>
              <div class="right"><span style="font-weight:${tarotSpread===sp.id?'800':'400'};color:${tarotSpread===sp.id?'var(--ink)':'var(--ink-3)'}">${tarotSpread===sp.id?'✓':'选'}</span></div>
            </div>`).join('')}
        </div>
        <div class="card fortune">
          ${t?t.draws.map((d,i)=>`
            <div class="desc" style="font-weight:700;color:var(--ink);margin-top:${i?'14px':'2px'}">${t.spread.pos[i]}</div>
            <div class="tarot-card ${d.rev?'rev':''}" style="transform-origin:center;margin:8px auto 6px">
              <div style="font-size:11px;color:var(--ink-3);letter-spacing:2px">${d.card.arc}</div>
              <div class="em" style="font-size:40px">${d.card.em}</div>
              <div style="font-weight:800">${d.card.name}${d.rev?' · 逆位':' · 正位'}</div>
            </div>
            <div class="tx" style="font-size:13px">${escapeHtml(d.rev?d.card.rev:d.card.up)}</div>`).join('')
          :`<div class="desc" style="margin:10px 0">静下心来想着你的问题，抽一次牌阵</div>`}
        </div>
        <button class="btn block" id="tarotBtn">${t?'重新抽取':'抽取牌阵'}</button>`}`;
    body.querySelectorAll('[data-ft]').forEach(el=>el.addEventListener('click',()=>{ fortTab=el.dataset.ft; draw(); }));
    body.querySelectorAll('[data-sp]').forEach(el=>el.addEventListener('click',()=>{
      tarotSpread=el.dataset.sp; state.lastTarotDraw=null; save(); draw();
    }));
    const fb=$('fortBtn');
    if(fb)fb.addEventListener('click',()=>{
      state.lastFortune=pick(FORTUNES);
      save(); draw(); renderDesktop();
    });
    const tb=$('tarotBtn');
    if(tb)tb.addEventListener('click',()=>{
      const sp=TAROT_SPREADS.find(s=>s.id===tarotSpread);
      const deck=TAROT.slice().sort(()=>Math.random()-.5).slice(0,sp.pos.length);
      state.lastTarotDraw={spread:{id:sp.id,name:sp.name,pos:sp.pos},draws:deck.map(c=>({card:c,rev:Math.random()<0.5}))};
      save(); draw();
    });
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 心意集市 ================= */
let marketTab='goods';
function itemById(id){ return (state.marketItems||[]).find(x=>x.id===id); }
function renderMarket(body,extra){
  let manage=false;
  function draw(){
    const tabs=['goods','cart','cabinet','wish'],names=['货品','提篮','回声匣','心愿'];
    let inner='';
    if(marketTab==='goods'){
      inner=`<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 12px">
          <div class="desc">货品可自行添加 / 删除（点右上「管理」）</div>
          <div style="display:flex;gap:8px">
            <button class="btn small ghost" id="addItemBtn">＋ 添加</button>
            <button class="btn small ghost" id="mngBtn">${manage?'完成':'管理'}</button>
          </div></div>
        <div class="goods-grid">${state.marketItems.map(it=>`
        <div class="goods"><div class="em">${it.em}</div><div class="nm">${escapeHtml(it.name)}</div>
        <div class="pr" style="display:flex;align-items:center;justify-content:center;gap:3px">${I('tide',13)} ${it.price}</div>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-buy="${it.id}">放进提篮</button>
          ${manage?`<button class="btn small danger" data-delitem="${it.id}">删</button>`:''}
        </div></div>`).join('')}</div>`;
    }else if(marketTab==='cart'){
      const rows=state.cart.map(c=>{
        const it=itemById(c.itemId);
        if(!it)return '';
        return `<div class="cart-item"><span style="font-size:22px">${it.em}</span>
          <div style="flex:1"><div style="font-weight:700;font-size:13px">${escapeHtml(it.name)}</div><div class="count">${I('tide',12)} ${it.price} × ${c.qty}</div></div>
          <button class="btn small ghost" data-dec="${c.itemId}">－</button>
          <button class="btn small ghost" data-inc="${c.itemId}">＋</button></div>`;
      }).join('');
      const total=state.cart.reduce((n,c)=>{ const it=itemById(c.itemId); return n+(it?it.price*c.qty:0); },0);
      inner=(rows||'<div class="empty">提篮空空的</div>')+
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
          <div style="font-weight:800;display:flex;align-items:center;gap:4px">${I('tide',14)} 合计 ${total}</div>
          <button class="btn" id="checkout" ${state.cart.length?'':'disabled style="opacity:.4"'}>结账</button></div>`;
    }else if(marketTab==='cabinet'){
      /* 回声匣：ta 送我的礼物存档（含实现的愿望）—— 你的心愿在这里有了回声 */
      const rows=state.cabinet.slice().sort((a,b)=>b.t-a.t).map(g=>{
        if(g.itemId==='__wish'){
          return `<div class="cart-item"><span style="display:flex;color:var(--ink)">${I('wish',22)}</span>
            <div style="flex:1"><div style="font-weight:700;font-size:13px">实现了愿望：${escapeHtml(g.text)}</div>
            <div class="count">来自「${escapeHtml(contactName(g.from))}」 · ${fmtDate(g.t)}</div></div></div>`;
        }
        const it=itemById(g.itemId);
        if(!it)return '';
        return `<div class="cart-item"><span style="font-size:22px">${it.em}</span>
          <div style="flex:1"><div style="font-weight:700;font-size:13px">${escapeHtml(it.name)}</div>
          <div class="count">来自「${escapeHtml(contactName(g.from))}」 · ${fmtDate(g.t)}</div></div></div>`;
      }).filter(Boolean);
      inner=rows.join('')||'<div class="empty">回声匣还是空的<br>ta 送你的每一份心意都会在这里轻轻回响</div>';
    }else{
      /* 心愿：我许愿想要什么，ta 们可以选择送或不送 */
      inner=`<div class="card">
          <div class="title">${I('wish',15)} 许个愿</div>
          <div class="desc">写下你想要的东西，ta 会看到并决定送或不送（约 40% 概率悄悄实现，实现的会存入回声匣）</div>
          <!-- v2.20.0：加 flex-wrap + 输入框 min-width:0，修复许愿按钮被挤出框 -->
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <input id="wishInput2" maxlength="30" placeholder="例如：一杯奶茶 / 一次约会" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:14px;outline:none;background:#fafafa">
            <select id="wishTo2" style="flex:none;border:1px solid var(--line);border-radius:14px;padding:10px 6px;font-size:13px;background:#fafafa;max-width:112px">
              <option value="all">全部人</option>
              ${state.contacts.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button class="btn" id="wishAddBtn" style="flex:none;white-space:nowrap">许愿</button>
          </div>
        </div>
        ${state.wishes.map(w=>`
          <div class="card" style="display:flex;align-items:center;gap:10px;padding:13px 16px">
            <span style="display:flex;color:var(--ink-2)">${I(w.status==='granted'?'gift':w.status==='refused'?'bubble':'clock',19)}</span>
            <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px;word-break:break-all">${escapeHtml(w.text)}</div>
            <div class="count">${w.to&&w.to!=='all'?'向'+escapeHtml(contactName(w.to))+' 许愿 · ':''}${w.status==='granted'?'ta 已经为你实现':w.status==='refused'?'ta 暂时没有回应…':'ta 还在考虑中'}</div></div>
            ${w.status?`<span class="delx" data-delwish="${w.id}">✕</span>`:''}
          </div>`).join('')||'<div class="empty">还没有心愿，许一个吧</div>'}`;
    }
    body.innerHTML=`
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px">
        <div style="font-weight:800;display:flex;align-items:center;gap:4px">${I('tide',14)} ${fmtCoins(state.coins)} 潮汐石</div>
        <button class="btn small ${state.lastSign===fmtDate(Date.now())?'ghost':''}" id="signBtn" ${state.lastSign===fmtDate(Date.now())?'disabled style="opacity:.5"':''}>${state.lastSign===fmtDate(Date.now())?'今日已签到':'每日签到 +20'}</button>
      </div>
      <div class="seg">${tabs.map((t,i)=>`<button class="${marketTab===t?'on':''}" data-tab="${t}">${names[i]}</button>`).join('')}</div>
      ${inner}`;
    $('signBtn').addEventListener('click',()=>{
      state.coins+=20; state.lastSign=fmtDate(Date.now());
      save(); refreshCoins(); draw(); toast('签到成功 +20 潮汐石');
    });
    body.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>{ marketTab=el.dataset.tab; draw(); }));
    if(marketTab==='goods'){
      $('addItemBtn').addEventListener('click',()=>{
        const mk=openModal('＋ 添加货品',`
          <div class="field"><label>emoji 图标</label><input id="giEm" maxlength="4" placeholder="🎁"></div>
          <div class="field"><label>名称</label><input id="giName" maxlength="12" placeholder="例如：一次旅行"></div>
          <div class="field" style="margin-bottom:0"><label>价格（潮汐石）</label><input id="giPrice" type="number" min="1" placeholder="50"></div>`,()=>{
          const em=mk.querySelector('#giEm').value.trim()||'🎁';
          const name=mk.querySelector('#giName').value.trim();
          const price=parseFloat(mk.querySelector('#giPrice').value);
          if(!name){ toast('先填写名称'); return false; }
          if(isNaN(price)||price<=0){ toast('价格要大于 0'); return false; }
          state.marketItems.push({id:'gi'+Date.now(),em,name,price:Math.round(price*100)/100});
          save(); draw(); toast('货品已上架');
        });
      });
      $('mngBtn').addEventListener('click',()=>{ manage=!manage; draw(); });
      body.querySelectorAll('[data-delitem]').forEach(el=>el.addEventListener('click',()=>{
        const it=itemById(el.dataset.delitem);
        state.marketItems=state.marketItems.filter(x=>x.id!==el.dataset.delitem);
        state.cart=state.cart.filter(c=>c.itemId!==el.dataset.delitem);
        save(); draw(); toast('已下架「'+(it?it.name:'')+'」');
      }));
    }
    if(marketTab==='wish'){
      const doAdd=()=>{ if(addWish($('wishInput2').value,$('wishTo2')?$('wishTo2').value:'all'))draw(); };
      $('wishAddBtn').addEventListener('click',doAdd);
      $('wishInput2').addEventListener('keydown',e=>{ if(e.key==='Enter')doAdd(); });
      body.querySelectorAll('[data-delwish]').forEach(el=>el.addEventListener('click',()=>{
        state.wishes=state.wishes.filter(w=>w.id!==el.dataset.delwish);
        save(); draw();
      }));
    }
    body.querySelectorAll('[data-buy]').forEach(el=>el.addEventListener('click',()=>{
      const c=state.cart.find(x=>x.itemId===el.dataset.buy);
      if(c)c.qty++; else state.cart.push({itemId:el.dataset.buy,qty:1});
      save(); draw(); toast('已放进提篮');
    }));
    body.querySelectorAll('[data-inc]').forEach(el=>el.addEventListener('click',()=>{
      state.cart.find(x=>x.itemId===el.dataset.inc).qty++; save(); draw();
    }));
    body.querySelectorAll('[data-dec]').forEach(el=>el.addEventListener('click',()=>{
      const c=state.cart.find(x=>x.itemId===el.dataset.dec);
      c.qty--; if(c.qty<=0)state.cart=state.cart.filter(x=>x!==c);
      save(); draw();
    }));
    const co=$('checkout');
    if(co)co.addEventListener('click',()=>{
      const total=state.cart.reduce((n,c)=>{ const it=itemById(c.itemId); return n+(it?it.price*c.qty:0); },0);
      if(total>state.coins)return toast('潮汐石不足');
      state.coins-=total;
      const bought=state.cart.slice();
      state.cart=[]; save(); refreshCoins(); draw();
      /* 结账后依次选择每件礼物的收礼人 */
      (function pickNext(i){
        if(i>=bought.length){ toast('购买完成'); return; }
        const c=bought[i], it=itemById(c.itemId);
        if(!it){ pickNext(i+1); return; }
        pickGiftRecipient(it,c.qty,()=>pickNext(i+1));
      })(0);
    });
  }
  extra.classList.add('hide');
  draw();
}

/* ---------- 送礼物：结账后选择收礼人（站内底部弹窗） ---------- */
function pickGiftRecipient(item,qty,done){
  const sheet=document.createElement('div');
  sheet.className='action-sheet';
  const chipStyle='background:#f4f4f6;border-radius:16px;padding:10px 15px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px';
  sheet.innerHTML=`
    <div class="sheet-mask"></div>
    <div class="sheet-panel">
      <div style="font-weight:800;font-size:15px;display:flex;align-items:center;gap:6px">${I('gift',16)} ${item.em} ${item.name} ×${qty}</div>
      <div class="desc" style="margin:4px 0 14px">选择将礼物送给谁</div>
      <div style="display:flex;flex-wrap:wrap;gap:9px">
        ${state.contacts.map(ct=>`<span class="gift-to" data-id="${ct.id}" style="${chipStyle}">${wmAvatar(ct.id,ct.name,'sm')}${escapeHtml(ct.name)}</span>`).join('')||''}
        <span class="gift-to" data-id="__me" style="${chipStyle}">留给自己</span>
      </div>
      ${state.contacts.length?'':'<div class="empty" style="padding:10px 0">还没有联系人，只能先留给自己啦</div>'}
    </div>`;
  document.getElementById('phone').appendChild(sheet);
  sheet.querySelector('.sheet-mask').addEventListener('click',()=>{ sheet.remove(); done&&done(); });
  sheet.querySelectorAll('.gift-to').forEach(el=>el.addEventListener('click',()=>{
    const pickId=el.dataset.id;
    sheet.remove();
    if(pickId==='__me'){ toast('已留下自用'); done&&done(); return; }
    const ct=state.contacts.find(x=>x.id===pickId);
    if(!ct){ toast('没有这个联系人'); done&&done(); return; }
    pushChatMsg(ct.id,'sys',`你送出了 ${item.em} ${item.name} ×${qty}`);
    /* v2.22.0：收礼后的回复改为「从字卡库随机挑 1~2 张」（不再固定只回「互动 · 动作」一句） */
    const back=[];
    for(let i=0;i<randInt(1,2);i++){
      const card=drawCard(['互动 · 动作','亲昵 · 情话','撒娇 · 粘人','关心 · 叮嘱','情绪','日常'],ct.id)||drawCard(null,ct.id);
      if(card&&!back.includes(card))back.push(card);
    }
    if(!back.length){ const fb=drawCard(null,ct.id); if(fb)back.push(fb); }
    back.forEach((card,i)=>setTimeout(()=>pushChatMsg(ct.id,'ta',card,null,ct.id),2500+i*randInt(1200,2400)));
    toast('礼物已送给「'+ct.name+'」');
    done&&done();
  }));
}

/* ================= 心愿单：我许愿想要什么，ta 们可以选择送或不送 ================= */
/* to: 联系人 id 或 'all'（向全部人许愿，v2.19.0） */
function addWish(text,to){
  text=(text||'').trim().slice(0,30);
  if(!text){ toast('先写下你想要什么'); return false; }
  const wish={id:'w'+Date.now()+Math.random().toString(36).slice(2,4),text,t:Date.now(),status:'',to:to||'all'};
  state.wishes.unshift(wish);
  save();
  /* ta 会在一会儿后决定：送（40%）或不送 */
  setTimeout(()=>decideWish(wish),randInt(8000,30000));
  return true;
}
function decideWish(wish){
  if(wish.status)return;
  /* 许愿对象：指定某人只让 ta 判定；'all' 全体依次判定，谁先愿意谁实现（v2.19.0） */
  const pool = wish.to&&wish.to!=='all'
    ? state.contacts.filter(c=>c.id===wish.to)
    : state.contacts.slice();
  if(!pool.length){ wish.status='refused'; save(); return; }
  const order = wish.to&&wish.to!=='all' ? pool : pool.slice().sort(()=>Math.random()-0.5);
  const tryOne=(idx)=>{
    const c=order[idx];
    if(!c){ wish.status='refused'; save(); return; }
    if(Math.random()*100<40){
      wish.status='granted';
      state.cabinet.push({itemId:'__wish',text:wish.text,from:c.id,t:Date.now()});
      state.coins=Math.round(state.coins); save(); refreshCoins();
      pushChatMsg(c.id,'sys',`${c.name} 看到了你的愿望「${wish.text}」，悄悄为你实现了！礼物已存入回声匣`);
      setTimeout(()=>{ const card=drawCard('亲昵 · 情话',c.id)||drawCard(null,c.id); if(card)pushChatMsg(c.id,'ta',card,null,c.id); },3000);
      toast('ta 圆了你的愿望：'+wish.text);
    }else{
      pushChatMsg(c.id,'sys',`${c.name} 看到了你的愿望「${wish.text}」，暂时没有回应（也许在准备惊喜）`);
      setTimeout(()=>{ const card=drawCard('撒娇 · 粘人',c.id)||drawCard(null,c.id); if(card)pushChatMsg(c.id,'ta',card,null,c.id); },2500);
      if(idx+1<order.length){ setTimeout(()=>tryOne(idx+1),randInt(8000,20000)); return; }
      wish.status='refused';
    }
    save();
    if(currentApp==='market')renderMarket($('appBody'),$('appExtra'));
  };
  tryOne(0);
}
/* 聊天「更多 → 许愿」弹窗：v2.19.0 可选择向谁许愿（某人 / 全部人） */
function openWishModal(){
  const mask=openModal('许个愿',`
    <div class="field"><label>向谁许愿</label>
      <select id="wishTo">
        <option value="all">全部人（谁愿意谁实现）</option>
        ${state.contacts.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label>你想要什么？（ta 会看到，并决定送或不送）</label>
      <input id="wishInput" maxlength="30" placeholder="例如：一杯奶茶 / 一起看日落"></div>
    ${state.wishes.slice(0,3).map(w=>`<div style="font-size:12px;color:var(--ink-2);padding:5px 0;border-bottom:1px solid var(--line)">
      ${w.status==='granted'?I('gift',13):w.status==='refused'?I('bubble',13):I('clock',13)} ${escapeHtml(w.text)}${w.to&&w.to!=='all'?` · 向${escapeHtml(contactName(w.to))}`:' · 向全部人'}</div>`).join('')}
    <div class="desc" style="margin-top:10px">全部心愿可在「闲屿小集 → 心愿」查看</div>`,()=>{
    const to=mask.querySelector('#wishTo').value;
    return addWish(mask.querySelector('#wishInput').value,to);
  });
  setTimeout(()=>{ const i=mask.querySelector('#wishInput'); if(i)i.focus({preventScroll:true}); },80);
}

/* ================= 问卷 ================= */
let surveyTab='ask';
function renderSurvey(body,extra){
  function draw(){
    let inner='';
    /* v2.22.0：问卷支持选「向谁提问」/「谁来向我提问」 */
    const whoSelect=(id,cur)=>{
      if(!state.contacts.length)return '<div class="desc" style="color:var(--ink-3)">还没有联系人，先去聊天页添加</div>';
      return `<div class="field" style="margin-bottom:10px"><label>${id==='qAskWho'?'向谁提问':'谁来向我提问'}</label>
        <select id="${id}">${state.contacts.map(c=>`<option value="${c.id}" ${cur===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>`;
    };
    if(surveyTab==='ask'){
      const q=state.curQ&&state.curQ.q?state.curQ:null;
      const who=(q&&q.who)||(state.contacts[0]?state.contacts[0].id:'');
      inner=`<div class="q-card">
        ${whoSelect('qAskWho',who)}
        ${q?`<div class="q">${escapeHtml(q.q)}</div>
          ${q.a?`<div class="desc">${q.who?escapeHtml(contactName(q.who))+' 的回答':'对方的回答'}：${escapeHtml(q.a)}</div>`
          :`<button class="btn block" id="qAskBtn">让 ta 回答</button>`}`
        :`<div class="desc" style="text-align:center;padding:10px 0">抽一个问题问问 ta 吧</div>`}
        <div class="field" style="margin-top:12px;margin-bottom:0">
          <label>换问题的方式</label>
          <select id="qPickMode">
            <option value="rand">随机抽一个题库里的问题</option>
            <option value="pick">自己从题库里挑一个</option>
            <option value="self">自己写一个问题</option>
          </select>
        </div>
        <div id="qPickBox" class="hide" style="margin-top:10px">
          <div class="field hide" id="qPickBankBox" style="margin-bottom:0">
            <label>从题库挑（点一条选中）</label>
            <div class="qbank-list" id="qPickBank">
              ${state.survey.bank.length?state.survey.bank.map((q,i)=>`<div class="qbank-item ${i===0?'on':''}" data-qb="${i}">${escapeHtml(q)}</div>`).join(''):'<div class="qbank-item">（题库是空的）</div>'}
            </div>
          </div>
          <div class="field hide" id="qSelfBox" style="margin-bottom:0">
            <label>我自己的问题</label>
            <input id="qSelfInput" placeholder="写下你想问 ta 的问题…" maxlength="60">
          </div>
        </div>
        <button class="btn ghost block" id="qNew" style="margin-top:10px">${I('dice',15)} 换一个问题</button>
      </div>`;
    }else if(surveyTab==='answer'){
      const q2=state.curQ2||null;
      const qtxt=q2?(typeof q2==='string'?q2:q2.q):null;
      const asker=(q2&&q2.who)||(state.contacts[0]?state.contacts[0].id:'');
      inner=`<div class="q-card">
        ${whoSelect('qAskMeWho',asker)}
        ${qtxt?`<div class="q">${escapeHtml(qtxt)}</div>
          ${asker?`<div class="desc" style="margin-bottom:10px">—— ${escapeHtml(contactName(asker))} 问你</div>`:''}
          <div class="field"><textarea id="qAns" style="min-height:70px" placeholder="写下你的回答…"></textarea></div>
          <button class="btn block" id="qAnsBtn">提交回答</button>`
        :`<div class="desc" style="text-align:center;padding:10px 0">点下方按钮，让选中的 ta 随机问你一个问题</div>`}
        <button class="btn ghost block" id="qNew2" style="margin-top:10px">${I('dice',15)} 让 ta 问我</button>
      </div>`;
    }else if(surveyTab==='bank'){
      inner=`<div class="card">
        <div class="title">${I('plus',15)} 批量添加问题</div>
        <div class="desc">每行一个问题，可以是你想问 ta 的，也可以是 ta 可以问你的</div>
        <div class="field" style="margin-top:10px"><textarea id="qBankInput" placeholder="问题一&#10;问题二"></textarea></div>
        <button class="btn block" id="qBankAdd">添加到题库</button>
      </div>
      <div class="card">
        <div class="title">题库 <span class="count">${state.survey.bank.length}</span></div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          ${state.survey.bank.map((q,i)=>`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px"><span>${escapeHtml(q)}</span><span class="delx" data-qdel="${i}">✕</span></div>`).join('')||'<div class="empty">题库是空的</div>'}
        </div>
      </div>`;
    }else{
      /* v2.24.0：记录可删除（✕），按原索引删，避免排序后错位 */
      const recs=state.survey.records.map((r,i)=>({r,i})).sort((a,b)=>b.r.t-a.r.t);
      inner=recs.map(({r,i})=>{
        const nm=r.who?escapeHtml(contactName(r.who)):'ta';
        const tag=r.by==='ta'?`${I('bubble',13)} ${nm} 答`:`${I('pen',13)} 我答${r.who?`（${nm} 问）`:''}`;
        return `
        <div class="q-card" style="position:relative">
          <div class="q" style="margin-bottom:6px;font-size:14px;padding-right:26px">${escapeHtml(r.q)}</div>
          <div style="font-size:13px;color:var(--ink-2);line-height:1.6">${tag}：${escapeHtml(r.a||'（未回答）')}</div>
          <div class="count" style="margin-top:6px">${fmtDate(r.t)}</div>
          <span class="delx" data-qrdel="${i}" title="删除这条记录" style="position:absolute;top:10px;right:10px">✕</span>
        </div>`;}).join('')||'<div class="empty">还没有问答记录</div>';
    }
    body.innerHTML=`
      <div class="seg">
        ${['ask','answer','bank','records'].map((t,i)=>`<button class="${surveyTab===t?'on':''}" data-tab="${t}">${['我问ta','ta问我','题库','记录'][i]}</button>`).join('')}
      </div>${inner}`;
    body.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>{ surveyTab=el.dataset.tab; draw(); }));
    const pickWho=selId=>{ const el=$(selId); return el?el.value:''; };
    const qn=$('qNew');
    /* v2.23.0：换问题支持 随机 / 自选题库 / 自己写 三种方式 */
    const pickModeSel=$('qPickMode');
    function syncPickMode(){
      const box=$('qPickBox'), bankBox=$('qPickBankBox'), selfBox=$('qSelfBox');
      if(!box)return;
      const mode=pickModeSel?pickModeSel.value:'rand';
      box.classList.toggle('hide',mode==='rand');
      if(bankBox)bankBox.classList.toggle('hide',mode!=='pick');
      if(selfBox)selfBox.classList.toggle('hide',mode!=='self');
    }
    if(pickModeSel){
      /* v2.24.0：题库改为自定义列表（原生下拉字大色丑），点选高亮 */
      body.querySelectorAll('#qPickBank .qbank-item[data-qb]').forEach(el=>el.addEventListener('click',()=>{
        body.querySelectorAll('#qPickBank .qbank-item').forEach(x=>x.classList.remove('on'));
        el.classList.add('on');
      }));
      pickModeSel.addEventListener('change',syncPickMode);
      syncPickMode();
    }
    if(qn)qn.addEventListener('click',()=>{
      if(!state.contacts.length)return toast('先添加联系人');
      const mode=pickModeSel?pickModeSel.value:'rand';
      let qtext='';
      if(mode==='self'){
        qtext=($('qSelfInput')?$('qSelfInput').value.trim():'');
        if(!qtext)return toast('先写下你的问题');
      }else if(mode==='pick'){
        const on=body.querySelector('#qPickBank .qbank-item.on[data-qb]');
        if(!on||!state.survey.bank.length)return toast('题库是空的，先去题库添加');
        qtext=state.survey.bank[+on.dataset.qb];
      }else{
        if(!state.survey.bank.length)return toast('题库是空的，先去题库添加');
        qtext=pick(state.survey.bank);
      }
      state.curQ={q:qtext,a:null,who:pickWho('qAskWho')||state.contacts[0].id};
      save(); draw();
    });
    const qa=$('qAskBtn');
    if(qa)qa.addEventListener('click',()=>{
      if($('qAskWho'))state.curQ.who=$('qAskWho').value;
      const who=state.curQ.who||(state.contacts[0]&&state.contacts[0].id);
      qa.disabled=true; qa.textContent='对方思考中…';
      setTimeout(()=>{
        /* ta 有 35% 概率回答，否则沉默（回答从字卡库取，走 ta 的专用库加权） */
        if(Math.random()*100<35){
          state.curQ.a=drawCard(['回复','情绪','日常','亲昵 · 情话'],who)||drawCard(null,who);
          state.survey.records.push({q:state.curQ.q,a:state.curQ.a,by:'ta',who,t:Date.now()});
          toast((who?contactName(who):'ta')+' 回答了你的问题');
        }else{
          state.curQ.a='（ta 沉默了，没有回答…）';
          state.survey.records.push({q:state.curQ.q,a:'',by:'ta',who,t:Date.now()});
          toast('ta 这次没有回答');
        }
        save(); draw();
      },randInt(2000,5000));
    });
    const qn2=$('qNew2');
    if(qn2)qn2.addEventListener('click',()=>{
      if(!state.survey.bank.length)return toast('题库是空的，先去题库添加');
      if(!state.contacts.length)return toast('先添加联系人');
      state.curQ2={q:pick(state.survey.bank),who:pickWho('qAskMeWho')||state.contacts[0].id};
      save(); draw();
    });
    const qa2=$('qAnsBtn');
    if(qa2)qa2.addEventListener('click',()=>{
      const a=$('qAns').value.trim();
      if(!a)return toast('先写下回答');
      const q2=state.curQ2||{};
      state.survey.records.push({q:(typeof q2==='string'?q2:q2.q),a,by:'me',who:q2.who||pickWho('qAskMeWho')||'',t:Date.now()});
      state.curQ2=null; save(); draw(); toast('已记录');
    });
    const qba=$('qBankAdd');
    if(qba)qba.addEventListener('click',()=>{
      const lines=$('qBankInput').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      let added=0;
      lines.forEach(l=>{ if(!state.survey.bank.includes(l)){state.survey.bank.push(l);added++;} });
      $('qBankInput').value=''; save(); draw();
      toast(added?`已添加 ${added} 个问题`:'没有新增问题');
    });
    body.querySelectorAll('[data-qdel]').forEach(el=>el.addEventListener('click',()=>{
      state.survey.bank.splice(+el.dataset.qdel,1); save(); draw();
    }));
    /* v2.24.0：问答记录可删除 */
    body.querySelectorAll('[data-qrdel]').forEach(el=>el.addEventListener('click',()=>{
      state.survey.records.splice(+el.dataset.qrdel,1); save(); draw(); toast('已删除这条记录');
    }));
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 灯塔（v2.24.17 由「寻踪」改名，文案同步换灯塔语系） ================= */
function renderTrack(body,extra){
  function draw(){
    body.innerHTML=`
      <div class="card" style="text-align:center">
        <div class="title">灯塔</div>
        <div class="desc" style="margin-bottom:6px">点亮灯塔扫过海面，随机感知 ta 此刻是否在你身边</div>
        <div class="field" style="margin-top:10px"><select id="trackWho">${state.contacts.map(c=>`<option value="${c.id}" ${state.lastTrack&&state.lastTrack.who===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
        <div class="tracking-ring" id="trackRing">
          <div class="val" id="trackVal">${state.lastTrack?(''+state.lastTrack.pct+'%'):'--'}</div>
          <div class="lab" id="trackLab">${state.lastTrack?(state.lastTrack.at?'ta 在你的光圈里':'光圈里没有 ta'):'灯塔待机中'}</div>
        </div>
        <div id="trackResult" style="font-weight:800;min-height:24px">${state.lastTrack?(state.lastTrack.at?`${I('heart',14)} ${escapeHtml(state.lastTrack.name)} 就在你身边！距离约 ${state.lastTrack.dist}`:`对方不在身边，距离约 ${state.lastTrack.dist}`):''}</div>
        <button class="btn block" id="trackBtn" style="margin-top:12px">开始扫描</button>
      </div>
      <div class="section-label">扫描记录</div>
      ${state.tracking.slice(0,10).map(t=>`<div class="card" style="padding:10px 16px;display:flex;justify-content:space-between;font-size:13px">
        <span style="display:inline-flex;align-items:center;gap:4px">${I(t.at?'heart':'track',13)} ${escapeHtml(t.name)} ${t.at?'在身边':'不在身边'}</span><span class="count">${fmtDate(t.t)}</span></div>`).join('')||'<div class="empty">还没有记录</div>'}`;
    $('trackBtn').addEventListener('click',()=>{
      if(!state.contacts.length)return toast('先添加联系人');
      const btn=$('trackBtn'); btn.disabled=true;
      const who=$('trackWho').value;
      /* v2.24.0：记住本次选的联系人，感知结束后不重置回第一个 */
      if(state.lastTrack)state.lastTrack.who=who;
      else state.lastTrack={who};
      const ring=$('trackRing');
      let pct=0;
      const iv=setInterval(()=>{
        if(!document.body.contains(ring)){ clearInterval(iv); return; } // 已离开页面
        pct+=randInt(4,12);
        if(pct>=100){
          pct=100; clearInterval(iv);
          const name=contactName(who);
          const at=Math.random()<0.38;
          const dist=at?(rand(0.1,3).toFixed(1)+' 米'):(rand(1,2000).toFixed(0)+' 公里');
          state.lastTrack={at,dist,name,pct:randInt(60,99),who};   /* v2.24.0：带上 who，重绘后 select 仍选中 ta */
          state.tracking.unshift({name,at,dist,t:Date.now()});
          if(state.tracking.length>30)state.tracking.length=30;
          save(); btn.disabled=false; draw();
          toast(at?'灯塔照到了！ta 就在你身边':'这片海面没有 ta 的影子');
        }else{
          if(!$('trackVal')){ clearInterval(iv); return; }
          $('trackVal').textContent=pct+'%';
          $('trackLab').textContent='扫描中…';
          ring.style.background=`conic-gradient(var(--accent) ${pct*3.6}deg,#e8e8ec ${pct*3.6}deg)`;
        }
      },90);
      ring.style.background=`conic-gradient(var(--accent) 0deg,#e8e8ec 0deg)`;
    });
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 音乐 · 一起听（v2.23.0） =================
   两种用法：
   ① 桌面「音乐」应用：粘贴网易云链接 / 歌曲 ID 导入自己的歌单，点歌即播（官方外链播放器）。
   ② 单人聊天页 → 更多互动 → 一起听：邀请当前联系人同听一首歌，
      聊天输入栏上方出现「一起听」横幅，切歌会同步给 ta，ta 也会回字卡。 */
let muAddOpen=false;      /* 导入区是否展开（默认收起，界面更干净） */
let muSel=-1;             /* 当前选中/播放的歌曲下标 */
let listenSync=null;      /* 切歌同步定时器句柄 */
/* v2.24.14：续播定时器降级为**兜底**。
   旧版（v2.24.5）因为拿不到 iframe 的 ended 回调，只能「按时长模拟」播完切歌；
   现在换了 <audio>，真 ended 事件可靠，主路径由 muBindAudio 的 ended 处理。
   这里保留的定时器只防一种情况：audio 被浏览器拦/卡死导致 ended 永不触发。
   所以它按「时长 + 6 秒缓冲」排队，正常播完时 ended 会先把它 clear 掉。 */
let muAutoTimer=null;
const MU_DEFAULT_LEN=210;  /* 未知时长按 3.5 分钟估算 */
const MU_MIN_LEN=20;       /* 最短按 20 秒，避免导入异常数据后立刻狂切歌 */
const MU_STALL_GRACE=6000; /* 兜底缓冲：比真实时长多等 6 秒 */

/* 当前曲目时长（秒）。优先用 audio 实测时长；没测到就退回记录值/估值 */
function muTrackLen(i){
  const a=document.getElementById('muAudio');
  if(i===(state.music&&state.music.cur)&&a&&isFinite(a.duration)&&a.duration>0)return a.duration;
  const t=muTrackAt(i);
  const n=t&&+t.len;
  return (n&&isFinite(n)&&n>0)?Math.max(MU_MIN_LEN,n):MU_DEFAULT_LEN;
}
/* 排定「播完自动下一首」。暂停/结束/切歌时先 clearMuAuto 再按需重排 */
function clearMuAuto(){ if(muAutoTimer){ clearTimeout(muAutoTimer); muAutoTimer=null; } }
function scheduleMuAuto(){
  clearMuAuto();
  const m=state.music;
  if(!m||!m.playing||m.cur==null)return;
  if(!m.tracks||m.tracks.length<2)return;      /* 只有一首就没必要续播 */
  const ms=muTrackLen(m.cur)*1000+MU_STALL_GRACE;
  muAutoTimer=setTimeout(()=>{
    muAutoTimer=null;
    const s=state.music;
    if(!s||!s.playing||s.cur==null)return;
    if(!s.tracks.length)return;
    /* 已经播完/停了就别再切（ended 抢先处理过就轮到这判断兜住） */
    const a=document.getElementById('muAudio');
    if(a&&a.ended)return;
    /* 顺序播到底再回头 —— 歌单循环 */
    const next=(s.cur+1)%s.tracks.length;
    muPlay(next,!!(state.listen&&state.listen.with));
  },ms);
}
/* v2.24.7：全局播放器升级成「可拖动的迷你悬浮窗」。
   —— 一次解决两个反馈：
   ①用户要「一起听开启后有个可随意拖动的悬浮小播放器」；
   ②「退出当前联系人界面时音乐会卡一下、然后从头播」。
   ②的病根：旧版 syncListenBar 把装着 iframe 的 #muHost 用 appendChild 在
   「聊天横幅」和「#phone」之间来回搬运 —— DOM 里移动一个 iframe 节点 = 卸载+重建，
   于是必然「卡顿一下 + 从头播」。
   现在的做法：**iframe 终身不动**，一直住在悬浮窗 #muFloat 里；
   进出聊天页只改悬浮窗的 CSS（显隐 / 停靠位置），从不搬动节点 → 绝不重载、绝不重头播。
   一起听横幅退化成一条纯文字信息条，不再承载播放器。 */
function muHost(){
  let h=document.getElementById('muHost');
  if(!h){
    h=document.createElement('div');
    h.id='muHost';
    (document.getElementById('phone')||document.body).appendChild(h);
  }
  return h;
}
/* 悬浮小窗外壳（常驻 #phone，跟随桌面/所有页面） */
function muFloat(){
  let f=document.getElementById('muFloat');
  if(!f){
    f=document.createElement('div');
    f.id='muFloat'; f.className='hide';
    (document.getElementById('phone')||document.body).appendChild(f);
    bindMuFloatDrag(f);
  }
  return f;
}
/* 拖动悬浮窗：小圆 / 面板空白处都能拖，位置写进 state.muPos 持久化。
   v2.24.14 适配小圆：因为整颗圆既是「点击展开」又是「拖动」，所以用 muFloatDragged
   区分「轻点」与「拖走」—— 位移超过 4px 才算拖，松手后 30ms 内忽略 click。 */
let muFloatDragged=false;
function bindMuFloatDrag(f){
  let drag=null;
  f.addEventListener('pointerdown',e=>{
    /* 面板里的按钮 / 进度条 / 音频节点上的手势不参与拖动 */
    if(e.target.closest('button')||e.target.closest('[data-mubar]')||e.target.closest('#muHost'))return;
    if(e.button!==undefined&&e.button!==0)return;
    drag={sx:e.clientX,sy:e.clientY,ox:f.offsetLeft,oy:f.offsetTop};
    try{ f.setPointerCapture(e.pointerId); }catch(err){}
    const r=f.getBoundingClientRect();
    f.style.right='auto'; f.style.bottom='auto';
    f.style.left=r.left+'px'; f.style.top=r.top+'px';
    e.preventDefault();
  });
  f.addEventListener('pointermove',e=>{
    if(!drag)return;
    const dx=e.clientX-drag.sx, dy=e.clientY-drag.sy;
    if(!muFloatDragged&&Math.abs(dx)<4&&Math.abs(dy)<4)return;
    muFloatDragged=true;
    f.classList.add('dragging');
    const phone=(document.getElementById('phone')||document.body).getBoundingClientRect();
    const w=f.offsetWidth||52, hgt=f.offsetHeight||52;
    const nx=Math.min(Math.max(4,drag.ox+dx),Math.max(4,phone.width-w-4));
    const ny=Math.min(Math.max(4,drag.oy+dy),Math.max(4,phone.height-hgt-4));
    f.style.left=nx+'px'; f.style.top=ny+'px';
  });
  const drop=()=>{
    if(drag&&muFloatDragged){
      state.muPos={x:f.offsetLeft,y:f.offsetTop}; save();
    }
    drag=null; f.classList.remove('dragging');
    setTimeout(()=>{ muFloatDragged=false; },30);
  };
  f.addEventListener('pointerup',drop);
  f.addEventListener('pointercancel',drop);
}
/* v2.24.14：播放内核从「网易云官方外链 iframe」换成「站内直连 <audio>」。
   —— 为什么非换不可，三条实测结论：
   ①官方外链页 music.163.com/outchain/player?... 返回的 HTML 里**根本没有歌曲数据**
     （grep 不到歌曲 id），数据靠页面内 JS 二次请求拉 —— 在 iframe 里既取不到也无法控制，
     所以旧版「面板空白、点了不出声」。
   ②网易云接口 api/song/enhance/player/url 对 VIP 歌返回 code:-110 / url:null（版权限制，无解）；
     对可播的歌返回 code:200 + 真实 mp3 地址（m801.music.126.net/...），且该地址**无 Referer 防盗链**，
     可以直接喂给 <audio> 播 —— 这就是本版走的新路。
   ③换来的是「真实播放状态」：进度条、时长、真正的 ended 续播，全部可控可测。
   付费/无版权的歌：给一句明确提示（不然用户只会觉得「又坏了」），然后自动跳到下一首可播的。 */

/* 歌曲元信息（歌名/歌手）—— 导入时若用户没填名字，用官方 detail 接口补齐
   v2.24.15：同样走多镜像，失败就安静放弃（歌名是锦上添花，不该拖累导入） */
function muFetchDetail(ncId){
  const q='c='+encodeURIComponent('[{"id":'+ncId+'}]');
  return muApiJson('v3/song/detail',q).then(j=>{
    const s=j&&j.songs&&j.songs[0];
    if(!s)return null;
    const ar=s.ar||s.artists||[];
    return {name:s.name||'',artist:(ar[0]&&ar[0].name)||''};
  }).catch(()=>null);
}
/* 取可播流地址。成功 → {url,via}；受限 → {blocked:true,msg}。
   v2.24.16 ⚠️ 三级取源链（前两版都栽在「纯浏览器里官方接口被 CORS 拦」上）：
     ① official 官方接口三镜像 —— 信息最全（能区分会员/试听），但**不返回 CORS 头**，
        纯浏览器里必挂（curl 能通是假象）；
     ② gd GD 音乐台公共接口 —— 实测 access-control-allow-origin:*，浏览器里真正能通的接口；
     ③ outer 媒体直链兜底 —— <audio> 播媒体不走 CORS，302 跳转浏览器自己跟。
     成功的通道记进 muChanPref，下一首优先走它。 */
const MU_API_HOSTS=[
  'https://music.163.com',
  'https://interface3.music.163.com',
  'https://interface.music.163.com',
];
let muApiHostIdx=0;
function muApiUrl(path,query){
  const h=MU_API_HOSTS[muApiHostIdx%MU_API_HOSTS.length];
  return h+'/api/'+path+(query?'?'+query:'');
}
/* 带超时的 fetch —— 弱网下"一直转圈"比"明确失败"更让人难受，8 秒没响应就换镜像 */
function muFetchWithTimeout(url,ms){
  return new Promise((resolve,reject)=>{
    let done=false;
    const t=setTimeout(()=>{ if(!done){ done=true; reject({net:true,msg:'timeout'}); } },ms||8000);
    fetch(url,{cache:'no-store',mode:'cors',credentials:'omit'}).then(r=>{
      if(done)return; done=true; clearTimeout(t); resolve(r);
    }).catch(err=>{ if(done)return; done=true; clearTimeout(t); reject({net:true,msg:String(err&&err.message||err)}); });
  });
}
/* 轮询所有镜像，任一返回可解析 JSON 即成功 */
function muApiJson(path,query){
  const tries=MU_API_HOSTS.length;
  const step=(n)=>{
    if(n<=0)return Promise.reject({net:true,msg:'all-hosts-failed'});
    return muFetchWithTimeout(muApiUrl(path,query)).then(r=>r.json()).catch(err=>{
      muApiHostIdx++;                    /* 换下一个镜像再试 */
      if(n-1<=0)throw err;
      return step(n-1);
    });
  };
  return step(tries);
}
/* 换镜像后把前面的失败记录清掉 —— 否则一次抖动会让整份歌单被误判为「都放不了」 */
function muResetNetState(){
  muNetFailAt=0;
  MU_API_HOSTS.forEach(()=>{ muApiHostIdx++; });   /* 轮换一次起点 */
}
/* ⚠️ v2.24.15b 关键修复：把 http 直链升级成 https。
   —— 这才是「音乐一直放不了、只提示网络不太顺」的真正病根。
   实测：网易云接口对可播的歌返回的是 **http://** 直链（m801/m10.music.126.net/...），
   而本站三通道全是 https。https 页面加载 http 媒体 = 混合内容（mixed content），
   浏览器**直接拦掉、连请求都不发**，<audio> 立刻触发 error 事件 →
   代码只能把这次失败归类成「网络不通」，于是用户看到的就是「网络不太顺」，
   而且怎么点都放不出来（因为根因不是网速，是协议）。
   好消息：同一台 CDN 用 https 完全可达（实测 200 + 完整 mp3），
   所以这里只要把协议头换掉即可，其余路径 / 查询串（vuutv 签名）原样保留。 */
function muHttpsUrl(u){
  if(typeof u!=='string'||!u)return u;
  if(u.indexOf('http://')!==0)return u;        /* 已经是 https（或其它协议）→ 不动 */
  return 'https://'+u.slice(7);
}
/* 上一首是哪条通道取成功的（'' = 还没试过；每次成功后更新，下一首优先走它） */
let muChanPref='';
/* ① 官方接口（三镜像）—— 信息最全（能准确区分「要会员」和「仅试听」）。
   ⚠️ v2.24.16 实锤：网易云三个镜像都**不返回 CORS 跨域头**，纯浏览器里这一步
   fetch 会被 CORS 直接拦掉（curl 不受此限 —— 桌面 curl 实测一直是通的，
   真浏览器却「接口没响应」，这就是 v2.24.15 修完混合内容还是播不了的真正原因）。 */
function muOfficialFetchUrl(ncId){
  const q='ids='+encodeURIComponent('['+ncId+']')+'&br=128000';
  return muApiJson('song/enhance/player/url',q).then(j=>{
    const d=j&&j.data&&j.data[0];
    if(d&&d.url)return {url:muHttpsUrl(d.url),size:d.size||0,via:'official'};
    /* 接口通了、但没给地址 —— 这才是真的版权受限（VIP / 仅试听） */
    return {blocked:true,msg:(d&&d.freeTrialInfo)?'这首歌只能试听片段，本站放不了':'这首歌需要网易云会员，本站播不了'};
  });
}
function muFetchUrl(ncId){
  /* 三级取源链：官方接口 → GD 台（CORS 开放）→ outer/url 媒体直链。
     哪条通过，就记住它（muChanPref），下一首直接先走它 —— 不再每次都先撞一遍必挂的通道。 */
  const provs=[
    {via:'official', f:()=>muOfficialFetchUrl(ncId)},
    {via:'gd',       f:()=>muGdFetchUrl(ncId)},
    {via:'outer',    f:()=>Promise.resolve({url:muOuterUrl(ncId),size:0,via:'outer'})}
  ];
  if(muChanPref){
    const i=provs.findIndex(p=>p.via===muChanPref);
    if(i>0){ const p=provs.splice(i,1)[0]; provs.unshift(p); }
  }
  const step=(n)=>{
    const p=provs[provs.length-n];
    return p.f().then(res=>{
      if(res&&res.via)muChanPref=res.via;
      return res;
    }).catch(err=>{
      if(n<=1)throw err;
      return step(n-1);
    });
  };
  return step(provs.length);
}
/* ② GD 音乐台公共接口 —— 唯一实测带 access-control-allow-origin:* 的取源通道，
   直接返回 https 直链。浏览器里真正干活的接口通道（2026-10-01 实测 200 + 直链）。 */
const MU_GD_API='https://music-api.gdstudio.xyz/api.php';
function muGdFetchUrl(ncId){
  const q='types=url&source=netease&id='+encodeURIComponent(ncId)+'&br=320';
  return muFetchWithTimeout(MU_GD_API+'?'+q).then(r=>{
    if(!r.ok)throw {net:true,msg:'gd HTTP '+r.status};
    return r.json();
  }).then(j=>{
    if(j&&j.url)return {url:muHttpsUrl(j.url),size:j.size||0,via:'gd'};
    throw {net:true,msg:'gd no-url'};
  });
}
/* ③ 媒体直链兜底 —— <audio> 播放媒体**不走 CORS**，直接交给这个地址，
   浏览器自动跟随 302 跳到真实 mp3（Chromium 系还会把跳转目标 http 自动升级成 https）。
   2026-10-01 实测：带本站 Referer 也 302，最终 200 + 完整 mp3。
   局限：拿不到大小、无法预判 VIP（VIP 歌会跳到占位音频，由 error/换下一首兜底）。
   它是「接口全挂」时的最后一条路 —— 宁可试播，不要无声。 */
function muOuterUrl(ncId){
  return 'https://music.163.com/song/media/outer/url?id='+ncId+'.mp3';
}

/* 音频节点：常驻 #muHost，**终身不动**（换源只改 src，不重建节点） */
function muAudio(){
  let a=document.getElementById('muAudio');
  if(!a){
    const h=muHost();
    a=document.createElement('audio');
    a.id='muAudio'; a.preload='auto'; a.setAttribute('playsinline','');
    h.appendChild(a);
    muBindAudio(a);
  }
  return a;
}
/* 把 audio 的真实状态同步回 UI 与 state —— 进度条/时长/自然播完全都靠它 */
function muBindAudio(a){
  a.addEventListener('timeupdate',()=>{ muTickProgress(); });
  a.addEventListener('loadedmetadata',()=>{
    const m=state.music;
    if(m&&m.cur!=null&&a.duration&&isFinite(a.duration)){
      const t=m.tracks[m.cur];
      if(t&&Math.abs((+t.len||0)-a.duration)>1){ t.len=Math.round(a.duration); save(); }
    }
    muTickProgress();
  });
  a.addEventListener('playing',()=>{ muSetLoadUI(false); });
  a.addEventListener('waiting',()=>{ muSetLoadUI(true); });
  a.addEventListener('canplay',()=>{ muSetLoadUI(false); });
  /* 真正播完 → 顺序下一首（这才是真 ended，替掉旧版「按时长模拟」的软续播） */
  a.addEventListener('ended',()=>{
    const m=state.music;
    if(!m||!m.playing)return;
    clearMuAuto();
    if(m.tracks&&m.tracks.length>1)muPlay((m.cur+1)%m.tracks.length,!!(state.listen&&state.listen.with));
    else{ m.playing=false; save(); muSyncUI(); }
  });
  a.addEventListener('error',()=>{
    /* 流地址失效（网易云换链/限流/防盗链）→ 先原地重取一次直链，再不行才换下一首。
       v2.24.15b：旧版这里直接"换下一首"，于是「地址本身有问题」被表现成
       「歌单里每一首都放不了，一路换到底」—— 现在多给一次机会（重取直链）。*/
    const m=state.music;
    if(!m||!m.playing)return;
    muSetLoadUI(false);
    const key=m.cur!=null&&m.tracks[m.cur]?m.tracks[m.cur].ncId:'';
    if(key&&(muNetRetry[key]||0)<MU_NET_RETRY){
      muNetRetry[key]=(muNetRetry[key]||0)+1;
      toast('这首歌的地址取不到，正在换一个地址重试…');
      setTimeout(()=>{ if(state.music===m&&m.playing)muLoad(true); },600);
      return;
    }
    muErrSet[key]='net';
    if(m.tracks&&m.tracks.length>1){
      const next=(m.cur+1)%m.tracks.length;
      toast('这首暂时放不出来，换下一首');
      muPlay(next,false);
    }else{ m.playing=false; save(); muSyncUI(); }
  });
}
/* 播放进度写进 UI（浮窗进度条 + 音乐页进度条），每 250ms 由 timeupdate 驱动 */
function muTickProgress(){
  muProgCache=muProgress();
  const p=muProgCache;
  document.querySelectorAll('[data-muprog]').forEach(el=>{
    el.style.width=(p.pct*100).toFixed(2)+'%';
  });
  document.querySelectorAll('[data-mutime]').forEach(el=>{
    el.textContent=p.cur+' / '+p.dur;
  });
}
let muProgCache={pct:0,cur:'0:00',dur:'0:00'};
function muFmtSec(s){
  s=Math.max(0,Math.floor(s||0));
  const m=Math.floor(s/60), r=s%60;
  return m+':'+(r<10?'0':'')+r;
}
function muProgress(){
  const a=document.getElementById('muAudio');
  const dur=(a&&isFinite(a.duration)&&a.duration>0)?a.duration:0;
  const cur=(a&&isFinite(a.currentTime))?a.currentTime:0;
  return {pct:dur?Math.min(1,cur/dur):0,cur:muFmtSec(cur),dur:dur?muFmtSec(dur):'--:--'};
}
/* 加载态开关（小圆转圈 + 面板输入禁用），一处改两处生效 */
function muSetLoadUI(on){
  muLoading=!!on;
  const f=document.getElementById('muFloat');
  if(f)f.classList.toggle('loading',muLoading);
}
let muLoading=false;
let muAudioSrcKey='';   /* 当前已装载的曲目 key，避免同曲重复换源 */
/* 统一装载：暂停/无歌 → 停掉 audio；在播 → 取直链换源并 play()。
   铁律：**只在「曲目真的变了」或强制 reroll 时换 src**，其它情况原地不动。
   （这条保证切页面、进聊天、收起浮窗都不会让歌从头发声） */
let muLoadedKey='';
function muLoad(reroll){
  const m=state.music;
  /* v2.24.19：暂停/无歌时改走 muPauseAudio —— 保留 src 与进度，别一有风吹草动就把歌打回开头 */
  if(!m||!m.playing||m.cur==null)return muPauseAudio();
  const t=m.tracks[m.cur]; if(!t)return muStopAudio();
  if(!t.ncId)return muStopAudio();
  muSessionPlayed=true;   /* v2.24.17：本次开站真的开始播了 → 浮窗此后才允许自动出现 */
  muRenderFloat();     /* 每次装载都保证浮窗存在（首次播放时它还没被创建） */
  const key=t.ncId;
  if(!reroll && key===muLoadedKey && muAudioSrcKey===key){
    const a=document.getElementById('muAudio');
    if(a&&a.paused){ clearMuAuto(); a.play().catch(()=>{}); }
    return;
  }
  muLoadedKey=key;
  const token=++muLoadToken;
  const a=muAudio();
  muSetLoadUI(true);
  muFetchUrl(t.ncId).then(res=>{
    if(token!==muLoadToken)return;                 /* 已被更新的请求取代 → 丢弃 */
    muNetRetry[key]=0;                             /* 取到地址 → 清掉这首歌的重试计数 */
    if(res.blocked){
      muSetLoadUI(false);
      muSrcBlocked(t.ncId);
      return;
    }
    muAudioSrcKey=key;
    a.src=res.url;
    a.volume=muVolume();
    const pr=a.play();
    /* v2.24.14：地址已就位 → 转圈就该停。
       不单靠 canplay/playing 事件（有些环境不触发/触发很晚，会造成「一直转圈」的假死观感）。 */
    muSetLoadUI(false);
    if(pr&&pr.catch)pr.catch(()=>{
      /* 浏览器自动播放策略：首次需一次用户交互。这里给一句提示，点一下即好 */
      muSetLoadUI(false);
      toast('浏览器拦了自动播放，点一下播放键就好');
    });
  }).catch(()=>{
    if(token!==muLoadToken)return;
    muSetLoadUI(false);
    /* v2.24.15 ⚠️ 重做：先把「网络不通」和「这首歌放不了」分开对待。
       弱网抖动非常常见，直接判死刑（旧版就是）会让用户觉得「这功能坏了」。
       新策略：同一首歌先**原地重试 1 次**（换镜像），仍然不通才往后走。
       muBlockedSet 只用来防「整份歌单全灭」时的无限换歌风暴，取到过一次就清掉。 */
    const tries=(muNetRetry[t.ncId]||0)+1;
    muNetRetry[t.ncId]=tries;
    if(tries<=MU_NET_RETRY){
      toast('网络有点慢，正在重试…');
      setTimeout(()=>{ if(token===muLoadToken)muLoad(true); },900);
      return;
    }
    muErrSet[t.ncId]='net';
    const now=Date.now();
    if(now-muNetFailAt<MU_NET_COOLDOWN){
      state.music.playing=false; save(); muSyncUI();
      toast('暂时取不到播放地址，先停一下。稍后再点播放试试');
      return;
    }
    muNetFailAt=now;
    muResetNetState();                    /* 换一批镜像，下次点播放就是新的起点 */
    const s=state.music;
    const rest=(s.tracks||[]).map((x,i)=>i).filter(i=>i!==s.cur&&!muBlockedSet[s.tracks[i].ncId]&&(muNetRetry[s.tracks[i].ncId]||0)<MU_NET_RETRY);
    if(rest.length){
      toast('这首取不到地址，换一首试试');
      muPlay(rest[0],false);
    }else{
      /* 整份歌单都没取到 —— 只可能是网络/接口问题，别把用户逼到"以为歌单坏了" */
      s.playing=false; save(); muSyncUI();
      toast('暂时取不到播放地址（网络或接口不稳），过一会儿再点播放就好');
    }
  });
}
let muNetFailAt=0;
const MU_NET_COOLDOWN=8000;   /* 8 秒内不重复自动换歌，防失败风暴 */
const MU_NET_RETRY=1;         /* v2.24.15：同一首歌网络失败后原地重试次数（换镜像） */
let muNetRetry={};            /* ncId → 已重试次数 */
let muLoadToken=1;
/* 这首放不了：明确提示 + 自动跳下一首可播的（可能是同一首被反复拒，用集合防死循环） */
let muBlockedSet={};
/* v2.24.15：把「为什么放不了」记下来，歌单列表里直接标出来 ——
   用户最烦的是「点了没反应，也不知道哪首能放」。 */
let muErrSet={};    /* ncId → 'vip' | 'net' */
function muSrcBlocked(ncId){
  const t=muCurTrack();
  const nm=t?t.name:'这首歌';
  muBlockedSet[ncId]=1;
  muNetRetry[ncId]=0;      /* 版权受限不是网络问题，别把重试次数也算上 */
  muErrSet[ncId]='vip';
  const m=state.music;
  const cand=(m.tracks||[]).map((x,i)=>i).filter(i=>!muBlockedSet[m.tracks[i].ncId]);
  if(cand.length){
    const i=cand.reduce((best,i)=>{
      const d=(i-(m.cur??0)+m.tracks.length)%m.tracks.length;
      const bd=(best-(m.cur??0)+m.tracks.length)%m.tracks.length;
      return d<bd?i:best;
    },cand[0]);
    toast('《'+nm+'》需要网易云会员，本站放不了，已跳到下一首');
    muPlay(i,false);
  }else{
    m.playing=false; save(); muSyncUI();
    toast('歌单里的歌都要网易云会员，本站播不了。换一首免费的试试～');
  }
}
/* v2.24.19：暂停专用 —— 只 pause，不摘 src、不清进度、不动 muLoadedKey。
   再按播放时 muLoad 走「同曲已装载」分支直接 a.play()，从暂停的位置继续。 */
function muPauseAudio(){
  const a=document.getElementById('muAudio');
  if(a){ try{ a.pause(); }catch(e){} }
  muSetLoadUI(false);
  muRenderFloat();
}
function muStopAudio(){
  const a=document.getElementById('muAudio');
  if(a){ try{ a.pause(); a.removeAttribute('src'); a.load(); }catch(e){} }
  muAudioSrcKey=''; muLoadedKey=''; muSetLoadUI(false);
  muProgCache={pct:0,cur:'0:00',dur:'0:00'};
  muRenderFloat();
}
/* 音量（持久化在 state.settings.muVolume，0~1） */
function muVolume(){
  const v=state.settings&&state.settings.muVolume;
  return (typeof v==='number'&&v>=0&&v<=1)?v:1;
}
function muSetVolume(v){
  v=Math.min(1,Math.max(0,v));
  state.settings.muVolume=v; save();
  const a=document.getElementById('muAudio');
  if(a)a.volume=v;
  document.querySelectorAll('[data-muvol]').forEach(el=>{ el.value=String(Math.round(v*100)); });
  document.querySelectorAll('[data-muvolpc]').forEach(el=>{ el.textContent=Math.round(v*100)+'%'; });
}
/* 浮窗 / 音乐页 / 桌面组件三处 UI 一起刷新 —— 状态变了就调它 */
function muSyncUI(){
  muRenderFloat();
  renderWidgets();
  if(currentApp==='music')renderMusic($('appBody'),$('appExtra'));
  /* v2.24.14：重绘会把进度条节点换成新的，必须重画一次进度，否则桌面组件进度条是空的 */
  muTickProgress();
}
/* v2.24.15：浮窗「手动隐藏」开关（只存内存，不落盘 —— 重进网站自动恢复，
   用户是「嫌它碍事想暂时收掉」，不是「永远不要」）。
   注意：只是隐藏浮窗，**播放器内核照常运行**，歌不会停。 */
let muFloatHidden=false;
let muSessionPlayed=false;   /* v2.24.17：本次开站是否真的播过 —— 浮窗只在播过之后才允许自动出现 */
function muHideFloat(silent){
  muFloatHidden=true;
  const f=document.getElementById('muFloat');
  if(f){ f.classList.add('hide'); f.classList.remove('expanded'); }
  if(!silent)toast('浮窗已关闭 · 音乐继续播放');
}
function muShowFloat(){
  muFloatHidden=false;
  muRenderFloat();
}
/* 悬浮窗内容 + 显隐：只要在播（或暂停但选中了歌）就露出
   v2.24.14：默认是 52px 小圆；点小圆展开控制面板。
   ⚠️ 关键：**绝不对 #muFloat 做整体 innerHTML 赋值** —— 整体重写会把 #muHost
     （装着 <audio> 的节点）一起销毁重建，那就是「卡一下又从头发声」的老毛病。
     所以这里按需复用：已有 .mu-mini/.mu-panel 就只更新内部文字与图标。 */
function muRenderFloat(){
  const f=muFloat();
  /* v2.24.15 ⚠️ 音频节点容器必须挂在 #phone 上，**不能挂在 #muFloat 里**。
     原因：「关掉浮窗」会把 #muFloat 设成 display:none，
     而 <audio> 一旦落进 display:none 的子树，部分浏览器会直接静音/暂停它
     —— 那就变成「关掉浮窗音乐也停了」，正是这一版要修掉的老毛病。
     放在 #phone 上（1px 不可见容器）则浮窗显隐完全不影响到发声。
     v2.24.17：必须放在**一切早退分支之前** —— 下面的显隐守卫会提前 return，
     若把挂载留在函数末尾，未播过歌时 muHost 永远不会被创建（A11 回归教训）。 */
  const h=muHost();
  const phone=document.getElementById('phone')||document.body;
  if(h.parentNode!==phone) phone.appendChild(h);
  const m=state.music;
  const has=!!(m&&m.cur!=null&&m.tracks&&m.cur<m.tracks.length);
  const playing=!!(m&&m.playing);
  /* v2.24.15：用户主动关掉的浮窗不要自己弹回来（除非重新播放/进音乐页显式唤出）
     v2.24.17：浮窗只在「真的在播」或「本次开站播过（现暂停）」时才出现 ——
     旧逻辑只要选过歌（state.music.cur 存进存档了）就显示，导致每次打开网站
     浮窗都自动糊脸。现在开站后必须等真正点播一次才露面；暂停后保持已显示；
     关过的依旧不弹回。 */
  if(!has||muFloatHidden||(!playing&&!muSessionPlayed)){ f.classList.add('hide'); f.classList.remove('expanded'); return; }
  const t=m.tracks[m.cur];
  f.classList.remove('hide');
  f.classList.toggle('paused',!playing);
  /* 停止播放时顺手收起展开面板 —— 面板是「正在放」的控制台，停了就没必要占着地方 */
  if(!playing)f.classList.remove('expanded');

  /* 小圆（首次创建后终身复用） */
  let mini=f.querySelector('.mu-mini');
  if(!mini){
    f.insertAdjacentHTML('afterbegin',`
      <div class="mu-mini" title="点开播放控制">
        <span class="ring"></span>
        <span class="disc">${I('music',17)}</span>
        <span class="eq"><i></i><i></i><i></i></span>
        <span class="x" data-fact="close" title="关掉悬浮小圆（音乐继续放）">${IC('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>')}</span>
      </div>
      <div class="mu-panel">
        <div class="mu-panel-hd">
          <span class="ico">${I('headset',15)}</span>
          <div class="tx">
            <div class="mu-float-name"></div>
            <div class="mu-float-sub"></div>
          </div>
          <button class="cls" data-fact="collapse" title="收成小圆（音乐不停）">${IC('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>')}</button>
        </div>
        <div class="mu-prog">
          <span class="tm" data-mutime>0:00 / --:--</span>
          <span class="bar" data-mubar><i data-muprog></i></span>
        </div>
        <div class="mu-float-ctl">
          <button class="mu-fb" data-fact="prev" title="上一首">${I('muPrev',15)}</button>
          <button class="mu-fb mu-fb-main" data-fact="toggle" title="播放/暂停">${I('muPause',17)}</button>
          <button class="mu-fb" data-fact="next" title="下一首">${I('muNext',15)}</button>
          <button class="mu-fb" data-fact="stop" title="停止播放">${I('stop',15)}</button>
        </div>
        <div class="mu-note">点小圆开合面板 · 拖小圆挪位置</div>
        <div class="mu-act">
          <button class="mu-mini-btn" data-fact="collapse">收成小圆</button>
          <button class="mu-close-btn" data-fact="close">关掉浮窗（音乐继续放）</button>
        </div>
      </div>`);
    mini=f.querySelector('.mu-mini');
    /* 点小圆：开合面板（**不是**关播放）。
       小圆右上角那个「x」是**真正关掉浮窗**的入口（见下方 data-fact="close"）。 */
    mini.addEventListener('click',e=>{
      if(muFloatDragged)return;
      if(e.target.closest('[data-fact]'))return;   /* 点到 x → 交给按钮逻辑 */
      e.stopPropagation();
      f.classList.toggle('expanded');
    });
    /* 面板里的按钮 */
    f.querySelectorAll('[data-fact]').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const act=b.dataset.fact;
      const mm=state.music;
      if(act==='toggle'){ muTogglePlay(true); return; }   /* true = 用户主动点 */
      /* v2.24.14：收起 = 只折叠面板，**音乐继续播** */
      if(act==='collapse'){ f.classList.remove('expanded'); return; }
      /* v2.24.15：真正「关掉浮窗」—— 浮窗消失，**音乐继续放**。
         进音乐页点任意一首、或点桌面播放器都会重新露出来。
         v2.24.15b：入口补全 —— 小圆右上角「x」+ 面板底部「关掉浮窗」，
         之前唯一入口藏在展开面板里，用户根本找不到。 */
      if(act==='close'){ muHideFloat(true); return; }
      /* 停止 = 收起面板 + 停播（保留曲目） */
      if(act==='stop'){ mm.playing=false; clearMuAuto(); muStopAudio(); f.classList.remove('expanded'); muSyncUI(); return; }
      if(!mm||!mm.tracks||!mm.tracks.length)return;
      const cur=mm.cur==null?0:mm.cur;
      if(act==='prev')muPlay((cur-1+mm.tracks.length)%mm.tracks.length,!!(state.listen&&state.listen.with));
      if(act==='next')muPlay((cur+1)%mm.tracks.length,!!(state.listen&&state.listen.with));
    }));
    /* 进度条点击 seek */
    const bar=f.querySelector('[data-mubar]');
    if(bar)bar.addEventListener('click',e=>{
      e.stopPropagation();
      const a=document.getElementById('muAudio');
      if(!a||!isFinite(a.duration)||!a.duration)return;
      const r=bar.getBoundingClientRect();
      a.currentTime=Math.min(a.duration,Math.max(0,(e.clientX-r.left)/r.width*a.duration));
      muTickProgress();
    });
    /* 恢复上次拖动位置（无记录时靠 CSS 的 right/bottom 定位） */
    const pos=state.muPos;
    if(pos&&typeof pos.x==='number'){
      const inside=pos.x>=0&&pos.x<=((document.getElementById('phone')||document.body).offsetWidth||1e9)
                &&pos.y>=0&&pos.y<=((document.getElementById('phone')||document.body).offsetHeight||1e9);
      if(inside){ f.style.left=pos.x+'px'; f.style.top=pos.y+'px'; f.style.right='auto'; f.style.bottom='auto'; }
    }
  }
  /* 文字/图标每次刷新（歌名随切歌变），节点原地更新 → 不动 audio */
  const nmEl=f.querySelector('.mu-float-name');
  if(nmEl&&nmEl.textContent!==(t.name||'未命名'))nmEl.textContent=t.name||'未命名';
  const sub=(t.artist||'网易云音乐')+(state.listen?' · 一起听中':'');
  const sbEl=f.querySelector('.mu-float-sub');
  if(sbEl&&sbEl.textContent!==sub)sbEl.textContent=sub;
  /* 小圆只在播时转 */
  if(mini)mini.classList.toggle('spin',playing);
  /* 播放/暂停图标跟着真实状态换 */
  const tgBtn=f.querySelector('.mu-fb-main');
  if(tgBtn){
    const want=(playing?I('muPause',17):I('play',17));
    if(tgBtn.dataset.ic!==(playing?'p':'s')){ tgBtn.dataset.ic=playing?'p':'s'; tgBtn.innerHTML=want; }
  }
  f.classList.toggle('loading',!!muLoading);
}
/* 进出聊天页只调用它：确保悬浮窗跟着显隐刷新，**绝不搬动 iframe**
   （旧版正是搬动 iframe 才导致卡顿 + 重头播） */
function syncListenBar(){ muRenderFloat(); }
/* 离开聊天页：只清掉遗留的横幅 DOM；播放器原地不动、继续放 */
function parkMuPlayer(){
  document.querySelectorAll('.listen-bar').forEach(b=>b.remove());
  muRenderFloat();
}

/* 从任意输入里解析出网易云歌曲 ID：支持完整链接、带 id= 的分享串、纯数字 */
function ncParseId(input){
  const s=String(input||'').trim();
  if(!s)return '';
  if(/^\d{4,20}$/.test(s))return s;
  let m=s.match(/[?&#]id=(\d{4,20})/);
  if(m)return m[1];
  m=s.match(/song\/(\d{4,20})/);
  if(m)return m[1];
  m=s.match(/(\d{6,20})/);
  if(m)return m[1];
  return '';
}
/* v2.24.14：官方外链地址已停用（网易云外链页不返回歌曲数据，播不了）。
   保留本函数只为兼容历史上仍引用它的旧测试；新逻辑一律走 muFetchUrl 直连播放。 */
function listenUrl(id,auto){
  return `https://music.163.com/outchain/player?type=2&id=${encodeURIComponent(id)}&auto=${(auto===0)?0:1}&height=66`;
}

function muTrackAt(i){ return (state.music&&state.music.tracks)?state.music.tracks[i]:null; }
function muCurTrack(){ const m=state.music; return (m&&m.cur!=null)?m.tracks[m.cur]:null; }

/* 选中但不播放（导入后自动选中用；不点亮组件律动） */
function muSelect(i){
  if(!state.music)state.music={tracks:[],cur:null,playing:false};
  if(i<0||i>=state.music.tracks.length)return;
  state.music.cur=i; state.music.playing=false; muSel=i; save();
  clearMuAuto();            /* v2.24.5：只选中不播，不能挂着续播定时器 */
  muStopAudio();            /* v2.24.14：停掉 audio */
  renderMusic($('appBody'),$('appExtra'));
  renderWidgets();          /* v2.24.5：桌面组件也要跟着显示当前歌 */
  if(currentChatId===state.listen?.with)renderListenBar();
}
/* 播放/暂停开关：暂停=停掉续播计时并移除 iframe（外链播放器即停声）；再点=重建并重排续播
   v2.24.8：新增 fromUser 参数 —— **只有用户主动点播放键才允许跳转音乐页**。
   此前桌面组件的自动续播 / 律动定时器也会调到本函数，歌单为空时它就 openApp('music')，
   于是「发完消息过一会儿自己跳到音乐界面」—— 与存储无关的观感 bug，一并修掉。 */
function muTogglePlay(fromUser){
  const m=state.music=state.music||{tracks:[],cur:null,playing:false};
  /* v2.24.5：没选过歌时不要静默 return（桌面点播放「没反应」的主因）——
     歌单非空就自动播第一首；歌单也空就提示去导入 */
  if(m.cur==null){
    if(m.tracks&&m.tracks.length){ muPlay(0,!!(state.listen&&state.listen.with)); return; }
    if(fromUser){
      toast('歌单还是空的，先去音乐导入一首吧');
      /* v2.24.8：**只有用户主动点**才跳页；后台定时器调用一律不跳，避免莫名其妙被拽走 */
      if(currentApp!=='music')openApp('music');
    }
    return;
  }
  m.playing=!m.playing; save();
  /* v2.24.19：暂停改 muPauseAudio（只 pause，不摘 src/不清进度）——
     旧版走 muStopAudio 会 removeAttribute('src')+load()，进度归零，再按播放就从头发。 */
  if(m.playing){ scheduleMuAuto(); muLoad(); } else { clearMuAuto(); muPauseAudio(); }
  /* v2.24.15：用户按的是浮窗/桌面上的播放键 → 说明他要看播放器，别让浮窗还藏者 */
  if(fromUser&&m.playing)muFloatHidden=false;
  muSyncUI();               /* v2.24.14：浮窗 / 音乐页 / 桌面组件一起跟状态走 */
}

/* 播放 / 切歌：记录当前曲目并重绘播放区（iframe 重建即开始播放）；
   v2.24.5：每次切歌都重排自动续播定时器 → 歌单按顺序播完一首接下一首 */
function muPlay(i,announce){
  if(!state.music)state.music={tracks:[],cur:null,playing:false};
  if(i<0||i>=state.music.tracks.length)return;
  muFloatHidden=false;   /* v2.24.15：主动点歌 = 想看到播放器，把浮窗唤回来 */
  state.music.cur=i; state.music.playing=true; muSel=i; save();   /* v2.24.0：点歌即视为在播 */
  const t=state.music.tracks[i];
  /* 一起听中：把我切歌的动作同步给 ta（ta 随一首字卡回应） */
  if(state.listen&&state.listen.with&&announce){
    const cid=state.listen.with;
    state.listen.name=t.name; state.listen.artist=t.artist||'';
    clearTimeout(listenSync);
    listenSync=setTimeout(()=>{
      if(!state.listen||state.listen.with!==cid)return;
      const line=pick([
        '这首也好听，我们一起听完好不好？',
        '换歌啦？你挑的我都喜欢。',
        '嗯…跟着你的节奏走。',
        '这首我熟，你果然懂我。',
      ]);
      pushChatMsg(cid,'ta',line,null,cid);
    },randInt(2500,5000));
  }
  scheduleMuAuto();         /* v2.24.5：兜底续播（真 ended 由 audio 事件负责，这里只在 audio 被拦时兜底） */
  muLoad(true);             /* v2.24.14：统一播放器换源 —— 任何入口点播放都从这一条出声 */
  muRenderFloat();          /* v2.24.14：让浮窗（小圆）立刻露出来 */
  renderMusic($('appBody'),$('appExtra'));
  renderWidgets();          /* v2.24.0：桌面音乐组件同步 */
  if(currentChatId===state.listen?.with)renderListenBar();
}

/* 桌面音乐页（v2.24.0 播放器美化：渐变卡 + 黑胶盘 + 居中播放/暂停） */
/* v2.24.15：歌单里每首歌的「状态徽标」—— 让用户一眼看出哪首能放、哪首为什么放不了 */
function muBadge(ncId){
  const e=muErrSet[ncId];
  if(e==='vip')return ' <span class="mu-tag vip">需会员</span>';
  if(e==='net')return ' <span class="mu-tag net">取不到地址</span>';
  return '';
}
function renderMusic(body,extra){
  if(!state.music)state.music={tracks:[],cur:null,playing:false};
  extra.classList.add('hide');
  muFloatHidden=false;   /* v2.24.15：进音乐页就是要管理播放 → 浮窗重新露出来 */
  const m=state.music;
  const t=(m.cur!=null)?m.tracks[m.cur]:null;
  const playing=!!m.playing&&!!t;

  function draw(){
    body.innerHTML=`
      <div class="mu-hero">
        <div class="mu-glow"></div>
        <div class="mu-disc ${playing?'spin':''}">
          <span class="mu-note">${I('music',30)}</span>
        </div>
        <div class="mu-name-hero">${t?escapeHtml(t.name):'还没有在听的歌'}</div>
        <div class="mu-artist-hero">${t?(escapeHtml(t.artist||'')||'网易云音乐'):'从下面导入一首吧 · 复制网易云分享链接粘贴即可'}</div>
        ${t?`<div class="mu-ctl">
          <button class="c-sm" id="muPrev" title="上一首">${IC('<path d="M18 6v12L9.5 12z"/><path d="M7 6v12" stroke-width="1.6"/>')}</button>
          <button class="c-main" id="muToggle" title="${playing?'暂停':'播放'}">${playing?IC('<path d="M8 5.5v13M16 5.5v13"/>'):IC('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>')}</button>
          <button class="c-sm" id="muNext" title="下一首">${IC('<path d="M6 6v12l8.5-6z"/><path d="M17 6v12" stroke-width="1.6"/>')}</button>
        </div>`:''}
      </div>
      ${t&&playing?`<div class="mu-out" id="muOutSlot">
        <div class="mu-out-hint"><span class="dot"></span> 正在播放 · 站内直连</div>
        <div class="bar" data-mubar><i data-muprog></i></div>
        <div class="tm"><span data-mutime>0:00 / --:--</span><span>点进度条可跳转</span></div>
      </div>
      <div class="mu-vol">
        <span class="lb">${IC('<path d="M4 9v6h3l4 3V6L7 9H4z"/><path d="M15 9.5a3.5 3.5 0 010 5"/>')}</span>
        <input type="range" min="0" max="100" value="${Math.round(muVolume()*100)}" data-muvol>
        <span class="pc" data-muvolpc>${Math.round(muVolume()*100)}%</span>
      </div>
      <div class="desc" style="margin-top:8px;text-align:center">按中间键暂停；暂停后再按继续从这首放起</div>`
      :t?`<div class="desc" style="margin-top:10px;text-align:center">按上面的 ▶ 开始播放</div>`:''}
      ${playing?`<div style="text-align:center;margin-top:10px">
        <button class="btn small ghost" id="muHideFloatBtn" style="margin:0">${IC('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>')} 关掉悬浮小圆（音乐继续放）</button>
        <div class="desc" style="margin-top:6px">悬浮小圆右上角也有一个「✕」，随时能收掉它；收掉后音乐继续播。</div>
      </div>`:''}

      <div class="card" style="margin-top:14px">
        <div class="title" style="margin-bottom:2px">${I('save',15)} 导入歌曲
          <span class="count">站内直连 · 不占空间</span>
        </div>
        <div class="desc" style="margin-bottom:10px">
          在网易云音乐里点「分享 → 复制链接」，把链接粘贴到下面即可；也可以直接填歌曲数字 ID。<br>
          <span style="color:var(--ink-3)">歌名留空的话，会自动去网易云把歌名和歌手取回来。</span>
        </div>
        <div class="field" style="margin-bottom:10px"><label>网易云链接 / 歌曲 ID</label>
          <input id="muNcInput" placeholder="https://music.163.com/song?id=xxxxxx 或 347230">
        </div>
        <div class="field" style="margin-bottom:10px"><label>歌名（可留空，自动获取）</label>
          <input id="muNameInput" placeholder="如：晴天" maxlength="30">
        </div>
        <button class="btn block" id="muAdd">${I('plus',15)} 加入我的歌单</button>
        <div class="desc" style="margin-top:9px;font-size:11px;color:var(--ink-3)">
          提示：网易云有版权的 VIP 歌曲是拿不到播放地址的，加进来会显示「需要会员」并自动跳过。免费的都能正常播。
        </div>
      </div>

      <div class="card">
        <div class="title" style="margin-bottom:10px">我的歌单 <span class="count">${m.tracks.length} 首</span></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${m.tracks.length?m.tracks.map((x,i)=>`
            <div class="mu-track ${m.cur===i?'on':''}" data-mu="${i}">
              <span class="no">${m.cur===i?I('play',13):(i+1)}</span>
              <div style="flex:1;min-width:0">
                <div class="tt">${escapeHtml(x.name)}${muBadge(x.ncId)}</div>
                <div class="ts">${escapeHtml(x.artist||'')||'网易云音乐'} · ID ${escapeHtml(x.ncId)}</div>
              </div>
              <span class="delx" data-mudel="${i}" title="删除">✕</span>
            </div>`).join(''):'<div class="empty">歌单还是空的，从上面导入第一首吧</div>'}
        </div>
      </div>

      <div class="card">
        <div class="title" style="margin-bottom:6px">${I('screen',15)} 播放自检 <span class="count">放不出来时点这个</span></div>
        <div class="desc" style="margin-bottom:10px">
          逐首去取一次播放地址，把「哪首能放、哪首要会员、哪首取不到」摆明白。
          自检不播放、不改歌单，放心点。
        </div>
        <button class="btn ghost block" id="muDiag">开始自检</button>
        <div class="desc" id="muDiagOut" style="margin-top:9px;display:none"></div>
      </div>

      <div class="card">
        <div class="title" style="margin-bottom:6px">${I('listen',15)} 一起听</div>
        <div class="desc">
          想和谁一起听？去<b>单人聊天页 → 右下角加号 → 更多互动 → 一起听</b>，
          挑一首歌邀请 ta。ta 应邀后，聊天页会出现「一起听」横幅，横幅里就能按播放；你换歌 ta 也会跟着回应。
          ${state.listen?`<br><br>正在和 <b>${escapeHtml(contactName(state.listen.with))}</b> 一起听《${escapeHtml(state.listen.name)}》。`:''}
        </div>
        ${state.listen?`<button class="btn ghost block" id="muStopListen" style="margin-top:10px">结束这次一起听</button>`:''}
      </div>
      <div style="height:74px"></div>`;

    body.querySelectorAll('[data-mu]').forEach(el=>el.addEventListener('click',e=>{
      if(e.target.dataset.mudel!==undefined)return;
      muPlay(+el.dataset.mu,!!(state.listen&&state.listen.with));
    }));
    body.querySelectorAll('[data-mudel]').forEach(el=>el.addEventListener('click',e=>{
      e.stopPropagation();
      const i=+el.dataset.mudel;
      const gone=m.tracks[i];
      m.tracks.splice(i,1);
      /* v2.24.15：这首歌的「失败记录」跟着一起清掉，不然重新加回来会被当成放不了的 */
      if(gone){
        if(gone.ncId){ delete muBlockedSet[gone.ncId]; muNetRetry[gone.ncId]=0; }
        delete muErrSet[gone.ncId];
      }
      if(m.cur===i){m.cur=null;m.playing=false;clearMuAuto();muStopAudio();}
      else if(m.cur!==null&&m.cur>i)m.cur--;
      save(); draw(); muSyncUI(); toast('已从歌单移除');
    }));
    /* v2.24.15b：播放自检 —— 逐首取地址，结果直接写页面上。
       便于用户（和以后的我）一眼看出是「歌要会员」还是「真的取不到」。 */
    const diag=$('muDiag');
    if(diag)diag.addEventListener('click',()=>{
      const out=$('muDiagOut');
      if(!out)return;
      if(!m.tracks.length){ out.style.display='block'; out.innerHTML='歌单是空的，先导入一首再自检。'; return; }
      out.style.display='block';
      out.innerHTML='自检中…';
      const rows=m.tracks.map(x=>x.name+'|'+x.ncId);
      let i=0; const lines=[];
      const canvasCls='style="font-variant-numeric:tabular-nums"';
      const step=()=>{
        if(i>=rows.length){
          /* 给一句总结 —— 直接告诉用户「为什么放不出来」 */
          const nOk=lines.filter(l=>l.ok).length;
          const nTry=lines.filter(l=>l.try).length;
          const nVip=lines.filter(l=>l.vip).length;
          const nNet=lines.filter(l=>l.net).length;
          const sum = nOk
            ? `<b style="color:#2f9e63">${nOk} 首可播</b>${nTry?`（其中 ${nTry} 首走直连试播）`:''}${nVip?` · ${nVip} 首需会员`:''}${nNet?` · ${nNet} 首取不到`:''}。点歌名就能放。`
            : (nVip&&!nNet
                ? '<b style="color:#b26a00">歌单里的歌都需要网易云会员</b>，免费歌才能在本站播。换一首免费的试试～'
                : '<b style="color:var(--danger)">所有歌都取不到播放地址</b> —— 多为网络/接口不稳定，过一会儿再自检一次。');
          out.innerHTML=lines.map(l=>`<div ${canvasCls}>${l.txt}</div>`).join('')+`<div style="margin-top:7px">${sum}</div>`;
          return;
        }
        const [nm,ncId]=rows[i].split('|');
        const safe=escapeHtml(nm||('歌曲 '+ncId));
        muFetchUrl(ncId).then(res=>{
          if(res&&res.url){
            const tag = res.via==='gd'   ? '可播（备用接口）'
                      : res.via==='outer'? '直连试播（接口不可用 · 播放器自动跳转）'
                      : '可播';
            lines.push({ok:true, try:res.via==='outer', txt:'✓ '+safe+' — '+tag});
          }
          else if(res&&res.blocked) lines.push({vip:true,txt:'✕ '+safe+' — '+(res.msg||'版权受限')});
          else                 lines.push({net:true,txt:'✕ '+safe+' — 取不到地址'});
        }).catch(()=>{
          lines.push({net:true,txt:'✕ '+safe+' — 接口没响应（跨域或网络问题）'});
        }).then(()=>{
          out.innerHTML=lines.map(l=>`<div ${canvasCls}>${l.txt}</div>`).join('')+'<div>自检中…</div>';
          i++; step();
        });
      };
      step();
    });
    /* v2.24.15：关掉悬浮小圆（音乐不停）—— 旧版只能靠删歌让浮窗消失，太反直觉 */
    const hfb=$('muHideFloatBtn');
    if(hfb)hfb.addEventListener('click',()=>muHideFloat(true));
    const add=$('muAdd');
    if(add)add.addEventListener('click',()=>{
      const raw=$('muNcInput').value;
      const ncId=ncParseId(raw);
      if(!ncId)return toast('没识别到歌曲，检查一下链接或 ID');
      const nameEl=$('muNameInput');
      const typed=nameEl.value.trim();
      nameEl.value=''; $('muNcInput').value='';
      /* v2.24.14：用户没填歌名 → 自动去官方 detail 取真实歌名/歌手（体验好很多） */
      const rec={id:'m'+Date.now(),name:typed||('网易云歌曲 '+ncId),artist:'',ncId};
      m.tracks.push(rec);
      if(m.cur===null)muSelect(m.tracks.length-1); else { save(); draw(); }
      toast('已加入歌单：'+rec.name);
      if(!typed){
        muFetchDetail(ncId).then(info=>{
          if(!info||!info.name)return;
          rec.name=info.name; rec.artist=info.artist||'';
          save(); draw(); renderWidgets(); muRenderFloat();
          toast('已识别：'+info.name+(info.artist?' · '+info.artist:''));
        });
      }
    });
    /* 音量条（v2.24.14 新增，持久化到 state.settings.muVolume） */
    const vol=body.querySelector('[data-muvol]');
    if(vol){
      vol.addEventListener('input',()=>muSetVolume((+vol.value||0)/100));
      vol.addEventListener('change',()=>{ save(); });
    }
    const prev=$('muPrev'), next=$('muNext'), tg=$('muToggle');
    if(prev)prev.addEventListener('click',()=>{
      if(!m.tracks.length)return;
      const i=(m.cur==null?m.tracks.length-1:(m.cur-1+m.tracks.length)%m.tracks.length);
      muPlay(i,!!(state.listen&&state.listen.with));
    });
    if(next)next.addEventListener('click',()=>{
      if(!m.tracks.length)return;
      const i=(m.cur==null?0:(m.cur+1)%m.tracks.length);
      muPlay(i,!!(state.listen&&state.listen.with));
    });
    if(tg)tg.addEventListener('click',()=>muTogglePlay(true));   /* 用户主动点 */
    const stop=$('muStopListen');
    if(stop)stop.addEventListener('click',()=>endListen(true));
    /* 进度条点击 seek（和浮窗里同一个行为） */
    const pbar=body.querySelector('[data-mubar]');
    if(pbar)pbar.addEventListener('click',e=>{
      const a=document.getElementById('muAudio');
      if(!a||!isFinite(a.duration)||!a.duration)return;
      const r=pbar.getBoundingClientRect();
      a.currentTime=Math.min(a.duration,Math.max(0,(e.clientX-r.left)/r.width*a.duration));
      muTickProgress();
    });
    muTickProgress();   /* 画完就补一次进度，避免切页回来进度条是空的 */
  }
  draw();
}

/* 一起听：选歌 → 邀请当前联系人（ta 按 listenAcceptProb 应邀） */
function inviteListenPicker(contactId){
  const c=state.contacts.find(x=>x.id===contactId);
  if(!c)return;
  const tracks=(state.music&&state.music.tracks)||[];
  const songs=tracks.length?tracks.map(t=>({name:t.name,artist:t.artist,ncId:t.ncId}))
    :[{name:'网易云每日推荐',artist:'随便听听',ncId:''}];
  const p=state.settings.listenAcceptProb??85;
  const mask=openModal('邀请一起听',`
    <div class="desc" style="margin-bottom:12px">
      选一首歌，邀请「<b>${escapeHtml(c.name)}</b>」一起听。ta 应邀后，你们会同步这一刻的音乐。
    </div>
    <div style="max-height:42vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
      ${songs.map((s,i)=>`
        <div class="gi-item" data-lt="${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);cursor:pointer">
          <span style="display:flex;color:var(--accent)">${I('music',20)}</span>
          <div style="flex:1;min-width:0">
            <div class="name" style="font-weight:700;font-size:13.5px">${escapeHtml(s.name)}</div>
            <div class="meta" style="font-size:11px;color:var(--ink-3)">${escapeHtml(s.artist||'')||'网易云音乐'}</div>
          </div>
          <span class="count">邀请 ›</span>
        </div>`).join('')}
    </div>
    <div class="desc" style="margin-top:12px;font-size:11.5px">
      应邀概率 ${Math.round(p)}%，可在「设置 → 概率 → 一起听应邀概率」调整。
      ${tracks.length?'':'（歌单是空的，先到桌面「音乐」里导入几首更好听）'}
    </div>
  `,()=>true,'关闭');
  mask.querySelectorAll('[data-lt]').forEach(el=>el.addEventListener('click',()=>{
    const s=songs[+el.dataset.lt];
    mask.remove();
    doInviteListen(contactId,s);
  }));
}

function doInviteListen(contactId,song){
  const c=state.contacts.find(x=>x.id===contactId);
  if(!c)return;
  const nm=c.name;
  const p=state.settings.listenAcceptProb??85;
  toast('已邀请「'+nm+'」一起听…');
  setTimeout(()=>{
    if(Math.random()*100<p){
      /* v2.24.0：应邀后把这首歌落进歌单并选中——修复「邀了却不播」 */
      const m=state.music=state.music||{tracks:[],cur:null,playing:false};
      let idx=m.tracks.findIndex(t=>song.ncId&&t.ncId===song.ncId);
      if(idx<0&&song.ncId){
        m.tracks.push({id:'m'+Date.now(),name:song.name,artist:song.artist||'',ncId:song.ncId});
        idx=m.tracks.length-1;
      }
      if(idx>=0){ m.cur=idx; m.playing=true; }   /* v2.24.5：应邀即开播（原先置 false 导致「邀了却不播」） */
      state.listen={name:song.name,artist:song.artist||'',with:contactId,since:Date.now(),ncId:song.ncId||''};
      save();
      scheduleMuAuto();                          /* v2.24.5：一起听按歌单顺序播下去，不再只听一首 */
      muLoad(true);                              /* v2.24.6：应邀即开播 —— 全局播放器立刻装载这首歌 */
      /* ta 的应邀字卡进聊天流，聊天页更有临场感 */
      const line=pick([
        '好啊，戴上耳机了，放吧。',
        '一起听~ 你说这首叫《'+song.name+'》？',
        '嗯，这一刻就我们两个人听。',
        '好呀，这首我想和你一起听很久了。',
      ]);
      pushChatMsg(contactId,'sys',`「${nm}」和你一起听《${song.name}》`);
      pushChatMsg(contactId,'ta',line,null,contactId);
      if(currentChatId===contactId)renderListenBar();
      if(currentApp==='chat'&&!currentChatId)renderChatListRefresh();
      renderWidgets();                                        /* 桌面音乐组件同步 */
      if(currentApp==='music')renderMusic($('appBody'),$('appExtra'));
      toast(nm+' 应邀了，一起听《'+song.name+'》');
    }else{
      openModal('「'+nm+'」暂时没空',`
        <div style="text-align:center;padding:6px 0 2px">
          ${wmAvatar(contactId,nm,'lg')}
          <div style="font-weight:700;font-size:14.5px;margin-top:8px;line-height:1.7">「${escapeHtml(nm)}」：${escapeHtml(pick(['现在在忙，晚点陪你听好不好？','环境有点吵，等安静下来再一起听～','先把耳机找出来，等我一下下。','唔…今天想听你唱给我听。']))}</div>
        </div>`,()=>{ inviteListenPicker(contactId); },null,'换首歌再邀','知道啦');
    }
  },randInt(900,2200));
}

/* 聊天页「一起听」横幅：插在输入栏上方。
   v2.24.7：横幅退化成**纯信息条** —— 播放器已经独立成一个可拖动的悬浮窗（#muFloat），
   横幅只负责显示歌名/时长和「结束」按钮，不再承载 iframe。
   这样横幅随聊天页进出生灭都完全无害：播放器在别的节点上，压根不受影响。 */
function renderListenBar(){
  const old=document.querySelector('.listen-bar');
  if(old)old.remove();
  muRenderFloat();          /* v2.24.7：一起听状态变了，悬浮窗的铺开/收起也要跟上 */
  if(!state.listen||!currentChatId||isGroup(currentChatId))return;
  if(state.listen.with!==currentChatId)return;
  const wrap=$('ibWrap'); if(!wrap)return;
  const dur=Math.max(0,Math.floor((Date.now()-(state.listen.since||Date.now()))/60000));
  const bar=document.createElement('div');
  bar.className='listen-bar';
  bar.innerHTML=`
    <span class="lb-eq"><i></i><i></i><i></i></span>
    <div class="lb-tx">
      <b>${escapeHtml(state.listen.name)}</b>
      <span>${escapeHtml(state.listen.artist||'网易云音乐')} · 一起听 ${dur} 分钟 · 播放器可在屏幕上拖动</span>
    </div>
    <button class="btn small ghost" id="listenBarToggle" style="margin:0">${(state.music&&state.music.playing)?'暂停':'播放'}</button>
    <button class="btn small ghost" id="listenStop" style="margin:0">结束</button>`;
  wrap.parentNode.insertBefore(bar,wrap);
  const st=$('listenStop');
  if(st)st.addEventListener('click',()=>endListen(true));
  const tg=$('listenBarToggle');
  if(tg)tg.addEventListener('click',e=>{e.stopPropagation();muTogglePlay(true);renderListenBar();});
}

/* 结束一起听 */
function endListen(byMe){
  if(!state.listen)return;
  const cid=state.listen.with, nm=contactName(cid);
  state.listen=null; clearTimeout(listenSync); clearMuAuto(); save();
  /* v2.24.6：一起听结束才真正停声 —— 之前退出聊天页会走到这里（横幅被销毁），现在不会了 */
  const m=state.music; if(m)m.playing=false;
  muStopAudio();
  renderWidgets();
  renderListenBar();
  parkMuPlayer();
  if(byMe&&cid){
    const line=pick(['那今天先听到这儿，下次继续。','好啦，摘耳机吧，晚安。','嗯，谢谢陪我听这一会儿。','歌停了，但想你的心情还在。']);
    pushChatMsg(cid,'ta',line,null,cid);
    toast('已结束和「'+nm+'」的一起听');
  }
}

/* 一起听会话过期保护：超过 3 小时自动收尾（避免横幅一直挂着） */
function listenExpireCheck(){
  if(!state.listen)return;
  if(Date.now()-(state.listen.since||0)>3*3600*1000){
    const cid=state.listen.with;
    state.listen=null; save();
    /* v2.24.6：过期收尾才算真的结束这次一起听 —— 顺手停声 + 释放播放器（否则它继续挂着） */
    const m=state.music; if(m)m.playing=false;
    clearMuAuto(); muStopAudio(); renderWidgets(); parkMuPlayer();
    if(cid&&currentChatId===cid)renderListenBar();
  }
}

/* ================= 小游戏（先邀请联系人来玩） ================= */
/* 玩法：点游戏 → 选一位联系人 → 发起邀请 → 按「邀请接受概率」判定是否应约 →
   接受后才开局（对手就是这位联系人）；不接受可换人重邀。 */
let gamePickFor=null;   /* 待邀请的游戏 id（用于邀请弹窗状态） */
function renderGames(body,extra){
  extra.classList.add('hide');
  const games=[
    ['rps','rps','猜拳','和 ta 猜拳，赢潮汐石'],
    ['memory','memory','记忆翻牌','翻牌配对考验记忆力'],
    ['gomoku','gomoku','五子棋','9 路棋盘和 ta 对弈'],
    ['snake','snake','贪吃蛇对战','和 ta 双人对战，活到最后'],
    ['tetris','tetris','双人俄罗斯方块','两种颜色一起消行，合作冲等级'],
  ];
  body.innerHTML=`
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px">
      <div style="font-weight:800;display:flex;align-items:center;gap:4px">${I('tide',14)} ${fmtCoins(state.coins)} 潮汐石</div>
      <div class="count">赢潮汐石可去闲屿小集消费</div>
    </div>
    <div class="card" style="padding:12px 16px">
      <div class="desc" style="margin:0">选一个游戏，然后<b>邀请一位联系人</b>一起来玩。ta 是否应邀可在「设置 → 概率」里调整。</div>
    </div>
    <div class="game-grid">
      ${games.map(g=>`<div class="game-tile" data-g="${g[0]}" data-n="${g[2]}"><div class="em" style="color:var(--ink)">${ICONS[g[1]]}</div>${g[2]}<div class="desc" style="font-weight:400">${g[3]}</div></div>`).join('')}
    </div>`;
  body.querySelectorAll('.game-tile').forEach(el=>el.addEventListener('click',()=>{
    openGameInvite(el.dataset.g, el.dataset.n);
  }));
}

/* 邀请弹窗：选联系人 → 发起邀请 → 概率判定 */
function openGameInvite(gameId, gameName){
  if(!state.contacts.length)return toast('先去添加联系人吧');
  gamePickFor=gameId;
  const mask=openModal('邀请一起玩',`
    <div class="desc" style="margin-bottom:12px">你想和谁一起玩「<b>${escapeHtml(gameName)}</b>」？</div>
    <div id="giList" style="max-height:44vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
      ${state.contacts.map(c=>`
        <div class="gi-item" data-gc="${c.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);cursor:pointer">
          ${wmAvatar(c.id,c.name,'sm')}
          <div style="flex:1;min-width:0">
            <div class="name" style="font-weight:700;font-size:13.5px">${escapeHtml(c.name)}</div>
            <div class="meta" style="font-size:11px;color:var(--ink-3)">应邀概率 ${Math.round(state.settings.gameInviteProb??50)}%</div>
          </div>
          <span class="count">邀请 ›</span>
        </div>`).join('')}
    </div>
    <div class="desc" style="margin-top:12px;font-size:11.5px">应邀概率可在「设置 → 概率 → 游戏邀请接受概率」里调整。</div>
  `,()=>true,'关闭');
  mask.querySelectorAll('[data-gc]').forEach(el=>el.addEventListener('click',()=>{
    const cid=el.dataset.gc;
    mask.remove();
    inviteGameTo(cid, gameId, gameName);
  }));
}

/* 发起邀请并判定是否应邀 */
function inviteGameTo(contactId, gameId, gameName){
  const c=state.contacts.find(x=>x.id===contactId);
  if(!c)return;
  const nm=c.name;
  const p=state.settings.gameInviteProb??50;   /* 默认 50% 应邀 */
  toast('已向「'+nm+'」发出邀请…');
  setTimeout(()=>{
    if(Math.random()*100 < p){
      /* 应邀：正式开局，标题带上对手名字 */
      const mk=openModal(nm+' 应邀了！',`
        <div style="text-align:center;padding:6px 0 2px">
          ${wmAvatar(contactId,nm,'lg')}
          <div style="font-weight:800;font-size:16px;margin-top:8px">「${escapeHtml(nm)}」接受了你的邀请</div>
          <div class="desc" style="margin-top:6px">准备好开始「${escapeHtml(gameName)}」了吗？</div>
        </div>`,()=>{
          $('appTitle').textContent='小游戏 · '+gameName;
          activeGameRival={ id:contactId, name:nm };
          Games.open(gameId);
        },null,'开始游戏','再等等');
      return;
    }
    /* 婉拒：给个理由，可换人重邀 */
    const reasons=['这会儿有点忙，待会儿陪你玩好不好？','手气不太好，让我先缓缓…','唔…现在不想动，抱一下再说？','在忙呢，晚点一定陪你玩！'];
    openModal('「'+nm+'」暂时没空',`
      <div style="text-align:center;padding:6px 0 2px">
        ${wmAvatar(contactId,nm,'lg')}
        <div style="font-weight:700;font-size:14.5px;margin-top:8px;line-height:1.7">「${escapeHtml(nm)}」：${escapeHtml(pick(reasons))}</div>
      </div>`,()=>{ openGameInvite(gameId, gameName); },null,'换个联系人','知道啦');
  }, randInt(900, 2200));
}

/* 当前对局对手（供游戏内文案使用） */
let activeGameRival=null;

/* ================= 经期记录（区间模型 + 月历 + 预测） =================
   记录格式：{ start:'YYYY-MM-DD', end:'YYYY-MM-DD' }（区间，含首尾）
   兼容旧格式：字符串 'YYYY-MM-DD' → 自动视作 start，end = start + 4 天 */
let pdY,pdM;
const PD_DEFAULT_LEN=5;   /* 未填结束日时的默认持续天数 */

/* 把一条记录（新/旧格式）规整成 {start,end} */
function pdNorm(r){
  if(!r)return null;
  if(typeof r==='string'){
    const st=new Date(r+'T00:00:00'); if(isNaN(st))return null;
    const en=new Date(st.getTime()+(PD_DEFAULT_LEN-1)*864e5);
    return { start:r, end:fmtDate(en.getTime()) };
  }
  if(typeof r==='object'&&r.start){
    const st=new Date(r.start+'T00:00:00'); if(isNaN(st))return null;
    let start=r.start, end=r.end;
    if(!end){ const en=new Date(st.getTime()+(PD_DEFAULT_LEN-1)*864e5); end=fmtDate(en.getTime()); }
    /* 结束日早于开始日 → 交换回来 */
    if(end<start){ const t=start; start=end; end=t; }
    return { start, end };
  }
  return null;
}
function pdAll(){ /* 规整后的全部记录（按开始日倒序） */
  return (state.period.records||[]).map(pdNorm).filter(Boolean).sort((a,b)=>a.start<b.start?1:-1);
}
function pdDaysOf(rec){ /* 该次持续天数（含首尾） */
  if(!rec)return 0;
  const s=new Date(rec.start+'T00:00:00'), e=new Date(rec.end+'T00:00:00');
  return Math.max(1,Math.round((e-s)/864e5)+1);
}
function inPeriodDay(ds){ /* ds 是否落在某个经期区间内 */
  return pdAll().some(r=>ds>=r.start&&ds<=r.end);
}
/* 平均周期：优先用「相邻两次开始日」的间隔平均，样本不足则回落设置值 */
function pdAvgCycle(){
  const rs=pdAll();
  if(rs.length<2)return state.period.cycle||28;
  const gaps=[];
  for(let i=0;i<rs.length-1;i++){
    const a=new Date(rs[i].start+'T00:00:00'), b=new Date(rs[i+1].start+'T00:00:00');
    const g=Math.round((a-b)/864e5);
    if(g>=15&&g<=60)gaps.push(g);   /* 过滤异常值 */
  }
  if(!gaps.length)return state.period.cycle||28;
  return Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);
}
function renderPeriod(body,extra){
  if(pdY===undefined){ const d=new Date(); pdY=d.getFullYear(); pdM=d.getMonth(); }
  function draw(){
    const recs=pdAll();                    /* 规整后的记录，按开始日倒序 */
    const latest=recs[0];
    const cyc=pdAvgCycle();
    let predict='';
    let predStr='';
    if(latest){
      const next=new Date(new Date(latest.start+'T00:00:00').getTime()+cyc*864e5);
      predStr=fmtDate(next.getTime());
      const days=Math.round((next-new Date())/864e5);
      const src=(recs.length>=2)?`按最近 ${Math.min(recs.length,6)} 次记录平均 ${cyc} 天推算`:`按设定 ${cyc} 天周期推算`;
      predict=`<div class="card" style="text-align:center">
        <div class="title">下次预测</div>
        <div class="ann-days">${predStr}</div>
        <div class="desc">${days>0?('还有 '+days+' 天'):(days===0?'就是今天':'已过期 '+(-days)+' 天')}</div>
        <div class="desc">${src}</div>
      </div>`;
    }
    /* 月历 */
    const first=new Date(pdY,pdM,1);
    const days=new Date(pdY,pdM+1,0).getDate();
    const startWd=first.getDay();
    const todayStr=fmtDate(Date.now());
    let cells='';
    for(let i=0;i<startWd;i++)cells+='<div></div>';
    for(let d=1;d<=days;d++){
      const ds=`${pdY}-${String(pdM+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      let cls='';
      const rec=recs.find(r=>ds>=r.start&&ds<=r.end);
      if(rec){
        cls+=' pd-window';
        if(ds===rec.start)cls+=' pd-start';
        if(ds===rec.end)cls+=' pd-end';
      }
      if(ds===todayStr)cls+=' today';
      if(ds===predStr)cls+=' pd-pred';
      cells+=`<div class="cal-day ${cls}" style="cursor:default">${d}</div>`;
    }
    const avgInfo=recs.length>=2?` · 平均周期 ${cyc} 天`:'';
    body.innerHTML=`
      ${predict}
      <div class="card">
        <div class="cal-head">
          <button class="iconbtn" id="pdPrev">‹</button>
          <div class="mon">${pdY}年${pdM+1}月</div>
          <button class="iconbtn" id="pdNext">›</button>
        </div>
        <div class="cal-grid">
          ${'一二三四五六日'.split('').map(w=>`<div class="wd">${w}</div>`).join('')}
          ${cells}
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--ink-2)">
          <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--accent);vertical-align:-1px"></i> 开始日</span>
          <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#f6d9e8;vertical-align:-1px"></i> 经期中</span>
          <span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#e9a5c9;vertical-align:-1px"></i> 结束日</span>
          <span><i style="display:inline-block;width:10px;height:10px;border-radius:50%;border:1.5px dashed var(--accent);vertical-align:-1px"></i> 预测日</span>
        </div>
      </div>
      <div class="card">
        <div class="title">${I('moon',15)} 记录一次经期</div>
        <div class="desc" style="margin-top:4px">填开始日和结束日；只填开始日也可以（默认按 5 天算）。</div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <div class="field" style="flex:1;margin-bottom:0"><label>开始日</label><input id="pdDate" type="date"></div>
          <div class="field" style="flex:1;margin-bottom:0"><label>结束日</label><input id="pdEnd" type="date"></div>
        </div>
        <div class="field" style="margin-top:10px"><label>周期（天）· 记录 ≥2 次后自动按平均值预测</label><input id="pdCycle" type="number" value="${state.period.cycle}" min="20" max="45"></div>
        <button class="btn block" id="pdAdd">保存记录</button>
      </div>
      <div class="section-label">历史记录 <span class="count">${recs.length} 次${avgInfo}</span></div>
      ${recs.map((r,i)=>{
        const n=pdDaysOf(r);
        return `<div class="card" style="padding:11px 16px;display:flex;justify-content:space-between;align-items:center;font-size:13px">
          <span style="display:inline-flex;align-items:center;gap:5px">${I('moon',13)} ${r.start} → ${r.end} <span class="count">${n} 天</span></span>
          <span class="delx" data-del="${i}">✕</span></div>`;
      }).join('')||'<div class="empty">还没有记录</div>'}`;
    $('pdPrev').addEventListener('click',()=>{ pdM--; if(pdM<0){pdM=11;pdY--;} draw(); });
    $('pdNext').addEventListener('click',()=>{ pdM++; if(pdM>11){pdM=0;pdY++;} draw(); });
    $('pdAdd').addEventListener('click',()=>{
      const s1=$('pdDate').value;
      const e1=$('pdEnd').value;
      if(!s1)return toast('请选择开始日期');
      if(e1&&e1<s1)return toast('结束日不能早于开始日');
      state.period.cycle=parseInt($('pdCycle').value)||28;
      const rec=pdNorm({ start:s1, end:e1||undefined });
      if(!rec)return toast('日期不合法');
      /* 同一开始日视为更新，避免重复 */
      const rest=(state.period.records||[]).filter(r=>{ const n=pdNorm(r); return !n||n.start!==rec.start; });
      rest.push(rec);
      state.period.records=rest;
      save(); draw(); toast(`已记录 ${pdDaysOf(rec)} 天`);
    });
    body.querySelectorAll('.delx').forEach(el=>el.addEventListener('click',()=>{
      const idx=+el.dataset.del;
      const norm=pdAll();
      const target=norm[idx]; if(!target)return;
      /* 按开始日删除（兼容新旧格式） */
      state.period.records=(state.period.records||[]).filter(r=>{ const n=pdNorm(r); return !n||n.start!==target.start; });
      save(); draw();
    }));
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 字卡库（双页签：字卡库 / 拍一拍库，两个独立功能组件） ================= */
let cardsTab='cards', cardCate=-1, privWho=null, privCate=-1;
/* v2.22.0：字卡搜索关键词（跨全部分类查找，方便确认某张字卡是否已添加） */
let cardQuery='';
function searchCardsHtml(q){
  if(!q)return '<div class="desc" style="color:var(--ink-3)">输入关键词后显示结果</div>';
  const kw=String(q).toLowerCase();
  const hits=[];
  state.cats.forEach((c,ci)=>c.cards.forEach(t=>{ if(String(t).toLowerCase().includes(kw)) hits.push({t,ci,name:c.name}); }));
  if(!hits.length)return `<div class="desc" style="color:var(--ink-3)">没有找到含「${escapeHtml(q)}」的字卡</div>`;
  return `<div class="desc" style="margin-bottom:8px">共找到 <b>${hits.length}</b> 张（点字卡可跳到所属分类）</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${hits.slice(0,200).map(h=>`<span class="chip" data-goto="${h.ci}" style="background:#f4f4f6;border-radius:14px;padding:7px 12px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;word-break:break-all">${escapeHtml(h.t)}<span style="font-size:11px;color:var(--ink-3)">${escapeHtml(h.name)}</span></span>`).join('')}
    </div>`;
}
function renderCards(body,extra){
  /* 页签事件委托：一次绑定对所有子视图生效（修复专用库页签点不动的 bug） */
  if(!body.__segBound){
    body.__segBound=true;
    body.addEventListener('click',e=>{
      const t=e.target.closest('[data-ct]');
      if(!t)return;
      cardsTab=t.dataset.ct; cardCate=-1; privWho=null; privCate=-1;
      draw();
    });
  }
  function segHtml(){
    return `<div class="seg">
      <button data-ct="cards" class="${cardsTab==='cards'?'on':''}">公用字卡</button>
      <button data-ct="priv" class="${cardsTab==='priv'?'on':''}">专用字卡</button>
      <button data-ct="pat" class="${cardsTab==='pat'?'on':''}">拍一拍</button>
    </div>`;
  }
  function drawCats(){
    body.innerHTML=`
      ${segHtml()}
      <div class="total-pill" style="display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--accent-ink);border-radius:22px;padding:9px 18px;font-size:13px;font-weight:600;margin-bottom:16px">📜 公用字卡 共 ${totalCards()} 张</div>
      <div class="card">
        <div class="title">${I('search',15)} 搜索字卡</div>
        <div class="desc" style="margin-top:4px">输入关键词，跨全部分类查找——看看这张字卡你有没有添加过</div>
        <div style="margin-top:10px"><input id="cardSearch" value="${escapeHtml(cardQuery)}" placeholder="如：晚安" style="width:100%;border:1px solid var(--line);border-radius:14px;padding:11px 14px;font-size:14px;outline:none;background:#fafafa"></div>
        <div id="cardSearchRes" style="margin-top:12px"></div>
      </div>
      <div class="card" style="padding:6px 16px">
        ${state.cats.map((c,i)=>`
          <div class="rowline cate-item" data-i="${i}" style="cursor:pointer">
            <div style="flex:1;min-width:0">
              <div class="name">${escapeHtml(c.name)}</div>
              <div class="meta">${c.cards.length} 张 · ${c.enabled?'参与抽卡':'已停用'}</div>
            </div>
            <div class="right">
              <button class="iconbtn" data-rename="${i}" title="修改分类名称" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center">${I('pen',14)}</button>
              <span class="count">›</span>
              <button class="switch ${c.enabled?'on':''}" data-toggle="${i}"></button>
            </div>
          </div>`).join('')||'<div class="empty">还没有分类</div>'}
      </div>
      <div class="card">
        <div class="title">${I('plus',15)} 新建分类</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <input id="newCateName" placeholder="分类名称" maxlength="12" style="flex:1;border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:14px;outline:none;background:#fafafa">
          <button class="btn" id="addCateBtn">创建</button>
        </div>
      </div>`;
    /* v2.22.0：搜索框（输入即查，结果里的字卡可点跳到所属分类） */
    const sInp=$('cardSearch');
    if(sInp){
      const run=()=>{
        cardQuery=sInp.value;
        const host=$('cardSearchRes');
        if(!host)return;
        host.innerHTML=searchCardsHtml(cardQuery.trim());
        host.querySelectorAll('[data-goto]').forEach(el=>el.addEventListener('click',()=>{
          cardCate=+el.dataset.goto; draw();
        }));
      };
      sInp.addEventListener('input',run);
      run();
    }
    body.querySelectorAll('.cate-item').forEach(el=>el.addEventListener('click',e=>{
      if(e.target.closest('[data-toggle]')||e.target.closest('[data-rename]'))return;
      cardCate=+el.dataset.i; draw();
    }));
    body.querySelectorAll('[data-toggle]').forEach(el=>el.addEventListener('click',()=>{
      const c=state.cats[+el.dataset.toggle];
      c.enabled=!c.enabled; save(); draw();
    }));
    /* 修改分类名称 */
    body.querySelectorAll('[data-rename]').forEach(el=>el.addEventListener('click',()=>{
      const c=state.cats[+el.dataset.rename];
      const mk=openModal('修改分类名称',`
        <div class="field" style="margin-bottom:0"><input id="rnInput" value="${escapeHtml(c.name)}" maxlength="12"></div>`,()=>{
        const name=mk.querySelector('#rnInput').value.trim();
        if(!name){ toast('名称不能为空'); return false; }
        if(name!==c.name&&state.cats.some(x=>x.name===name)){ toast('已有同名分类'); return false; }
        c.name=name; save(); draw(); toast('已改名为「'+name+'」');
      });
      setTimeout(()=>{ const i=mk.querySelector('#rnInput'); if(i){i.focus();i.select();} },60);
    }));
    $('addCateBtn').addEventListener('click',()=>{
      const name=$('newCateName').value.trim();
      if(!name)return toast('先填写分类名称');
      if(state.cats.some(c=>c.name===name))return toast('已有同名分类');
      state.cats.push({name,enabled:true,cards:[]});
      save(); draw(); toast('已创建「'+name+'」');
    });
  }
  function drawDetail(){
    const c=state.cats[cardCate];
    body.innerHTML=`
      <div class="backrow" style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <button class="iconbtn" id="cardBack">‹</button>
        <div style="flex:1"><div style="font-weight:800;font-size:17px">${escapeHtml(c.name)}</div>
        <div style="font-size:11px;color:var(--ink-2)">${c.cards.length} 张字卡</div></div>
        <button class="iconbtn" id="renameCate" title="修改分类名称" style="display:flex;align-items:center;justify-content:center">${I('pen',15)}</button>
      </div>
      <div class="card">
        <div class="title">${I('plus',15)} 批量添加</div>
        <div class="desc">每行一条，自动拆分为字卡（重复自动跳过）</div>
        <div style="margin-top:10px"><textarea id="batchInput" placeholder="字卡一&#10;字卡二"></textarea></div>
        <button class="btn block" id="batchAdd" style="margin-top:10px">添加到当前分类</button>
      </div>
      <div class="card">
        <div class="title">${I('folder',15)} 全部字卡 <span class="count">${c.cards.length}</span></div>
        <div class="desc" style="margin-top:4px">点字卡上的 ⇪ 可移动到其他分组</div>
        <div style="margin-top:10px"><input id="cardFilter" placeholder="在本分类里筛选…" style="width:100%;border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:13.5px;outline:none;background:#fafafa"></div>
        <div id="chipHost" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
          ${c.cards.map((t,i)=>`<span class="chip" data-t="${escapeHtml(t)}" style="background:#f4f4f6;border-radius:14px;padding:7px 12px;font-size:13px;display:inline-flex;align-items:center;gap:7px;word-break:break-all">${escapeHtml(t)}<span class="delx" data-move="${i}" title="移动分组" style="font-size:12px;cursor:pointer">⇪</span><span class="delx" data-del="${i}" style="font-size:12px">✕</span></span>`).join('')||'<div class="empty">还没有字卡</div>'}
        </div>
      </div>
      <button class="btn danger block" id="delCate">删除此分类</button>`;
    $('cardBack').addEventListener('click',()=>{ cardCate=-1; draw(); });
    $('renameCate').addEventListener('click',()=>{
      const mk=openModal('修改分类名称',`
        <div class="field" style="margin-bottom:0"><input id="rnInput" value="${escapeHtml(c.name)}" maxlength="12"></div>`,()=>{
        const name=mk.querySelector('#rnInput').value.trim();
        if(!name){ toast('名称不能为空'); return false; }
        if(name!==c.name&&state.cats.some(x=>x.name===name)){ toast('已有同名分类'); return false; }
        c.name=name; save(); draw(); toast('已改名为「'+name+'」');
      });
      setTimeout(()=>{ const i=mk.querySelector('#rnInput'); if(i){i.focus();i.select();} },60);
    });
    $('batchAdd').addEventListener('click',()=>{
      const lines=$('batchInput').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      let added=0,dup=0;
      lines.forEach(l=>{ if(c.cards.includes(l))dup++; else{c.cards.push(l);added++;} });
      $('batchInput').value=''; save(); draw();
      toast(added?`已添加 ${added} 张${dup?`，跳过重复 ${dup} 张`:''}`:(dup?`全部重复`:'没有可添加的内容'));
    });
    /* v2.22.0：本分类内筛选 */
    const cf=$('cardFilter');
    if(cf)cf.addEventListener('input',()=>{
      const q=cf.value.trim().toLowerCase();
      body.querySelectorAll('#chipHost .chip').forEach(ch=>{
        ch.style.display=(!q||String(ch.dataset.t||'').toLowerCase().includes(q))?'':'none';
      });
    });
    body.querySelectorAll('[data-del]').forEach(el=>el.addEventListener('click',()=>{
      c.cards.splice(+el.dataset.del,1); save(); draw();
    }));
    /* 字卡移动分组 */
    body.querySelectorAll('[data-move]').forEach(el=>el.addEventListener('click',()=>{
      const idx=+el.dataset.move;
      const others=state.cats.map((x,i)=>({x,i})).filter(o=>o.i!==cardCate);
      if(!others.length)return toast('只有这一个分类，无法移动');
      const sheet=document.createElement('div');
      sheet.className='action-sheet';
      sheet.innerHTML=`
        <div class="sheet-mask"></div>
        <div class="sheet-panel">
          <div style="font-weight:800;font-size:15px;margin-bottom:4px">⇪ 移动字卡</div>
          <div class="desc" style="margin-bottom:12px">「${escapeHtml(c.cards[idx])}」移动到：</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;max-height:46vh;overflow-y:auto">
            ${others.map(o=>`<span class="chip mv-chip" data-i="${o.i}" style="background:#f4f4f6;border-radius:14px;padding:8px 13px;font-size:13px;cursor:pointer">${escapeHtml(o.x.name)}（${o.x.cards.length}）</span>`).join('')}
          </div>
        </div>`;
      document.getElementById('phone').appendChild(sheet);
      sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
      sheet.querySelectorAll('.mv-chip').forEach(ch=>ch.addEventListener('click',()=>{
        const target=state.cats[+ch.dataset.i];
        if(target.cards.includes(c.cards[idx])){ toast('目标分类已有这张字卡，跳过'); }
        else{ target.cards.push(c.cards[idx]); c.cards.splice(idx,1); save(); toast('已移动到「'+target.name+'」'); }
        sheet.remove(); draw();
      }));
    }));
    $('delCate').addEventListener('click',()=>{
      openModal('删除分类',`<div style="font-size:14px;line-height:1.7">确定删除分类「${escapeHtml(c.name)}」及其全部 ${c.cards.length} 张字卡？</div>`,()=>{
        state.cats.splice(cardCate,1); cardCate=-1; save(); draw(); toast('已删除');
      });
    });
  }
  /* ---------- 专用字卡库：每位联系人独立一套 ---------- */
  function drawPrivList(){
    const cs=state.contacts;
    const spv=clampPrivWeight(state.settings?state.settings.privWeight:1);
    body.innerHTML=`
      ${segHtml()}
      <div class="card">
        <div class="title">${I('letter',16)} 专用字卡库 <span class="count">${Object.keys(state.privLibs).length} 位已创建</span></div>
        <div class="desc">为指定联系人单独建一套专属语料：开启后，ta 说话时<b>公用字卡和专用字卡合成一个大卡池一起抽</b>（不再是谁占大头全看某一边）。<br>下面的「加权倍率」决定专用卡在这个大池里的分量：<b>1 = 与公用卡同权</b>（专用几张就只占几份），调高则专用卡更容易被抽到。</div>
        ${probRow('privWeight','专用字卡加权倍率','每张专用字卡按多少张公用字卡参与抽取（1 = 纯按张数比例）',spv,'×',50,1)}
        <div style="margin-top:12px">
          ${cs.map(c=>{ const lib=state.privLibs[c.id]; return `
            <div class="rowline" data-pw="${c.id}" style="cursor:pointer;padding:11px 0;border-bottom:1px solid var(--line)">
              <div style="flex:1;min-width:0;display:flex;align-items:center;gap:10px">
                ${wmAvatar(c.id,c.name,'sm')}
                <div style="min-width:0">
                  <div class="name">${escapeHtml(c.name)}</div>
                  <div class="meta">${lib?(lib.enabled?'已开启':'已停用')+' · '+(lib.cats||[]).length+' 个分类 · '+(lib.cats||[]).reduce((n,x)=>n+x.cards.length,0)+' 张':'未创建'}</div>
                </div>
              </div>
              <div class="right">
                ${lib?`<button class="switch ${lib.enabled?'on':''}" data-plib="${c.id}"></button>`:''}
                <span class="count">›</span>
              </div>
            </div>`;}).join('')||'<div class="empty">先去添加联系人</div>'}
        </div>
      </div>`;
    const sp=document.getElementById('privWeight');
    if(sp){
      sp.addEventListener('input',()=>{ const v=document.getElementById('privWeightVal'); if(v)v.textContent=sp.value+'×'; });
      sp.addEventListener('change',()=>{ state.settings.privWeight=clampPrivWeight(sp.value); save(); toast('专用字卡加权 '+state.settings.privWeight+'×'); });
    }
    body.querySelectorAll('[data-plib]').forEach(el=>el.addEventListener('click',e=>{
      e.stopPropagation();
      const id=el.dataset.plib;
      state.privLibs[id]=state.privLibs[id]||{enabled:true,cats:[]};
      state.privLibs[id].enabled=!state.privLibs[id].enabled;
      save(); draw();
      toast(state.privLibs[id].enabled?'已开启 '+contactName(id)+' 的专用字卡':'已停用 '+contactName(id)+' 的专用字卡');
    }));
    body.querySelectorAll('[data-pw]').forEach(el=>el.addEventListener('click',()=>{
      privWho=el.dataset.pw; privCate=-1; draw();
    }));
  }
  function drawPrivDetail(){
    const c=state.contacts.find(x=>x.id===privWho);
    if(!c){ privWho=null; drawPrivList(); return; }
    const lib=state.privLibs[privWho]=state.privLibs[privWho]||{enabled:true,cats:[]};
    if(!Array.isArray(lib.cats))lib.cats=[];
    function drawCatsView(){
      body.innerHTML=`
        ${segHtml()}
        <div class="backrow" style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <button class="iconbtn" id="privBack">‹</button>
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:9px">
            ${wmAvatar(c.id,c.name,'sm')}
            <div><div style="font-weight:800;font-size:16px">${escapeHtml(c.name)} 的专用字卡</div>
            <div style="font-size:11px;color:var(--ink-2)">${lib.cats.length} 个分类 · ${lib.cats.reduce((n,x)=>n+x.cards.length,0)} 张字卡</div></div>
          </div>
          <button class="switch ${lib.enabled?'on':''}" id="privToggle" title="开启 / 停用"></button>
        </div>
        <div class="card" style="padding:6px 16px">
          <div class="title" style="padding-top:14px">${I('scale',15)} 这一位的专用卡分量</div>
          ${probRow('privWhoWeight','专用字卡加权倍率（仅此人生效）','留空=跟随全局；调高=这位联系人的专用卡在大卡池里更常被抽到',(lib.weight===undefined||lib.weight===null||lib.weight==='')?clampPrivWeight(state.settings.privWeight):clampPrivWeight(lib.weight),'×',50,1)}
          <button class="btn ghost small block" id="privWhoWeightReset" style="margin:10px 0 14px">跟随全局（${clampPrivWeight(state.settings.privWeight)}×）</button>
        </div>
        <div class="card" style="padding:6px 16px">
          ${lib.cats.map((cat,i)=>`
            <div class="rowline" data-pi="${i}" style="cursor:pointer">
              <div style="flex:1;min-width:0">
                <div class="name">${escapeHtml(cat.name)}</div>
                <div class="meta">${cat.cards.length} 张 · ${cat.enabled?'参与抽卡':'已停用'}</div>
              </div>
              <div class="right">
                <button class="iconbtn" data-prename="${i}" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center">${I('pen',14)}</button>
                <span class="count">›</span>
                <button class="switch ${cat.enabled?'on':''}" data-ptoggle="${i}"></button>
              </div>
            </div>`).join('')||'<div class="empty" style="padding:14px 0">还没有分类，先新建一个</div>'}
        </div>
        <div class="card">
          <div class="title">${I('plus',15)} 新建分类</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <input id="privNewName" placeholder="分类名称" maxlength="12" style="flex:1;border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:14px;outline:none;background:#fafafa">
            <button class="btn" id="privAddCate">创建</button>
          </div>
        </div>
        ${lib.cats.length?'':'<button class="btn danger block" id="privDelLib">删除整套专用字卡库</button>'}`;
      $('privBack').addEventListener('click',()=>{ privWho=null; draw(); });
      $('privToggle').addEventListener('click',()=>{ lib.enabled=!lib.enabled; save(); draw(); toast(lib.enabled?'专用字卡已开启':'专用字卡已停用'); });
      const wEl=$('privWhoWeight');
      if(wEl){
        wEl.addEventListener('input',()=>{ const v=$('privWhoWeightVal'); if(v)v.textContent=wEl.value+'×'; });
        wEl.addEventListener('change',()=>{ lib.weight=clampPrivWeight(wEl.value); save(); toast(contactName(privWho)+' 的专用字卡加权 '+lib.weight+'×'); });
      }
      const wRst=$('privWhoWeightReset');
      if(wRst)wRst.addEventListener('click',()=>{ delete lib.weight; save(); draw(); toast('已改为跟随全局 '+clampPrivWeight(state.settings.privWeight)+'×'); });
      body.querySelectorAll('[data-pi]').forEach(el=>el.addEventListener('click',e=>{
        if(e.target.closest('[data-ptoggle]')||e.target.closest('[data-prename]'))return;
        privCate=+el.dataset.pi; draw();
      }));
      body.querySelectorAll('[data-ptoggle]').forEach(el=>el.addEventListener('click',()=>{
        lib.cats[+el.dataset.ptoggle].enabled=!lib.cats[+el.dataset.ptoggle].enabled; save(); draw();
      }));
      body.querySelectorAll('[data-prename]').forEach(el=>el.addEventListener('click',()=>{
        const cat=lib.cats[+el.dataset.prename];
        const mk=openModal('修改分类名称',`<div class="field" style="margin-bottom:0"><input id="rnInput" value="${escapeHtml(cat.name)}" maxlength="12"></div>`,()=>{
          const name=mk.querySelector('#rnInput').value.trim();
          if(!name){ toast('名称不能为空'); return false; }
          if(name!==cat.name&&lib.cats.some(x=>x.name===name)){ toast('已有同名分类'); return false; }
          cat.name=name; save(); draw(); toast('已改名为「'+name+'」');
        });
        setTimeout(()=>{ const i=mk.querySelector('#rnInput'); if(i){i.focus();i.select();} },60);
      }));
      $('privAddCate').addEventListener('click',()=>{
        const name=$('privNewName').value.trim();
        if(!name)return toast('先填写分类名称');
        if(lib.cats.some(x=>x.name===name))return toast('已有同名分类');
        lib.cats.push({name,enabled:true,cards:[]});
        save(); draw(); toast('已创建「'+name+'」');
      });
      const del=$('privDelLib');
      if(del)del.addEventListener('click',()=>{
        openModal('删除专用字卡库',`<div style="font-size:14px;line-height:1.7">确定删除「${escapeHtml(c.name)}」的整套专用字卡库？</div>`,()=>{
          delete state.privLibs[privWho]; privWho=null; save(); draw(); toast('已删除');
        });
      });
    }
    function drawCardsView(){
      const cat=lib.cats[privCate];
      if(!cat){ privCate=-1; drawCatsView(); return; }
      body.innerHTML=`
        ${segHtml()}
        <div class="backrow" style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <button class="iconbtn" id="privCateBack">‹</button>
          <div style="flex:1"><div style="font-weight:800;font-size:17px">${escapeHtml(cat.name)}</div>
          <div style="font-size:11px;color:var(--ink-2)">${escapeHtml(c.name)} 专用 · ${cat.cards.length} 张字卡</div></div>
          <button class="iconbtn" id="privRenameCate" style="display:flex;align-items:center;justify-content:center">${I('pen',15)}</button>
        </div>
        <div class="card">
          <div class="title">${I('plus',15)} 批量添加</div>
          <div class="desc">每行一条，自动拆分为字卡（重复自动跳过）</div>
          <div style="margin-top:10px"><textarea id="privBatchInput" placeholder="字卡一&#10;字卡二"></textarea></div>
          <button class="btn block" id="privBatchAdd" style="margin-top:10px">添加到当前分类</button>
        </div>
        <div class="card">
          <div class="title">${I('folder',15)} 全部字卡 <span class="count">${cat.cards.length}</span></div>
          <div class="desc" style="margin-top:4px">点 ⇪ 可移动到这套专用库的其他分类</div>
          <div style="margin-top:10px"><input id="privFilter" placeholder="在本分类里筛选…" style="width:100%;border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:13.5px;outline:none;background:#fafafa"></div>
          <div id="privChipHost" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
            ${cat.cards.map((t,i)=>`<span class="chip" data-t="${escapeHtml(t)}" style="background:#f4f4f6;border-radius:14px;padding:7px 12px;font-size:13px;display:inline-flex;align-items:center;gap:7px;word-break:break-all">${escapeHtml(t)}<span class="delx" data-pmove="${i}" style="font-size:12px;cursor:pointer">⇪</span><span class="delx" data-pdel="${i}" style="font-size:12px">✕</span></span>`).join('')||'<div class="empty">还没有字卡</div>'}
          </div>
        </div>
        <button class="btn danger block" id="privDelCate">删除此分类</button>`;
      $('privCateBack').addEventListener('click',()=>{ privCate=-1; draw(); });
      $('privRenameCate').addEventListener('click',()=>{
        const mk=openModal('修改分类名称',`<div class="field" style="margin-bottom:0"><input id="rnInput" value="${escapeHtml(cat.name)}" maxlength="12"></div>`,()=>{
          const name=mk.querySelector('#rnInput').value.trim();
          if(!name){ toast('名称不能为空'); return false; }
          if(name!==cat.name&&lib.cats.some(x=>x.name===name)){ toast('已有同名分类'); return false; }
          cat.name=name; save(); draw(); toast('已改名为「'+name+'」');
        });
        setTimeout(()=>{ const i=mk.querySelector('#rnInput'); if(i){i.focus();i.select();} },60);
      });
      $('privBatchAdd').addEventListener('click',()=>{
        const lines=$('privBatchInput').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        let added=0,dup=0;
        lines.forEach(l=>{ if(cat.cards.includes(l))dup++; else{cat.cards.push(l);added++;} });
        $('privBatchInput').value=''; save(); draw();
        toast(added?`已添加 ${added} 张${dup?`，跳过重复 ${dup} 张`:''}`:(dup?'全部重复':'没有可添加的内容'));
      });
      body.querySelectorAll('[data-pdel]').forEach(el=>el.addEventListener('click',()=>{
        cat.cards.splice(+el.dataset.pdel,1); save(); draw();
      }));
      /* v2.22.0：专用字卡本分类内筛选 */
      const pf=$('privFilter');
      if(pf)pf.addEventListener('input',()=>{
        const q=pf.value.trim().toLowerCase();
        body.querySelectorAll('#privChipHost .chip').forEach(ch=>{
          ch.style.display=(!q||String(ch.dataset.t||'').toLowerCase().includes(q))?'':'none';
        });
      });
      body.querySelectorAll('[data-pmove]').forEach(el=>el.addEventListener('click',()=>{
        const idx=+el.dataset.pmove;
        const others=lib.cats.map((x,i)=>({x,i})).filter(o=>o.i!==privCate);
        if(!others.length)return toast('专用库里只有这一个分类');
        const sheet=document.createElement('div');
        sheet.className='action-sheet';
        sheet.innerHTML=`
          <div class="sheet-mask"></div>
          <div class="sheet-panel">
            <div style="font-weight:800;font-size:15px;margin-bottom:4px">⇪ 移动字卡</div>
            <div class="desc" style="margin-bottom:12px">「${escapeHtml(cat.cards[idx])}」移动到：</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;max-height:46vh;overflow-y:auto">
              ${others.map(o=>`<span class="chip pmv-chip" data-i="${o.i}" style="background:#f4f4f6;border-radius:14px;padding:8px 13px;font-size:13px;cursor:pointer">${escapeHtml(o.x.name)}（${o.x.cards.length}）</span>`).join('')}
            </div>
          </div>`;
        document.getElementById('phone').appendChild(sheet);
        sheet.querySelector('.sheet-mask').addEventListener('click',()=>sheet.remove());
        sheet.querySelectorAll('.pmv-chip').forEach(ch=>ch.addEventListener('click',()=>{
          const target=lib.cats[+ch.dataset.i];
          if(target.cards.includes(cat.cards[idx])){ toast('目标分类已有这张字卡，跳过'); }
          else{ target.cards.push(cat.cards[idx]); cat.cards.splice(idx,1); save(); toast('已移动到「'+target.name+'」'); }
          sheet.remove(); draw();
        }));
      }));
      $('privDelCate').addEventListener('click',()=>{
        openModal('删除分类',`<div style="font-size:14px;line-height:1.7">确定删除分类「${escapeHtml(cat.name)}」及其全部 ${cat.cards.length} 张字卡？</div>`,()=>{
          lib.cats.splice(privCate,1); privCate=-1; save(); draw(); toast('已删除');
        });
      });
    }
    if(privCate<0) drawCatsView(); else drawCardsView();
  }
  function draw(){
    if(cardsTab==='pat'){
      /* 拍一拍页签：复用拍一拍库的内容区 */
      body.innerHTML=`${segHtml()}<div id="cardPatHost"></div>`;
      renderPatPanel($('cardPatHost'),draw);
      return;
    }
    if(cardsTab==='priv'){ if(privWho===null) drawPrivList(); else drawPrivDetail(); return; }
    if(cardCate<0) drawCats(); else drawDetail();
  }
  extra.classList.add('hide');
  draw();
}

/* ================= 拍一拍库（独立 App：双向两组文案） =================
   me = 我拍ta 可用；ta = ta拍我（含 ta 主动拍我 / 回拍）可用。
   词卡内容为「动作部分」，展示时由 patText() 套成「xx拍了xx」，自动适配双方名字。 */
let patTab='me';
function renderPatLib(body,extra){
  const draw=()=>{
    /* v2.19.0：方向切换只保留 renderPatPanel 内部的那一个（修复方向组件重复出现两个） */
    body.innerHTML=`<div id="patLibHost"></div>`;
    renderPatPanel($('patLibHost'),draw);
  };
  extra.classList.add('hide');
  draw();
}
/* 拍一拍内容区（字卡库「拍一拍」页签 与 独立拍一拍 App 共用） */
function renderPatPanel(host,redraw){
  const lib=state.patLib||(state.patLib={me:[],ta:[]});
  const s=state.settings;
  if(patTab!=='me'&&patTab!=='ta') patTab='me';
  const taName=contactName(state.contacts[0]&&state.contacts[0].id)||(state.contacts[0]&&state.contacts[0].name)||'ta';
  const sampleName = patTab==='me'?(s.myName||'我'):taName;
  const otherName  = patTab==='me'?taName:(s.myName||'我');

  host.innerHTML=`
    <div class="seg" style="margin-bottom:12px">
      <button class="${patTab==='me'?'on':''}" data-ptab2="me">${I('pat',13)} 我拍ta</button>
      <button class="${patTab==='ta'?'on':''}" data-ptab2="ta">${I('hand2',13)} ta拍我</button>
    </div>
    <div class="card">
      <div class="title">${patTab==='me'?I('pat',15)+' 我拍ta 的词卡':I('hand2',15)+' ta拍我 的词卡'} <span class="count">${(lib[patTab]||[]).length} 张</span></div>
      <div class="desc" style="margin-bottom:10px">
        词卡有三种写法，发送时自动适配双方名字与人称：<br>
        · 纯动作片段：<code>的脑门</code>（自动补成「拍了拍+片段」）<br>
        · 双向互动句：<code>戳了戳{ta}的脸颊</code>、<code>拍了拍你的肩膀</code>（<code>{ta}</code>=对方名字、<code>{me}</code>=我的名字；句中「你」换成对方、「我」换成说话方）<br>
        · 单方动作句：<code>发送了一个爱心</code>、<code>敲了敲木鱼，功德加一</code>（完整动作句直接原样套用，不补「拍了拍」）<br>
        ${patTab==='me'
          ?'你在聊天里拍 ta 时用这组词卡。'
          :'ta 主动拍你、或你拍 ta 后 ta 回拍你时，用这组词卡。'}
      </div>
      <div style="margin-top:10px"><textarea id="patInput" placeholder="词卡一&#10;词卡二（每行一条）"></textarea></div>
      <div style="display:flex;gap:9px;margin-top:10px;flex-wrap:wrap">
        <button class="btn" id="patAdd">批量添加</button>
        <button class="btn ghost" id="patCopy">复制「${patTab==='me'?'ta拍我':'我拍ta'}」的词卡过来</button>
      </div>
    </div>
    <div class="card">
      <div class="title">${I('folder',15)} 词卡预览 <span class="count">点一下可改</span></div>
      <div class="desc" style="margin-bottom:10px">展示的是实际发送效果；点词卡可直接编辑，右上角可以删除。</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
        ${(lib[patTab]||[]).map((t,i)=>`<span class="chip pat-item" data-edit="${i}" style="background:#f4f4f6;border-radius:14px;padding:7px 12px;font-size:13px;display:inline-flex;align-items:center;gap:7px;word-break:break-all;cursor:pointer">
          ${escapeHtml(patText(sampleName,t,otherName))}<span class="delx" data-del="${i}" style="font-size:12px">✕</span></span>`).join('')||'<div class="empty">还没有词卡，在上面文本框里每行写一条即可添加</div>'}
      </div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('dice',15)} 他使用拍一拍的概率</div>
      ${probRow('patProb','他使用拍一拍的概率','ta 主动拍你、以及你拍 ta 后 ta 回拍你的概率',s.patProb??20)}
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('bulb',15)} 提示</div>
      <div class="desc">聊天页点「拍一拍」会弹出方向选择（我拍ta / ta拍我），两个方向各取本页对应组的词卡。<br>你和 ta <b>都可以拍</b>：你拍 ta 用「我拍ta」组，ta 拍你用「ta拍我」组。</div>
    </div>`;

  host.querySelectorAll('[data-ptab2]').forEach(el=>el.addEventListener('click',()=>{
    patTab=el.dataset.ptab2; redraw();
  }));
  const list=lib[patTab]||(lib[patTab]=[]);
  const addBtn=host.querySelector('#patAdd');
  if(addBtn)addBtn.addEventListener('click',()=>{
    const lines=(host.querySelector('#patInput').value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    let added=0,dup=0;
    lines.forEach(l=>{ if(list.includes(l))dup++; else{list.push(l);added++;} });
    host.querySelector('#patInput').value=''; save(); redraw();
    toast(added?`已添加 ${added} 张${dup?`，跳过重复 ${dup} 张`:''}`:(dup?'全部重复':'没有可添加的内容'));
  });
  const cpBtn=host.querySelector('#patCopy');
  if(cpBtn)cpBtn.addEventListener('click',()=>{
    const other=lib[patTab==='me'?'ta':'me']||[];
    let added=0;
    other.forEach(l=>{ if(!list.includes(l)){list.push(l);added++;} });
    save(); redraw();
    toast(added?`已复制 ${added} 张`:'没有新的可复制');
  });
  host.querySelectorAll('.pat-item .delx').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    list.splice(+el.dataset.del,1); save(); redraw();
  }));
  /* 点一下词卡 → 改名（简化交互，避免双击在移动端不灵） */
  host.querySelectorAll('.pat-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const i=+el.dataset.edit;
      openModal('编辑词卡','<div class="field" style="margin-bottom:0"><label>动作部分（自动套成「'+escapeHtml(sampleName)+'拍…」）</label><input id="patEditIn" maxlength="40" value="'+escapeHtml(list[i])+'"></div>',()=>{
        const v=(document.querySelector('#patEditIn').value||'').trim();
        if(!v){ toast('不能为空'); return false; }
        list[i]=v; save(); redraw(); toast('已修改');
      });
    });
  });
}
/* ================= 主题 ================= */
const ACCENTS=[['墨黑','#1c1c1e'],['雾蓝','#5b7a9d'],['樱粉','#d98a9e'],['抹茶','#7a9d7f'],['暖棕','#a0826d'],['紫灰','#8a7f9d']];
const BUBBLES=[['经典',18],['圆软',24],['方糖',6]];
const WALLS=[['波点','dots'],['条纹','stripe'],['纯色','plain']];
/* ============ 主题页：顶部方块导航 + 分面板（v2.13.0 起） ============ */
let themeTab='color';   /* color | bubble | font | wall | css */
function renderTheme(body,extra){
  const s=state.settings;
  const TABS=[
    ['color','palette','配色'],
    ['bubble','bubble','气泡'],
    ['font','fontIc','字体'],
    ['wall','image','壁纸'],
    ['css','doc','高级'],
  ];
  if(!TABS.some(t=>t[0]===themeTab)) themeTab='color';

  /* 方块入口：未选具体功能时只看得到方块，点进去才是功能内容（缩短页面） */
  const head=`
    <div class="tabbar">
      ${TABS.map(([id,ic,nm])=>`<button class="tbtn ${themeTab===id?'on':''}" data-ttab="${id}">
        <i class="ti" style="display:flex">${I(ic,19)}</i><span class="tn">${nm}</span></button>`).join('')}
    </div>
    <div class="tab-head">
      <span class="th-title" style="display:flex;align-items:center;gap:6px">${I(TABS.find(t=>t[0]===themeTab)[1],16)} ${TABS.find(t=>t[0]===themeTab)[2]}</span>
      <span class="th-sub">${themeTabSub()}</span>
    </div>`;

  body.innerHTML = head + themePanel(s);
  bindTheme(body,extra);
}
function themeTabSub(){
  const s=state.settings;
  if(themeTab==='color') return s.darkMode?'夜间':'白天';
  if(themeTab==='bubble') return '共 '+((state.bubblePresets||[]).length)+' 款';
  if(themeTab==='font') return '共 '+FONTS.length+' 款';
  if(themeTab==='wall') return ({plain:'纯色',dots:'波点',stripe:'条纹',img:'图片'}[s.wallpaper.type]||'默认');
  return '自定义 CSS';
}
/* 各分面板内容 */
function themePanel(s){
  if(themeTab==='color') return themePanelColor(s);
  if(themeTab==='bubble') return themePanelBubble(s);
  if(themeTab==='font') return themePanelFont(s);
  if(themeTab==='wall') return themePanelWall(s);
  return themePanelCss(s);
}
function themePanelColor(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:12px">主题配色</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${ACCENTS.map(([n,c])=>`<div data-accent="${c}" style="cursor:pointer;text-align:center">
          <div style="width:44px;height:44px;border-radius:50%;background:${c};border:3px solid ${s.accent===c?'var(--ink)':'transparent'};box-shadow:var(--shadow)"></div>
          <div style="font-size:11px;margin-top:4px;color:var(--ink-2)">${n}</div></div>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('moonHalf',16)} 夜间模式</div>
      <div class="rowline" style="padding-top:0">
        <div style="flex:1"><div class="name">深色界面</div><div class="meta">所有界面切换为深色，夜里不刺眼</div></div>
        <button class="switch ${s.darkMode?'on':''}" id="thDarkSwitch"></button>
      </div>
      <div class="seg" style="margin-top:4px">
        <button class="${s.darkMode===false?'on':''}" data-dmode="light">${I('sun',14)} 白天</button>
        <button class="${s.darkMode===true?'on':''}" data-dmode="dark">${I('moon',14)} 夜间</button>
      </div>
    </div>`;
}
function themePanelBubble(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('bubble',16)} 聊天气泡 <span class="count">${(state.bubblePresets||[]).length} 款</span></div>
      <div class="desc" style="margin-bottom:10px">一键切换气泡外观，无需写 CSS；也可以在下方粘贴 CSS 存成自己的气泡（可改名、可删除）。</div>
      <div class="bub-grid">
        ${(state.bubblePresets||[]).map(p=>`
          <div class="bub-card ${(s.bubbleStyle||'')===p.id?'sel':''}" data-bpick="${p.id}">
            ${(s.bubbleStyle||'')===p.id?'<span class="bub-on">使用中</span>':''}
            <div class="bub-demo" style="${bubPreviewStyle(p)}">你好呀，今天也要开心哦</div>
            <div class="bub-nm">${escapeHtml(p.name)}${p.builtin?'':'<span class="count">自定</span>'}</div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:9px;margin-top:12px;flex-wrap:wrap">
        <button class="btn small" id="bubPasteNew">＋ 粘贴 CSS 新建气泡</button>
        <button class="btn small ghost" id="bubRenameCur">重命名当前</button>
        <button class="btn small ghost" id="bubDelCur">删除当前</button>
      </div>
      <div class="desc" style="margin-top:10px">想让某个人用不一样的气泡？进ta的聊天页 → 更多互动 → 「ta的气泡」单独设置。</div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:12px">气泡圆角</div>
      <div class="seg">${BUBBLES.map(([n,r])=>`<button class="${s.bubbleR===r?'on':''}" data-bub="${r}">${n}</button>`).join('')}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:6px"><div class="bubble" style="max-width:60%">预览：今天也很想你</div></div>
    </div>`;
}
function themePanelFont(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('fontIc',16)} 聊天字体</div>
      <div class="desc" style="margin-bottom:10px">只作用在聊天气泡里的文字，不影响其他界面。</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${FONTS.map(f=>`
          <div class="font-row ${(s.bubbleFont||'')===f.id?'sel':''}" data-fontpick="${f.id}">
            ${(s.bubbleFont||'')===f.id?'<span class="bub-on">使用中</span>':''}
            <div class="font-demo" style="${f.id?f.css.replace('.bubble{','').replace('}',''):''}">今天也很想你 · 晚安</div>
            <div class="font-nm">${f.name}</div>
          </div>`).join('')}
      </div>
    </div>`;
}
function themePanelWall(s){
  const wn={plain:'纯色',dots:'波点',stripe:'条纹',img:'图片'}[s.wallpaper.type]||'默认';
  return `
    <div class="card">
      <div class="title" style="margin-bottom:12px">主桌面壁纸 <span class="count">${wn}</span></div>
      <div class="seg">${WALLS.map(([n,t])=>`<button class="${s.wallpaper.type===t?'on':''}" data-wall="${t}">${n}</button>`).join('')}</div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn ghost block" id="wallUpload">上传自定义壁纸</button>
        ${s.wallpaper.type==='img'?'<button class="btn danger block" id="wallClear">移除壁纸</button>':''}
      </div>
      <input type="file" id="wallFile" accept="image/*" style="display:none">
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:12px">聊天背景壁纸</div>
      <div class="seg">
        <button class="${s.chatWallpaper.type==='plain'?'on':''}" data-cwall="plain">纯色</button>
        <button class="${s.chatWallpaper.type==='dots'?'on':''}" data-cwall="dots">波点</button>
        <button class="${s.chatWallpaper.type==='stripe'?'on':''}" data-cwall="stripe">条纹</button>
        <button class="${s.chatWallpaper.type==='img'?'on':''}" data-cwall="img">图片</button>
      </div>
      ${s.chatWallpaper.type==='img'
        ?`<div style="display:flex;gap:10px;align-items:center">
            ${s.chatWallpaper.data?`<img src="${s.chatWallpaper.data}" style="width:72px;height:72px;object-fit:cover;border-radius:14px;box-shadow:var(--shadow)">`:''}
            <button class="btn ghost block" id="cwallUpload">更换图片</button>
          </div>`
        :`<div class="desc">选择一种默认底纹，或切换到「图片」上传自定义聊天壁纸</div>`}
      <input type="file" id="cwallFile" accept="image/*" style="display:none">
    </div>`;
}
function themePanelCss(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:8px">自定义 CSS</div>
      <div class="desc" style="margin-bottom:10px">
        直接写 CSS 即可全局生效，可用于美化气泡、头像、字体等。<br>
        <b>气泡的类名是 <code>.bubble</code></b>：我发的是 <code>.row.me .bubble</code>，ta 发的是 <code>.row:not(.me) .bubble</code>。<br>
        例：<code>.row.me .bubble{background:#fff8ec !important;}</code>
      </div>
      <textarea id="userCssInput" style="min-height:150px;font-family:monospace;font-size:12px" placeholder=".row.me .bubble{ ... }">${escapeHtml(s.userCss||'')}</textarea>
      <button class="btn block" id="userCssSave" style="margin-top:10px">应用 CSS</button>
    </div>`;
}
/* 主题页事件绑定（切 tab 时重绘整页） */
function bindTheme(body,extra){
  const s=state.settings;
  const redraw=()=>renderTheme(body,extra);
  body.querySelectorAll('[data-ttab]').forEach(el=>el.addEventListener('click',()=>{
    themeTab=el.dataset.ttab; redraw(); body.scrollTop=0;
  }));
  body.querySelectorAll('[data-accent]').forEach(el=>el.addEventListener('click',()=>{
    s.accent=el.dataset.accent; save(); applyTheme(); redraw();
  }));
  const thDark=$('thDarkSwitch');
  if(thDark)thDark.addEventListener('click',()=>{
    s.darkMode=!s.darkMode; save(); applyTheme(); redraw();
    toast(s.darkMode?'夜间模式已开启':'已切回白天');
  });
  body.querySelectorAll('[data-dmode]').forEach(el=>el.addEventListener('click',()=>{
    s.darkMode = el.dataset.dmode==='dark';
    save(); applyTheme(); redraw();
    toast(s.darkMode?'夜间模式已开启':'已切回白天');
  }));
  body.querySelectorAll('[data-bpick]').forEach(el=>el.addEventListener('click',()=>{
    s.bubbleStyle=el.dataset.bpick;
    const p=(state.bubblePresets||[]).find(x=>x.id===s.bubbleStyle);
    save(); applyTheme(); redraw();
    toast('已应用气泡「'+(p?p.name:'')+'」');
  }));
  const bpNew=$('bubPasteNew');
  if(bpNew)bpNew.addEventListener('click',()=>pasteBubbleCss(redraw));
  const bpRen=$('bubRenameCur');
  if(bpRen)bpRen.addEventListener('click',()=>{
    const p=(state.bubblePresets||[]).find(x=>x.id===s.bubbleStyle); if(!p)return;
    openModal('重命名气泡','<div class="field" style="margin-bottom:0"><label>气泡名称</label><input id="bubNm2" maxlength="14" value="'+escapeHtml(p.name)+'"></div>',()=>{
      const n=document.querySelector('#bubNm2').value.trim();
      if(!n){ toast('名称不能为空'); return false; }
      p.name=n; save(); redraw(); toast('已重命名为「'+n+'」');
    });
  });
  const bpDel=$('bubDelCur');
  if(bpDel)bpDel.addEventListener('click',()=>{
    const p=(state.bubblePresets||[]).find(x=>x.id===s.bubbleStyle);
    if(!p)return;
    if(p.builtin)return toast('内置气泡不能删除，可以先改名再调整');
    openModal('删除气泡',`<div style="font-size:14px;line-height:1.7">确定删除自定义气泡「${escapeHtml(p.name)}」？<br>用到它的联系人会自动回到「跟随全局」。</div>`,()=>{
      state.bubblePresets=state.bubblePresets.filter(x=>x.id!==p.id);
      state.contacts.forEach(c=>{ if(c.bubbleId===p.id)c.bubbleId=''; });
      (state.groups||[]).forEach(g=>{ if(g.bubbleId===p.id)g.bubbleId=''; });
      s.bubbleStyle='bp-classic';
      save(); applyTheme(); redraw(); toast('已删除');
    });
  });
  body.querySelectorAll('[data-fontpick]').forEach(el=>el.addEventListener('click',()=>{
    s.bubbleFont=el.dataset.fontpick;
    save(); applyTheme(); redraw();
    const f=FONTS.find(x=>x.id===s.bubbleFont);
    toast('字体已切换为「'+(f?f.name:'系统默认')+'」');
  }));
  body.querySelectorAll('[data-bub]').forEach(el=>el.addEventListener('click',()=>{
    s.bubbleR=+el.dataset.bub; save(); applyTheme(); redraw();
  }));
  body.querySelectorAll('[data-wall]').forEach(el=>el.addEventListener('click',()=>{
    s.wallpaper={type:el.dataset.wall,data:s.wallpaper.type==='img'?s.wallpaper.data:''}; save(); applyTheme(); redraw();
  }));
  body.querySelectorAll('[data-cwall]').forEach(el=>el.addEventListener('click',()=>{
    s.chatWallpaper={type:el.dataset.cwall,data:el.dataset.cwall==='img'?s.chatWallpaper.data:''};
    save(); applyChatWallpaper(); redraw();
  }));
  const wu=$('wallUpload');
  if(wu){
    wu.addEventListener('click',()=>$('wallFile').click());
    $('wallFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=()=>{ compressImage(r.result,720,dataUrl=>{
        s.wallpaper={type:'img',data:dataUrl}; save(); applyTheme(); redraw(); toast('壁纸已更换');
      }); };
      r.readAsDataURL(f);
    });
  }
  const wc=$('wallClear');
  if(wc)wc.addEventListener('click',()=>{ s.wallpaper={type:'dots',data:''}; save(); applyTheme(); redraw(); });
  const cu=$('cwallUpload');
  if(cu){
    cu.addEventListener('click',()=>$('cwallFile').click());
    $('cwallFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=()=>{ compressImage(r.result,720,dataUrl=>{
        s.chatWallpaper={type:'img',data:dataUrl}; save(); applyChatWallpaper(); redraw(); toast('聊天壁纸已更换');
      }); };
      r.readAsDataURL(f);
    });
  }
  const us=$('userCssSave');
  if(us)us.addEventListener('click',()=>{
    s.userCss=$('userCssInput').value;
    save(); applyTheme(); toast('CSS 已应用');
  });
}
function compressImage(dataUrl,maxW,cb,quality){
  const img=new Image();
  img.onload=()=>{
    const scale=Math.min(1,maxW/img.width);
    const cv=document.createElement('canvas');
    cv.width=Math.max(1,Math.round(img.width*scale)); cv.height=Math.max(1,Math.round(img.height*scale));
    cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
    try{ cb(cv.toDataURL('image/jpeg',quality||0.82)); }catch(e){ cb(dataUrl); }
  };
  img.onerror=()=>cb(dataUrl);
  img.src=dataUrl;
}
/* v2.23.0：表情包智能压缩。
   开关开（默认）：≤300KB 原图直存；>300KB 压到最长边 480px / 质量 0.85；
   开关关：原图直存，但超过 1.2MB 仍强制压缩（保护 localStorage，避免存爆）。
   cb 统一回调压缩后的 dataURL。 */
let stkCompress=true;
const STK_SMALL=300*1024, STK_FORCE=1.2*1024*1024;
function smartStickerData(dataUrl,cb){
  const force=dataUrl.length>STK_FORCE;
  const tooBig=dataUrl.length>STK_SMALL;
  if(stkCompress&&tooBig) return compressImage(dataUrl,480,cb,0.85);
  if(force) return compressImage(dataUrl,720,cb,0.85);
  cb(dataUrl);
}

function renderChatListRefresh(){
  if(currentApp==='chat'&&!currentChatId)openApp('chat');
  else if(currentApp==='chat'&&currentChatId)renderChatMsgs();
}
let deskCheckTimer=null, proactiveTimer=null, dailyTimer=null;
function scheduleDeskCheck(){
  clearTimeout(deskCheckTimer);
  if(!state.settings.deskCheck||!state.contacts.length)return;
  deskCheckTimer=setTimeout(()=>{
    if(state.contacts.length){
      /* 按设置概率决定本轮是否触发查岗 */
      if(Math.random()*100 < (state.settings.deskCheckProb??50)){
        const c=pick(state.contacts);
        pushChatMsg(c.id,'ta',pick(DESKCHECK_LINES));
        toast(c.name+' 来查岗了');
      }
    }
    scheduleDeskCheck();
  },randInt(5*60e3,12*60e3));
}
/* 联系人主动来电 / 主动拍一拍（不依赖查岗开关，始终低频运行） */
function scheduleProactive(){
  clearTimeout(proactiveTimer);
  proactiveTimer=setTimeout(()=>{
    if(state.contacts.length){
      const c=pick(state.contacts);
      const s=state.settings;
      if(Math.random()*100 < (s.callInProb??25)){
        incomingCall(c.id);
        toast(c.name+' 来电了');
      }else if(Math.random()*100 < 15){ /* 主动用词卡拍你一下 */
        const lib=state.patLib||[];
        const line=lib.length?pick(lib):'拍了拍你';
        pushChatMsg(c.id,'sys',`「${c.name}」${line}`);
      }
    }
    scheduleProactive();
  },randInt(8*60e3,20*60e3));
}
/* 联系人主动发消息（v2.20.0）：设置开关开启时，每 30 分钟判定一次，
   40% 概率随机挑一位联系人主动发 1~3 条字卡消息（走 sendCardBatch，带「正在输入」与表情包概率）。
   正在回复中（pending 有队列）的会话不打断；返回是否真的发了，便于测试。 */
function proactiveMsgTick(){
  if(state.settings.proactiveMsg===false)return false;
  if(!state.contacts.length)return false;
  if(Math.random()>=0.4)return false;
  const c=pick(state.contacts);
  if(pending[c.id])return false;
  sendCardBatch(c.id,c.id);
  setTimeout(()=>toast(c.name+' 主动发来消息'),600);
  return true;
}
let proactiveMsgTimer=null;
function scheduleProactiveMsg(){
  clearTimeout(proactiveMsgTimer);
  proactiveMsgTimer=setTimeout(()=>{
    try{ proactiveMsgTick(); }catch(e){}
    scheduleProactiveMsg();
  },30*60e3);
}
/* ================= 每日行为引擎 ================= */
function inPeriod(){
  const today=new Date(); today.setHours(0,0,0,0);
  return state.period.records.some(d=>{
    const s=new Date(d+'T00:00:00'); if(isNaN(s))return false;
    const diff=Math.round((today-s)/864e5);
    return diff>=0&&diff<=4;
  });
}
/* 联系人写信正文：从字卡库挑 3~15 句（v2.18.0 由 2~4 上调） */
function buildLetterBody(cid){
  const n=randInt(3,15);
  const lines=[];
  for(let i=0;i<n;i++){
    const c=drawCard(['心语 · 长句','亲昵 · 情话','撒娇 · 粘人','关心 · 叮嘱'],cid)||drawCard(null,cid);
    if(c&&!lines.includes(c))lines.push(c);
  }
  return lines.join('\n')||'见字如面。今天也很想你。';
}
function dailyRollover(){
  const today=fmtDate(Date.now());
  if(state.dailyRoll===today)return;
  state.dailyRoll=today;
  if(state.contacts.length){
    /* 联系人主动发朋友圈 · 每日按设置概率（默认 40%），命中则发 1~2 条 */
    const mp=state.settings.momentProb??40;
    if(Math.random()*100<mp){
      const times=randInt(1,2);
      for(let i=0;i<times;i++){
        setTimeout(()=>{
          const cid=pick(state.contacts).id;
          addMomentByContact(cid);
          toast(contactName(cid)+' 发了新动态');
        }, i*randInt(2000,6000));
      }
    }
    /* 联系人主动写信：按设置概率（v2.24.15 默认 50%）；
       连续 2 天没写 → 第 3 天起自动抬到 80%（设置里调低也照样抬，只会更高不会更低） */
    const wroteToday=state.letters.some(l=>l.from!=='me'&&fmtDate(l.t)===today);
    if(!wroteToday){
      const base=state.settings.letterProb??50;
      const streakBoost=(state.letterStreak||0)>=2;
      const p=streakBoost?Math.max(base,80):base;
      if(Math.random()*100<p){
        const cid=pick(state.contacts).id;
        state.letters.push({id:'l'+Date.now(),from:cid,to:'me',
          title:pick(['给你的一封信','想和你说的话','夜深了，写给你','今日份想念','见字如面']),
          body:buildLetterBody(cid),t:Date.now(),reply:null,star:false});
        state.letterStreak=0;
        setTimeout(()=>toast('收到一封来自「'+contactName(cid)+'」的信'),5000);
      }else state.letterStreak=(state.letterStreak||0)+1;
    }
    /* 联系人写心情日记 · 每位联系人每日独立 40%（v2.19.0 由 30% 上调），随机从字卡库挑 1~3 句 */
    state.contacts.forEach(c=>{
      if(Math.random()*100<40){
        const n=randInt(1,3);
        const sentences=[];
        for(let i=0;i<n;i++){ const s=drawCard(['心语 · 长句','亲昵 · 情话','日常','情绪'],c.id)||drawCard(null,c.id); if(s)sentences.push(s); }
        if(sentences.length){
          state.diary.push({id:'d'+Date.now()+Math.random().toString(36).slice(2,5),author:c.id,mood:pick(MOODS),
            text:sentences.join('\n'),t:Date.now()});
          setTimeout(()=>toast(c.name+' 写了一篇日记'),8000);
        }
      }
    });
    /* 红包 · 联系人向我发红包：每日每位联系人独立 40% 概率向系统申请金额（金额无上限） */
    state.contacts.forEach(c=>{
      if(Math.random()*100<40){
        /* 向系统申请金额：随机生成，不设上限（偶有大额） */
        const amt=Math.round(rand(5, Math.random()<0.12?5200:520)*100)/100;
        state.coins=+(state.coins+amt).toFixed(2);
        pushChatMsg(c.id,'ta',String(amt),'rp',c.id);
        setTimeout(()=>toast(c.name+' 给你发了一个红包'),4000);
        setTimeout(()=>{ const cc=drawCard('互动 · 动作',c.id)||drawCard(null,c.id); if(cc)pushChatMsg(c.id,'ta',cc,null,c.id); },randInt(3000,6000));
      }
    });
    /* 群红包 · 群成员发群红包（v2.24.10）：每日每群独立 20% 概率，
       随机一位成员发出拼手气红包（份数 ≤ 全员含我），其他成员陆续抢，必留一份等我点开领取 */
    state.groups.forEach(g=>{
      if(g&&g.members&&g.members.length&&Math.random()*100<20)groupMemberRedPacket(g);
    });
    /* 送礼 · 联系人送我礼物：每日每位联系人独立 20%，存入回声匣 */
    state.contacts.forEach(c=>{
      if(Math.random()*100<20){
        const it=pick(state.marketItems.length?state.marketItems:MARKET_ITEMS);
        state.cabinet.push({itemId:it.id,from:c.id,t:Date.now()});
        pushChatMsg(c.id,'sys',`「${c.name}」送了你 ${it.em} ${it.name}`);
        setTimeout(()=>toast(c.name+' 送了你 '+it.name+'（已存入回声匣）'),7000);
      }
    });
    /* 问卷 · 联系人向我提问：v2.23.0 起每日按设置概率（默认 37%），命中则记下「谁在问我」 */
    const sqp=state.settings.surveyAskProb??37;
    if(Math.random()*100<sqp&&state.survey.bank.length&&state.contacts.length){
      const cid=pick(state.contacts).id;
      state.curQ2={q:pick(state.survey.bank),who:cid};
      setTimeout(()=>toast(contactName(cid)+' 有个问题想问你（问卷）'),10000);
    }
    /* 经期关心 · 经期期间每日 20% */
    if(inPeriod()&&Math.random()*100<20){
      const cid=pick(state.contacts).id;
      pushChatMsg(cid,'ta',pick(PERIOD_CARE),null,cid);
      setTimeout(()=>toast(contactName(cid)+': '+PERIOD_CARE[0].slice(0,12)+'…'),4000);
    }
    /* 联系人换头像 · 每 3 天 30%（从各自的专属头像库里换，也可能换我的） */
    const sinceAvatar=state.avatarRollDay?Math.round((Date.now()-new Date(state.avatarRollDay+'T00:00:00').getTime())/864e5):99;
    if(sinceAvatar>=3){
      state.avatarRollDay=today;
      if(Math.random()*100<30){
        const targets=['me',...state.contacts.map(c=>c.id)];
        const t=pick(targets);
        if(t==='me'){
          const cur=state.settings.myAvatar;
          const others=state.avatarLib.filter(a=>a.id!==cur);
          if(others.length){
            state.settings.myAvatar=pick(others).id;
            setTimeout(()=>toast('有人偷偷换掉了你的头像'),6000);
          }
        }else{
          const c=state.contacts.find(x=>x.id===t);
          const lib=c.avatarLib||[];
          const others=lib.filter(a=>a.id!==c.avatar);
          if(others.length){
            c.avatar=pick(others).id;
            setTimeout(()=>toast(c.name+' 换了新头像'),6000);
          }
        }
      }
    }
  }
  save(); renderDesktop();
}

/* ================= 设置 ================= */
function probRow(id,name,meta,val,unit,max,min){
  if(unit===undefined)unit='%';
  if(max===undefined||max===null)max=100;
  if(min===undefined||min===null)min=0;
  return `<div class="rowline">
    <div style="flex:1;padding-right:10px"><div class="name">${name} <span class="count" id="${id}Val">${val}${unit}</span></div>
    ${meta?`<div class="meta">${meta}</div>`:''}
    <input id="${id}" type="range" min="${min}" max="${max}" value="${val}" style="width:100%;margin-top:6px;accent-color:var(--accent)">
    </div>
  </div>`;
}
let avaManage=false;
/* ================= 解锁（防误触） =================
   进入设置先「锁定」：所有改动只是草稿，点底部「保存」才落盘。
   连续点两下版本号可解锁「即时保存」模式（自己用更方便）。 */
let setUnlocked=false, setUnlockClicks=0, setUnlockTimer=null;
function setUnlock(){ setUnlocked=true; toast('已解锁：设置改动即时生效'); }
function setLock(){ setUnlocked=false; toast('已锁定：设置改动需点保存'); }
/* 已保存状态的快照（用于撤销 / 跨页提示） */
let setSavedSnap=null;
function snapSaved(){ try{ setSavedSnap=JSON.stringify(state.settings); }catch(e){ setSavedSnap=null; } }
function draftDirty(){
  if(!setSavedSnap)return false;
  try{ return JSON.stringify(state.settings)!==setSavedSnap; }catch(e){ return false; }
}

/* ============ 设置页：顶部方块导航 + 分面板（v2.13.0 起） ============ */
let setTab='me';   /* me | reply | prob | notify | look | data */
function renderSet(body,extra){
  const s=state.settings;
  function persist(){
    if(setUnlocked){ save(); snapSaved(); }
    else save();
    syncSaveBar();
  }
  /* v2.17.0：tab 重做 —— 字卡库药丸风格 + 线性图标（原 tbtn 描边小方块弃用） */
  const TABS=[
    ['me','<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5"/>','我的'],
    ['reply','<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2v4.8l3.2 1.9"/>','回复'],
    ['prob','<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/>','概率'],
    ['notify','<path d="M12 4a5.6 5.6 0 0 1 5.6 5.6c0 3.2.7 5 1.6 6.1H4.8c.9-1.1 1.6-2.9 1.6-6.1A5.6 5.6 0 0 1 12 4z"/><path d="M10.2 19.4a1.9 1.9 0 0 0 3.6 0"/>','提醒'],
    ['look','<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/>','外观'],
    ['data','<path d="M4.6 7.4c0-1.5 3.4-2.7 7.4-2.7s7.4 1.2 7.4 2.7v9.2c0 1.5-3.4 2.7-7.4 2.7s-7.4-1.2-7.4-2.7z"/><path d="M4.6 7.4c0 1.5 3.4 2.7 7.4 2.7s7.4-1.2 7.4-2.7"/>','数据'],
  ];
  if(!TABS.some(t=>t[0]===setTab)) setTab='me';
  const head=`
    <div class="seg set-seg">
      ${TABS.map(([id,ic,nm])=>`<button class="${setTab===id?'on':''}" data-stab="${id}">${IC(ic)}<span>${nm}</span></button>`).join('')}
    </div>
    <div class="tab-head">
      <span class="th-title">${TABS.find(t=>t[0]===setTab)[2]}</span>
      <span class="th-sub">${setTabSub()}</span>
      <span class="count" id="setLockTag" style="margin-left:auto;font-weight:600">${setUnlocked?'即时保存 · 已解锁':'改动需保存 · 已锁定'}</span>
    </div>`;
  body.innerHTML = head + setPanel(s);
  bindSetPanels(body,extra,s,persist);
}

function setTabSub(){
  const s=state.settings;
  if(setTab==='me') return '头像 · 昵称';
  if(setTab==='data') return '导出 · 导入 · 回滚';
  if(setTab==='reply') return '等待 '+s.replyMin+'~'+s.replyMax+' 秒';
  if(setTab==='prob') return '共 15 项概率';
  if(setTab==='notify') return (s.notifyOn?'推送开':'推送关')+' · '+(s.bgNotify!==false?'后台开':'后台关')+' · '+(s.soundOn?'音效开':'音效关');
  return s.darkMode?'夜间':'白天';
}

/* 设置页各分区内容 */
function setPanel(s){
  if(setTab==='me') return setPanelMe(s);
  if(setTab==='data') return setPanelData(s);
  if(setTab==='reply') return setPanelReply(s);
  if(setTab==='prob') return setPanelProb(s);
  if(setTab==='notify') return setPanelNotify(s);
  return setPanelLook(s);
}

/* ① 我的：头像 + 昵称 + 数据 + 防误触 + 版本（按要求合并到一页） */
function setPanelMe(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:2px">${I('person',16)} 我的</div>
      <div class="my-profile">
        <div class="my-ava" id="myAvaBtn" title="点击更换头像">
          ${avatarHtml(s.myName,'','me')}
          <span class="my-ava-hint">${I('camera',11)} 换头像</span>
        </div>
        <div style="flex:1;min-width:0;padding-top:2px">
          <div class="field" style="margin-bottom:0"><label>我的昵称（点击虚线框修改）</label><input id="myNameInput" value="${escapeHtml(s.myName)}" maxlength="12"></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('image',16)} 我的头像库 <span class="count">${state.avatarLib.length} 个</span></div>
      <div class="desc" style="margin-bottom:10px">这里只管理我自己的头像；每位联系人有自己的头像库，在各自聊天页 → 更多互动 → ta的头像库里管理</div>
      ${state.avatarLib.length?'':'<div class="desc" style="margin-bottom:10px;color:var(--ink-3)">内置头像已清空 · 点下面的「＋」加一个 emoji，或点图片图标上传</div>'}
      <div class="stk-grid" style="margin-top:4px">
        ${state.avatarLib.map(a=>`
          <div class="stk" data-setava="${a.id}" style="${s.myAvatar===a.id?'outline:2.5px solid var(--accent);outline-offset:-2.5px':''}" title="设为我的头像">
            ${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}
            ${avaManage?`<span class="delx" data-delava="${a.id}">✕</span>`:''}
          </div>`).join('')}
        <div class="stk add" id="avaAddEmoji" title="添加 emoji 头像">＋</div>
        <div class="stk add" id="avaAddImg" title="上传图片头像" style="display:flex;align-items:center;justify-content:center">${I('image',22)}</div>
      </div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn small ghost" id="avaManageBtn">${avaManage?'完成':'管理'}</button>
        <input type="file" id="avaFile" accept="image/*" style="display:none">
      </div>
    </div>
    <div class="card">
      <div class="desc" style="margin:0">版本与数据相关设置都在「数据」分区：导出 / 导入 / 回滚 / 检查更新 / 重置。</div>
    </div>
    <div style="text-align:center;color:var(--ink-3);font-size:11px;padding:6px 0 74px">彤话屿 · 数据仅保存在本机浏览器</div>`;
}

/* ② 数据：导出 / 导入 / 回滚 / 清空 / 防误触 / 版本（v2.24.1 独立成页，避免误点重置） */
function setPanelData(s){
  /* v2.24.8：存储用量可视化 —— 让用户在爆掉之前就能看到预警（旧版毫无提示，
     一直写不进去才发现，那时新数据已经丢了） */
  const st=storageStat();
  const barColor = st.pct>=90 ? 'var(--danger)' : st.pct>=75 ? '#e8a33d' : 'var(--accent)';
  setTimeout(fillIdbUsage, 80);
  return `
    <div class="card">
      <div class="title" style="margin-bottom:10px">${I('save',16)} 本机存储</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <b style="font-size:19px">${(st.used/1024).toFixed(0)}</b>
        <span style="color:var(--ink-3);font-size:13px">KB 开机快取 / 约 ${Math.round(st.quota/1024/1024*10)/10} MB（${st.pct}%）</span>
      </div>
      <div style="height:8px;border-radius:99px;background:var(--line);overflow:hidden">
        <div style="height:100%;width:${Math.max(2,st.pct)}%;background:${barColor};border-radius:99px;transition:width .3s"></div>
      </div>
      <div class="desc" style="margin-top:9px" id="idbStatLine">大容量库：统计中…</div>
      <div class="desc" style="margin-top:6px">
        聊天记录、表情包、字卡、头像的<b>完整数据</b>都保存在「大容量库」（IndexedDB）里，
        容量按设备磁盘动态分配，通常<b>数百 MB 起步</b>（约是 5MB 快取的上百倍），一般永远用不完。
        上面的 5MB 只是「开机快取」——满了会自动整理，<b>不影响任何数据</b>。
        ${st.warn
          ? '<b style="color:var(--danger)">快取存储已经偏满</b>——会自动整理，完整数据在大容量库不受影响。'
          : '快取占用超过 80% 会自动整理，也可随时手动整理。'}
      </div>
      <button class="btn ghost block" id="slimBtn" style="margin-top:10px">一键整理快取（不动任何聊天 / 图片）</button>
      <div class="desc" style="margin-top:8px">整理只压缩<b>快取镜像</b>里超龄的图片缓存（头像库 / 表情包 / 邻屿圈配图超出上限的部分），<b>大容量库里的正式数据一条不删</b>；当前在用的头像与最近的内容也会保留。</div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:12px">${I('save',16)} 数据</div>
      <div style="display:flex;flex-direction:column;gap:9px">
        <button class="btn ghost block" id="exportBtn">导出数据…（可勾选内容）</button>
        <button class="btn ghost block" id="importBtn">导入数据</button>
        <button class="btn ghost block" id="rollbackBtn">回滚到最近一次正常存档</button>
        <button class="btn danger block" id="clearChatBtn">清空全部聊天记录</button>
        <button class="btn danger block" id="resetCardsBtn">恢复默认字卡库</button>
      </div>
      <div class="desc" style="margin-top:10px">「导出数据」里可以分别勾选<b>字卡</b>（含分组 / 表情包 / 拍一拍）和<b>聊天记录</b>（单人 / 群聊），也可以一键全部导出。</div>
      <input type="file" id="importFile" accept=".json" style="display:none">
    </div>
    <div class="card" id="setDangerCard">
      <div class="title" style="margin-bottom:6px">${I('shield',16)} 防误触</div>
      <div class="desc" style="margin-bottom:10px">
        设置页默认<b>锁定</b>：所有改动只是草稿，点底部「保存」才写入。<br>
        危险操作（清空 / 重置）仍需在弹窗里二次确认。
      </div>
      <button class="btn ghost block" id="setLockBtn">${setUnlocked?'重新锁定设置（推荐）':'解锁「即时保存」模式'}</button>
      <div class="desc" style="margin-top:8px">小技巧：在下面「版本」里连点两下构建号，也能切换锁定 / 解锁。</div>
    </div>
    <div class="card">
      <div class="title" style="margin-bottom:12px">${I('refresh',16)} 版本</div>
      <div class="rowline" style="padding-top:0">
        <div style="flex:1">
          <div class="name" id="buildNumTap">当前构建号 <b id="buildNum">${window.__BUILD__||'0'}</b></div>
          <div class="meta" id="verState">点右侧检查线上最新版本 · 连点两下构建号切换锁定</div>
        </div>
        <button class="btn small" id="checkVerBtn" style="margin:0">检查更新</button>
      </div>
      <div class="rowline">
        <div style="flex:1">
          <div class="name">重新开始</div>
          <div class="meta">清空本机全部数据，回到全新初始状态</div>
        </div>
        <button class="btn small ghost" id="freshBtn" style="margin:0">重置</button>
      </div>
    </div>
    <div style="text-align:center;color:var(--ink-3);font-size:11px;padding:6px 0 74px">彤话屿 · 数据仅保存在本机浏览器</div>`;
}

/* ② 回复速度 + 回复行为开关 */
/* ② 回复：回复速度 + 回复行为开关 */
function setPanelReply(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:12px">${I('clock',16)} 回复速度</div>
      <div class="field"><label>收到消息后随机等待（秒）</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="replyMin" type="number" value="${s.replyMin}" style="flex:1;text-align:center"><span style="color:var(--ink-3)">~</span>
          <input id="replyMax" type="number" value="${s.replyMax}" style="flex:1;text-align:center"><span style="color:var(--ink-3)">秒</span>
        </div></div>
      <div class="field" style="margin-bottom:0"><label>两条字卡之间的间隔（秒）</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="gapMin" type="number" value="${s.gapMin}" style="flex:1;text-align:center"><span style="color:var(--ink-3)">~</span>
          <input id="gapMax" type="number" value="${s.gapMax}" style="flex:1;text-align:center"><span style="color:var(--ink-3)">秒</span>
        </div></div>
      <div class="field" style="margin-bottom:0"><label>单次回复字卡上限（1~4 张随机）</label>
        <input id="cardMaxInput" type="number" value="${s.cardMax||3}" min="1" max="4" style="text-align:center">
      </div>
    </div>
    <div class="card" style="padding:4px 16px">
      <div class="rowline" style="padding-top:16px">
        <div><div class="name">自动回复</div><div class="meta">关闭后对方不再抽卡回你</div></div>
        <button class="switch ${s.autoReply?'on':''}" id="autoReplySwitch"></button>
      </div>
      <div class="rowline" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><div class="name">已读不回</div><div class="meta">开启后消息会显示「已读」，并按设定概率已读不回</div></div>
          <button class="switch ${s.readNoReply?'on':''}" id="readNoReplySwitch"></button>
        </div>
        ${s.readNoReply?probRow('readNoProb','已读不回概率','ta 已读后不回复你的概率',s.readNoProb??60):''}
      </div>
      <div class="rowline">
        <div><div class="name">挂桌面查岗</div><div class="meta">开启后，联系人会按设定概率不定时来"查岗"</div></div>
        <button class="switch ${s.deskCheck?'on':''}" id="deskCheckSwitch"></button>
      </div>
      <div class="rowline">
        <div><div class="name">联系人主动发消息</div><div class="meta">开启后，联系人每 30 分钟有 40% 概率主动给你发消息</div></div>
        <button class="switch ${s.proactiveMsg!==false?'on':''}" id="proactiveMsgSwitch"></button>
      </div>
    </div>`;
}
/* ③ 概率控制 */
function setPanelProb(s){
  return `
    <div class="card" style="padding:4px 16px">
      <div class="title" style="padding-top:14px">${I('dice',16)} 概率控制</div>
      ${probRow('callInProb','联系人主动来电','待机时联系人主动打来电话的概率',s.callInProb??25)}
      ${probRow('callAnswer','电话接通概率','打电话时对方接通的概率',s.callAnswer??85)}
      ${probRow('callHangProb','通话中联系人挂断概率','通话接通后，ta 主动挂断电话的概率（0 = 永不主动挂断）',s.callHangProb??20)}
      ${probRow('stickerProb','回复发表情包概率','ta 回复消息时改发表情包的概率',s.stickerProb??20)}
      ${probRow('groupReplyProb','群聊回复概率','群聊里每位成员在你发消息后<b>各自独立</b>回你的概率',s.groupReplyProb??70)}
      ${probRow('patProb','他使用拍一拍的概率','ta 主动拍你（以及你拍 ta 后 ta 回拍你）的概率',s.patProb??20)}
      ${probRow('deskCheckProb','查岗触发概率','挂桌面状态下每轮触发查岗的概率',s.deskCheckProb??50)}
    </div>
    <div class="card" style="padding:4px 16px">
      <div class="title" style="padding-top:14px">${I('announce',16)} 动态与来信</div>
      ${probRow('momentProb','联系人发邻屿圈概率','每日判定一次；命中后当天发 1~2 条动态',s.momentProb??40)}
      ${probRow('letterProb','联系人写信概率','每日判定一次；连续 2 天没写会自动抬到 80%（0 = 永不写信）',s.letterProb??50)}
    </div>
    <div class="card" style="padding:4px 16px">
      <div class="title" style="padding-top:14px">${I('heart',16)} 邻屿圈互动（我发的动态）</div>
      ${probRow('momentLikeProb','联系人点赞概率','每位联系人独立判定，看到你的动态后点赞',s.momentLikeProb??70)}
      ${probRow('momentCommentProb','联系人评论概率','每位联系人独立判定，给你的动态留言',s.momentCommentProb??35)}
    </div>
    <div class="card" style="padding:4px 16px">
      <div class="title" style="padding-top:14px">${I('dice',16)} 问卷与互动</div>
      ${probRow('surveyAskProb','联系人主动提问概率','每日判定一次；命中后联系人会来问卷页问你一个问题',s.surveyAskProb??37)}
      ${probRow('listenAcceptProb','一起听应邀概率','邀请联系人一起听音乐时，ta 应邀的概率',s.listenAcceptProb??85)}
    </div>
    <div class="card" style="padding:4px 16px">
      <div class="title" style="padding-top:14px">${I('gamepad',16)} 小游戏</div>
      ${probRow('gameInviteProb','游戏邀请接受概率','邀请联系人一起玩游戏时，ta 应邀的概率',s.gameInviteProb??50)}
    </div>`;
}

/* ④ 提醒：通知 + 提示音 */
/* v2.24.12：后台通知说明条 —— 开关在上一行，这里负责「权限」与「解释」 */
function notifyPermRow(s){
  let perm='';
  try{ perm = ('Notification' in window) ? Notification.permission : 'unsupported'; }catch(e){ perm='unsupported'; }
  if(perm==='unsupported'){
    return `<div class="rowline" style="flex-direction:column;align-items:stretch">
      <div class="meta">当前浏览器不支持系统通知，暂时只能看站内提示</div>
    </div>`;
  }
  const ok = perm==='granted';
  const label = ok ? '已授权 · 后台仍会收到消息' :
                perm==='denied' ? '已被拒绝 · 需要在浏览器设置里允许本站通知' :
                '尚未授权 · 点右侧按钮允许，才能在后台收到通知';
  const offTip = s && s.bgNotify===false
    ? `<div class="meta" style="color:var(--ink-3);padding:2px 0 0">后台通知开关已关闭 · 当前不会发送任何后台通知</div>` : '';
  return `<div class="rowline" style="flex-direction:column;align-items:stretch">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div style="min-width:0">
        <div class="name" style="display:flex;align-items:center;gap:6px">${I('bell',15)} 系统通知权限</div>
        <div class="meta">${label}</div>
      </div>
      <button class="btn small ${ok?'ghost':''}" id="bgNotifyBtn" style="margin:0;flex:none">${ok?'已授权':'去授权'}</button>
    </div>
    ${offTip}
    <div class="meta" style="padding:8px 0 14px;color:var(--ink-3);line-height:1.85">
      <b style="color:var(--ink-2)">这是什么</b>：让<b style="color:var(--ink-2)">浏览器</b>在本站退到后台时，仍然在手机通知栏弹出新消息。这是浏览器的能力，不是原生 App 推送。<br>
      <b style="color:var(--ink-2)">怎么开启</b>：① 上面的「后台消息通知」开关打开 → ② 点右侧「去授权」允许本站通知 → ③ 之后把网站退到后台（<b style="color:var(--ink-2)">不用清后台、也不用一直开着页面</b>）即可收到。<br>
      <b style="color:var(--ink-2)">关掉会怎样</b>：开关关闭后，网站只在你<b style="color:var(--ink-2)">正开着页面</b>时用站内提示；退到后台就完全安静，不再打扰你。<br>
      <b style="color:var(--ink-2)">为什么不能秒到</b>：网页在后台的定时器会被系统限频，本站靠「后台服务」尽量替你盯着 —— <b style="color:var(--ink-2)">能收到，但不保证分秒不差</b>；真正实时的推送只有原生 App 才做得到。<br>
      <b style="color:var(--ink-2)">收不到时的自查</b>：① 开关是否为「开」；② 权限是否显示「已授权」；③ 手机系统的「通知」里是否给浏览器放行（部分机型默认关闭）；④ iOS 需先把本站<b style="color:var(--ink-2)">「添加到主屏幕」</b>再从桌面图标打开。<br>
      <b style="color:var(--ink-2)">隐私</b>：全部在本机运算，不联网、不向任何服务器发送数据。</div>
  </div>`;
}
function setPanelNotify(s){
  const bgOn = s.bgNotify!==false;
  return `
    <div class="card" style="padding:4px 16px">
      <div class="rowline" style="padding-top:16px">
        <div><div class="name" style="display:flex;align-items:center;gap:6px">${I('bell',15)} 消息推送通知</div><div class="meta">不在聊天页时，用系统通知提醒新消息（浏览器需授权）</div></div>
        <button class="switch ${s.notifyOn?'on':''}" id="notifySwitch"></button>
      </div>
      <div class="rowline">
        <div><div class="name" style="display:flex;align-items:center;gap:6px">${I('bell',15)} 后台消息通知</div><div class="meta">退出网站、没清掉后台时，手机上仍能收到消息通知（可随时关闭）</div></div>
        <button class="switch ${bgOn?'on':''}" id="bgNotifySwitch"></button>
      </div>
      ${notifyPermRow(s)}
      <div class="rowline" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><div class="name" style="display:flex;align-items:center;gap:6px">${I('sound',15)} 消息提示音</div><div class="meta">清脆风铃音 · 收到 / 发出消息时播放</div></div>
          <button class="switch ${s.soundOn?'on':''}" id="soundSwitch"></button>
        </div>
        ${s.soundOn?`<div style="display:flex;gap:10px;align-items:center;padding:8px 0 14px">
          <span style="font-size:12px;color:var(--ink-2);white-space:nowrap">音量</span>
          <input type="range" id="soundVol" min="0" max="100" value="${Math.round((s.soundVol??0.5)*100)}" style="flex:1;accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--ink-3);width:30px;text-align:right">${Math.round((s.soundVol??0.5)*100)}%</span>
          <button class="btn small ghost" id="soundTest" style="margin:0">试听</button></div>`:''}
      </div>
    </div>`;
}

/* ============ 导出数据：可勾选导出内容（字卡 / 聊天记录 / 其他 / 全部） ============ */
function exportStats(){
  const nCards=(state.cats||[]).reduce((a,c)=>a+(c.cards||[]).length,0);
  const nCats=(state.cats||[]).length;
  const nStk=(state.stickers||[]).length+(state.myStickers||[]).length;
  const nPat=((state.patLib&&state.patLib.me)||[]).length;
  const contacts=(state.contacts||[]).length;
  const groups=(state.groups||[]).length;
  const nMsg=Object.values(state.chats||{}).reduce((a,l)=>a+(l||[]).length,0);
  const nLetters=(state.letters||[]).length;
  const nAva=(state.avatarLib||[]).length;
  const nMom=(state.moments||[]).length;
  return {nCards,nCats,nStk,nPat,contacts,groups,nMsg,nLetters,nAva,nMom};
}
function openExportDialog(){
  const st=exportStats();
  const mk=openModal('导出数据',`
    <div class="desc" style="margin-bottom:12px">勾选要导出的内容，可任意组合。导出为 <code>.json</code> 文件，可用于备份或导入到其他设备。</div>

    <label class="exp-row" style="border-color:var(--accent)">
      <input type="checkbox" id="expAll" style="margin-top:3px">
      <div style="flex:1">
        <div class="name" style="font-weight:800">全部导出</div>
        <div class="meta">所有数据一份完整备份（字卡 + 聊天记录 + 信箱 + 头像库 + 朋友圈 + 气泡/界面设置 + 桌面布局等，<b>什么都不漏</b>）</div>
      </div>
    </label>

    <div class="exp-sec">字卡</div>
    <label class="exp-row">
      <input type="checkbox" class="exp-card" id="expCats" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">字卡分组 <span class="count">${st.nCats} 组 · ${st.nCards} 张</span></div>
        <div class="meta">字卡库的分组与全部字卡</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-card" id="expStk" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">表情包 <span class="count">${st.nStk} 个</span></div>
        <div class="meta">公共表情包 + 我的表情包</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-card" id="expPat" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">拍一拍 <span class="count">${st.nPat} 条</span></div>
        <div class="meta">拍一拍词库（我拍ta / ta拍我 共用的词卡）</div>
      </div>
    </label>

    <div class="exp-sec">聊天记录</div>
    <label class="exp-row">
      <input type="checkbox" class="exp-chat" id="expDm" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">单人聊天 <span class="count">${st.contacts} 位</span></div>
        <div class="meta">与每位联系人的对话记录</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-chat" id="expGrp" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">群聊天 <span class="count">${st.groups} 个</span></div>
        <div class="meta">群聊的对话记录</div>
      </div>
    </label>

    <div class="exp-sec">其他（v2.24.2 新增，之前漏掉的都在这）</div>
    <label class="exp-row">
      <input type="checkbox" class="exp-x" id="expLetter" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">信箱 <span class="count">${st.nLetters} 封</span></div>
        <div class="meta">收到的所有信件</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-x" id="expAva" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">头像库 <span class="count">${st.nAva} 个</span></div>
        <div class="meta">自制的头像与装扮</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-x" id="expMom" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">朋友圈 <span class="count">${st.nMom} 条</span></div>
        <div class="meta">朋友圈动态与评论</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="checkbox" class="exp-x" id="expSet" style="margin-top:3px">
      <div style="flex:1">
        <div class="name">界面与气泡设置</div>
        <div class="meta">气泡样式、字体、昵称、回复间隔、壁纸等偏好</div>
      </div>
    </label>
    <div class="desc" style="margin-top:8px">共 ${st.nMsg} 条消息记录。想一份备份保平安，直接勾「<b>全部导出</b>」。</div>
  `,()=>{
    const pick={
      all:   $('expAll').checked,
      cats:  $('expCats').checked,
      stk:   $('expStk').checked,
      pat:   $('expPat').checked,
      dm:    $('expDm').checked,
      grp:   $('expGrp').checked,
      letter:$('expLetter').checked,
      ava:   $('expAva').checked,
      mom:   $('expMom').checked,
      set:   $('expSet').checked,
    };
    const any = pick.cats||pick.stk||pick.pat||pick.dm||pick.grp||pick.letter||pick.ava||pick.mom||pick.set;
    if(!pick.all && !any){ toast('至少勾选一项'); return false; }
    doExport(pick);
  },null,'导出','取消');

  /* 勾选联动：全部导出 → 一键全选；子项全勾则回勾「全部导出」（v2.24.2 统一处理所有子项） */
  const all=$('expAll');
  const SUB_IDS=['expCats','expStk','expPat','expDm','expGrp','expLetter','expAva','expMom','expSet'];
  const anySub=()=>SUB_IDS.some(id=>{ const el=$(id); return el&&el.checked; });
  const allSub=()=>SUB_IDS.every(id=>{ const el=$(id); return el&&el.checked; });
  if(all)all.addEventListener('change',()=>{
    const on=all.checked;
    SUB_IDS.forEach(id=>{ const el=$(id); if(el)el.checked=on; });
  });
  SUB_IDS.forEach(id=>{
    const el=$(id);
    if(el)el.addEventListener('change',()=>{ if(all) all.checked = allSub(); });
  });
}
/* 按勾选项组装导出数据 */
function doExport(pick){
  const stamp=fmtDate(Date.now());
  if(pick.all){
    const blob=new Blob([JSON.stringify({__type:'tonghuayu-full',exportedAt:Date.now(),data:state},null,2)],{type:'application/json'});
    dlBlob(blob,'彤话屿_全部备份_'+stamp+'.json');
    toast('已导出全部备份');
    return;
  }
  const out={__type:'tonghuayu-partial',exportedAt:Date.now(),version:window.__BUILD__||''};
  const names=[];
  /* 字卡相关 */
  if(pick.cats||pick.stk||pick.pat) out.cards={};
  if(pick.cats){ out.cards.cats=state.cats; names.push('字卡分组'); }
  if(pick.stk){ out.cards.stickers=state.stickers; out.cards.myStickers=state.myStickers; names.push('表情包'); }
  if(pick.pat){ out.cards.patLib=state.patLib; names.push('拍一拍'); }
  /* 聊天记录 */
  if(pick.dm||pick.grp) out.chats={};
  if(pick.dm){
    out.chats.contacts=(state.contacts||[]).map(c=>({id:c.id,name:c.name,avatar:c.avatar}));
    out.chats.dm={};
    (state.contacts||[]).forEach(c=>{ out.chats.dm[c.id]=state.chats[c.id]||[]; });
    out.chats.contactMeta=(state.contacts||[]).map(c=>({id:c.id,name:c.name}));
    names.push('单人聊天');
  }
  if(pick.grp){
    out.chats.groups=(state.groups||[]).map(g=>({id:g.id,name:g.name,members:g.members}));
    out.chats.group={};
    (state.groups||[]).forEach(g=>{ out.chats.group[g.id]=state.chats[g.id]||[]; });
    names.push('群聊天');
  }
  /* v2.24.2：其他（信箱 / 头像库 / 朋友圈 / 界面设置）——之前分项导出漏掉的内容 */
  if(pick.letter||pick.ava||pick.mom||pick.set) out.extras={};
  if(pick.letter){ out.extras.letters=state.letters; names.push('信箱'); }
  if(pick.ava){ out.extras.avatarLib=state.avatarLib; names.push('头像库'); }
  if(pick.mom){ out.extras.moments=state.moments; names.push('朋友圈'); }
  if(pick.set){ out.extras.settings=state.settings; names.push('界面设置'); }
  const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
  dlBlob(blob,'彤话屿_'+names.join('+')+'_'+stamp+'.json');
  toast('已导出：'+names.join('、'));
}
/* ============ 导入数据：两种模式 ============ */
/* v2.24.1：把导入文件「尽力规整」成 state 形状 —— 旧版本导出的备份里字段名/结构可能不同
   （例如只有 chats / 只有 contacts、字卡键叫 library / cardGroups 等），
   一律先救回来，宁可多点重复也不要再出现「导不进去」。 */
function normalizeImportedState(d){
  const s=(d&&typeof d==='object')?d:{};
  const pick=(...names)=>{ for(const n of names){ if(s[n]!==undefined&&s[n]!==null) return s[n]; } return undefined; };
  const out=Object.assign({},s);
  /* 字卡库：cats / cardCats / library / cardGroups */
  const cats=pick('cats','cardCats','cardGroups','library');
  if(Array.isArray(cats)) out.cats=cats;
  else if(cats&&typeof cats==='object'){
    out.cats=Object.keys(cats).map(k=>({name:k,cards:Array.isArray(cats[k])?cats[k]:[]}));
  }
  /* 联系人：contacts / friends / contactList / characters */
  const cts=pick('contacts','friends','contactList','characters');
  if(Array.isArray(cts)) out.contacts=cts;
  /* 群聊 */
  const gps=pick('groups','groupList');
  if(Array.isArray(gps)) out.groups=gps;
  /* 聊天记录：chats / chatLogs / messages（messages 若按 id 分组也兼容） */
  const cht=pick('chats','chatLogs','messages');
  if(cht&&typeof cht==='object'&&!Array.isArray(cht)) out.chats=cht;
  /* 表情包 / 拍一拍 / 头像库 / 信件 / 朋友圈 */
  const stk=pick('stickers');
  if(Array.isArray(stk)) out.stickers=stk;
  const myStk=pick('myStickers','myEmojis');
  if(Array.isArray(myStk)) out.myStickers=myStk;
  const pat=pick('patLib','patLines');
  if(pat) out.patLib=pat;
  const ava=pick('avatarLib','avatars');
  if(Array.isArray(ava)) out.avatarLib=ava;
  const lt=pick('letters','letterList');
  if(Array.isArray(lt)) out.letters=lt;
  const mo=pick('moments','momentList');
  if(Array.isArray(mo)) out.moments=mo;
  /* 设置项平铺在顶层的情况（老备份有时把 replyMin 等直接放在根上） */
  if(!out.settings||typeof out.settings!=='object'){
    const flat={};
    ['myName','taName','replyMin','replyMax','gapMin','gapMax','cardMax','accent','bubbleR'].forEach(k=>{
      if(s[k]!==undefined) flat[k]=s[k];
    });
    if(Object.keys(flat).length) out.settings=flat;
  }
  return out;
}
/* 解析导入文件，返回 {kind:'full'|'partial', data, isFull} */
function parseImport(raw){
  let obj;
  try{ obj=JSON.parse(raw); }catch(err){ return {err:'文件不是合法的 JSON'}; }
  if(!obj||typeof obj!=='object') return {err:'文件内容为空'};
  /* 1) 全部备份：{__type:'tonghuayu-full', data:{...state}} */
  if(obj.__type==='tonghuayu-full' && obj.data && typeof obj.data==='object')
    return {kind:'full',data:normalizeImportedState(obj.data),isFull:true};
  /* 2) 分项导出：{__type:'tonghuayu-partial', cards:{...}, chats:{...}} */
  if(obj.__type==='tonghuayu-partial') return {kind:'partial',data:obj,isFull:false};
  /* 3) 兼容：裸 state（有 settings + cats 数组） */
  if(obj.settings && Array.isArray(obj.cats)) return {kind:'full',data:obj,isFull:true};
  /* 4) v2.24.1 兜底：裸 state 但没有 cats —— 只要像存档就救回来（原来的写法在这里会直接判失败） */
  if(obj.settings || obj.contacts || obj.chats || obj.moments || obj.cats || obj.cards || obj.letters)
    return {kind:'full',data:normalizeImportedState(obj),isFull:false};
  return {err:'无法识别的文件格式'};
}
/* 统计导入文件里各类内容数量，用于弹窗展示 */
function importSummary(p){
  const d=p.data||{};
  const extras=(p.kind==='partial'?(d.extras||{}):d)||{};
  const cards = p.kind==='partial' ? (d.cards||{}) : d;
  const chats = p.kind==='partial' ? (d.chats||{}) : d;
  const nCards=(cards.cats||[]).reduce((a,c)=>a+((c.cards||[]).length),0);
  const nCats=(cards.cats||[]).length;
  const nStk=((cards.stickers||[]).length)+((cards.myStickers||[]).length);
  const nPat=((cards.patLib&&cards.patLib.me)||[]).length;
  let nContacts=0,nGroups=0,nMsg=0;
  if(p.kind==='partial'){
    nContacts=(chats.contacts||[]).length||Object.keys(chats.dm||{}).length;
    nGroups=(chats.groups||[]).length||Object.keys(chats.group||{}).length;
    nMsg=Object.values(chats.dm||{}).reduce((a,l)=>a+((l||[]).length),0)
        +Object.values(chats.group||{}).reduce((a,l)=>a+((l||[]).length),0);
  }else{
    nContacts=(chats.contacts||[]).length;
    nGroups=(chats.groups||[]).length;
    nMsg=Object.values(chats.chats||{}).reduce((a,l)=>a+((l||[]).length),0);
  }
  /* v2.24.2：信箱 / 头像库 / 朋友圈 / 设置 —— 分项文件的 extras 和全部备份的顶层字段统一统计 */
  const nMoment=((p.kind==='partial'?extras.moments:d.moments)||[]).length;
  const nLetter=((p.kind==='partial'?extras.letters:d.letters)||[]).length;
  const nAva=((p.kind==='partial'?extras.avatarLib:d.avatarLib)||[]).length;
  const nSet=(p.kind==='partial'?!!extras.settings:!!d.settings)?1:0;
  return {nCats,nCards,nStk,nPat,nContacts,nGroups,nMsg,nMoment,nLetter,nAva,nSet};
}
/* 消息去重键：同一角色 + 同文本 + 同时间戳视为同一条 */
function msgKey(m){ return (m&&m.role||'')+'|'+(m&&m.ts||m&&m.time||'')+'|'+String((m&&m.text)||''); }
function mergeMsgList(a,b){
  const out=[].concat(a||[]);
  const seen={}; out.forEach(m=>{ seen[msgKey(m)]=1; });
  (b||[]).forEach(m=>{ const k=msgKey(m); if(!seen[k]){ seen[k]=1; out.push(m); } });
  /* 按时间排序（有 ts 时） */
  const hasTs=out.some(m=>m&&(m.ts||m.time));
  if(hasTs) out.sort((x,y)=>((x.ts||x.time)||0)-((y.ts||y.time)||0));
  return out;
}
function mergeCats(a,b){
  const out=(a||[]).map(c=>Object.assign({},c,{cards:[].concat(c.cards||[])}));
  const idx={}; out.forEach((c,i)=>{ idx[c.name]=i; });
  (b||[]).forEach(c=>{
    if(idx[c.name]!==undefined){
      const tgt=out[idx[c.name]]; const seen={}; (tgt.cards||[]).forEach(t=>{ seen[String(t.text||t)]=1; });
      (c.cards||[]).forEach(t=>{ const k=String(t.text||t); if(!seen[k]){ seen[k]=1; tgt.cards.push(t); } });
    }else{ idx[c.name]=out.length; out.push(Object.assign({},c,{cards:[].concat(c.cards||[])})); }
  });
  return out;
}
function mergeArrByName(a,b){
  const out=[].concat(a||[]); const seen={}; out.forEach(x=>{ seen[String(x.name||x)]=1; });
  (b||[]).forEach(x=>{ const k=String(x.name||x); if(!seen[k]){ seen[k]=1; out.push(x); } });
  return out;
}
function mergeContacts(a,b){
  const out=(a||[]).map(c=>Object.assign({},c));
  const idx={}; out.forEach((c,i)=>{ idx[c.name]=i; });
  (b||[]).forEach(c=>{
    if(idx[c.name]!==undefined){ /* 同名联系人保留本地，仅补齐缺失字段 */
      const tgt=out[idx[c.name]];
      Object.keys(c).forEach(k=>{ if(tgt[k]===undefined||tgt[k]===null||tgt[k]==='') tgt[k]=c[k]; });
    }else{ idx[c.name]=out.length; out.push(Object.assign({},c)); }
  });
  return out;
}
function mergeGroups(a,b){
  const out=(a||[]).map(g=>Object.assign({},g,{members:[].concat(g.members||[])}));
  const idx={}; out.forEach((g,i)=>{ idx[g.name]=i; });
  (b||[]).forEach(g=>{
    if(idx[g.name]!==undefined){
      const tgt=out[idx[g.name]];
      const seen={}; (tgt.members||[]).forEach(m=>{ seen[String(m)]=1; });
      (g.members||[]).forEach(m=>{ if(!seen[String(m)]){ seen[String(m)]=1; tgt.members.push(m); } });
    }else{ idx[g.name]=out.length; out.push(Object.assign({},g,{members:[].concat(g.members||[])})); }
  });
  return out;
}
function mergeMoments(a,b){
  const out=[].concat(a||[]);
  const key=m=>String((m&&m.by)||'')+'|'+String((m&&m.text)||'')+'|'+String((m&&m.ts)||(m&&m.time)||'');
  const seen={}; out.forEach(m=>{ seen[key(m)]=1; });
  (b||[]).forEach(m=>{ const k=key(m); if(!seen[k]){ seen[k]=1; out.push(m); } });
  out.sort((x,y)=>((x.ts||x.time)||0)-((y.ts||y.time)||0));
  return out;
}
/* 把导入数据合并进当前 state（去重） */
function mergeIntoState(p){
  /* v2.24.2：分项导入把「其他」（信箱/头像库/朋友圈/设置）从 extras 里取出来，
     与全部备份共用下面同一套合并逻辑 —— 之前分项导入根本走不到这段，信件等导入了也白导 */
  const d=(p.kind==='partial'?Object.assign({},(p.data&&p.data.extras)||{}):p.data)||{};
  const cards=(p.kind==='partial'?(p.data.cards||{}):p.data)||{};
  const chats=(p.kind==='partial'?(p.data.chats||{}):p.data)||{};
  const report=[];

  /* —— 字卡分项 —— */
  if(Array.isArray(cards.cats)&&cards.cats.length){
    const before=(state.cats||[]).reduce((a,c)=>a+(c.cards||[]).length,0);
    state.cats=mergeCats(state.cats,cards.cats);
    const after=(state.cats||[]).reduce((a,c)=>a+(c.cards||[]).length,0);
    report.push('字卡 +'+(after-before)+' 张');
  }
  if(Array.isArray(cards.stickers)&&cards.stickers.length){
    const b=(state.stickers||[]).length;
    state.stickers=mergeArrByName(state.stickers,cards.stickers);
    report.push('表情包 +'+((state.stickers||[]).length-b)+' 个');
  }
  if(Array.isArray(cards.myStickers)&&cards.myStickers.length){
    const b=(state.myStickers||[]).length;
    state.myStickers=mergeArrByName(state.myStickers,cards.myStickers);
    report.push('我的表情包 +'+((state.myStickers||[]).length-b)+' 个');
  }
  if(cards.patLib){
    state.patLib=state.patLib||{me:[],ta:[]};
    if(Array.isArray(cards.patLib.me)){
      const b=(state.patLib.me||[]).length;
      state.patLib.me=mergeArrByName(state.patLib.me,cards.patLib.me);
      report.push('拍一拍 +'+((state.patLib.me||[]).length-b)+' 条');
    }
    if(Array.isArray(cards.patLib.ta)){
      const b=(state.patLib.ta||[]).length;
      state.patLib.ta=mergeArrByName(state.patLib.ta,cards.patLib.ta);
      report.push('拍一拍(ta) +'+((state.patLib.ta||[]).length-b)+' 条');
    }
  }

  /* —— 联系人 / 群 —— */
  const inContacts = chats.contacts || (p.kind==='partial'&&chats.dm ? Object.keys(chats.dm).map(id=>({id,name:id})) : null);
  if(Array.isArray(inContacts)&&inContacts.length){
    const b=(state.contacts||[]).length;
    state.contacts=mergeContacts(state.contacts,inContacts);
    report.push('联系人 +'+((state.contacts||[]).length-b)+' 位');
  }
  const inGroups = chats.groups || null;
  if(Array.isArray(inGroups)&&inGroups.length){
    const b=(state.groups||[]).length;
    state.groups=mergeGroups(state.groups,inGroups);
    report.push('群聊 +'+((state.groups||[]).length-b)+' 个');
  }

  /* —— 聊天记录 —— */
  const dmSrc = p.kind==='partial' ? (chats.dm||{}) : null;
  const grpSrc = p.kind==='partial' ? (chats.group||{}) : null;
  state.chats=state.chats||{};
  const addMsg=(chatId,list,label,map)=>{
    if(!Array.isArray(list)||!list.length) return;
    let realId=chatId;
    if(map){ const hit=map[chatId]; if(hit) realId=hit; }
    const before=(state.chats[realId]||[]).length;
    state.chats[realId]=mergeMsgList(state.chats[realId],list);
    const add=(state.chats[realId]||[]).length-before;
    if(add>0) report.push(label+' +'+add+' 条');
  };
  if(p.kind==='partial'){
    /* 分项：按 id 或 name 找本地对应聊天 */
    const cMap={}; (state.contacts||[]).forEach(c=>{ cMap[c.id]=c.id; cMap[c.name]=c.id; });
    Object.keys(dmSrc).forEach(k=>addMsg(k,dmSrc[k],'聊天',cMap));
    const gMap={}; (state.groups||[]).forEach(g=>{ gMap[g.id]=g.id; gMap[g.name]=g.id; });
    Object.keys(grpSrc).forEach(k=>addMsg(k,grpSrc[k],'群聊天',gMap));
  }else{
    /* 全部备份：直接按 chatId 合并（id 一致） */
    const all=d.chats||{};
    Object.keys(all).forEach(k=>addMsg(k,all[k],'聊天',null));
  }

  /* —— 朋友圈 —— */
  if(Array.isArray(d.moments)&&d.moments.length){
    const b=(state.moments||[]).length;
    state.moments=mergeMoments(state.moments,d.moments);
    report.push('朋友圈 +'+((state.moments||[]).length-b)+' 条');
  }
  /* —— 信件 —— */
  if(Array.isArray(d.letters)&&d.letters.length){
    const b=(state.letters||[]).length;
    state.letters=mergeArrByName(state.letters,d.letters);
    report.push('信件 +'+((state.letters||[]).length-b)+' 封');
  }
  /* —— 设置：只补缺失项，不覆盖本地已有偏好 —— */
  if(d.settings&&typeof d.settings==='object'){
    state.settings=state.settings||{};
    Object.keys(d.settings).forEach(k=>{
      const cur=state.settings[k];
      if(cur===undefined||cur===null||cur==='') state.settings[k]=d.settings[k];
    });
  }
  if(Array.isArray(d.avatars)&&d.avatars.length){
    state.avatars=mergeArrByName(state.avatars,d.avatars);
  }
  if(Array.isArray(d.avatarLib)&&d.avatarLib.length){
    state.avatarLib=mergeArrByName(state.avatarLib,d.avatarLib);
  }
  return report;
}
function openImportDialog(raw, body, extra){
  let p;
  try{ p=parseImport(raw); }catch(err){ p={err:'文件解析出错：'+(err&&err.message||err)}; }
  if(p.err){ toast(p.err); return; }
  const s=importSummary(p);
  const typeLabel = p.isFull?'完整备份':'分项数据';
  const rows=[
    s.nCats?`字卡 <b>${s.nCats}</b> 组 · <b>${s.nCards}</b> 张`:null,
    s.nStk?`表情包 <b>${s.nStk}</b> 个`:null,
    s.nPat?`拍一拍 <b>${s.nPat}</b> 条`:null,
    s.nContacts?`联系人 <b>${s.nContacts}</b> 位`:null,
    s.nGroups?`群聊 <b>${s.nGroups}</b> 个`:null,
    s.nMsg?`聊天记录 <b>${s.nMsg}</b> 条`:null,
    s.nMoment?`朋友圈 <b>${s.nMoment}</b> 条`:null,
    s.nLetter?`信件 <b>${s.nLetter}</b> 封`:null,
    s.nAva?`头像 <b>${s.nAva}</b> 个`:null,
    s.nSet?`界面与气泡设置`:null,
  ].filter(Boolean);

  openModal('导入数据',`
    <div class="desc" style="margin-bottom:10px">识别为<b>${typeLabel}</b>，包含：</div>
    <div class="desc" style="margin-bottom:14px;line-height:1.9">${rows.length?rows.join('　·　'):'（未识别到可导入的内容）'}</div>
    <div class="exp-sec">选择导入方式</div>
    <label class="exp-row" style="border-color:var(--accent)">
      <input type="radio" name="impMode" id="impMerge" value="merge" checked style="margin-top:4px">
      <div style="flex:1">
        <div class="name" style="font-weight:800">并入（推荐）</div>
        <div class="meta">在原数据基础上加入新内容，自动删除重复项，现有内容不会被覆盖</div>
      </div>
    </label>
    <label class="exp-row">
      <input type="radio" name="impMode" id="impOver" value="over" style="margin-top:4px">
      <div style="flex:1">
        <div class="name" style="font-weight:800">全部覆盖</div>
        <div class="meta">用文件里的数据整体替换当前数据，<b>当前内容会丢失</b>（建议先导出备份）</div>
      </div>
    </label>
  `,()=>{
    const mode = $('impOver')&&$('impOver').checked ? 'over' : 'merge';
    /* v2.24.8：save() 现在返回布尔 —— 导入必须如实反馈是否真的落盘，
       不能「写不进还报成功」，否则用户刷新后以为导入失败（上一版就是这个坑）。 */
    let wrote=false;
    if(mode==='over'){
      /* 全部覆盖：优先用完整 state，分项文件则逐项替换 */
      let s2;
      if(p.kind==='full'){ s2=normalizeImportedState(p.data); }
      else{ s2=JSON.parse(JSON.stringify(state)); applyPartial(s2,p.data,p); }
      migrate(s2); state=s2; wrote=save(); applyTheme(); renderDesktop(); renderSet(body,extra);
      snapSaved(); syncSaveBar();
      if(wrote) toast('已全部覆盖导入');
    }else{
      const report=mergeIntoState(p);
      migrate(state); wrote=save(); applyTheme(); renderDesktop(); renderSet(body,extra);
      snapSaved(); syncSaveBar();
      if(wrote) toast('已并入：'+(report.length?report.slice(0,4).join('，'):'无新增内容'));
    }
    if(!wrote){
      /* 明确告知：数据已在本次会话生效，但没能写入本机存储 */
      openModal('导入已载入，但没能存到本机',
        '<div style="font-size:14px;line-height:1.8">内容已经<b>加载进当前界面</b>了，但本机存储已满，<b>没能写入磁盘</b>——一刷新就会回滚。<br><br>请先做这两步：<br>① 到「设置 → 数据」点<b>导出备份</b>，把当前数据存成文件；<br>② 点下面的<b>一键瘦身</b>清掉超龄图片缓存，再重新导入一次。<br><br>（本次导入的内容此刻仍在，先导出就不会丢。）</div>',
        ()=>{ const r=purgeOldImages(); renderSet(body,extra); toast('已清理 '+Math.round(r/1024)+'KB，请重新导入'); },
        null,'一键瘦身（推荐）','先知道了');
    }
  },null,'确认导入','取消');
}
/* 分项数据整体覆盖到 state 上 */
function applyPartial(s2,part,parsed){
  const cards=part.cards||{}, chats=part.chats||{}, extras=part.extras||{};
  if(cards.cats) s2.cats=cards.cats;
  if(cards.stickers) s2.stickers=cards.stickers;
  if(cards.myStickers) s2.myStickers=cards.myStickers;
  if(cards.patLib) s2.patLib=cards.patLib;
  if(Array.isArray(chats.contacts)&&chats.contacts.length) s2.contacts=chats.contacts;
  if(Array.isArray(chats.groups)&&chats.groups.length) s2.groups=chats.groups;
  s2.chats=s2.chats||{};
  if(chats.dm) Object.keys(chats.dm).forEach(k=>{ s2.chats[k]=chats.dm[k]; });
  if(chats.group) Object.keys(chats.group).forEach(k=>{ s2.chats[k]=chats.group[k]; });
  /* v2.24.2：其他（信箱 / 头像库 / 朋友圈 / 界面设置） */
  if(Array.isArray(extras.letters)) s2.letters=extras.letters;
  if(Array.isArray(extras.avatarLib)) s2.avatarLib=extras.avatarLib;
  if(Array.isArray(extras.moments)) s2.moments=extras.moments;
  if(extras.settings&&typeof extras.settings==='object') s2.settings=extras.settings;
  return s2;
}
function dlBlob(blob,filename){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  URL.revokeObjectURL(a.href);
}


function setPanelLook(s){
  return `
    <div class="card">
      <div class="title" style="margin-bottom:8px">${I('moonHalf',16)} 外观</div>
      <div class="rowline" style="padding-top:6px">
        <div style="flex:1"><div class="name">夜间模式</div><div class="meta">所有界面切换为深色，夜里看着不刺眼</div></div>
        <button class="switch ${s.darkMode?'on':''}" id="darkSwitch"></button>
      </div>
      <div class="seg" style="margin-top:4px">
        <button class="${s.darkMode===false?'on':''}" data-dmode="light">${I('sun',14)} 白天</button>
        <button class="${s.darkMode===true?'on':''}" data-dmode="dark">${I('moon',14)} 夜间</button>
      </div>
      <div class="desc" style="margin-top:12px">更多外观（配色 / 壁纸 / 气泡 / 字体）在主页面的「主题」App 里</div>
    </div>`;
}

/* 设置页分区切换 + 各分区事件绑定 */
function bindSetPanels(body,extra,s,persist){
  /* 顶部方块：切换分区（重绘当前页） */
  body.querySelectorAll('[data-stab]').forEach(el=>el.addEventListener('click',()=>{
    setTab=el.dataset.stab;
    renderSet(body,extra);
  }));
  /* —— 以下绑定按存在性判断，因为不同分区 DOM 不同 —— */
  /* 数值输入：失焦时规范化并写入草稿（不落盘） */
  ['replyMin','replyMax','gapMin','gapMax','cardMaxInput'].forEach(id=>{
    const el=$(id); if(!el)return;
    el.addEventListener('change',()=>{
      const num=(v,def,lo,hi)=>{v=parseInt(v);return isNaN(v)?def:Math.min(hi,Math.max(lo,v));};
      const rMin=$('replyMin'),rMax=$('replyMax'),gMin=$('gapMin'),gMax=$('gapMax'),cMax=$('cardMaxInput');
      if(rMin&&rMax){ s.replyMin=num(rMin.value,5,1,600); s.replyMax=num(rMax.value,50,1,600);
        if(s.replyMin>s.replyMax)[s.replyMin,s.replyMax]=[s.replyMax,s.replyMin]; }
      if(gMin&&gMax){ s.gapMin=num(gMin.value,3,1,120); s.gapMax=num(gMax.value,5,1,120);
        if(s.gapMin>s.gapMax)[s.gapMin,s.gapMax]=[s.gapMax,s.gapMin]; }
      if(cMax) s.cardMax=num(cMax.value,3,1,4);
      persist();
    });
  });
  /* 我的昵称（在「我的」分区） */
  const myNameEl=$('myNameInput');
  if(myNameEl)myNameEl.addEventListener('change',()=>{
    s.myName=myNameEl.value.trim()||'彤';
    persist();
  });
  /* 换我的头像（弹窗选择 / 上传） */
  const myAvaBtn=$('myAvaBtn');
  if(myAvaBtn)myAvaBtn.addEventListener('click',()=>{
    let picked=s.myAvatar||'';
    const mk=openModal('我的头像',`
      <div class="stk-grid" id="mpGrid">
        ${state.avatarLib.map(a=>`<div class="stk ${picked===a.id?'sel':''}" data-ava="${a.id}">${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}</div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <input id="mpEmoji" placeholder="输入一个 emoji" maxlength="4" style="flex:1">
        <button class="btn small ghost" id="mpAddEmoji" style="margin:0">添加</button>
        <button class="btn small ghost" id="mpUpload" style="margin:0">上传图片</button>
      </div>
      <input type="file" id="mpFile" accept="image/*" style="display:none">`,()=>{
      s.myAvatar=picked; persist(); renderDesktop(); renderChatListRefresh();
      renderSet(body,extra); toast('头像已更新');
    });
    const grid=mk.querySelector('#mpGrid');
    const bind=()=>grid.querySelectorAll('[data-ava]').forEach(el=>el.addEventListener('click',()=>{
      picked=el.dataset.ava;
      grid.querySelectorAll('.stk').forEach(x=>x.classList.toggle('sel',x.dataset.ava===picked));
    }));
    const redraw=()=>{
      grid.innerHTML=state.avatarLib.map(a=>`<div class="stk ${picked===a.id?'sel':''}" data-ava="${a.id}">${a.type==='emoji'?escapeHtml(a.data):`<img src="${a.data}" alt="">`}</div>`).join('');
      bind();
    };
    bind();
    mk.querySelector('#mpAddEmoji').addEventListener('click',()=>{
      const e=mk.querySelector('#mpEmoji').value.trim();
      if(!e)return toast('先输入一个 emoji');
      state.avatarLib.push({id:'a'+Date.now(),type:'emoji',data:e});
      mk.querySelector('#mpEmoji').value=''; redraw();
    });
    mk.querySelector('#mpUpload').addEventListener('click',()=>mk.querySelector('#mpFile').click());
    mk.querySelector('#mpFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=()=>compressImage(r.result,200,url=>{
        const id='a'+Date.now();
        state.avatarLib.push({id,type:'img',data:url}); picked=id; redraw();
      });
      r.readAsDataURL(f); e.target.value='';
    });
  });
  /* 概率滑杆 */
  [['callInProb',25],['callAnswer',85],['callHangProb',20],['stickerProb',20],['patProb',20],['deskCheckProb',50],['readNoProb',60],
   ['groupReplyProb',70],['momentProb',40],['letterProb',50],['momentLikeProb',70],['momentCommentProb',35],['gameInviteProb',50],
   ['surveyAskProb',37],['listenAcceptProb',85]].forEach(([id,def])=>{
    const el=$(id); if(!el)return;
    el.addEventListener('input',()=>{ $(id+'Val').textContent=el.value+'%'; });
    el.addEventListener('change',()=>{ s[id]=parseInt(el.value); persist(); });
  });
  /* 夜间模式 */
  const _darkSwitch=$('darkSwitch');
  if(_darkSwitch)_darkSwitch.addEventListener('click',function(){
    s.darkMode=!s.darkMode; this.classList.toggle('on',s.darkMode);
    applyTheme();
    persist();
    toast(s.darkMode?'夜间模式已开启':'已切回白天');
  });
  /* 我的头像库 */
  body.querySelectorAll('[data-setava]').forEach(el=>el.addEventListener('click',e=>{
    if(e.target.dataset.delava)return;
    s.myAvatar=el.dataset.setava; persist(); toast('已设为我的头像');
    renderSet(body,extra); renderDesktop(); renderChatListRefresh();
  }));
  body.querySelectorAll('[data-delava]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.delava;
    state.avatarLib=state.avatarLib.filter(a=>a.id!==id);
    if(s.myAvatar===id)s.myAvatar='';
    state.contacts.forEach(c=>{ if(c.avatar===id)c.avatar=''; });
    persist(); renderSet(body,extra); renderDesktop();
  }));
  const _avaManageBtn=$('avaManageBtn');
  if(_avaManageBtn)_avaManageBtn.addEventListener('click',()=>{ avaManage=!avaManage; renderSet(body,extra); });
  const _avaAddEmoji=$('avaAddEmoji');
  if(_avaAddEmoji)_avaAddEmoji.addEventListener('click',()=>{
    const mk=openModal('添加 emoji 头像','<div class="field" style="margin-bottom:0"><input id="avaEm" maxlength="4" placeholder="如 🐻"></div>',()=>{
      const e=mk.querySelector('#avaEm').value.trim();
      if(!e){ toast('先输入一个 emoji'); return false; }
      state.avatarLib.push({id:'a'+Date.now(),type:'emoji',data:e});
      persist(); renderSet(body,extra); toast('已添加头像');
    });
  });
  const _avaAddImg=$('avaAddImg');
  if(_avaAddImg)_avaAddImg.addEventListener('click',()=>{ const f=$('avaFile'); if(f)f.click(); });
  const _avaFile=$('avaFile');
  if(_avaFile)_avaFile.addEventListener('change',e=>{
    const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=()=>{
      compressImage(r.result,200,url=>{
        state.avatarLib.push({id:'a'+Date.now()+Math.random().toString(36).slice(2,5),type:'img',data:url});
        persist(); renderSet(body,extra); toast('已添加图片头像');
      });
    };
    r.readAsDataURL(f); e.target.value='';
  });
  const _readNoReplySwitch=$('readNoReplySwitch');
  if(_readNoReplySwitch)_readNoReplySwitch.addEventListener('click',function(){
    s.readNoReply=!s.readNoReply; this.classList.toggle('on',s.readNoReply);
    persist(); renderSet(body,extra); renderDesktop();
    toast(s.readNoReply?'已开启已读不回':'已关闭已读不回');
  });
  const _autoReplySwitch=$('autoReplySwitch');
  if(_autoReplySwitch)_autoReplySwitch.addEventListener('click',function(){
    s.autoReply=!s.autoReply; this.classList.toggle('on',s.autoReply);
    if(!s.autoReply)Object.keys(pending).forEach(clearPending);
    persist();
  });
  const _deskCheckSwitch=$('deskCheckSwitch');
  if(_deskCheckSwitch)_deskCheckSwitch.addEventListener('click',function(){
    s.deskCheck=!s.deskCheck; this.classList.toggle('on',s.deskCheck);
    persist(); toast(s.deskCheck?'已开启挂桌面查岗':'已关闭查岗'); scheduleDeskCheck();
  });
  /* v2.20.0：联系人主动发消息开关 */
  const _proactiveMsgSwitch=$('proactiveMsgSwitch');
  if(_proactiveMsgSwitch)_proactiveMsgSwitch.addEventListener('click',function(){
    s.proactiveMsg=(s.proactiveMsg===false); this.classList.toggle('on',s.proactiveMsg!==false);
    persist(); toast(s.proactiveMsg!==false?'已开启：联系人会主动发消息':'已关闭：联系人不再主动发消息');
  });
  /* 消息推送通知：开启时请求浏览器授权 */
  const _notifySwitch=$('notifySwitch');
  if(_notifySwitch)_notifySwitch.addEventListener('click',function(){
    s.notifyOn=!s.notifyOn; this.classList.toggle('on',s.notifyOn);
    persist();
    if(s.notifyOn&&'Notification' in window&&Notification.permission==='default'){
      Notification.requestPermission().then(p=>{
        toast(p==='granted'?'通知已授权':'浏览器未授权通知，将只用站内提示');
        try{ pushBgNotifyState(); }catch(e){}       /* v2.24.12：授权后立刻告诉 SW 可以接管后台通知 */
      });
    }else{
      toast(s.notifyOn?'推送通知已开启':'推送通知已关闭');
      try{ pushBgNotifyState(); }catch(e){}
    }
  });
  /* v2.24.12：后台通知 —— 开关 + 权限说明 + 一键申请系统通知权限 */
  const _bgNotifySwitch=$('bgNotifySwitch');
  if(_bgNotifySwitch)_bgNotifySwitch.addEventListener('click',function(){
    s.bgNotify=(s.bgNotify===false);          /* 默认开 → 点击在 开/关 之间切 */
    this.classList.toggle('on',s.bgNotify!==false);
    persist();
    try{ pushBgNotifyState(); }catch(e){}
    try{ renderSet(body,extra); }catch(e){}   /* 重绘：刷新下方权限说明与页签小标题 */
    if(s.bgNotify!==false){
      if('Notification' in window && Notification.permission==='default'){
        toast('已开启后台通知 · 建议点右侧「去授权」允许系统通知');
      }else if('Notification' in window && Notification.permission==='denied'){
        toast('开关已开，但通知权限被浏览器拒绝了 —— 需去浏览器设置里允许');
      }else{
        toast('已开启后台消息通知');
      }
    }else{
      toast('已关闭后台消息通知 · 退到后台将不再提醒');
    }
  });
  const _bgNotifyBtn=$('bgNotifyBtn');
  if(_bgNotifyBtn)_bgNotifyBtn.addEventListener('click',function(){
    if(!('Notification' in window)){ toast('当前浏览器不支持系统通知'); return; }
    if(!('serviceWorker' in navigator)){ toast('当前环境不支持后台通知（需 https 或 localhost）'); return; }
    if(Notification.permission==='granted'){
      toast('通知已授权 · 退出网站后仍会收到消息');
      try{ pushBgNotifyState(); }catch(e){}
      return;
    }
    if(Notification.permission==='denied'){
      toast('通知被浏览器拒绝了，请在浏览器设置里允许本站通知');
      return;
    }
    Notification.requestPermission().then(p=>{
      if(p==='granted'){
        s.notifyOn=true; s.bgNotify=true; persist();
        try{ pushBgNotifyState(); }catch(e){}
        try{ renderSet(body,extra); }catch(e){}
        toast('已开启 · 退出网站、没清后台也能收到消息通知');
      }else toast('未授权，暂时收不到系统通知');
    }).catch(()=>toast('授权失败'));
  });
  /* 音效开关 + 音量 + 试听 */
  const _soundSwitch=$('soundSwitch');
  if(_soundSwitch)_soundSwitch.addEventListener('click',function(){
    s.soundOn=!s.soundOn; this.classList.toggle('on',s.soundOn);
    persist(); renderSet(body,extra);
    if(s.soundOn){ playDing(); toast('提示音已开启'); }
    else toast('提示音已关闭');
  });
  const volEl=$('soundVol');
  if(volEl){
    volEl.addEventListener('input',()=>{
      s.soundVol=volEl.value/100; persist();
      volEl.parentElement.querySelector('span:last-of-type').textContent=volEl.value+'%';
    });
    volEl.addEventListener('change',()=>playDing());
  }
  const stBtn=$('soundTest');
  if(stBtn)stBtn.addEventListener('click',()=>playDing());
  const _exportBtn=$('exportBtn');
  if(_exportBtn)_exportBtn.addEventListener('click',()=>openExportDialog());  const _importBtn=$('importBtn');
  if(_importBtn)_importBtn.addEventListener('click',()=>{ const f=$('importFile'); if(f)f.click(); });
  const _importFile=$('importFile');
  if(_importFile)_importFile.addEventListener('change',e=>{
    const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=()=>{ try{ openImportDialog(r.result, body, extra); }
                   catch(err){ openModal('导入失败','<div style="font-size:14px;line-height:1.8">文件读进来了，但解析时出错：<br><code style="font-size:12px;word-break:break-all">'+escapeHtml(String(err&&err.message||err))+'</code><br><br>请确认选的是本 App「导出数据」生成的 <b>.json</b> 文件（不是聊天记录截图或 txt）。</div>',null,null,'知道了'); } };
    r.onerror=()=>{ toast('文件读取失败，请重新选择'); };
    r.readAsText(f); e.target.value='';
  });
  /* v2.24.1：回滚到「最近一次正常存档」（每次保存都会留一份） */
  const _rollbackBtn=$('rollbackBtn');
  if(_rollbackBtn)_rollbackBtn.addEventListener('click',()=>{
    let bak=null;
    try{ bak=localStorage.getItem(LS_KEY+'_bak'); }catch(e){}
    if(!bak){ toast('还没有可回滚的存档'); return; }
    let info='';
    try{
      const b=JSON.parse(bak);
      const nc=(b.contacts||[]).length, ncard=(b.cats||[]).reduce((a,c)=>a+((c.cards||[]).length),0);
      info=`存档里含 <b>${nc}</b> 位联系人 · <b>${ncard}</b> 张字卡 · <b>${(b.groups||[]).length}</b> 个群聊。`;
    }catch(e){}
    openModal('回滚存档','<div style="font-size:14px;line-height:1.8">将把本机数据恢复到<b>最近一次正常保存</b>的状态（每次正常保存都会自动留一份）。<br>'+info+'<br><b>当前数据会被替换</b>，确定继续？</div>',()=>{
      try{
        const s=loadRaw(bak);
        state=s; migrate(state); save();
        applyTheme(); renderDesktop();
        setTab='data'; renderSet($('appBody'),$('appExtra'));
        toast('已回滚到最近一次正常存档');
      }catch(err){ toast('回滚失败：'+(err&&err.message||err)); }
    },null,'确认回滚','取消');
  });
  /* v2.24.9：一键整理快取 —— 只重写快取镜像，绝不动正式数据（正式数据住大容量库） */
  const _slimBtn=$('slimBtn');
  if(_slimBtn)_slimBtn.addEventListener('click',()=>{
    const freed=rebuildMirror();
    renderSet(body,extra);
    toast(freed>0 ? ('快取已整理（省 '+Math.round(freed/1024)+'KB），完整数据一条不少') : '快取已经很干净，完整数据一条不少');
  });
  /* 危险操作：二次确认（防误触） */
  const _clearChatBtn=$('clearChatBtn');
  if(_clearChatBtn)_clearChatBtn.addEventListener('click',()=>{
    openModal('清空聊天记录','<div style="font-size:14px;line-height:1.7">确定清空所有联系人和群聊的聊天记录？<br><b>此操作不可恢复</b>，建议先导出备份。</div>',()=>{
      openModal('再确认一次','<div style="font-size:14px;line-height:1.7">真的要清空<b>全部</b>聊天记录吗？<br>字卡库、头像、设置都会保留。</div>',()=>{
        Object.keys(state.chats).forEach(id=>{ state.chats[id]=[]; delete unreadMap[id]; });
        save(); toast('已清空'); renderDesktop();
      });
    });
  });
  const _resetCardsBtn=$('resetCardsBtn');
  if(_resetCardsBtn)_resetCardsBtn.addEventListener('click',()=>{
    openModal('恢复默认字卡库','<div style="font-size:14px;line-height:1.7">恢复默认字卡库？你添加的分类和字卡会被覆盖。</div>',()=>{
      state.cats=defaultLibrary(); save(); toast('已恢复');
      if(currentApp==='cards')renderCards($('appBody'),$('appExtra'));
    });
  });
  /* 锁定 / 解锁切换（防误触） */
  const _setLockBtn=$('setLockBtn');
  if(_setLockBtn)_setLockBtn.addEventListener('click',()=>{
    if(setUnlocked){
      setLock();
      /* 锁定前把当前草稿先落盘，避免用户以为丢了 */
      save(); snapSaved();
      renderSet(body,extra);
    }else{
      setUnlock();
      snapSaved();
      renderSet(body,extra);
    }
  });
  /* 连点两下构建号：切换锁定 / 解锁 */
  const _buildNumTap=$('buildNumTap');
  if(_buildNumTap)_buildNumTap.addEventListener('click',()=>{
    setUnlockClicks++;
    clearTimeout(setUnlockTimer);
    if(setUnlockClicks>=2){
      setUnlockClicks=0;
      if(setUnlocked){ setLock(); save(); snapSaved(); } else { setUnlock(); snapSaved(); }
      renderSet(body,extra);
      return;
    }
    setUnlockTimer=setTimeout(()=>{ setUnlockClicks=0; },600);
  });
  /* 版本检查：拉线上 version.json（不走缓存），不一致则引导刷新 */
  const cv=$('checkVerBtn');
  if(cv)cv.addEventListener('click',()=>{
    const st=$('verState');
    /* 单文件版没有同源 version.json，检查必然失败——直接说明 */
    if(window.__SINGLE__){
      if(st)st.textContent='单文件版无需检查更新，以发布页版本为准';
      toast('单文件版以发布页为准');
      return;
    }
    if(st)st.textContent='检查中…';
    fetch('version.json?t='+Date.now(),{cache:'no-store'})
      .then(r=>r.ok?r.json():null)
      .then(j=>{
        if(!j||!j.build)throw new Error('no-version');
        const mine=String(window.__BUILD__||'0');
        if(String(j.build)===mine){
          if(st)st.textContent='已是最新版本 v'+j.build+' ✓';
          toast('已是最新版本 ✓');
        }else{
          if(st)st.textContent='线上有新版 v'+j.build+'，正在刷新…';
          toast('发现新版本，正在刷新…');
          setTimeout(()=>location.replace(location.pathname+'?v='+j.build+'&t='+Date.now()),700);
        }
      })
      .catch(()=>{ if(st)st.textContent='检查失败，请检查网络后重试'; toast('检查失败'); });
  });
  /* 重新开始：清空本机数据 → 全新初始状态（二次确认） */
  const fb=$('freshBtn');
  if(fb)fb.addEventListener('click',()=>{
    openModal('重新开始','<div style="font-size:14px;line-height:1.7">将<b>清空本机全部数据</b>（联系人、聊天记录、字卡、备份外的所有内容），回到像刚安装一样的初始状态。<br><br>建议先「导出数据」备份。确定继续？</div>',()=>{
      openModal('再确认一次','<div style="font-size:14px;line-height:1.7">这一步<b>无法撤销</b>。真的要从头开始吗？</div>',()=>{
        try{
          localStorage.setItem('tonghuayu_idb_wipe','1');   /* v2.24.9：大库也要清（开机校时见 idbBootCheck） */
          localStorage.removeItem(LS_KEY);
          localStorage.removeItem('tonghuayu_skip_splash');
          localStorage.removeItem('tonghuayu_notice_ok');   /* v2.24.12：重看须知 */
          localStorage.removeItem('th_miniPos');
          localStorage.removeItem('th_pass_ok_v');
          sessionStorage.removeItem('th_pass_ok');
        }catch(e){}
        try{ history.replaceState(null,'',location.pathname); }catch(e){}
        location.reload();
      });
    });
  });
  if(!setSavedSnap)snapSaved();
  syncSaveBar();
}

/* ================= 设置页保存条 ================= */
function syncSaveBar(){
  const bar=$('saveBar'); if(!bar)return;
  const onSettings = currentApp==='set';
  const dirty = draftDirty();
  const show = onSettings && dirty && !setUnlocked;
  bar.classList.toggle('on', !!show);
  const t1=$('sbTitle'), t2=$('sbDesc');
  if(t1)t1.textContent = show?'有改动尚未保存':'';
  if(t2)t2.textContent = show?'点右侧「保存」后才会生效':'';
}
function initSaveBar(){
  const bar=$('saveBar'); if(!bar)return;
  const sv=$('sbSave'), un=$('sbUndo');
  if(sv)sv.addEventListener('click',()=>{
    save(); snapSaved(); syncSaveBar();
    renderDesktop(); applyTheme();
    toast('设置已保存 ✓');
  });
  if(un)un.addEventListener('click',()=>{
    if(!setSavedSnap)return;
    try{
      const snap=JSON.parse(setSavedSnap);
      state.settings=snap;
      save(); applyTheme();
      if(currentApp==='set')renderSet($('appBody'),$('appExtra'));
      syncSaveBar();      toast('已撤销未保存的改动');
    }catch(e){}
  });
}

/* ================= 开屏页（v2.17.0 二段式 · v2.24.12 拆成「图标」与「开场动画」两段） =================
   v2.24.12 起开屏被拆成两段：
     · 第一段是「点进去的图标」—— 网站一打开就看到的这一屏，轻触即出（就是下面这个 #splash）；
     · 第二段是「开场动画」—— 须知 / 口令都过完之后再放一次，作为进站仪式（startSplashIntro）。
   两段复用同一个 #splash 元素、同一套动画，靠 hold / out 两个 class 控制节奏。 */
function initSplash(){
  const sp=$('splash');
  if(!sp)return;
  const enter=()=>{
    if(sp.classList.contains('out'))return;
    if(sp.classList.contains('hold'))return;    /* v2.24.12：被须知/口令门拦住时，轻触无效 */
    sp.classList.add('out');
    /* v2.24.12：「下次自动进入」只自动跳过第一段（图标），后面的须知 / 口令 / 开场动画照走 */
    if($('spRemember')&&$('spRemember').checked){
      try{
        const wasSkipped = localStorage.getItem('tonghuayu_skip_splash')==='1';
        localStorage.setItem('tonghuayu_skip_splash','1');
        if(!wasSkipped){ setTimeout(()=>{ try{ applyEntryStage(); }catch(e){} }, 60); }
      }catch(e){}
    }
    setTimeout(()=>{ sp.style.display='none'; },750);
  };
  window.__enterSplash = enter;                 /* 老口令门 inline 脚本若还在，调它也幂等；v2.24.12 起口令门由流程序列接管 */
  let skipped=false;
  try{ skipped=localStorage.getItem('tonghuayu_skip_splash')==='1'; }catch(e){}
  if(skipped){ setTimeout(enter,1800); }
  else{
    /* 动画先行约 1 秒后任意轻触进入 */
    let ready=false;
    setTimeout(()=>{ ready=true; },1000);
    sp.addEventListener('click',e=>{
      if(e.target.closest('.sp-remember'))return; /* 勾选框不触发进入 */
      if(ready)enter();
    });
  }
}
/* v2.24.12：开场动画 —— 须知与口令都过了之后播一遍，播完（或轻触）即进入网站。
   注意 #splash 此刻可能已经被第一段「轻触」变成了 out 状态，这里会把它复位重播。 */
let splashIntroPlayed = false;
function startSplashIntro(){
  if(splashIntroPlayed) return;
  splashIntroPlayed = true;
  const sp = $('splash');
  if(!sp) return;
  const finish = ()=>{
    if(sp.classList.contains('out')) return;
    sp.classList.add('out');
    setTimeout(()=>{ sp.style.display='none'; }, 750);
  };
  /* 复位：去掉 hold/out，把 display 还回来，并重跑一遍进场动画 */
  sp.classList.remove('hold','out');
  sp.style.display = '';
  sp.style.visibility = '';
  try{
    sp.style.animation = 'none';
    void sp.offsetWidth;                       /* 强制重排，动画才能重播 */
    sp.style.animation = '';
  }catch(e){}
  /* 动画放约 2.4 秒后允许轻触；3.6 秒后自动进入，不让人干等 */
  let ready = false;
  setTimeout(()=>{ ready = true; }, 2400);
  const onClick = e=>{
    if(e.target.closest('.sp-remember')) return;
    if(ready){ sp.removeEventListener('click', onClick); finish(); }
  };
  sp.addEventListener('click', onClick);
  setTimeout(()=>{ sp.removeEventListener('click', onClick); finish(); }, 3600);
}

/* ================= 网站须知（v2.24.11 首版 · v2.24.12 改为流程第一关） =================
   v2.24.12 进站顺序：开屏图标 →（轻触）→ 网站须知 →（阅读满 30 秒 + 勾选）→ 输入口令 → 开场动画 → 进入网站
   机制：
     · 首次进入 + 每次网站更新（build 变化）都强制弹出须知，未确认过不进入下一步；
     · 须知的开启由 applyEntryStage() 统管（见下），务必先看过关卡状态再弹；
     · 已通过记录：localStorage.tonghuayu_notice_ok = build 号。 */
const NOTICE_READ_SECONDS = 30;
const NOTICE_KEY = 'tonghuayu_notice_ok';
let noticeTicker = null;
let noticeLayerEl = null;      /* 须知层（从 <template id="noticeTpl"> 搬进 #phone 后的实体） */
let noticeReadyCb = null;      /* 用户点「确认进入网站」后要执行的下一步 */
let noticeInited = false;

function noticeNeedShow(){
  try{ return localStorage.getItem(NOTICE_KEY) !== String(window.__BUILD__ || ''); }
  catch(e){ return true; }
}
/* 把 <template id="noticeTpl"> 里的须知层搬进 #phone 内部：
   ① 它必须能盖住开屏页（#splash，z-index 300）→ 需要更高的 z-index；
   ② 它不该盖住手机屏以外的页面底色 → 所以放进 #phone（#phone 自身是 relative，层内 absolute 即只覆盖手机屏）。
   幂等：重复调用不会重复插入。 */
function mountNoticeLayer(){
  if(noticeLayerEl && noticeLayerEl.isConnected) return noticeLayerEl;
  const existed = document.getElementById('noticeLayer');
  if(existed){ noticeLayerEl = existed; return existed; }
  const tpl = document.getElementById('noticeTpl');
  const phone = document.getElementById('phone');
  if(!tpl || !phone) return null;
  let node = null;
  try{ node = tpl.content.firstElementChild.cloneNode(true); }catch(e){ node = null; }
  if(!node) return null;
  phone.appendChild(node);
  noticeLayerEl = node;
  return node;
}
/* 显示须知；onDone 在用户点「确认进入网站」后调用（只调用一次） */
function openNotice(onDone){
  const lay = mountNoticeLayer();
  if(!lay){ if(typeof onDone==='function') onDone(); return false; }
  const btn = lay.querySelector('#ntEnter') || $('ntEnter');
  const cb  = lay.querySelector('#ntAgree') || $('ntAgree');
  if(!btn || !cb){ if(typeof onDone==='function') onDone(); return false; }
  noticeReadyCb = (typeof onDone==='function') ? onDone : null;

  lay.classList.add('on');
  hideUnderNotice();

  if(noticeInited){ /* 已经绑过事件（同一页面内二次弹出）→ 直接放行 */
    return true;
  }
  noticeInited = true;

  let left = NOTICE_READ_SECONDS;
  let timeUp = false;
  const LABEL_READ = '请先阅读（', LABEL_WAIT_CB = '请勾选上方确认项', LABEL_GO = '确认进入网站';
  const sync = ()=>{
    const ready = cb.checked && timeUp;
    btn.disabled = !ready;
    /* 用 innerHTML 重建，保留倒计时 span（textContent 会把 span 抹掉） */
    if(ready) btn.innerHTML = LABEL_GO;
    else if(timeUp) btn.innerHTML = LABEL_WAIT_CB;
    else btn.innerHTML = LABEL_READ + '<span class="nt-remain" id="ntRemain">' + left + '</span>s）';
  };
  const remain = lay.querySelector('#ntRemain');
  if(remain) remain.textContent = String(left);
  sync();

  clearInterval(noticeTicker);
  noticeTicker = setInterval(()=>{
    left--;
    if(left <= 0){
      left = 0; timeUp = true;
      clearInterval(noticeTicker); noticeTicker = null;
    }
    const el = lay.querySelector('#ntRemain');
    if(el) el.textContent = String(left);
    sync();
  }, 1000);

  cb.addEventListener('change', sync);
  btn.addEventListener('click', ()=>{
    if(btn.disabled) return;
    clearInterval(noticeTicker); noticeTicker = null;
    try{ localStorage.setItem(NOTICE_KEY, String(window.__BUILD__ || '')); }catch(e){}
    lay.classList.remove('on');
    /* v2.24.12：确认须知后不再直接进站 —— 交给流程状态机推进（下一步通常是输入口令） */
    const done = noticeReadyCb; noticeReadyCb = null;
    if(typeof done==='function') done();
  });
  return true;
}
/* 须知展示期间：压住开屏页（防其自动进入）、压住桌面。口令门在须知之下（见 CSS z-index） */
function hideUnderNotice(){
  const sp = $('splash');
  if(sp && !sp.classList.contains('out')) sp.classList.add('hold');
}
/* 兼容旧调用点：老逻辑「口令门若在，须知稍后再弹」由 applyEntryStage 统一接管 */
function initNotice(){
  /* v2.24.12：弹不弹、什么时候弹，全部交给 applyEntryStage() 决定 */
  return applyEntryStage();
}

/* ================= 进站流程状态机（v2.24.12） =================
   顺序：开屏图标 →（轻触）→ 网站须知 →（读满 30 秒 + 勾选）→ 输入口令 → 开场动画 → 进入网站
   · 口令已在 sessionStorage / localStorage 里通过过的老用户：轻触开屏后直接进站（不再卡口令）；
   · 须知每次更新（build 变化）都要重看，所以它排在口令之前 —— 未看须知不被告知要输口令也很自然，
     因为口令提示就写在须知第七条里。 */
/* ================= v2.24.23 服务端口令门（云服务） =================
   为什么要有它：原来口令是明文写在 index.html 里的（window.__PASS__），拿到链接的人看一眼源码
   就拿到了口令；更麻烦的是改了口令也没法让已经进来的老设备失效，而且「有多少人来过」根本无从查起。
   现在把口令判定挪到服务端（PostgreSQL 函数 gate_check，bcrypt 校验）：
     · 源码里不再需要口令          → 看源码拿不到
     · 换口令 = 改一行数据库记录   → 所有旧设备立刻失效（令牌由口令哈希派生）
     · 每次进站尝试都落一行日志    → 这才第一次有了「多少人、几个设备、什么时候来」
   覆盖范围（实测）：云服务按精确 Origin 匹配，只有主链能直连；单文件版与 GitHub 版被 403 挡掉，
   所以它们走 gate-bridge.html 桥接 —— 那是主链上的一页，用隐藏 iframe + postMessage 代为通话。
   云端不可达时（离线、桥接超时、文件被另存到本机）退回本地口令，保证离线仍能用。 */
const CLOUD_CFG = {
  /* 四项均取自云服务 publicConfig（workbuddy_cloud_service action=activate 的返回）。
     endpoint 必须与发布域名一字不差，否则精确 Origin 匹配会拒掉整条通道。 */
  endpoint: 'https://tonghua-island.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_LH8sgrzkWc4ZO24DLCSejY_gAwzDTrHkUv2OORSdmqWQDK8dB305PEp'
};
const GATE_BRIDGE_URL = CLOUD_CFG.endpoint + '/gate-bridge.html';
const GATE_TOKEN_KEY = 'th_gate_token';
/* 桥接页要等 SDK 下载完才报「就位」（最多 2.5 秒），所以这里的超时要留够 */
const GATE_TIMEOUT_MS = 9000;
let _cloudClient = null;
/* kind: unknown（还没问过）| checking（正在静默验令牌）| ok | bad | offline（创建者已停站）
        | locked（试错太频繁，临时锁）| unavailable（云端到不了 → 走本地兜底） */
let gateState = { kind: 'unknown' };

function gateCloudReady(){
  try{ return typeof WorkBuddyCloud !== 'undefined' && WorkBuddyCloud && typeof WorkBuddyCloud.createWorkBuddyCloud === 'function'; }
  catch(e){ return false; }
}
function cloudClient(){
  if(_cloudClient) return _cloudClient;
  if(!gateCloudReady()) return null;
  try{
    _cloudClient = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CLOUD_CFG.endpoint,
      oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
      publishableKey: CLOUD_CFG.publishableKey
    });
  }catch(e){ _cloudClient = null; }
  return _cloudClient;
}
/* 设备标识：随机串，只用来给「独立访客」去重，不含任何身份信息 */
function gateDeviceId(){
  try{
    let d = localStorage.getItem('th_dev');
    if(!d){ d = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('th_dev', d); }
    return d;
  }catch(e){ return ''; }
}
function gateChannel(){
  try{
    const h = location.hostname || '';
    /* v2.24.23：先用「精确 origin」认主链，再按域名认别家。
       起因：分享版是 tonghua-friends.app.workbuddy.host，与主链同属
       app.workbuddy.host 这一族。若按域名族判定，它会误判成 main，
       而它又不是精确 origin —— 直连被 403、桥接又不走，最后静默退回本机明文口令：
       既不落日志（统计失真），也躲过换口令与停站。所以同族的「另一个站点」
       必须单独成类（wb），照样走桥接。 */
    if(location.origin === CLOUD_CFG.endpoint) return 'main';
    if(h.indexOf('htmlcode.fun') >= 0) return 'single';
    if(h.indexOf('github.io') >= 0) return 'gh';
    if(h.indexOf('.app.workbuddy.host') >= 0) return 'wb';
    return h ? 'other' : 'local';
  }catch(e){ return 'unknown'; }
}
function gateHasToken(){
  try{ return !!localStorage.getItem(GATE_TOKEN_KEY); }catch(e){ return false; }
}
/* 直连：只有主链（与 endpoint 同源）能用 */
function gateDirect(value){
  return new Promise(function(resolve){
    const c = cloudClient();
    if(!c || !c.database){ resolve({ status: 'unavailable' }); return; }
    let done = false;
    const timer = setTimeout(function(){ if(!done){ done = true; resolve({ status: 'unavailable' }); } }, GATE_TIMEOUT_MS);
    const settle = function(v){ if(done) return; done = true; clearTimeout(timer); resolve(v); };
    try{
      c.database.rpc('gate_check', { p_pass: value, p_device: gateDeviceId(), p_channel: gateChannel() })
        .then(function(r){
          if(r && r.error){ settle({ status: 'unavailable' }); return; }
          const d = r && r.data;
          if(d && typeof d === 'object' && d.status) settle({ status: d.status, token: d.token || '' });
          else settle({ status: 'unavailable' });
        }, function(){ settle({ status: 'unavailable' }); });
    }catch(e){ settle({ status: 'unavailable' }); }
  });
}
/* 桥接：单文件版 / GitHub 版与云服务不同源，直连必被 403。改为在主链上开一个隐藏 iframe，
   由它（同源）去调云服务，再把 ok/bad 用 postMessage 回传。 */
function gateViaBridge(value){
  return new Promise(function(resolve){
    const ORIGIN = CLOUD_CFG.endpoint;
    const nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;border:0;';
    frame.src = GATE_BRIDGE_URL + '?nonce=' + encodeURIComponent(nonce);
    let settled = false;
    const finish = function(v){
      if(settled) return; settled = true;
      try{ window.removeEventListener('message', onMsg); }catch(e){}
      try{ if(frame.parentNode) frame.parentNode.removeChild(frame); }catch(e){}
      resolve(v);
    };
    function onMsg(e){
      if(e.origin !== ORIGIN) return;
      const d = e.data;
      if(!d || d.nonce !== nonce) return;
      if(d.type === 'th-gate-ready'){
        try{
          frame.contentWindow.postMessage({
            type: 'th-gate-ask', nonce: nonce, pass: value,
            device: gateDeviceId(), channel: gateChannel()
          }, ORIGIN);
        }catch(err){}
        return;
      }
      if(d.type === 'th-gate-result') finish({ status: d.status || 'unavailable', token: d.token || '' });
    }
    window.addEventListener('message', onMsg);
    try{ document.body.appendChild(frame); }catch(e){ finish({ status: 'unavailable' }); return; }
    setTimeout(function(){ finish({ status: 'unavailable' }); }, GATE_TIMEOUT_MS);
  });
}
function gateRemote(value){
  let sameOrigin = false;
  try{ sameOrigin = (location.origin === CLOUD_CFG.endpoint); }catch(e){}
  if(sameOrigin){
    /* 主链：与云服务同源，直接问 */
    if(!gateCloudReady()) return Promise.resolve({ status: 'unavailable' });
    return gateDirect(value);
  }
  /* 非主链：本页压根碰不到云服务（精确 Origin 会 403），交给主链上的桥接页代问。
     这条路径不需要本页加载 SDK —— 单文件版、GitHub 版、以及同族但不同 origin 的
     分享版（wb）都走它；其余情形（手机里另存的文件、未知域名、测试环境）
     一律判为够不着，直接退回本地口令。 */
  const ch = gateChannel();
  if(ch === 'single' || ch === 'gh' || ch === 'wb') return gateViaBridge(value);
  return Promise.resolve({ status: 'unavailable' });
}
/* 进站用：先问服务端；服务端够不着才退回本地口令 */
function gateSubmit(value){
  if(!value) return Promise.resolve({ status: 'bad' });
  return gateRemote(value).then(function(res){
    if(res && res.status && res.status !== 'unavailable') return res;
    let lp = '';
    try{ lp = String(window.__PASS__ || ''); }catch(e){}
    if(!lp) return { status: 'ok', local: true };
    return { status: value === lp ? 'ok' : 'bad', local: true };
  }, function(){ return { status: 'unavailable' }; });
}
/* 静默探测：p_pass 传 null，服务端只回报状态、不写日志。
   这样「停站」能立刻对所有人生效，也不会污染进站统计。 */
function gateProbe(){
  return gateRemote(null).then(function(res){ return (res && res.status) || 'unavailable'; },
                              function(){ return 'unavailable'; });
}
/* 静默验令牌：老设备进站时先拿本机存的令牌问一次服务端。
   令牌 = sha256(口令哈希)，所以换口令后它会自动对不上 → 老设备被重新拦回口令门。 */
function gateVerifyToken(){
  let tok = '';
  try{ tok = String(localStorage.getItem(GATE_TOKEN_KEY) || ''); }catch(e){}
  if(!tok) return Promise.resolve(false);
  return gateRemote('tok:' + tok).then(function(res){
    const st = (res && res.status) || 'unavailable';
    if(st === 'offline'){ gateState = { kind: 'offline' }; gateShowPaused(); return false; }
    if(st === 'ok'){ gateState = { kind: 'ok' }; return true; }
    if(st === 'unavailable'){ gateState = { kind: 'unavailable' }; return false; }
    /* bad / locked → 令牌已失效（多半是创建者换过口令）→ 清掉它，重新走口令门 */
    try{ localStorage.removeItem(GATE_TOKEN_KEY); }catch(e){}
    gateState = { kind: 'bad' };
    return false;
  }, function(){ gateState = { kind: 'unavailable' }; return false; });
}
/* 创建者在后台按下「停站」 → 立刻拦下所有通道 */
function gateShowPaused(){
  window.__BLOCKED__ = true;
  const lay = $('gateLayer'), app = $('phone');
  const t = $('gateTitle'), d = $('gateDesc'), rec = $('gatePassWrap'), hw = $('gateHintWrap');
  if(t) t.textContent = '已 暂 停 分 享';
  if(d) d.innerHTML = '这个页面的分享已关闭。<br>如需重新开放，请告诉创建者。';
  if(rec) rec.style.display = 'none';
  if(hw) hw.style.display = 'none';
  if(app) app.style.visibility = 'hidden';
  if(lay) lay.classList.add('on');
}
function gateLayerOn(){
  const g = $('gateLayer');
  return !!(g && g.classList.contains('on'));
}
/* v2.24.23：这个通道够不够得着云服务？主链直连；单文件版、GitHub 版、
   以及同族的分享版（wb）都走主链上的桥接。
   都不行（手机里另存的文件、未知域名、离线）才允许退回本地口令。 */
function gateCloudCapable(){
  const ch = gateChannel();
  return ch === 'main' || ch === 'single' || ch === 'gh' || ch === 'wb';
}
function passAlreadyOk(){
  let pass = '';
  try{ pass = String(window.__PASS__ || ''); }catch(e){}
  try{ if(sessionStorage.getItem('th_pass_ok') === '1') return true; }catch(e){}
  /* 服务端本次进站已确认过（静默验令牌通过） */
  if(gateState.kind === 'ok') return true;
  /* 云端到不了 / 没配云服务 → 完全沿用旧逻辑，保证离线与本地文件可用。
     ⚠️ v2.24.23：能连上云服务时必须先问服务端 —— 否则一台来过一次的老设备会凭本机
     这张「旧口令通行证」永远绕开服务端：既不落日志（统计失真），也躲过换口令与停站。 */
  if(gateState.kind === 'unavailable' || (gateState.kind === 'unknown' && !gateCloudCapable())){
    if(!pass) return true;                       /* 没设口令 → 视为已通过 */
    try{ return localStorage.getItem('th_pass_ok_v') === pass; }catch(e){ return true; }
  }
  return false;
}
/* 把当前该显示的那一层摆好 */
function applyEntryStage(){
  if(window.__BLOCKED__){                       /* 已下线：口令门负责整站提示，别的都不要显示 */
    const lay = noticeLayerEl || document.getElementById('noticeLayer');
    if(lay) lay.classList.remove('on');
    return;
  }
  const sp = $('splash');
  const splashDone = !sp || sp.classList.contains('out');
  if(!splashDone) return;                       /* 开屏还没轻触 → 先看图标，什么都别弹 */

  if(noticeNeedShow()){ openNotice(()=>{ applyEntryStage(); }); return; }

  /* 须知已确认 → 该看口令了 */
  if(gateLayerOn()) return;
  if(gateState.kind === 'checking') return;         /* 正在静默验令牌 → 先别弹门，等结果 */
  /* v2.24.23：本机存过服务端令牌 → 先静默验一次；通过就直接进站，不必再输口令 */
  if(gateState.kind === 'unknown' && gateHasToken()){
    gateState = { kind: 'checking' };
    gateVerifyToken().then(function(){ applyEntryStage(); },
                           function(){ gateState = { kind: 'unavailable' }; applyEntryStage(); });
    return;
  }
  if(!passAlreadyOk()){ openGateFromFlow(); return; }
  /* 全部过关 → 起开场动画 */
  startSplashIntro();
}
/* app.js 接管口令门（v2.24.12 起）：口令门里的 inline 脚本只负责「渲染」，提交由这里处理。
   v2.24.13：暗号线索挪到本页，分步解锁 —— 初始只给第一句；输错累计满 3 次再浮出第二句。
   v2.24.15：第二级线索（"万物之始，数之极，三才之数，复归于无。"）已删除 ——
   用户要求只保留第一句，输错也不再解锁第二句。 */
const GATE_HINT_1 = '【屿上留笺】阳数至极时扬帆，月魄历满一轮归尽，方可启航。';
const GATE_HINT_AFTER_FAILS = 0;   /* v2.24.15：0 = 永不解锁第二句 */
let gateFailCount = 0;
let gateHint2Shown = false;

function renderGateHints(){
  const wrap = $('gateHintWrap');
  if(wrap) wrap.style.display = 'block';
  const h1 = $('gateHint1'), h2 = $('gateHint2');
  if(h1) h1.textContent = GATE_HINT_1;
  /* v2.24.15：第二级线索已废弃，DOM 里若还留着就一并藏掉 */
  if(h2){ h2.textContent=''; h2.style.display = 'none'; }
}
function revealGateHint2(){
  /* v2.24.15：二级线索已删除 → 空实现（保留函数名，避免老调用点报错） */
  return;
}
let gateSubmitWired = false;
function openGateFromFlow(){
  const lay = $('gateLayer'); if(!lay) return;
  const t = $('gateTitle'), d = $('gateDesc'), rec = $('gatePassWrap');
  if(t) t.textContent = '非 请 勿 入';
  if(d) d.textContent = '这是一个私密页面，请输入访问口令。';
  if(rec) rec.style.display = 'block';
  renderGateHints();
  lay.classList.add('on');
  if(!gateSubmitWired){
    gateSubmitWired = true;
    const submit = ()=>{
      const inp = $('gateInput'), err = $('gateErr'), btn = $('gateBtn');
      const v = ((inp && inp.value) || '').trim();
      if(err) err.textContent = '';
      if(btn){ btn.disabled = true; btn.textContent = '验 证 中'; }
      const finish = (res)=>{
        if(btn){ btn.disabled = false; btn.textContent = '进 入'; }
        const st = (res && res.status) || 'unavailable';
        if(st === 'ok'){
          gateFailCount = 0;
          let pass = ''; try{ pass = String(window.__PASS__ || ''); }catch(e){}
          /* 服务端发令牌 → 记令牌（换口令即失效）；本地兜底路径 → 沿用旧键，离线也免输 */
          if(res && res.token){ try{ localStorage.setItem(GATE_TOKEN_KEY, res.token); }catch(e){} }
          else if(pass){ try{ localStorage.setItem('th_pass_ok_v', pass); }catch(e){} }
          try{ sessionStorage.setItem('th_pass_ok','1'); }catch(e){}
          gateState = { kind: 'ok' };
          lay.classList.remove('on');
          if(inp) inp.value = '';
          if(err) err.textContent = '';
          applyEntryStage();               /* 过关 → 往下推进（起开场动画） */
          return;
        }
        if(st === 'offline'){ gateShowPaused(); return; }
        if(st === 'locked'){ if(err) err.textContent = '尝试次数过多，请过几分钟再来'; return; }
        gateFailCount++;
        if(inp) inp.value = '';
        /* v2.24.15：二级线索已删除 —— 输错只说一句「口令不对」，不再提示"还能试几次"
           （那个计数是为二级线索服务的，线索没了就没有意义） */
        if(err) err.textContent = '口令不对，请对照上面的线索再试一次';
      };
      gateSubmit(v).then(finish, function(){ finish({ status: 'unavailable' }); });
    };
    const b = $('gateBtn'), i = $('gateInput');
    if(b) b.addEventListener('click', submit);
    if(i) i.addEventListener('keydown', e=>{ if(e.key === 'Enter') submit(); });
  }
  setTimeout(()=>{ const i = $('gateInput'); if(i) i.focus(); }, 120);
}

/* ================= 启动 ================= */
/* v2.24.9：申请持久存储（降低浏览器磁盘紧张时清退本站数据的概率）+ 大库校时。
   idbBootCheck 完成前，save() 只写快取不写大库（防旧快取盖掉大库新档）。 */
try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){}); }catch(e){}
idbBootCheck();
applyTheme();
tickClock();
renderDesktop();
save();                       /* v2.24.1：首次载入即落盘，等于为老存档建立一份兜底快照 */
initSplash();                 /* v2.24.12：先摆好「点进去的图标」（第一段开屏） */
mountNoticeLayer();           /* v2.24.12：把须知层搬进 #phone（只覆盖手机屏） */
initSaveBar();
initBgNotify();               /* v2.24.12：后台消息通知（页面切后台后由 SW 接管弹通知） */
scheduleDeskCheck();
scheduleProactive();
scheduleProactiveMsg();
dailyRollover();
scanPendingReplies();
scanPendingMomReactions();       /* v2.24.21：补上离站期间到点的朋友圈点赞 / 评论 */
/* v2.24.23：远程停站开关 —— 创建者在后台把 offline 置真，这里立刻就能拦下所有人，
   不必等重新发布。p_pass 传 null：服务端只回报状态、不写访问日志，所以探测不污染统计。 */
try{
  gateProbe().then(function(st){ if(st === 'offline'){ try{ gateShowPaused(); }catch(e){} } },
                   function(){});
}catch(e){}
dailyTimer=setInterval(dailyRollover,10*60e3);

/* v2.24.12 进站流程：开屏（图标）→ 须知 → 口令 → 开场动画 → 进站。
   延迟一拍启动，确保开屏页的进场动画先跑起来（先看见图标，再被拦下来读须知）。 */
setTimeout(function(){
  try{ applyEntryStage(); }catch(e){ try{ console.warn('[彤话屿] 进站流程启动失败', e); }catch(_){} }
}, 900);
/* 用户轻触开屏页之后也要推进一次（轻触 → 该弹须知了） */
setTimeout(function(){
  var sp = $('splash');
  if(!sp) return;
  var t = setInterval(function(){
    if(sp.classList.contains('out')){ clearInterval(t); try{ applyEntryStage(); }catch(e){} }
  }, 120);
  setTimeout(function(){ clearInterval(t); }, 30000);
}, 1000);
