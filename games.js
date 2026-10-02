/* 彤话屿 · 小游戏模块（猜拳 / 记忆翻牌 / 五子棋 / 贪吃蛇 / 双人合作俄罗斯方块） */
'use strict';

const Games = {

  /* 对局对手名（由 app.js 的 inviteGameTo 设置；没设置时退回「ta」） */
  rival(){
    try{
      const r=(typeof activeGameRival!=='undefined')&&activeGameRival;
      return (r&&r.name)||'ta';
    }catch(e){ return 'ta'; }
  },

  /* ===== 入口 ===== */
  open(gameId){
    const body = document.getElementById('appBody');
    body.classList.remove('chat-mode');
    ({ rps:()=>this.rps(body), memory:()=>this.memory(body),
       gomoku:()=>this.gomoku(body), snake:()=>this.snake(body),
       tetris:()=>this.tetris(body) }[gameId]||(()=>{}))();
  },

  /* ===== 猜拳 =====
     v2.24.17：修胜负判断 —— 旧版 (i-j+3)%3===1 是反的，会出现「剪刀赢石头」；
     正确口诀：石头砸剪刀 · 剪刀剪布 · 布包石头（即 (i-j+3)%3===2 才算赢）。
     顺带优化：双方出拳都亮出来 + 0.45 秒悬念 + 本局战绩累计。 */
  rps(box){
    const hands=['✊','✌️','✋'];
    const names=['石头','剪刀','布'];
    const rival=this.rival();
    let tally={w:0,d:0,l:0};
    box.innerHTML = `
      <div class="card" style="text-align:center">
        <div class="desc" style="margin-bottom:6px">赢了 +8 潮汐石 · 平局 +2 · 输了 -3</div>
        <div style="display:flex;justify-content:center;align-items:center;gap:20px;margin:4px 0 6px">
          <div><div style="font-size:12px;color:var(--ink-2)">我出</div><div id="rpsMe" style="font-size:46px;line-height:1.2">❔</div></div>
          <div style="font-weight:800;color:var(--ink-3);font-size:13px">VS</div>
          <div><div style="font-size:12px;color:var(--ink-2)">${rival} 出</div><div id="rpsTa" style="font-size:46px;line-height:1.2">❔</div></div>
        </div>
        <div id="rpsResult" style="font-weight:800;font-size:17px;min-height:26px">出拳吧！石头砸剪刀 · 剪刀剪布 · 布包石头</div>
        <div class="count" id="rpsTally" style="margin-top:4px">胜 0 · 平 0 · 负 0</div>
      </div>
      <div class="rps-row">
        ${hands.map((h,i)=>`<button class="rps-hand" data-i="${i}">${h}</button>`).join('')}
      </div>`;
    const res=document.getElementById('rpsResult');
    box.querySelectorAll('.rps-hand').forEach(btn=>btn.addEventListener('click',()=>{
      const i=+btn.dataset.i, j=Math.floor(Math.random()*3);
      document.getElementById('rpsMe').textContent=hands[i];
      document.getElementById('rpsTa').textContent='…';
      res.textContent='石头…剪刀…布——';
      /* 半秒悬念再揭晓，比「一点就出」更有对局感 */
      setTimeout(()=>{
        document.getElementById('rpsTa').textContent=hands[j];
        if(i===j){ tally.d++; res.textContent='平局！都出了'+names[i]; state.coins+=2; }
        else if((i-j+3)%3===2){ tally.w++; res.textContent='你赢了！'+names[i]+'赢了'+names[j]+' 🎉'; state.coins+=8; }
        else { tally.l++; res.textContent='你输了…'+names[j]+'赢了'+names[i]; state.coins=Math.max(0,state.coins-3); }
        document.getElementById('rpsTally').textContent=`胜 ${tally.w} · 平 ${tally.d} · 负 ${tally.l}`;
        save(); refreshCoins();
      },450);
    }));
  },

  /* ===== 记忆翻牌 · 对战（v2.24.17 重做） =====
     你先翻完全部配对并记下步数 → ta 接着翻（模拟对局，步数随机 13~26）→
     两边都结束后比步数：少的一方赢。赢 +15 · 平 +8 · 输 +3 潮汐石。 */
  memory(box){
    const pool=['🌹','🐻','🍰','🌙','⭐','🧋','❤️','🍀'];
    const deck=[...pool,...pool].sort(()=>Math.random()-.5);
    const rival=this.rival();
    let open=[], lock=false, moves=0, done=0, phase='me', myMoves=0, taIv=null;
    box.innerHTML=`
      <div class="card" style="text-align:center">
        <div style="font-weight:800">记忆翻牌 · 和 ${rival} 比步数 <span class="count" id="memMoves">我 0 步</span></div>
        <div class="desc" id="memDesc">你先翻：全部配对后轮到 ta，步数少的一方赢（赢 +15 · 平 +8 · 输 +3 潮汐石）</div>
      </div>
      <div class="mem-grid" id="memGrid"></div>`;
    const grid=document.getElementById('memGrid');
    const movesEl=()=>document.getElementById('memMoves');
    const descEl=()=>document.getElementById('memDesc');
    /* 我翻完 → ta 上场（模拟对局：逐一步数往上跳，像真在翻）→ 比步数结算 */
    function finishByMe(){
      myMoves=moves; phase='ta'; lock=true;
      movesEl().textContent=`我 ${myMoves} 步 · ${rival} 翻牌中…`;
      descEl().textContent=rival+' 正在翻牌，稍等～';
      const target=13+Math.floor(Math.random()*14);   /* ta 用 13~26 步完成 */
      let shown=0;
      taIv=setInterval(()=>{
        if(!document.body.contains(grid)){ clearInterval(taIv); return; }   /* 已离开页面 */
        shown++;
        movesEl().textContent=`我 ${myMoves} 步 · ${rival} ${shown} 步…`;
        if(shown>=target){
          clearInterval(taIv);
          const win=myMoves<target, tie=myMoves===target;
          const reward=win?15:tie?8:3;
          state.coins+=reward; save(); refreshCoins();
          const verdict=win?`你赢了！${myMoves} 步 vs ${target} 步`
                        :tie?`平局！都是 ${target} 步`
                            :`${rival} 赢了…${myMoves} 步 vs ${target} 步`;
          descEl().textContent=verdict;
          movesEl().textContent=`我 ${myMoves} 步 · ${rival} ${target} 步`;
          toast(verdict+'，+'+reward+' 潮汐石');
          const again=document.createElement('button');
          again.className='btn block'; again.style.marginTop='12px'; again.textContent='再战一局';
          again.addEventListener('click',()=>Games.memory(box));
          box.appendChild(again);
        }
      },140);
    }
    deck.forEach((em,idx)=>{
      const b=document.createElement('button');
      b.className='mem-cell'; b.dataset.em=em;
      b.addEventListener('click',()=>{
        if(phase!=='me'||lock||b.classList.contains('open')||b.classList.contains('done'))return;
        b.classList.add('open'); b.textContent=em; open.push(b);
        if(open.length===2){
          moves++; movesEl().textContent='我 '+moves+' 步';
          if(open[0].dataset.em===open[1].dataset.em){
            open.forEach(x=>{x.classList.remove('open');x.classList.add('done');});
            open=[]; done++;
            if(done===8)finishByMe();
          }else{
            lock=true;
            setTimeout(()=>{ open.forEach(x=>{x.classList.remove('open');x.textContent='';}); open=[]; lock=false; },650);
          }
        }
      });
      grid.appendChild(b);
    });
  },

  /* ===== 五子棋（9 路，评分 AI，末手高亮） =====
     v2.24.20：棋盘改为标准棋盘 —— 棋子落在棋盘线的交叉点上。
     做法：绝对定位的 SVG 画 9 条竖线 + 9 条横线（线间距 34px，交叉点落在 22/56/90…）；
     落子按钮是一个 9×9 网格，格子 34px、左/上内边距 5px，
     于是「格子中心」正好压在「线的交叉点」上（5 + 34k + 17 = 22 + 34k）。 */
  gomoku(box){
    const N=9;
    const rival=this.rival();   /* v2.24.17：先取好对手名 —— place/setTimeout 里 this 会丢（严格模式=undefined），旧版第一手就抛错卡死 */
    let board=Array.from({length:N},()=>Array(N).fill(0)); // 0空 1我(黑) 2ta(白)
    let over=false, last=null, busy=false;
    box.innerHTML=`
      <div class="card" style="text-align:center">
        <div style="font-weight:800;margin-bottom:4px">五子棋 · 你执黑先行</div>
        <div class="desc" id="gkState">点击棋盘落子</div>
      </div>
      <div class="gomoku" id="gkBoard"></div>
      <button class="btn ghost block" id="gkReset" style="margin-top:14px">重新开始</button>`;
    const wrap=document.getElementById('gkBoard');
    const stateEl=document.getElementById('gkState');

    /* 标准棋盘线：9 条竖线 + 9 条横线，外加星位小圆点。
       v2.24.20：格子/边距从 CSS 变量读，窄屏缩格时线也自动跟着缩，落点永远压在线交叉点上。
       对齐算式：格心 = PAD + CELL/2 = LINE  →  棋子中心正好落在线上。 */
    (function drawLines(){
      const cs=getComputedStyle(wrap);
      const num=(name,dflt)=>{ const v=parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v)&&v>0?v:dflt; };
      const CELL=num('--gc',34);          /* 格宽 */
      const PAD=num('--gpad',5);          /* 棋盘内边距 */
      const LINE=num('--gline',CELL/2+PAD);/* 首条线的位置 = 边距 + 半格 */
      const LEN=CELL*(N-1), SIZE=LEN+LINE*2;
      let svg=`<svg class="gk-lines" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`;
      for(let i=0;i<N;i++){
        const p=LINE+i*CELL;
        svg+=`<line x1="${LINE}" y1="${p}" x2="${LINE+LEN}" y2="${p}" stroke="#a98453" stroke-width="1" stroke-linecap="round"/>`;
        svg+=`<line x1="${p}" y1="${LINE}" x2="${p}" y2="${LINE+LEN}" stroke="#a98453" stroke-width="1" stroke-linecap="round"/>`;
      }
      /* 星位：9 路棋盘的四角星 + 天元 */
      [[2,2],[6,2],[2,6],[6,6],[4,4]].forEach(([x,y])=>{
        svg+=`<circle cx="${LINE+x*CELL}" cy="${LINE+y*CELL}" r="2.6" fill="#8a6b3c"/>`;
      });
      svg+=`</svg>`;
      wrap.insertAdjacentHTML('beforeend',svg);
    })();
    const grid=document.createElement('div');
    grid.className='gk-grid';
    wrap.appendChild(grid);

    function line(x,y,dx,dy){
      const v=board[y][x]; if(!v)return 0;
      let n=0,x2=x,y2=y;
      while(x2>=0&&y2>=0&&x2<N&&y2<N&&board[y2][x2]===v){n++;x2+=dx;y2+=dy;}
      let n2=0,x3=x-dx,y3=y-dy;
      while(x3>=0&&y3>=0&&x3<N&&y3<N&&board[y3][x3]===v){n++;x3-=dx;y3-=dy;}
      return n;
    }
    function win(x,y){
      return [[1,0],[0,1],[1,1],[1,-1]].some(([dx,dy])=>line(x,y,dx,dy)>=5);
    }
    function score(x,y,who){
      let s=0;
      for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]){
        let c=1,block=0,x2=x+dx,y2=y+dy;
        while(x2>=0&&y2>=0&&x2<N&&y2<N&&board[y2][x2]===who){c++;x2+=dx;y2+=dy;}
        if(x2<0||y2<0||x2>=N||y2>=N||board[y2][x2]!==0)block++;
        x2=x-dx;y2=y-dy;
        while(x2>=0&&y2>=0&&x2<N&&y2<N&&board[y2][x2]===who){c++;x2-=dx;y2-=dy;}
        if(x2<0||y2<0||x2>=N||y2>=N||board[y2][x2]!==0)block++;
        if(c>=5)s+=100000; else if(c===4)s+= block?2000:12000; else if(c===3)s+= block?150:900; else if(c===2)s+=block?20:60; else s+=4;
      }
      return s;
    }
    function aiMove(){
      let best=-1,bx=-1,by=-1;
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){
        if(board[y][x])continue;
        const s=score(x,y,2)*1.05+score(x,y,1);
        if(s>best){best=s;bx=x;by=y;}
      }
      if(bx>=0){ board[by][bx]=2; last=[bx,by]; }
    }
    function checkWin(mark){
      for(let y=0;y<N;y++)for(let x=0;x<N;x++)
        if(board[y][x]===mark&&win(x,y))return true;
      return false;
    }
    function render(){
      grid.innerHTML='';
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){
        const b=document.createElement('button');
        b.dataset.x=x; b.dataset.y=y;
        if(board[y][x]===1)b.className='b';
        if(board[y][x]===2)b.className='w';
        if(last&&last[0]===x&&last[1]===y)b.classList.add('last');
        b.addEventListener('click',()=>place(x,y));
        grid.appendChild(b);
      }
    }
    function place(x,y){
      if(over||busy||board[y][x])return;
      board[y][x]=1; last=[x,y]; busy=true;
      render();
      if(win(x,y)){ over=true; stateEl.textContent='你赢啦！+12 潮汐石 🎉'; state.coins+=12; save(); refreshCoins(); busy=false; return; }
      stateEl.textContent=rival+' 思考中…';
      setTimeout(()=>{
        if(!grid.isConnected){ busy=false; return; } /* 已离开页面 */
        aiMove(); render();
        if(checkWin(2)){ over=true; stateEl.textContent=rival+' 赢了，再接再厉！'; busy=false; return; }
        /* 棋盘下满 → 平局 */
        if(board.every(row=>row.every(v=>v))){ over=true; stateEl.textContent='平局！+5 潮汐石'; state.coins+=5; save(); refreshCoins(); busy=false; return; }
        stateEl.textContent='轮到你了'; busy=false;
      },400);
    }
    document.getElementById('gkReset').addEventListener('click',()=>Games.gomoku(box));
    render();
  },

  /* ===== 贪吃蛇 · 双人对战（你 vs ta） =====
     v2.24.20 三处调整（用户反馈）：
     ① 速度仍然太快 → 单步 230ms 再放慢到 340ms，并且开局不自动跑：
        先画好静止的棋盘，等你按下第一个方向键（或点方向盘）才开始计时。
     ② 碰撞判定不对称（ta 撞上我不判输，我撞上 ta 却判输）→ 旧版只算了一次 hit()，
        而那个 hit() 把「我」和「ta」的身体都当成障碍，等于用同一把尺子同时量两个人；
        新版拆开：撞墙 / 撞自己 = 自杀（谁撞只算谁）；撞到对方身体 = 对方赢。
     ③ 转向按键不顺手 → 旧版方向键要精确点 52px 方块；
        新版把四个键摆成十字方向盘，并加 2 步输入缓冲（连按不丢方向、不会反手自撞）。

     v2.24.21 二处调整（用户反馈：「丑」「手感卡顿」）：
     ④ 卡顿 → 网格逻辑没变，但渲染改由 requestAnimationFrame 驱动：每帧在
        「上一步坐标 → 这一步坐标」之间做线性插值，画面是连续滑行，不再一格一格硬跳。
        步进间隔同步从 340ms 收回 200ms —— 平滑之后不必靠慢来换手感，反而更跟手。
     ⑤ 丑 → 丢掉棋盘格底色与 emoji 苹果：改成柔白底 + 极细网格；蛇身用
        「圆角连线」（lineCap / lineJoin = round）画成圆润胶囊并带高光体积，
        蛇头有朝向双眼，食物是带呼吸光晕的圆点。 */
  snake(box){
    box.innerHTML=`
      <div class="card" style="text-align:center">
        <div style="font-weight:800">贪吃蛇对战 <span class="count" id="snScore">你 0 : 0 ${this.rival()}</span></div>
        <div class="desc" id="snHint">按方向键或点方向盘开始 · 撞墙/撞自己/撞到对方身体就输 · 赢 +15 · 平 +5 · 输 +3</div>
      </div>
      <canvas class="game-canvas sn-cv" id="snCv" width="300" height="300"></canvas>
      <div class="pad sn-dpad" id="snPad"></div>
      <button class="btn ghost block" id="snReset" style="margin-top:12px">再来一局</button>`;
    const cv=document.getElementById('snCv'), ctx=cv.getContext('2d');
    const S=15, CELL=20, W=S*CELL;
    const DIRS={U:[0,-1],D:[0,1],L:[-1,0],R:[1,0]};
    const rival=this.rival();   /* v2.24.17：先取好对手名 —— reset/step 是普通调用，this 会丢，旧版开局即抛错 → 卡在开始界面 */
    const STEP_MS=200;          /* v2.24.21：340ms 在平滑插值下显得发钝，收回 200ms */
    const MY_DARK='#23232b', MY_LITE='#4a4a58';   /* 我的蛇：墨色 */
    const TA_DARK='#9595a3', TA_LITE='#c2c2cd';   /* ta 的蛇：雾灰 */
    let me,ta,food,myScore,taScore,dead,timer,myDir,taDir,started,queue;
    let mePrev,taPrev,stepAt,raf=null,foodAt=0;

    /* jsdom / 老内核兜底：没有 rAF 就用 setTimeout 顶一下，保证画面照样能跑 */
    const RAF=(typeof requestAnimationFrame==='function')?function(cb){return requestAnimationFrame(cb);}
                                                          :function(cb){return setTimeout(function(){cb(performance.now());},16);};
    const CAF=(typeof cancelAnimationFrame==='function')?function(id){cancelAnimationFrame(id);}:clearTimeout;

    function reset(){
      me=[[3,7],[2,7],[1,7]]; ta=[[11,7],[12,7],[13,7]];
      mePrev=me.map(p=>p.slice()); taPrev=ta.map(p=>p.slice());
      myDir='R'; taDir='L'; myScore=0; taScore=0; dead=false; started=false; queue=[];
      stepAt=0; foodAt=performance.now();
      clearInterval(timer);
      if(raf){ CAF(raf); raf=null; }
      placeFood(); draw(0);
      document.getElementById('snScore').textContent=`你 ${myScore} : ${taScore} ${rival}`;
      document.getElementById('snHint').textContent='按方向键或点方向盘开始 · 撞墙/撞自己/撞到对方身体就输';
      raf=RAF(frame);
    }
    function start(){
      if(started||dead)return;
      started=true; stepAt=performance.now();
      document.getElementById('snHint').textContent='开始了！转向可连按，最多缓存 2 步';
      clearInterval(timer);
      timer=setInterval(step,STEP_MS);
    }
    function occupied(x,y){
      return me.some(p=>p[0]===x&&p[1]===y)||ta.some(p=>p[0]===x&&p[1]===y);
    }
    function placeFood(){
      do{ food=[Math.floor(Math.random()*S),Math.floor(Math.random()*S)]; }while(occupied(food[0],food[1]));
    }
    /* ---------- 渲染：rAF 插值 + 圆角连线画法（v2.24.21） ---------- */
    function center(c){ return c*CELL+CELL/2; }
    function lerp(a,b,t){ return a+(b-a)*t; }
    /* 把「上一格坐标 → 这一格坐标」按 t（0~1）插值成像素点串
       —— 数组下标一一对应：第 i 节从「上一步的第 i 节」滑到「这一步的第 i 节」 */
    function seg2px(arr,prev,t){
      const out=[];
      for(let i=0;i<arr.length;i++){
        const p=arr[i], q=(prev&&prev[i])||arr[i];
        out.push([lerp(q[0],p[0],t)*CELL+CELL/2, lerp(q[1],p[1],t)*CELL+CELL/2]);
      }
      return out;
    }
    function strokePath(pts){
      if(pts.length<2)return;
      ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
      for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);
      ctx.stroke();
    }
    function snakeBody(pts,dark,lite,dir,mine){
      if(!pts.length)return;
      ctx.lineCap='round'; ctx.lineJoin='round';
      /* ① 外圈柔光：让蛇从底色上浮起来 */
      ctx.strokeStyle=mine?'rgba(35,35,43,.09)':'rgba(120,120,140,.12)';
      ctx.lineWidth=CELL*0.88;
      if(pts.length<2){ ctx.beginPath(); ctx.arc(pts[0][0],pts[0][1],CELL*0.44,0,7); ctx.fillStyle=ctx.strokeStyle; ctx.fill(); }
      else strokePath(pts);
      /* ② 身体主色 */
      ctx.strokeStyle=dark; ctx.lineWidth=CELL*0.66;
      if(pts.length<2){ ctx.beginPath(); ctx.arc(pts[0][0],pts[0][1],CELL*0.33,0,7); ctx.fillStyle=dark; ctx.fill(); }
      else strokePath(pts);
      /* ③ 顶部高光：一条贴着身体上缘的浅线，做出圆润的体积感 */
      ctx.strokeStyle=lite; ctx.lineWidth=CELL*0.16;
      strokePath(pts.map(p=>[p[0],p[1]-CELL*0.16]));
      /* ④ 蛇头：实心圆 + 朝向双眼 */
      const h=pts[0];
      ctx.fillStyle=dark;
      ctx.beginPath(); ctx.arc(h[0],h[1],CELL*0.40,0,7); ctx.fill();
      const fx=dir[0]*CELL*0.15, fy=dir[1]*CELL*0.15;      /* 朝前偏移 */
      const sx=dir[1]*CELL*0.16, sy=dir[0]*CELL*0.16;      /* 左右偏移（法向） */
      ctx.fillStyle=mine?'#f6f6f8':'#3b3b46';
      ctx.beginPath(); ctx.arc(h[0]+fx-sx,h[1]+fy-sy,CELL*0.075,0,7); ctx.fill();
      ctx.beginPath(); ctx.arc(h[0]+fx+sx,h[1]+fy+sy,CELL*0.075,0,7); ctx.fill();
    }
    function draw(t){
      const now=performance.now();
      ctx.clearRect(0,0,W,W);
      /* 底色：柔白 + 极细网格（不再是棋盘格） */
      ctx.fillStyle='#f6f6f8'; ctx.fillRect(0,0,W,W);
      ctx.strokeStyle='rgba(28,28,30,.045)'; ctx.lineWidth=1;
      for(let i=1;i<S;i++){
        const p=i*CELL+.5;
        ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,W); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(W,p); ctx.stroke();
      }
      /* 食物：呼吸光晕 + 实心果 */
      const fxx=center(food[0]), fyy=center(food[1]);
      const pulse=0.5+0.5*Math.sin((now-foodAt)/420);
      ctx.fillStyle='rgba(224,68,63,'+(0.09+0.10*pulse).toFixed(3)+')';
      ctx.beginPath(); ctx.arc(fxx,fyy,CELL*0.60+pulse*2.4,0,7); ctx.fill();
      ctx.fillStyle='#e0443f';
      ctx.beginPath(); ctx.arc(fxx,fyy,CELL*0.30,0,7); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,.78)';
      ctx.beginPath(); ctx.arc(fxx-CELL*0.11,fyy-CELL*0.13,CELL*0.075,0,7); ctx.fill();
      /* ta 先画，我的压在上面 */
      snakeBody(seg2px(ta,taPrev,t), TA_DARK, TA_LITE, DIRS[taDir], false);
      snakeBody(seg2px(me,mePrev,t), MY_DARK, MY_LITE, DIRS[myDir], true);
    }
    /* 渲染循环：每帧算一次插值进度 t。未开局 t=0（静止），死亡后停在最后一步 */
    function frame(){
      if(!cv.isConnected){ if(raf){ CAF(raf); raf=null; } clearInterval(timer); return; }
      if(dead){ draw(1); raf=null; return; }
      const t=started?Math.min(1,(performance.now()-stepAt)/STEP_MS):0;
      draw(t);
      raf=RAF(frame);
    }
    /* 新版碰撞判定：拆成「自杀」与「撞到对方」两条互不干扰的线
       —— 撞墙 / 撞自己 = 谁撞谁输；撞到对方身体 = 对方赢。 */
    function outOfWall(x,y){ return x<0||y<0||x>=S||y>=S; }
    function bodyHit(arr,x,y,skipTail){ return (skipTail?arr.slice(0,-1):arr).some(p=>p[0]===x&&p[1]===y); }
    function step(){
      if(dead||!started)return;
      if(!cv.isConnected){ clearInterval(timer); return; } /* 已离开页面 */
      /* 输入缓冲：把缓存里的方向逐步入队（已过滤反方向与重复） */
      while(queue.length){
        const d=queue.shift(); const nd=DIRS[d];
        if(nd[0]===-DIRS[myDir][0]&&nd[1]===-DIRS[myDir][1])continue;
        if(d===myDir)continue;
        myDir=d; break;
      }
      /* ta 的 AI：贪心追食物，避墙避蛇 */
      const head0=ta[0];
      const cand=Object.entries(DIRS).filter(([k,[dx,dy]])=>!(dx===-DIRS[taDir][0]&&dy===-DIRS[taDir][1]));
      let bestD=taDir,bestScore=Infinity;
      for(const [k,[dx,dy]] of cand){
        const nx=head0[0]+dx,ny=head0[1]+dy;
        if(nx<0||ny<0||nx>=S||ny>=S)continue;
        const blocked=(k===taDir?ta.slice(0,-1):ta).some(p=>p[0]===nx&&p[1]===ny)||me.some(p=>p[0]===nx&&p[1]===ny);
        if(blocked)continue;
        const d=Math.abs(nx-food[0])+Math.abs(ny-food[1]);
        if(d<bestScore){bestScore=d;bestD=k;}
      }
      taDir=bestD;
      /* 双方同时走一步 */
      const myHead=[me[0][0]+DIRS[myDir][0],me[0][1]+DIRS[myDir][1]];
      const taHead=[ta[0][0]+DIRS[taDir][0],ta[0][1]+DIRS[taDir][1]];
      const sameCell=(myHead[0]===taHead[0]&&myHead[1]===taHead[1]);
      const myWall=outOfWall(myHead[0],myHead[1]);
      const taWall=outOfWall(taHead[0],taHead[1]);
      /* 撞自己：排除「尾巴即将让位」的那一节，避免贴着尾巴走被误判 */
      const mySelf=!myWall&&bodyHit(me,myHead[0],myHead[1],true);
      const taSelf=!taWall&&bodyHit(ta,taHead[0],taHead[1],true);
      /* 撞到对方身体 */
      const myInto=!myWall&&bodyHit(ta,myHead[0],myHead[1],false);
      const taInto=!taWall&&bodyHit(me,taHead[0],taHead[1],false);
      const myDead=myWall||mySelf||myInto||sameCell;
      const taDead=taWall||taSelf||taInto||sameCell;
      if(myDead||taDead){
        dead=true; clearInterval(timer); draw(1);   /* 停在最后一步的画面 */
        let msg,reward;
        if(myDead&&taDead){ msg='同归于尽，平局！'; reward=5; }
        else if(myDead){ msg=(myInto?'你撞到了 '+rival+' 的身体…':'你撞到了，')+rival+' 赢了本局'; reward=3; }
        else{ msg=(taInto?rival+' 撞到了你的身体，你赢啦！🎉':rival+' 撞到了，你赢啦！🎉'); reward=15; }
        state.coins+=reward; save(); refreshCoins();
        document.getElementById('snHint').textContent=msg;
        toast(msg+(reward?` +${reward} 潮汐石`:''));
        return;
      }
      /* v2.24.21：先把「这一步之前的坐标」存下来，渲染循环才能插值滑行 */
      mePrev=me.map(p=>p.slice()); taPrev=ta.map(p=>p.slice());
      me.unshift(myHead); ta.unshift(taHead);
      if(myHead[0]===food[0]&&myHead[1]===food[1]){ myScore++; placeFood(); }
      else me.pop();
      if(taHead[0]===food[0]&&taHead[1]===food[1]){ taScore++; placeFood(); }
      else ta.pop();
      document.getElementById('snScore').textContent=`你 ${myScore} : ${taScore} ${rival}`;
      stepAt=performance.now();      /* 插值进度从这里重新起算 */
    }
    /* 转向：与「将要走出的方向」比较，允许连点缓存 2 步 */
    function turn(d){
      const last=queue.length?queue[queue.length-1]:myDir;
      const nd=DIRS[d];
      if(nd[0]===-DIRS[last][0]&&nd[1]===-DIRS[last][1])return;
      if(d===last)return;
      if(queue.length>=2)return;
      queue.push(d);
      start();
    }
    /* v2.24.20：四个方向键摆成十字方向盘（上排「↑」、中排「← · →」、下排「↓」），拇指一按就到 */
    document.getElementById('snPad').innerHTML=`
      <span></span><button data-d="U" title="向上">↑</button><span></span>
      <button data-d="L" title="向左">←</button><span>·</span><button data-d="R" title="向右">→</button>
      <span></span><button data-d="D" title="向下">↓</button><span></span>`;
    /* v2.24.22（用户反馈：「点击后有延迟」）：
       原来只绑 click —— 触摸端按下手指后，浏览器要等它判定「这是单击还是双击/长按」，
       约 150~300ms 之后才派发 click，于是按下去像慢半拍。改成：
         ① pointerdown 立即转向（手指一落就走），并即时给一个 .hit 高亮，按感不靠 :active 猜；
         ② 同时 preventDefault 压掉这次触摸产生的合成 click，避免同一次按压转两次向；
         ③ 仍保留 click 兜底，但用时间窗过滤 —— 键盘 Enter / 空格触发的 click
            前面没有 pointerdown，时间差很大，照样能走（无障碍不丢）。 */
    let padDownAt=0;
    box.querySelectorAll('#snPad button').forEach(b=>{
      const fire=()=>{
        turn(b.dataset.d);
        b.classList.add('hit');
        clearTimeout(b._hitT);
        b._hitT=setTimeout(()=>b.classList.remove('hit'),110);
      };
      b.addEventListener('pointerdown',e=>{ e.preventDefault(); padDownAt=performance.now(); fire(); });
      b.addEventListener('click',e=>{
        e.preventDefault();
        if(performance.now()-padDownAt>420) fire();   /* 键盘触发的 click 没走 pointerdown */
      });
    });
    const keyMap={ArrowUp:'U',ArrowDown:'D',ArrowLeft:'L',ArrowRight:'R',w:'U',s:'D',a:'L',d:'R',W:'U',S:'D',A:'L',D:'R'};
    const keyHandler=e=>{ if(keyMap[e.key]){ e.preventDefault(); turn(keyMap[e.key]); } };
    document.addEventListener('keydown',keyHandler);
    document.getElementById('snReset').addEventListener('click',reset);
    reset();
  },

  /* ===== 双人合作俄罗斯方块（v2.24.20 新增 · v2.24.21 改玩法） =====
     v2.24.21（用户反馈：「跟我想的不一样，我想的是 ta 操控蓝色、我操控红色，
     在同一个界面里分两半进行，按钮『落下』改成『加速下落』」）：
       · 同一块画布里并排两半 —— 左半是你的红盘、右半是 ta 的蓝盘，各玩各的；
       · 两边的方块**互不干扰**（不再叠到对方堆上、也不再要求同一行两边一起满）；
       · 各自消自己那半的行，**消掉的行数合在一起算**，命数与等级也是共用的 —— 合作在这里；
       · 操作盘中间的「落下」改成「加速下落」（软降）：点一下往下一格，
         按住不放会持续加速下落，想直接落到底就用旋转键下面的「直落」。
       · ta 的 AI 改成常规消行打法（补平凹槽、优先消行），不再需要「给我让位」。

     判赢设计（合作模式没有「谁打死谁」，所以判的是这一局合作得怎么样）：
       等级由「双方合计消灭的行数」决定，共 5 档：初见 / 搭把手 / 默契 / 心有灵犀 / 潮汐共鸣。
       一局 3 条命。任一方的新方块出生即被顶死 → 扣 1 条命并双方清场重开；
       3 条命用完 → 结算。奖励按合计消灭行数分段：
         0~4 行 → +2（「今天各堆各的」）
         5~9 行 → +6
         10~14 行 → +12
         15~19 行 → +20
         20 行以上 → +30
       并附赠一句关系评语（等级越高越亲密）。每次消行都弹一句双方回应，合作越久越热闹。 */
  tetris(box){
    const COLS=10, ROWS=18, CELL=16;
    const rival=this.rival();
    const P_L='L', P_R='R';                    /* 左半=我（红） · 右半=ta（蓝） */
    const MY_RGB='198,86,74', TA_RGB='94,132,178';   /* 珊瑚红 / 雾蓝 */
    const MY_HEX='#c6564a', TA_HEX='#5e84b2';
    const SHAPES=[
      [[[1,1,1,1]],4],
      [[[1,1],[1,1]],2],
      [[[0,1,0],[1,1,1]],2],
      [[[0,1,1],[1,1,0]],2],
      [[[1,1,0],[0,1,1]],2],
      [[[1,0,0],[1,1,1]],2],
      [[[0,0,1],[1,1,1]],2],
    ];
    const LEVELS=[
      {n:0, name:'初见', tip:'各堆各的，也很有意思'},
      {n:5, name:'搭把手', tip:'开始会互相看一眼对方的半场了'},
      {n:10,name:'默契', tip:'不用说话就知道对方要落哪儿'},
      {n:15,name:'心有灵犀', tip:'两半消掉的行都长到一起了'},
      {n:20,name:'潮汐共鸣', tip:'这座屿今晚只听得见你们俩'},
    ];
    let side={}, lines=0, dead=false, over=false, lives=3, timer=null, hintT=null;
    let softHold=null;                         /* 「加速下落」按住时的连发计时器 */

    function cells(){                       /* 每方各自的格盘（10×18） */
      return Array.from({length:ROWS},()=>Array(COLS).fill(''));
    }
    function newPiece(kind){
      const [sp]=SHAPES[Math.floor(Math.random()*SHAPES.length)];
      const shape=sp.map(r=>r.slice());
      return { shape, x:Math.floor((COLS-shape[0].length)/2), y:0, kind };
    }
    /* 整行清除：v2.24.21 起「各消各的」——只清自己那半盘的满行，
       两半消掉的行数加起来算作合作成绩（不再要求同一行两边都满） */
    function clearLines(kind){
      const g=side[kind].g;
      let n=0;
      for(let y=ROWS-1;y>=0;y--){
        let full=true;
        for(let x=0;x<COLS;x++) if(!g[y][x]){ full=false; break; }
        if(!full) continue;
        n++;
        g.splice(y,1);
        g.unshift(Array(COLS).fill(''));
        y++;                                /* 同一行重新检查 */
      }
      return n;
    }
    function collides(kind,p,dx,dy,shape){
      const g=side[kind].g, sh=shape||p.shape;
      for(let j=0;j<sh.length;j++)for(let i=0;i<sh[j].length;i++){
        if(!sh[j][i])continue;
        const x=p.x+i+(dx||0), y=p.y+j+(dy||0);
        if(x<0||x>=COLS||y>=ROWS)return true;
        if(y>=0&&g[y][x])return true;
      }
      return false;
    }
    function rotate(shape){
      const h=shape.length,w=shape[0].length;
      const out=Array.from({length:w},()=>Array(h).fill(0));
      for(let j=0;j<h;j++)for(let i=0;i<w;i++) out[i][h-1-j]=shape[j][i];
      return out;
    }
    function myTurn(dir){                   /* 顺时针旋转 = 快速连按 2 次，不必单独加键 */
      if(over)return;
      const p=side[P_L].p;
      if(dir==='rot'){
        const r=rotate(p.shape);
        if(!collides(P_L,p,0,0,r)) p.shape=r;
        else if(!collides(P_L,{...p,x:p.x-1},0,0,r)){ p.x-=1; p.shape=r; }
        else if(!collides(P_L,{...p,x:p.x+1},0,0,r)){ p.x+=1; p.shape=r; }
        return;
      }
      const dx=dir==='left'?-1:dir==='right'?1:0;
      if(dx&&!collides(P_L,p,dx,0)) p.x+=dx;
      if(dir==='down') softDrop(P_L);       /* v2.24.21：加速下落（软降）—— 一格一格往下推 */
      if(dir==='drop') hardDrop(P_L);       /* 直落：另留一个「一键到底」的入口 */
    }
    /* v2.24.21：加速下落 —— 单独点一下往下走一格；按住不放时由操作盘那边连发调用 */
    function softDrop(kind){
      if(over)return;
      const p=side[kind].p; if(!p)return;
      if(!collides(kind,p,0,1)){ p.y++; if(kind===P_L){ syncHud(); draw(); } }
      else lockPiece(kind);
    }
    function hardDrop(kind){
      const p=side[kind].p; if(!p)return;
      while(!collides(kind,p,0,1)) p.y++;
      lockPiece(kind);
    }
    function lockPiece(kind){
      const p=side[kind].p, g=side[kind].g;
      p.shape.forEach((row,j)=>row.forEach((v,i)=>{
        if(!v)return;
        const x=p.x+i, y=p.y+j;
        if(y<0){ topOut(kind); return; }
        if(y<ROWS&&x>=0&&x<COLS) g[y][x]=kind;   /* 'L' 我 / 'R' ta */
      }));
      if(over)return;
      const n=clearLines(kind);
      if(n){
        lines+=n;
        burst(kind,n);
      }
      spawn(kind);
    }
    function spawn(kind){
      const p=newPiece(kind);                 /* kind 直接就是 'L' / 'R' */
      p.kind=kind;
      if(collides(kind,p,0,0)){ topOut(kind); return; }
      side[kind].p=p;
    }
    /* 顶死：扣一条命；v2.24.21 起「各消各的」，所以只清被顶死那半场，另一方的堆保留 */
    function topOut(kind){
      if(over||dead)return;
      lives--;
      if(lives<=0){ finish(); return; }
      side[kind].g=cells();
      flash(`${kind===P_L?'你':'ta'}被顶住了，${kind===P_L?'你的红盘':'ta 的蓝盘'}清空重开 · 还剩 ${lives} 条命`);
      spawn(kind);
    }
    function finish(){
      over=true; dead=true;
      clearInterval(timer);
      if(softHold){ clearInterval(softHold); softHold=null; }
      const lv=[...LEVELS].reverse().find(L=>lines>=L.n)||LEVELS[0];
      let reward = lines>=20?30 : lines>=15?20 : lines>=10?12 : lines>=5?6 : 2;
      state.coins+=reward; save(); refreshCoins();
      msgEl.classList.remove('hide');
      msgEl.innerHTML=`
        <div style="font-size:34px">🌊</div>
        <div style="font-size:17px">潮汐共鸣 · ${lv.name}</div>
        <div class="desc" style="font-weight:600">你们合计消灭了 <b>${lines}</b> 行</div>
        <div class="desc" style="font-size:12.5px">${lv.tip}</div>
        <div class="tz-pill">+${reward} 潮汐石</div>
        <button class="btn block" id="tzAgain" style="max-width:150px;margin-top:4px">再来一局</button>`;
      document.getElementById('tzAgain').addEventListener('click',()=>Games.tetris(box));
      toast(`合作结束 · 消灭 ${lines} 行 · 等级「${lv.name}」 +${reward} 潮汐石`);
      setTimeout(()=>{           /* 结算页盖住棋盘时也顺手停掉 AI */
        clearInterval(timer);
      },10);
    }
    /* 消行时的小反馈：攒着一起弹，避免连续消行刷屏 */
    let burstBuf=0, burstTimer=null;
    function burst(kind,n){
      burstBuf+=n;
      if(burstTimer)return;
      burstTimer=setTimeout(()=>{
        const total=burstBuf; burstBuf=0; burstTimer=null;
        const who=kind===P_L?'你':rival;
        flash(`${who} 消掉 ${total} 行 · 合计 ${lines} 行`);
      },260);
    }
    let msgEl=null, hintEl=null;
    function flash(t){
      if(!hintEl||!t)return;
      hintEl.textContent=t;
      clearTimeout(hintT);
      hintT=setTimeout(()=>{ if(hintEl)hintEl.textContent=baseHint(); },2200);
    }
    function baseHint(){ return `${rival} 在右半蓝盘、你在左半红盘 · 各消各的半场，行数合在一起算`; }
    function levelName(){
      return ([...LEVELS].reverse().find(L=>lines>=L.n)||LEVELS[0]).name;
    }

    box.innerHTML=`
      <div class="card" style="text-align:center">
        <div style="font-weight:800;display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap">
          双人合作俄罗斯方块
          <span class="tz-pill"><span class="tz-dot" style="background:${MY_HEX}"></span>你 · 红</span>
          <span class="tz-pill"><span class="tz-dot" style="background:${TA_HEX}"></span>${rival} · 蓝</span>
        </div>
        <div class="count" style="margin-top:4px">合计消灭 <b id="tzLines">0</b> 行 · 等级 <b id="tzLevel">初见</b> · 剩 <b id="tzLives">3</b> 条命</div>
      </div>
      <div id="tzWrap">
        <canvas id="tzCv" width="${COLS*CELL*2+34}" height="${ROWS*CELL+22}"></canvas>
        <div id="tzMsg" class="hide"></div>
      </div>
      <div class="desc" style="text-align:center;margin-top:6px" id="tzHint">左半红盘归你、右半蓝盘归 ta · 各消各的半场，行数合在一起算</div>
      <div class="pad tz-dpad" id="tzPad" style="margin-top:10px"></div>
      <button class="btn ghost block" id="tzReset" style="margin-top:12px">重新开始</button>`;
    const cv=document.getElementById('tzCv');
    const ctx=cv.getContext('2d');
    const msgElRef=document.getElementById('tzMsg');
    msgEl=msgElRef;
    hintEl=document.getElementById('tzHint');
    hintEl.textContent=baseHint();

    /* v2.24.21：同一块画布里并排两半 —— 左半是你的红盘、右半是 ta 的蓝盘，
       中间一条虚线分开，两半之间没有任何互相影响（各消各的） */
    const TOP=22;                          /* 顶部留一条战队标签带 */
    function boardX(kind){ return kind===P_L?0:COLS*CELL+34; }
    function draw(){
      ctx.clearRect(0,0,cv.width,cv.height);
      ctx.fillStyle='#f6f6f8'; ctx.fillRect(0,0,cv.width,cv.height);
      /* 中缝：虚线，把两半分开 */
      ctx.save();
      ctx.setLineDash([4,5]); ctx.strokeStyle='rgba(28,28,30,.14)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(cv.width/2,4); ctx.lineTo(cv.width/2,cv.height-4); ctx.stroke();
      ctx.restore();
      for(const k of [P_L,P_R]){
        const ox=boardX(k), hex=k===P_L?MY_HEX:TA_HEX, rgb=k===P_L?MY_RGB:TA_RGB;
        /* 半场底 */
        ctx.fillStyle='#ffffff'; ctx.fillRect(ox,TOP,COLS*CELL,ROWS*CELL);
        /* 顶部战队色条 + 标签（画在画布内，省一层 DOM） */
        ctx.fillStyle=hex; ctx.fillRect(ox,TOP-3,COLS*CELL,3);
        ctx.font='600 11px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle=hex;
        ctx.fillText(k===P_L?'你 · 红':'蓝 · '+rival, ox+COLS*CELL/2, 10);
        /* 网格 */
        ctx.strokeStyle='rgba(0,0,0,.05)'; ctx.lineWidth=1;
        for(let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(ox+x*CELL+.5,TOP); ctx.lineTo(ox+x*CELL+.5,TOP+ROWS*CELL); ctx.stroke(); }
        for(let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(ox,TOP+y*CELL+.5); ctx.lineTo(ox+COLS*CELL,TOP+y*CELL+.5); ctx.stroke(); }
        /* 已固定的方块 */
        for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++){
          if(!side[k].g[y][x])continue;
          ctx.fillStyle=`rgba(${rgb},${side[k].g[y][x]===k?1:.42})`;
          ctx.fillRect(ox+x*CELL+1,TOP+y*CELL+1,CELL-2,CELL-2);
        }
        /* 落点虚影：帮双方预判落位 */
        const p=side[k].p;
        if(p&&!over){
          let dy=0; while(!collides(k,p,0,dy+1))dy++;
          ctx.fillStyle=`rgba(${rgb},.14)`;
          p.shape.forEach((row,j)=>row.forEach((v,i)=>{ if(v) ctx.fillRect(ox+(p.x+i)*CELL+1,TOP+(p.y+j+dy)*CELL+1,CELL-2,CELL-2); }));
          ctx.fillStyle=`rgba(${rgb},1)`;
          p.shape.forEach((row,j)=>row.forEach((v,i)=>{ if(v) ctx.fillRect(ox+(p.x+i)*CELL+1,TOP+(p.y+j)*CELL+1,CELL-2,CELL-2); }));
        }
      }
    }
    function syncHud(){
      const e1=document.getElementById('tzLines'), e2=document.getElementById('tzLevel'), e3=document.getElementById('tzLives');
      if(e1)e1.textContent=lines;
      if(e2)e2.textContent=levelName();
      if(e3)e3.textContent=lives;
    }
    /* ta 的 AI（v2.24.21）：改成常规消行打法 —— 优先消行、其次别挖洞、再次压平整、最后控高度。
       两半各消各的之后，不再需要「给我让位」那套重罚。 */
    function taThink(){
      const p=side[P_R].p; if(!p)return;
      const g=side[P_R].g;
      let best=null;
      for(let trial=0;trial<4;trial++){
        let sh=p.shape;
        for(let r=0;r<trial;r++)sh=rotate(sh);
        const w=sh[0].length;
        if(w>COLS)continue;
        for(let sx=0;sx<=COLS-w;sx++){
          const probe={shape:sh,x:sx,y:p.y};
          if(collides(P_R,probe,0,0))continue;
          let dy=0; while(!collides(P_R,probe,0,dy+1))dy++;
          const fx=sx, fy=p.y+dy;
          /* 在副本上试着落定，再打分 */
          const sim=g.map(r=>r.slice());
          let bad=false;
          for(let j=0;j<sh.length&&!bad;j++)for(let i=0;i<sh[j].length;i++){
            if(!sh[j][i])continue;
            const gx=fx+i, gy=fy+j;
            if(gy<0||gy>=ROWS||gx<0||gx>=COLS){ bad=true; break; }
            sim[gy][gx]='R';
          }
          if(bad)continue;
          let clears=0;
          for(let y=0;y<ROWS;y++) if(sim[y].every(v=>v))clears++;
          let holes=0; const hs=[];
          for(let x=0;x<COLS;x++){
            let top=-1;
            for(let y=0;y<ROWS;y++) if(sim[y][x]){ top=y; break; }
            hs.push(top<0?0:ROWS-top);
            if(top<0)continue;
            for(let y=top+1;y<ROWS;y++) if(!sim[y][x])holes++;
          }
          const maxH=Math.max.apply(null,hs);
          const bump=hs.reduce((a,h,i)=>a+(i?Math.abs(h-hs[i-1]):0),0);
          let s=0;
          s+=clears*260;                 /* 能消行最香 */
          s-=holes*46;                   /* 挖洞最亏 */
          s-=bump*4;                     /* 表面别太坑洼 */
          s-=maxH*3;                     /* 别堆太高 */
          s+=(fy+sh.length)*2;           /* 落得低一点 */
          if(!best||s>best.s)best={s,x:fx,rot:trial};
        }
      }
      if(!best)return;
      const p2=side[P_R].p;
      p2.shape=p.shape;
      for(let r=0;r<best.rot;r++)p2.shape=rotate(p2.shape);
      p2.x=best.x;
    }
    let taTick=0;
    function step(){
      if(over)return;
      /* 每 3 步让 ta 决策一次，稍微「想一想」，更有对手感 */
      if(++taTick%3===1)taThink();
      if(!side[P_L].p||!side[P_R].p)return;
      if(!collides(P_L,side[P_L].p,0,1))side[P_L].p.y++;
      else lockPiece(P_L);
      if(over)return;
      if(!collides(P_R,side[P_R].p,0,1))side[P_R].p.y++;
      else lockPiece(P_R);
      syncHud(); draw();
    }
    function reset(){
      over=false; dead=false; lines=0; lives=3; taTick=0;
      if(softHold){ clearInterval(softHold); softHold=null; }
      side[P_L]={g:cells(),p:null};
      side[P_R]={g:cells(),p:null};
      spawn(P_L); spawn(P_R);
      msgEl.classList.add('hide');
      hintEl.textContent=baseHint();
      syncHud(); draw();
      clearInterval(timer);
      timer=setInterval(step,470);          /* 比单机慢一些，两个人一起看不会慌 */
    }
    /* 操作盘（v2.24.21）：中间那颗「落下」改成「加速下落」（软降，按住会持续加速），
       另在下面留一个「直落」按钮，想一步到底时用 */
    document.getElementById('tzPad').innerHTML=`
      <span></span><button data-a="rot" title="顺时针旋转">↻<small>旋转</small></button><span></span>
      <button data-a="left" title="左移">←<small>左移</small></button>
      <button data-a="down" title="加速下落（按住不放会持续加速）">⇓<small>加速下落</small></button>
      <button data-a="right" title="右移">→<small>右移</small></button>
      <span></span><button data-a="drop" title="直接落到底">⤓<small>直落</small></button><span></span>`;
    box.querySelectorAll('#tzPad button').forEach(b=>{
      const act=b.dataset.a;
      b.addEventListener('click',()=>{ myTurn(act); syncHud(); draw(); });
      if(act==='down'){                 /* 按住不放 = 连续加速下落 */
        const holdOn=()=>{ if(softHold)return; softHold=setInterval(()=>{ softDrop(P_L); },70); };
        const holdOff=()=>{ if(softHold){ clearInterval(softHold); softHold=null; } };
        b.addEventListener('pointerdown',holdOn);
        b.addEventListener('pointerup',holdOff);
        b.addEventListener('pointerleave',holdOff);
        b.addEventListener('pointercancel',holdOff);
      }
    });
    const keyMap={ArrowLeft:'left',ArrowRight:'right',ArrowDown:'down',ArrowUp:'rot',a:'left',d:'right',s:'down',w:'rot',A:'left',D:'right',S:'down',W:'rot'};
    const keyHandler=e=>{ if(keyMap[e.key]){ e.preventDefault(); myTurn(keyMap[e.key]); syncHud(); draw(); } };
    document.addEventListener('keydown',keyHandler);
    document.getElementById('tzReset').addEventListener('click',reset);
    reset();
  }
};
