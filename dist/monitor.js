/**
 * Peon Memory Cockpit — a dark, multi-page console for trusting, steering, and
 * proving the value of your AI's memory.
 *
 * Served at GET /monitor as one self-contained HTML document (no build step, no
 * CDN — local-first). Hash-routed pages (#/overview, #/memory, #/network, #/ops):
 *   - Overview: what the AI knows, what it injected last, tokens saved, what needs review
 *   - Memory: the belief list — now editable (pin / edit / delete / merge)
 *   - Network: global memory + the cross-project map
 *   - Ops: consolidation cost, token A/B, live traffic and logs
 * Fed by /monitor/state (poll), /overview, /network, and the /memory/* mutations.
 */
export function renderMonitorHtml() {
    return DOCUMENT;
}
const CLIENT_SCRIPT = String.raw `
  var EL = function (id) { return document.getElementById(id); };
  var STATUSES = ["active", "archived", "superseded", "stale", "conflicted"];
  var STATUS_HELP = {
    active: "a current belief Peon recalls",
    archived: "compressed or resolved by the brain — recoverable, searchable, not injected",
    superseded: "an old belief replaced by a newer one — kept as history",
    stale: "aged out — not recalled by default",
    conflicted: "contradicts another belief"
  };
  var ROUTES = ["brain","projects","overview","memory","ops"];
  var ui = { project:"", filter:"all", search:null, focus:null, editing:null };
  var latest = null, overview = null, network = null, dash = null, busy = false;
  var ovLoadedAt = 0, netLoadedAt = 0, dashLoadedAt = 0, HEAVY_TTL = 12000;
  var seenActivity = {}, activityFirstLoad = true, recentActivity = []; // for live popups
  function freshNow(){ try{ return Date.now(); }catch(e){ return 0; } }
  var KIND_ICON = { resolve_conflict:"⚖", merge_duplicate:"⛓", compress_cluster:"🗜", reinforce:"✦" };
  var KIND_VERB = { resolve_conflict:"Resolved a conflict", merge_duplicate:"Merged duplicates", compress_cluster:"Compressed a topic", reinforce:"Reinforced a belief" };

  async function pollActivity(){
    var items;
    try{ items=await fetch("/brain/activity?limit=40",{cache:"no-store"}).then(function(r){return r.json();}); }catch(e){ return; }
    recentActivity=items||[];
    var fresh=[];
    recentActivity.forEach(function(a){ var key=a.at+"|"+a.type+"|"+a.detail; if(!seenActivity[key]){ seenActivity[key]=1; fresh.push(a); } });
    if(!activityFirstLoad){
      // Only the compression/resolve/merge actions deserve a popup — reinforce is too frequent/noisy.
      fresh.filter(function(a){return a.type!=="reinforce";}).slice(0,3).forEach(showToast);
      if(fresh.some(function(a){return a.type!=="reinforce";})) flashBrain();
    }
    activityFirstLoad=false;
    if(currentRoute()==="brain"){ renderActivityFeed(); uniTicker(); }
  }
  function flashBrain(){ UNI.pulses.push({x:0,y:0,r0:24,r1:480,t:Date.now()}); }
  function showToast(a){
    var wrap=EL("toasts"); if(!wrap) return;
    var t=document.createElement("div"); t.className="toast";
    t.innerHTML='<span class="ti">'+(KIND_ICON[a.type]||"🧠")+'</span><div class="tb"><div class="tt">'+esc(KIND_VERB[a.type]||"Brain acted")+' · <span class="tp">'+esc(a.projectName)+'</span></div><div class="td">'+esc(clip(a.detail,90))+'</div></div>';
    wrap.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add("in"); });
    setTimeout(function(){ t.classList.remove("in"); setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },400); },6000);
  }

  function esc(v){ return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  function clip(v,n){ var s=String(v==null?"":v).trim(); return s.length>n?s.slice(0,n)+"…":s; }
  function fmt(n){ return (Number(n)||0).toLocaleString("en-US"); }
  function tm(iso){ try{ return new Date(iso).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}); }catch(e){ return ""; } }
  function name(p){ return String(p||"").split("/").filter(Boolean).pop()||"project"; }
  function pct(x){ return Math.max(0,Math.min(100,Math.round((Number(x)||0)*100))); }
  function recordsOf(p){ return (p&&p.brain&&p.brain.records)||[]; }
  function count(recs,st){ var n=0; for(var i=0;i<recs.length;i++) if(recs[i].status===st) n++; return n; }
  function projects(){ return (latest&&latest.projects)||[]; }
  function selected(){ var ps=projects(); if(!ps.length) return null; for(var i=0;i<ps.length;i++) if(ps[i].projectPath===ui.project) return ps[i]; return ps[0]; }
  function recent(iso,sec){ try{ return (Date.now()-new Date(iso).getTime())<sec*1000; }catch(e){ return false; } }
  function ago(iso){ try{ var s=Math.round((Date.now()-new Date(iso).getTime())/1000); if(s<60) return s+"s ago"; if(s<3600) return Math.round(s/60)+"m ago"; if(s<86400) return Math.round(s/3600)+"h ago"; return Math.round(s/86400)+"d ago"; }catch(e){ return ""; } }
  function currentRoute(){ var h=(location.hash||"#/overview").replace("#/",""); return ROUTES.indexOf(h)>=0?h:"overview"; }
  function scopeBadge(s){ var cls=s==="global"?"sb-global":"sb-project"; return '<span class="sb '+cls+'">'+esc(s)+'</span>'; }

  async function refresh(){
    var state;
    try{ state=await fetch("/monitor/state",{cache:"no-store"}).then(function(r){return r.json();}); }
    catch(e){ EL("status").textContent="offline"; EL("dot").classList.add("off"); return; }
    EL("dot").classList.remove("off"); EL("status").textContent="live · "+tm(state.generatedAt);
    latest=state;
    var ps=projects();
    if(!ui.project && ps.length){ var best=ps[0]; ps.forEach(function(p){ if(recordsOf(p).length>recordsOf(best).length) best=p; }); ui.project=best.projectPath; }
    syncSwitcher(); renderRoute();
  }

  function syncSwitcher(){
    var sel=EL("switcher"); if(!sel) return;
    var ps=projects().slice().sort(function(a,b){return recordsOf(b).length-recordsOf(a).length;});
    var cur=ui.project;
    sel.innerHTML=ps.map(function(p){ return '<option value="'+esc(p.projectPath)+'"'+(p.projectPath===cur?" selected":"")+'>'+esc(name(p.projectPath))+' · '+count(recordsOf(p),"active")+'</option>'; }).join("");
  }

  function renderRoute(force){
    var r=currentRoute();
    ROUTES.forEach(function(x){ var p=EL("page-"+x); if(p) p.hidden=(x!==r); });
    // The project dropdown is CONTEXT, not chrome: it only applies inside a project's
    // Insights/Memory pages. Global pages (Neural Core / Sectors / Systems) hide it —
    // switching projects there happens by picking a galaxy or a sector card.
    var sw=EL("switcher"); if(sw) sw.hidden=!(r==="overview"||r==="memory");
    // Nav highlight: overview/memory belong under "projects".
    ["brain","projects","ops"].forEach(function(x){ var t=EL("nav-"+x); if(t) t.classList.toggle("on", x===r || ((r==="overview"||r==="memory")&&x==="projects")); });
    if(r==="brain"){ loadDashboard(force); renderBrainHome(); }
    else if(r==="projects"){ loadNetwork(force); renderProjectsGrid(); }
    else if(r==="overview"){ loadOverview(force); renderOverviewPage(); }
    else if(r==="memory") renderMemoryPage();
    else if(r==="ops") renderOpsPage();
  }

  // ===== BRAIN HOME (global) =====
  async function loadDashboard(force){
    if(!force && (freshNow()-dashLoadedAt)<HEAVY_TTL) return;
    dashLoadedAt=freshNow();
    try{ dash=await fetch("/global/dashboard",{cache:"no-store"}).then(function(r){return r.json();}); renderBrainHome(); }catch(e){}
  }
  // ===== NEURAL UNIVERSE — every real belief is a star; projects are galaxies =====
  var UNI = { nodes:[], clusters:[], grid:{}, cell:46, cam:{x:0,y:0,z:1}, tx:{x:0,y:0,z:1},
    hover:null, selected:null, hits:null, sig:"", raf:0, flash:0, pulses:[], drag:null, moved:false, t0:Date.now() };
  var TYPE_COLOR = { decision:"#59e3ff", preference:"#5dffb0", fact:"#eaf6ff", artifact:"#ffc957",
    open_question:"#ff9d70", timeline:"#7db4ff", summary:"#9db4ff" };
  function uniCanvas(){ return EL("uni"); }
  function hashN(str){ var h=2166136261>>>0; for(var i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0)/4294967295; }

  function buildUniverse(){
    var ps=projects(); if(!ps.length) return;
    var sig=ps.map(function(p){ return name(p.projectPath)+":"+recordsOf(p).length; }).join("|")+"|g"+((dash&&dash.records&&dash.records.length)||0);
    if(sig===UNI.sig) return; UNI.sig=sig;
    var nodes=[], clusters=[];
    var sorted=ps.slice().sort(function(a,b){ return recordsOf(b).length-recordsOf(a).length; });
    var golden=2.39996; var maxCount=Math.max(1,recordsOf(sorted[0]).length);
    // galaxies on a ring; radius of each galaxy grows with sqrt(node count)
    var ringR=430;
    sorted.forEach(function(p,pi){
      var recs=recordsOf(p); if(!recs.length) return;
      var ang=(pi/sorted.length)*Math.PI*2 - Math.PI/2;
      var gR=Math.sqrt(recs.length)*7+40;
      var cx=Math.cos(ang)*(ringR+gR*0.35), cy=Math.sin(ang)*(ringR+gR*0.35)*0.72;
      var cluster={ x:cx, y:cy, r:gR, name:name(p.projectPath), path:p.projectPath, count:recs.length,
        active:count(recs,"active"), spin:(pi%2?1:-1)*(0.00003+0.00002*hashN(p.projectPath)) };
      clusters.push(cluster);
      recs.forEach(function(rec,i){
        var rr=Math.sqrt(i+1)/Math.sqrt(recs.length)*gR;
        var th=i*golden + hashN(rec.id)*0.35;
        var imp=(rec.score&&rec.score.importance)||0.5;
        var st=rec.status;
        var col=TYPE_COLOR[rec.type]||"#9fd0e0";
        var alpha=st==="active"?0.95:(st==="conflicted"?0.95:0.22);
        if(st==="conflicted") col="#ff7a70";
        nodes.push({ id:rec.id, rec:rec, cl:cluster, rad:rr, th:th,
          x:0, y:0, r:0.9+imp*2.6+(rec.pinned?1.2:0), c:col, a:alpha, tw:hashN(rec.id)*6.28,
          hot:recent(rec.updatedAt, 3600*6) });
      });
    });
    // global memory = the center core's own small galaxy
    var g=(dash&&dash.records)||[];
    var gc={ x:0, y:0, r:Math.sqrt(g.length||1)*6+30, name:"GLOBAL", path:null, count:g.length, active:g.length, spin:0.00005 };
    clusters.push(gc);
    g.forEach(function(rec,i){
      var rr=26+Math.sqrt(i+1)/Math.sqrt(g.length||1)*gc.r;
      nodes.push({ id:"g-"+i, rec:rec, cl:gc, rad:rr, th:i*golden, x:0,y:0,
        r:1.2+((rec.score&&rec.score.importance)||0.6)*2.2, c:"#eaf6ff", a:0.9, tw:hashN(String(i))*6.28, hot:false });
    });
    UNI.nodes=nodes; UNI.clusters=clusters;
    uniFit(); uniLegend(); uniStats();
  }

  function uniFit(){
    var c=uniCanvas(); if(!c) return;
    var maxR=0; UNI.clusters.forEach(function(cl){ maxR=Math.max(maxR, Math.hypot(cl.x,cl.y)+cl.r+60); });
    var z=Math.min(c.clientWidth,c.clientHeight)/(maxR*2)||1;
    UNI.tx={x:0,y:0,z:z}; UNI.cam={x:0,y:0,z:z};
  }
  function uniLegend(){
    var el=EL("uni-legend"); if(!el) return;
    var t=Object.keys(TYPE_COLOR).map(function(k){ return '<span class="ul"><i style="background:'+TYPE_COLOR[k]+'"></i>'+k.replace("_"," ")+'</span>'; }).join("");
    el.innerHTML=t+'<span class="ul"><i style="background:#ff7a70"></i>conflict</span><span class="ul dim"><i></i>dim = archived / superseded</span>';
  }
  function uniStats(){
    var el=EL("uni-stats"); if(!el) return;
    var tot=UNI.nodes.length, act=0, conf=0;
    UNI.nodes.forEach(function(n){ if(n.rec.status==="active") act++; if(n.rec.status==="conflicted") conf++; });
    el.innerHTML='<b>'+fmt(tot)+'</b> BELIEFS · <b>'+fmt(act)+'</b> ACTIVE · <b class="'+(conf?"warn":"")+'">'+fmt(conf)+'</b> CONFLICTED · <b>'+fmt(UNI.clusters.length-1)+'</b> GALAXIES';
  }
  function uniHealth(){
    var el=EL("uni-health"); if(!el) return;
    var h=(latest&&latest.health)||{}; var sv=h.serve;
    var stl=h.stl?h.stl.headline:"";
    var dotc=stl.indexOf("🔴")>=0?"#ff7a70":(stl.indexOf("🟡")>=0?"#ffc957":"#5dffb0");
    el.innerHTML=(sv?('UPLINK <b>'+fmt(sv.count)+'</b>/24H · <b>'+(sv.avgMs/1000).toFixed(1)+'S</b> AVG · <b>~'+fmt(sv.avgTokens)+'</b> TOK'):'UPLINK —')+
      ' <span class="stl-dot" style="background:'+dotc+'" title="'+esc(stl)+'"></span>';
  }

  var SPRITES={};
  function nodeSprite(color, glow){
    var key=color+(glow?"G":"");
    if(SPRITES[key]) return SPRITES[key];
    var pad=glow?10:2, R=6, size=(R+pad)*2;
    var sc=document.createElement("canvas"); sc.width=size; sc.height=size;
    var g=sc.getContext("2d");
    if(glow){ g.shadowColor=color; g.shadowBlur=9; }
    g.fillStyle=color; g.beginPath(); g.arc(size/2,size/2,R,0,6.29); g.fill();
    if(glow){ g.fill(); }
    SPRITES[key]={c:sc,R:R,half:size/2};
    return SPRITES[key];
  }

  function uniProject(n){ /* world position with slow galaxy rotation */
    var t=(Date.now()-UNI.t0);
    var th=n.th + t*n.cl.spin;
    n.x=n.cl.x+Math.cos(th)*n.rad; n.y=n.cl.y+Math.sin(th)*n.rad*0.9;
  }
  function uniGridBuild(){
    UNI.grid={};
    UNI.nodes.forEach(function(n,i){ var k=Math.floor(n.x/UNI.cell)+","+Math.floor(n.y/UNI.cell); (UNI.grid[k]=UNI.grid[k]||[]).push(i); });
  }
  function uniPick(wx,wy){
    var best=null,bd=1e9, cx=Math.floor(wx/UNI.cell), cy=Math.floor(wy/UNI.cell);
    for(var dx=-1;dx<=1;dx++)for(var dy=-1;dy<=1;dy++){
      var b=UNI.grid[(cx+dx)+","+(cy+dy)]; if(!b) continue;
      for(var i=0;i<b.length;i++){ var n=UNI.nodes[b[i]]; var d=Math.hypot(n.x-wx,n.y-wy); if(d<bd){bd=d;best=n;} }
    }
    return bd < 14/UNI.cam.z ? best : null;
  }

  function uniDraw(){
    var c=uniCanvas(); if(!c||currentRoute()!=="brain"){ UNI.raf=0; return; }
    UNI.lastDraw=Date.now();
    var dpr=window.devicePixelRatio||1;
    if(c.width!==c.clientWidth*dpr||c.height!==c.clientHeight*dpr){ c.width=c.clientWidth*dpr; c.height=c.clientHeight*dpr; }
    var ctx=c.getContext("2d");
    var W=c.clientWidth,H=c.clientHeight,t=Date.now();
    // ease camera
    UNI.cam.x+=(UNI.tx.x-UNI.cam.x)*0.12; UNI.cam.y+=(UNI.tx.y-UNI.cam.y)*0.12; UNI.cam.z+=(UNI.tx.z-UNI.cam.z)*0.12;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.save();
    ctx.translate(W/2,H/2); ctx.scale(UNI.cam.z,UNI.cam.z); ctx.translate(-UNI.cam.x,-UNI.cam.y);
    // galaxy rings + labels
    UNI.clusters.forEach(function(cl){
      ctx.beginPath(); ctx.arc(cl.x,cl.y,cl.r+14,0,6.29);
      ctx.strokeStyle="rgba(89,227,255,.10)"; ctx.lineWidth=1/UNI.cam.z; ctx.setLineDash([4/UNI.cam.z,7/UNI.cam.z]); ctx.stroke(); ctx.setLineDash([]);
      ctx.font=(11/UNI.cam.z)+"px ui-monospace,Menlo,monospace";
      ctx.fillStyle="rgba(127,169,192,.85)"; ctx.textAlign="center";
      ctx.fillText(cl.name.toUpperCase()+" · "+cl.count, cl.x, cl.y-cl.r-22/UNI.cam.z);
    });
    // core reactor
    var pul=0.5+0.5*Math.sin(t/600);
    var gr=ctx.createRadialGradient(0,0,2,0,0,26);
    gr.addColorStop(0,"rgba(234,255,255,.95)"); gr.addColorStop(0.4,"rgba(158,240,255,.8)"); gr.addColorStop(1,"rgba(43,168,201,0)");
    ctx.beginPath(); ctx.arc(0,0,26+pul*6,0,6.29); ctx.fillStyle=gr; ctx.fill();
    // injection / activity pulses
    UNI.pulses=UNI.pulses.filter(function(pp){ return t-pp.t<1200; });
    UNI.pulses.forEach(function(pp){
      var k=(t-pp.t)/1200;
      ctx.beginPath(); ctx.arc(pp.x,pp.y,pp.r0+k*pp.r1,0,6.29);
      ctx.strokeStyle="rgba(89,227,255,"+(0.5*(1-k))+")"; ctx.lineWidth=1.6/UNI.cam.z; ctx.stroke();
    });
    // nodes
    var hits=UNI.hits, dimOthers=!!(hits&&hits.size);
    // viewport bounds in world coords (with margin) for culling
    var vw=W/2/UNI.cam.z+30, vh=H/2/UNI.cam.z+30, vcx=UNI.cam.x, vcy=UNI.cam.y;
    UNI.nodes.forEach(function(n){
      uniProject(n);
      if(n.x<vcx-vw||n.x>vcx+vw||n.y<vcy-vh||n.y>vcy+vh) return; // offscreen — skip draw
      var tw=0.78+0.22*Math.sin(t/900+n.tw);
      var a=n.a*tw, r=n.r;
      if(dimOthers){ if(hits.has(n.id)){ a=1; r=n.r*1.7; } else a*=0.08; }
      if(n.hot) r*=1.15;
      var glow=(dimOthers&&hits.has(n.id))||n===UNI.hover||n===UNI.selected||n.rec.status==="conflicted";
      var sp=nodeSprite(n.c, glow);
      var scale=(r/Math.sqrt(UNI.cam.z))/sp.R;
      ctx.globalAlpha=Math.min(1,a);
      ctx.drawImage(sp.c, n.x-sp.half*scale, n.y-sp.half*scale, sp.c.width*scale, sp.c.height*scale);
    });
    ctx.globalAlpha=1;
    // hover crosshair
    if(UNI.hover){ var hN=UNI.hover; var hr=10/UNI.cam.z;
      ctx.strokeStyle="rgba(234,255,255,.85)"; ctx.lineWidth=1/UNI.cam.z;
      ctx.beginPath(); ctx.arc(hN.x,hN.y,hr,0,6.29); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hN.x-hr*1.8,hN.y); ctx.lineTo(hN.x-hr,hN.y); ctx.moveTo(hN.x+hr,hN.y); ctx.lineTo(hN.x+hr*1.8,hN.y);
      ctx.moveTo(hN.x,hN.y-hr*1.8); ctx.lineTo(hN.x,hN.y-hr); ctx.moveTo(hN.x,hN.y+hr); ctx.lineTo(hN.x,hN.y+hr*1.8); ctx.stroke();
    }
    ctx.restore();
    if(!UNI.lastGrid||t-UNI.lastGrid>250){ uniGridBuild(); UNI.lastGrid=t; }
    // tooltip
    var tip=EL("uni-tip");
    if(tip){ if(UNI.hover){ var sp=uniToScreen(UNI.hover,W,H);
        tip.hidden=false; tip.style.left=Math.min(W-330,Math.max(8,sp.x+16))+"px"; tip.style.top=Math.max(8,sp.y-14)+"px";
        tip.innerHTML='<span class="tt-type" style="color:'+UNI.hover.c+'">'+esc(UNI.hover.rec.type)+'</span> '+esc(clip(UNI.hover.rec.content,140));
      } else tip.hidden=true; }
    // ~30fps is indistinguishable here and halves the draw cost on big brains
    UNI.raf=requestAnimationFrame(function(){ setTimeout(function(){ UNI.raf=0; uniDraw(); }, 15); });
  }
  function uniToScreen(n,W,H){ return { x:(n.x-UNI.cam.x)*UNI.cam.z+W/2, y:(n.y-UNI.cam.y)*UNI.cam.z+H/2 }; }
  function uniToWorld(sx,sy){ var c=uniCanvas(); var W=c.clientWidth,H=c.clientHeight;
    return { x:(sx-W/2)/UNI.cam.z+UNI.cam.x, y:(sy-H/2)/UNI.cam.z+UNI.cam.y }; }
  function uniStart(){
    if(!UNI.raf&&uniCanvas()) UNI.raf=requestAnimationFrame(uniDraw);
    // Some embedded/webview panes throttle rAF to zero — a watchdog keeps the field alive.
    if(!UNI.watchdog) UNI.watchdog=setInterval(function(){
      if(currentRoute()!=="brain") return;
      if(!UNI.lastDraw||Date.now()-UNI.lastDraw>400){ UNI.raf=0; uniDraw(); }
    },300);
    uniHealth();
  }

  function uniSearch(q){
    q=String(q||"").trim().toLowerCase();
    var hitsEl=EL("uq-hits");
    if(!q){ UNI.hits=null; if(hitsEl) hitsEl.textContent=""; return; }
    var toks=q.split(/\s+/).filter(Boolean);
    var set=new Set(), sx=0, sy=0, m=0;
    UNI.nodes.forEach(function(n){
      var hay=(n.rec.content+" "+(n.rec.entities||[]).join(" ")).toLowerCase();
      var ok=true; for(var i=0;i<toks.length;i++) if(hay.indexOf(toks[i])<0){ ok=false; break; }
      if(ok){ set.add(n.id); sx+=n.x; sy+=n.y; m++; }
    });
    UNI.hits=set;
    if(hitsEl) hitsEl.textContent=m?(m+" MATCH"+(m>1?"ES":"")):"NO MATCH";
    if(m){ UNI.tx.x=sx/m; UNI.tx.y=sy/m; UNI.tx.z=Math.max(UNI.cam.z, m<20?1.1:0.55); }
  }
  function uniInspect(n){
    var el=EL("uni-inspect"); if(!el) return;
    if(!n){ el.hidden=true; UNI.selected=null; return; }
    UNI.selected=n; var r=n.rec;
    el.hidden=false;
    el.innerHTML='<button class="ui-x" id="ui-x">✕</button>'+
      '<div class="ui-type" style="color:'+n.c+'">'+esc(r.type)+' · '+esc(r.status||"global")+'</div>'+
      '<div class="ui-content">'+esc(r.content)+'</div>'+
      '<div class="ui-meta">'+
        '<span class="g">IMP <b>'+pct(r.score&&r.score.importance)+'</b><i class="bar"><i style="width:'+pct(r.score&&r.score.importance)+'%"></i></i></span>'+
        '<span class="g">CONF <b>'+pct(r.score&&r.score.confidence)+'</b><i class="bar"><i class="b2" style="width:'+pct(r.score&&r.score.confidence)+'%"></i></i></span></div>'+
      ((r.entities&&r.entities.length)?'<div class="ui-ents">'+r.entities.slice(0,8).map(function(e){return '<span class="ent mono">'+esc(e)+'</span>';}).join("")+'</div>':"")+
      '<div class="ui-proj mono">'+esc(n.cl.name)+(r.updatedAt?' · '+esc(ago(r.updatedAt)):'')+'</div>'+
      (n.cl.path?'<button class="btn sm" id="ui-open">OPEN IN MEMORY BANKS →</button>':"");
    var x=EL("ui-x"); if(x) x.addEventListener("click",function(){ uniInspect(null); });
    var op=EL("ui-open"); if(op) op.addEventListener("click",function(){
      ui.project=n.cl.path; ui.focus=n.id; ui.search=null; syncSwitcher(); location.hash="#/memory"; });
  }
  function uniTicker(){
    var el=EL("uni-ticker"); if(!el) return;
    var items=recentActivity.slice(0,3);
    el.innerHTML=items.length?items.map(function(a,i){
      return '<div class="utk" style="opacity:'+(1-i*0.3)+'"><span class="utk-k">'+esc(a.type.replace("_"," "))+'</span> '+esc(a.projectName)+' — '+esc(clip(a.detail,110))+' <span class="utk-t">'+esc(ago(a.at))+'</span></div>';
    }).join(""):'<div class="utk">memory field stable — no autonomous actions yet</div>';
  }
  function uniWire(){
    var c=uniCanvas(); if(!c||c.getAttribute("data-wired")) return; c.setAttribute("data-wired","1");
    c.addEventListener("wheel",function(e){ e.preventDefault();
      var w=uniToWorld(e.offsetX,e.offsetY);
      var z=UNI.tx.z*Math.pow(1.0015,-e.deltaY); z=Math.max(0.12,Math.min(9,z));
      UNI.tx.z=z; UNI.tx.x=w.x-(e.offsetX-c.clientWidth/2)/z; UNI.tx.y=w.y-(e.offsetY-c.clientHeight/2)/z;
      UNI.cam.z=z; UNI.cam.x=UNI.tx.x; UNI.cam.y=UNI.tx.y;
    },{passive:false});
    c.addEventListener("mousedown",function(e){ UNI.drag={x:e.clientX,y:e.clientY,cx:UNI.tx.x,cy:UNI.tx.y}; UNI.moved=false; });
    window.addEventListener("mousemove",function(e){
      if(UNI.drag){ var dx=(e.clientX-UNI.drag.x)/UNI.cam.z, dy=(e.clientY-UNI.drag.y)/UNI.cam.z;
        if(Math.hypot(e.clientX-UNI.drag.x,e.clientY-UNI.drag.y)>4) UNI.moved=true;
        UNI.tx.x=UNI.drag.cx-dx; UNI.tx.y=UNI.drag.cy-dy; UNI.cam.x=UNI.tx.x; UNI.cam.y=UNI.tx.y; }
      else if(e.target===c){ var r=c.getBoundingClientRect(); var w=uniToWorld(e.clientX-r.left,e.clientY-r.top); UNI.hover=uniPick(w.x,w.y); }
    });
    window.addEventListener("mouseup",function(e){
      if(UNI.drag&&!UNI.moved&&e.target===c){ if(UNI.hover) uniInspect(UNI.hover); else uniInspect(null); }
      UNI.drag=null;
    });
    c.addEventListener("dblclick",function(){ uniFit(); });
    var uq=EL("uq"); if(uq){ uq.addEventListener("input",function(){ uniSearch(uq.value); }); }
    var fit=EL("uni-fit"); if(fit) fit.addEventListener("click",function(){ uniFit(); });
  }

  function renderBrainHome(){
    var d=dash||{totalBeliefs:0,byType:{},topEntities:[],recentActions:[],records:[]};
    buildUniverse(); uniWire(); uniStart(); uniTicker(); uniHealth();
    var types=Object.keys(d.byType||{}).map(function(t){return [t,d.byType[t]];}).sort(function(a,b){return b[1]-a[1];});
    var html='<section class="panel"><div class="phead"><div class="ht"><h2>Global memory</h2><span class="note">cross-cutting facts every project recalls · '+fmt(d.totalBeliefs)+' beliefs</span></div></div>'+
      '<div class="bhtypes" style="margin-bottom:10px">'+(types.length?types.map(function(t){return '<span class="tchip">'+esc(t[0])+' <b>'+t[1]+'</b></span>';}).join(""):'<span class="muted"></span>')+'</div>'+
      '<div class="scroll" style="max-height:260px">'+((d.records||[]).length?d.records.map(function(g){return '<div class="rec active"><div class="recline"><span class="rtype">'+esc(g.type)+'</span><span class="rcontent">'+esc(g.content)+'</span></div></div>';}).join(""):'<div class="empty">Global memory is empty — cross-cutting facts auto-promote here.</div>')+'</div></section>'+
    '<section class="panel"><div class="phead"><div class="ht"><h2>what the brain is doing</h2><span class="note">live autonomous activity</span></div></div><div id="bhactivity"></div></section>';
    EL("bh-body").innerHTML=html;
    renderActivityFeed();
  }
  function renderActivityFeed(){
    var el=EL("bhactivity"); if(!el) return;
    var items=recentActivity.slice(0,12);
    el.innerHTML=items.length?items.map(function(a){
      return '<div class="didrow"><span class="didkind k-'+esc(a.type)+'">'+esc(a.type.replace("_"," "))+'</span>'+
        '<span class="sb '+(a.scope==="global"?"sb-global":"sb-project")+'">'+esc(a.projectName)+'</span>'+
        '<span class="didtxt">'+esc(clip(a.detail,80))+'</span><span class="didtime">'+esc(ago(a.at))+'</span></div>';
    }).join(""):'<div class="empty">The brain hasn\'t needed to act yet. It curates automatically as memory grows.</div>';
  }

  // ===== PROJECTS GRID → drill into insights =====
  function renderProjectsGrid(){
    var n=network||{projects:[]};
    // Disambiguate same-named projects by showing their parent folder.
    var nameCount={}; n.projects.forEach(function(p){ nameCount[p.projectName]=(nameCount[p.projectName]||0)+1; });
    function parentOf(path){ var parts=String(path).split("/").filter(Boolean); return parts.length>1?parts[parts.length-2]:""; }
    EL("projgrid").innerHTML=n.projects.length?n.projects.map(function(p){
      var dis=nameCount[p.projectName]>1?'<span class="pcdis"> · in '+esc(parentOf(p.projectPath))+'</span>':'';
      return '<button class="pcard" data-p="'+esc(p.projectPath)+'" title="'+esc(p.projectPath)+'">'+
        '<div class="pcname">'+esc(p.projectName)+dis+'</div>'+
        '<div class="pcstats"><span class="pcg">'+p.active+'</span> active beliefs'+(p.pinned?' · '+p.pinned+' pinned':'')+'</div>'+
        '<div class="pcgo">open insights →</div></button>';
    }).join(""):'<div class="empty">No projects yet</div>';
    Array.prototype.forEach.call(document.querySelectorAll(".pcard"),function(b){ b.addEventListener("click",function(){ ui.project=b.getAttribute("data-p"); ui.search=null; ui.focus=null; overview=null; syncSwitcher(); location.hash="#/overview"; }); });
  }

  // ===== OVERVIEW =====
  async function loadOverview(force){
    if(!ui.project) return;
    if(!force && (freshNow()-ovLoadedAt)<HEAVY_TTL) return; // throttle the heavy endpoint
    ovLoadedAt=freshNow();
    try{ overview=await fetch("/overview?projectPath="+encodeURIComponent(ui.project),{cache:"no-store"}).then(function(r){return r.json();}); renderOverviewPage(); }catch(e){}
  }
  function renderOverviewPage(){
    var sel=selected();
    if(!sel){ EL("ov-body").innerHTML='<div class="empty">No project selected.</div>'; return; }
    var o=overview && overview.projectPath===ui.project ? overview : null;
    var recs=recordsOf(sel);
    var c=o?o.counts:{active:count(recs,"active"),superseded:count(recs,"superseded"),conflicts:count(recs,"conflicted"),stale:count(recs,"stale"),total:recs.length,project:count(recs,"active"),global:0};
    var conflicts=o?o.needsReview.conflicts:[];
    var dups=o?o.needsReview.duplicates:[];
    var reviewN=conflicts.length+dups.length;
    var healthy=reviewN===0;
    var saved=o&&o.tokensSaved;

    var vitals=o&&o.vitals;
    var pulse=vitals&&vitals.alive?'<span class="pulse-dot" title="the brain is awake"></span> awake':'<span class="pulse-dot off"></span> asleep';
    var dream=vitals&&vitals.lastDreamAt?' · last curated '+esc(ago(vitals.lastDreamAt)):(vitals&&vitals.lastHeartbeatAt?' · last pulse '+esc(ago(vitals.lastHeartbeatAt)):'');
    var hero='<div class="hero"><div class="hero-l"><span class="hero-name">'+esc(name(sel.projectPath))+'</span>'+
      '<span class="health '+(healthy?"ok":"warn")+'">'+(healthy?"memory healthy":reviewN+" need review")+'</span>'+
      '<span class="vital">'+pulse+dream+'</span></div>'+
      '<span class="hero-r">'+(o&&o.lastConsolidatedAt?"last consolidated "+esc(ago(o.lastConsolidatedAt)):"")+'</span></div>';

    var savedCard = saved
      ? '<div class="cardnum g">~'+fmt(saved.savedPerSession)+'</div><div class="cardlbl">tokens saved / session</div><div class="cardsub">'+saved.onSessions+' on · '+saved.offSessions+' off baseline</div>'
      : '<div class="cardnum muted">—</div><div class="cardlbl">tokens saved / session</div><div class="cardsub">run a Peon-off session to compare</div>';
    var cards='<div class="cards">'+
      '<div class="card"><div class="cardnum">'+fmt(c.active)+'</div><div class="cardlbl">beliefs known</div><div class="cardsub">'+fmt(c.project)+' project · '+fmt(c.global)+' global</div></div>'+
      '<div class="card">'+savedCard+'</div>'+
      '<div class="card"><div class="cardnum '+(reviewN?"a":"")+'">'+reviewN+'</div><div class="cardlbl">needs review</div><div class="cardsub">'+dups.length+' duplicate · '+conflicts.length+' conflict</div></div>'+
      '</div>';

    var injItems=o&&o.lastInjection?o.lastInjection.items:[];
    var injBody=injItems.length?injItems.slice(0,8).map(function(it){
      return '<div class="injrow">'+scopeBadge(it.scope)+'<span class="injc">'+esc(clip(it.content,150))+'</span><span class="injs">'+pct(it.score)+'%</span></div>';
    }).join(""):'<div class="empty">No injection captured yet — Peon fills this on your next prompt.</div>';
    var inj='<section class="panel"><div class="phead"><div class="ht"><h2>what Peon injected into your last prompt</h2><span class="note">'+(o&&o.lastInjection&&o.lastInjection.query?'"'+esc(clip(o.lastInjection.query,60))+'"':"")+'</span></div></div>'+injBody+'</section>';

    var review="";
    if(reviewN){
      var rows=dups.map(function(d){
        return '<div class="revrow"><span class="revtxt">Near-duplicate: <b>'+esc(clip(d.aContent,60))+'</b> ／ '+esc(clip(d.bContent,60))+'</span>'+
          '<span class="revacts"><button class="btn sm" data-merge-keep="'+esc(d.aId)+'" data-merge-drop="'+esc(d.bId)+'">Merge</button></span></div>';
      }).join("");
      rows+=conflicts.map(function(cf){
        return '<div class="revrow"><span class="revtxt">Conflict: '+esc(clip(cf.content,90))+'</span>'+
          '<span class="revacts"><button class="btn sm ghost" data-goto="'+esc(cf.id)+'">Resolve</button></span></div>';
      }).join("");
      review='<section class="panel review"><div class="phead"><div class="ht"><h2>needs your attention</h2></div></div>'+rows+'</section>';
    }

    // What the brain did on its own — the autonomous action feed, with undo.
    var acts=(o&&o.brainActions)||[];
    var did="";
    if(acts.length){
      var rows=acts.slice(0,8).map(function(e){
        return e.actions.map(function(a){
          return '<div class="didrow"><span class="didkind k-'+esc(a.type)+'">'+esc(a.type.replace("_"," "))+'</span><span class="didtxt">'+esc(clip(a.detail,90))+'</span><span class="didtime">'+esc(ago(e.at))+'</span></div>';
        }).join("");
      }).join("");
      did='<section class="panel"><div class="phead"><div class="ht"><h2>what the brain did on its own</h2><button class="btn sm ghost" id="undo-brain" title="restore the most recent backup snapshot">Undo last</button></div><div class="cap">autonomous curation — every change is recoverable</div></div>'+rows+'</section>';
    }

    EL("ov-body").innerHTML=hero+cards+inj+review+did;
    Array.prototype.forEach.call(document.querySelectorAll("[data-merge-keep]"),function(b){ b.addEventListener("click",function(){ mutate("/memory/merge",{projectPath:ui.project,keepId:b.getAttribute("data-merge-keep"),dropId:b.getAttribute("data-merge-drop")}); }); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-goto]"),function(b){ b.addEventListener("click",function(){ ui.focus=b.getAttribute("data-goto"); location.hash="#/memory"; }); });
    var undo=EL("undo-brain"); if(undo) undo.addEventListener("click",function(){ if(confirm("Restore the most recent backup, undoing the brain's last changes?")) mutate("/brain/restore",{projectPath:ui.project}); });
  }

  // ===== MEMORY (editable) =====
  function renderMemoryPage(){
    var sel=selected();
    EL("memScope").textContent=sel?name(sel.projectPath):"";
    if(!sel){ EL("records").innerHTML='<div class="empty">No project</div>'; EL("filters").innerHTML=""; return; }
    var recs=recordsOf(sel);
    var chips=[["all",recs.length,"every record"]]; STATUSES.forEach(function(s){ chips.push([s,count(recs,s),STATUS_HELP[s]]); });
    EL("filters").innerHTML=chips.map(function(c){ return '<button class="chip'+(ui.filter===c[0]?" on":"")+'" data-f="'+c[0]+'" title="'+esc(c[2])+'">'+(c[0]==="all"?"":'<span class="sd '+c[0]+'"></span>')+esc(c[0])+'<span class="cc">'+c[1]+'</span></button>'; }).join("");
    Array.prototype.forEach.call(document.querySelectorAll(".chip"),function(b){ b.addEventListener("click",function(){ ui.filter=b.getAttribute("data-f"); renderMemoryPage(); }); });
    var isSearch=!!ui.search,rows;
    if(isSearch) rows=ui.search.map(function(r){return {record:r.record,why:r.explanation||""};});
    else rows=recs.filter(function(r){return ui.filter==="all"||r.status===ui.filter;}).sort(function(a,b){ var ap=a.pinned?1:0,bp=b.pinned?1:0; if(ap!==bp) return bp-ap; var aw=a.status==="active"?1:0,bw=b.status==="active"?1:0; if(aw!==bw) return bw-aw; return (b.score.importance+b.score.confidence)-(a.score.importance+a.score.confidence); }).map(function(r){return {record:r,why:""};});
    EL("memCount").textContent=rows.length+(isSearch?" matches":"");
    EL("records").innerHTML=rows.length?rows.map(function(r){return recCard(r.record,r.why);}).join(""):'<div class="empty">'+(isSearch?"No matches":"No records")+'</div>';
    wireRecordActions();
    EL("inject").textContent=(sel.brain&&sel.brain.injectionPreview&&sel.brain.injectionPreview.trim())?clip(sel.brain.injectionPreview,2400):"—";
  }
  function recCard(r,why){ var hl=ui.focus===r.id?" hl":""; var editing=ui.editing===r.id;
    var content=editing
      ? '<input class="editin" id="edit-'+esc(r.id)+'" value="'+esc(r.content)+'"><button class="btn sm" data-save="'+esc(r.id)+'">Save</button><button class="btn sm ghost" data-canceledit="1">Cancel</button>'
      : '<span class="rcontent">'+esc(r.content)+'</span>';
    return '<div class="rec '+esc(r.status)+hl+(r.pinned?" pinned":"")+'" id="rec-'+esc(r.id)+'"><div class="recline"><span class="sd '+esc(r.status)+'" title="'+esc(STATUS_HELP[r.status]||r.status)+'"></span><span class="rtype">'+esc(r.type)+'</span>'+content+
      '<span class="racts">'+
        '<button class="ract'+(r.pinned?" on":"")+'" data-pin="'+esc(r.id)+'" data-pinned="'+(r.pinned?"1":"0")+'" title="'+(r.pinned?"unpin":"pin")+'">'+(r.pinned?"★":"☆")+'</button>'+
        '<button class="ract" data-edit="'+esc(r.id)+'" title="edit">✎</button>'+
        '<button class="ract del" data-del="'+esc(r.id)+'" title="delete">✕</button>'+
      '</span></div>'+
      '<div class="recmeta"><span class="g">imp <b>'+pct(r.score.importance)+'</b><i class="bar"><i style="width:'+pct(r.score.importance)+'%"></i></i></span><span class="g">conf <b>'+pct(r.score.confidence)+'</b><i class="bar"><i class="b2" style="width:'+pct(r.score.confidence)+'%"></i></i></span>'+scopeBadge(r.scope)+
      (r.entities&&r.entities.length?r.entities.slice(0,6).map(function(e){return '<span class="ent mono">'+esc(e)+'</span>';}).join(""):"")+'</div>'+(why?'<div class="why">'+esc(clip(why,130))+'</div>':"")+'</div>';
  }
  function wireRecordActions(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-pin]"),function(b){ b.addEventListener("click",function(){ mutate("/memory/update",{projectPath:ui.project,id:b.getAttribute("data-pin"),pinned:b.getAttribute("data-pinned")!=="1"}); }); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-del]"),function(b){ b.addEventListener("click",function(){ if(confirm("Delete this belief permanently?")) mutate("/memory/delete",{projectPath:ui.project,id:b.getAttribute("data-del")}); }); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-edit]"),function(b){ b.addEventListener("click",function(){ ui.editing=b.getAttribute("data-edit"); renderMemoryPage(); var inp=EL("edit-"+ui.editing); if(inp){ inp.focus(); inp.select(); } }); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-canceledit]"),function(b){ b.addEventListener("click",function(){ ui.editing=null; renderMemoryPage(); }); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-save]"),function(b){ b.addEventListener("click",function(){ var id=b.getAttribute("data-save"); var inp=EL("edit-"+id); var v=inp?inp.value.trim():""; if(v){ ui.editing=null; mutate("/memory/update",{projectPath:ui.project,id:id,content:v}); } }); });
    Array.prototype.forEach.call(document.querySelectorAll(".editin"),function(inp){ inp.addEventListener("keydown",function(e){ if(e.key==="Enter"){ var id=inp.id.replace("edit-",""); var v=inp.value.trim(); if(v){ ui.editing=null; mutate("/memory/update",{projectPath:ui.project,id:id,content:v}); } } if(e.key==="Escape"){ ui.editing=null; renderMemoryPage(); } }); });
  }
  async function mutate(path,body){
    if(busy) return; busy=true;
    try{ await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); }catch(e){}
    busy=false; ui.search=null; var cl=EL("clear"); if(cl) cl.hidden=true; var q=EL("q"); if(q) q.value="";
    await refresh(); if(currentRoute()==="overview") loadOverview(true);
  }
  async function runSearch(){ var q=EL("q").value.trim(); if(!q||!ui.project) return; EL("go").disabled=true;
    try{ var res=await fetch("/search?projectPath="+encodeURIComponent(ui.project)+"&query="+encodeURIComponent(q),{cache:"no-store"}).then(function(r){return r.json();}); ui.search=res.records||[]; EL("clear").hidden=false; }catch(e){ ui.search=[]; }
    EL("go").disabled=false; renderMemoryPage(); }
  async function processNow(){ if(!ui.project) return; var b=EL("process"); b.disabled=true; b.textContent="Processing…";
    try{ await fetch("/process",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectPath:ui.project,reason:"monitor-manual"})}); }catch(e){} b.disabled=false; b.textContent="Process now"; refresh(); }

  // ===== NETWORK =====
  async function loadNetwork(force){
    if(!force && (freshNow()-netLoadedAt)<HEAVY_TTL) return; // throttle the heavy endpoint
    netLoadedAt=freshNow();
    try{ network=await fetch("/network",{cache:"no-store"}).then(function(r){return r.json();}); renderProjectsGrid(); }catch(e){}
  }

  // ===== OPS (tokens + activity) =====
  function renderOpsPage(){
    /* health strip: serve latency/cost (24h telemetry) + STL daily self-check verdict */
    var h=(latest&&latest.health)||{};
    var sv=h.serve;
    EL("hl-lat").textContent = sv ? (sv.avgMs/1000).toFixed(1)+"s / "+(sv.p95Ms/1000).toFixed(1)+"s" : "–";
    EL("hl-count").textContent = sv ? fmt(sv.count) : "–";
    EL("hl-tok").textContent = sv ? fmt(sv.avgTokens) : "–";
    EL("hl-stl").textContent = h.stl ? "Daily self-check ("+(h.stl.generatedAt||"").slice(0,10)+"): "+h.stl.headline : "Daily self-check: no report yet.";
    var t=(latest&&latest.tokens)||{total:0,runs:0,byModel:{},byProject:{},recent:[]};
    EL("tok-total").textContent=fmt(t.total);
    EL("tok-runs").textContent=fmt(t.runs);
    EL("tok-avg").textContent=t.runs?fmt(Math.round(t.total/t.runs)):"0";
    EL("tok-cost").textContent="≈ $"+(t.total/1000000*0.10).toFixed(4);
    var byp=Object.keys(t.byProject||{}).map(function(p){return [p,t.byProject[p]];}).filter(function(x){return x[1]>0;}).sort(function(a,b){return b[1]-a[1];}).slice(0,8);
    var pmax=byp.reduce(function(a,p){return Math.max(a,p[1]);},1);
    EL("tok-projects").innerHTML=byp.length?byp.map(function(p){ var on=p[0]===ui.project; return '<div class="trow"><div class="tlabel'+(on?" cur":"")+'">'+esc(name(p[0]))+'</div><div class="tbar"><i class="g" style="width:'+(p[1]/pmax*100)+'%"></i></div><div class="tval">'+fmt(p[1])+'</div></div>'; }).join(""):'<div class="empty">No runs yet</div>';
    EL("tok-recent").innerHTML=(t.recent||[]).length?t.recent.slice(0,14).map(function(r){
      var bits=[]; if(r.superseded) bits.push(r.superseded+" changed"); if(r.merged) bits.push(r.merged+" merged"); if(r.recordsAdded) bits.push(r.recordsAdded+" learned");
      return '<div class="row"><div class="rmain"><span class="rt">'+esc(name(r.projectPath))+'</span><span class="rs">'+esc(tm(r.createdAt))+'</span></div><div class="rsub mono">'+fmt(r.tokens)+' tok · '+esc(r.model)+(bits.length?' · '+bits.join(", "):"")+'</div></div>';
    }).join(""):'<div class="empty">No consolidations recorded yet</div>';
    var s=latest||{}; var sess=s.activeSessions||[], jobs=s.processingJobs||[], logs=s.recentLogs||[];
    EL("sessions").innerHTML=sess.length?sess.slice(0,10).map(function(x){ return '<div class="row"><div class="rmain"><span class="rt">'+esc(x.client)+'</span><span class="rs">'+esc(tm(x.startedAt))+'</span></div><div class="rsub mono">'+esc(name(x.projectPath))+'</div></div>'; }).join(""):'<div class="empty">No active sessions</div>';
    EL("jobs").innerHTML=jobs.length?jobs.slice(0,10).map(function(j){ var st=j.stats; var line=st?((st.superseded||0)+" superseded · "+(st.merged||0)+" merged · "+(st.recordsAdded||0)+" added"):"";
      return '<div class="row"><div class="rmain"><span class="rt"><span class="sd '+esc(j.status)+'"></span>'+esc(j.status)+'</span><span class="rs">'+esc(tm(j.createdAt))+'</span></div><div class="rsub">'+esc(j.model||"no model")+' · '+esc(j.estimatedTokens||0)+' tok</div>'+(line?'<div class="rsub strong">'+esc(line)+'</div>':'')+(j.error?'<div class="rsub err">'+esc(clip(j.error,70))+'</div>':'')+'</div>'; }).join(""):'<div class="empty">No processing yet</div>';
    EL("logs").innerHTML=logs.length?logs.slice(0,14).map(function(l){ return '<div class="row tight"><div class="rmain"><span class="rt">'+esc(l.type)+'</span><span class="rs">'+esc(tm(l.createdAt))+'</span></div>'+(l.path?'<div class="rsub mono">'+esc(l.method||"")+' '+esc(l.path)+' '+esc(l.status||"")+'</div>':'')+(l.error?'<div class="rsub err">'+esc(clip(l.error,80))+'</div>':'')+'</div>'; }).join(""):'<div class="empty">No logs</div>';
  }

  // wire-up
  window.addEventListener("hashchange",function(){ renderRoute(true); });
  EL("switcher").addEventListener("change",function(e){ ui.project=e.target.value; ui.search=null; ui.focus=null; ui.editing=null; overview=null; renderRoute(true); });
  EL("go").addEventListener("click",runSearch);
  EL("clear").addEventListener("click",function(){ ui.search=null; EL("q").value=""; EL("clear").hidden=true; renderMemoryPage(); });
  EL("q").addEventListener("keydown",function(e){ if(e.key==="Enter") runSearch(); });
  EL("process").addEventListener("click",processNow);
  if(!location.hash) location.hash="#/brain";
  refresh(); setInterval(refresh,2500);
  pollActivity(); setInterval(pollActivity,4000); // live brain popups
`;
const DOCUMENT = String.raw `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PEON // NEURAL HUD</title>
<style>
  :root{
    --bg:#020710; --bg2:#041020; --panel:rgba(7,22,38,.66); --panel2:rgba(5,16,30,.66);
    --line:rgba(89,227,255,.16); --line2:rgba(89,227,255,.36);
    --ink:#d9f6ff; --muted:#7fa9c0; --faint:#48708a;
    --cyan:#59e3ff; --cyan-soft:rgba(89,227,255,.12); --cyan-ink:#b9f2ff;
    --green:#5dffb0; --green-soft:rgba(93,255,176,.12); --green-ink:#b9ffdd;
    --blue:#7db4ff; --blue-soft:rgba(125,180,255,.14); --violet:#9db4ff;
    --amber:#ffc957; --amber-soft:rgba(255,201,87,.13); --red:#ff7a70;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; --r:4px;
    --cham:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);
  }
  *{box-sizing:border-box;}
  html{scrollbar-color:#12374d var(--bg);}
  body{margin:0; color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
    font-size:13.5px; line-height:1.55; letter-spacing:.01em; -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1100px 700px at 50% -220px, rgba(43,168,201,.16) 0%, transparent 60%),
      radial-gradient(900px 500px at 110% 110%, rgba(43,120,201,.10) 0%, transparent 55%),
      linear-gradient(rgba(89,227,255,.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(89,227,255,.028) 1px, transparent 1px),
      var(--bg);
    background-size:auto,auto,44px 44px,44px 44px,auto;}
  /* CRT scanlines + roaming scan bar + vignette */
  body::before{content:""; position:fixed; inset:0; z-index:99; pointer-events:none;
    background:repeating-linear-gradient(0deg, rgba(200,240,255,.022) 0 1px, transparent 1px 3px);}
  body::after{content:""; position:fixed; left:0; right:0; top:-15%; height:26vh; z-index:98; pointer-events:none;
    background:linear-gradient(180deg, transparent, rgba(89,227,255,.045) 55%, rgba(89,227,255,.09) 60%, transparent);
    animation:scanroam 9s linear infinite;}
  @keyframes scanroam{0%{transform:translateY(-30vh);} 100%{transform:translateY(160vh);}}
  h1,h2,h3,p{margin:0;}
  .mono{font-family:var(--mono); font-size:11px; letter-spacing:.02em;}
  button,select,input{font:inherit; cursor:pointer; color:inherit;}
  :focus-visible{outline:1.5px solid var(--cyan); outline-offset:2px;}
  [title]{cursor:help;}
  ::selection{background:rgba(89,227,255,.3);}

  /* ── HUD top bar ── */
  header{position:sticky; top:0; z-index:40; display:flex; align-items:center; gap:18px;
    padding:10px 22px; background:linear-gradient(180deg, rgba(4,14,26,.94), rgba(3,10,20,.86));
    backdrop-filter:saturate(1.3) blur(14px); border-bottom:1px solid var(--line);
    box-shadow:0 1px 0 rgba(89,227,255,.06), 0 12px 40px -18px rgba(43,168,201,.35);}
  header::after{content:""; position:absolute; left:0; right:0; bottom:-1px; height:1px;
    background:linear-gradient(90deg, transparent, var(--cyan) 30%, transparent 60%); opacity:.5; animation:hdrsweep 7s linear infinite;}
  @keyframes hdrsweep{0%{transform:translateX(-40%);} 100%{transform:translateX(60%);}}
  .brand{display:flex; align-items:center; gap:11px; flex:none;}
  .logo{position:relative; width:34px; height:34px; border-radius:50%; flex:none;
    background:radial-gradient(circle at 50% 45%, #eaffff 0%, #9ef0ff 30%, #1f7e9c 68%, #06202e 100%);
    display:grid; place-items:center; color:#03202c; font-weight:900; font-size:13px;
    box-shadow:0 0 22px -2px rgba(89,227,255,.8), inset 0 0 8px rgba(255,255,255,.5);}
  .logo::before{content:""; position:absolute; inset:-5px; border-radius:50%;
    border:1px dashed rgba(89,227,255,.65); animation:spin 14s linear infinite;}
  .logo::after{content:""; position:absolute; inset:-10px; border-radius:50%;
    border:1px solid rgba(89,227,255,.22); border-top-color:rgba(89,227,255,.8); animation:spin 4s linear infinite reverse;}
  .brand h1{font-size:14px; font-weight:760; letter-spacing:.34em; text-transform:uppercase; color:var(--cyan-ink);
    text-shadow:0 0 14px rgba(89,227,255,.55);}
  nav{display:flex; gap:6px; flex:1; flex-wrap:wrap;}
  nav a{padding:6px 15px; clip-path:var(--cham); font-size:11px; font-weight:700; letter-spacing:.18em; text-transform:uppercase;
    color:var(--muted); text-decoration:none; background:rgba(89,227,255,.04); border:1px solid transparent; transition:all .18s;}
  nav a:hover{background:rgba(89,227,255,.1); color:var(--cyan-ink);}
  nav a.on{background:linear-gradient(180deg, rgba(89,227,255,.22), rgba(89,227,255,.08)); color:#eaffff;
    box-shadow:0 0 18px -4px rgba(89,227,255,.7), inset 0 0 12px rgba(89,227,255,.12); text-shadow:0 0 10px rgba(89,227,255,.8);}
  .switcher{background:rgba(5,18,32,.9); border:1px solid var(--line2); color:var(--cyan-ink); clip-path:var(--cham);
    padding:7px 12px; max-width:230px; font-size:12px; font-family:var(--mono);}
  .live{display:flex; align-items:center; gap:8px; font-size:10.5px; color:var(--muted); flex:none;
    font-family:var(--mono); text-transform:uppercase; letter-spacing:.14em;}
  .dot{width:8px; height:8px; border-radius:50%; background:var(--cyan); box-shadow:0 0 12px var(--cyan); animation:beat 2s infinite;}
  .dot.off{background:var(--red); box-shadow:0 0 12px var(--red); animation:none;}
  @keyframes beat{0%,100%{opacity:1;} 50%{opacity:.35;}}
  @keyframes spin{to{transform:rotate(360deg);}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important; transition:none!important;}}

  .wrap{max-width:1200px; margin:0 auto; padding:24px 24px 80px;}

  /* boot reveal */
  .wrap > section > *{animation:boot .5s cubic-bezier(.2,.8,.3,1) both;}
  .wrap > section > *:nth-child(2){animation-delay:.07s;} .wrap > section > *:nth-child(3){animation-delay:.14s;}
  .wrap > section > *:nth-child(4){animation-delay:.21s;} .wrap > section > *:nth-child(5){animation-delay:.28s;}
  @keyframes boot{from{opacity:0; transform:translateY(10px);} to{opacity:1; transform:none;}}

  /* ── holo panels: chamfer + corner brackets ── */
  .panel,.card,.bignum,.pcard,.netnode{position:relative;
    background:linear-gradient(165deg, var(--panel), var(--panel2));
    border:1px solid var(--line); clip-path:var(--cham);}
  .panel{padding:16px 18px; margin-bottom:16px; backdrop-filter:blur(6px);}
  .panel::before,.card::before,.bignum::before,.pcard::before{content:""; position:absolute; top:0; left:0; width:14px; height:14px;
    border-top:1.5px solid var(--line2); border-left:1.5px solid var(--line2); pointer-events:none;}
  .panel::after,.card::after,.bignum::after,.pcard::after{content:""; position:absolute; bottom:0; right:0; width:14px; height:14px;
    border-bottom:1.5px solid var(--line2); border-right:1.5px solid var(--line2); pointer-events:none;}
  .phead{margin-bottom:12px;}
  .phead .ht{display:flex; align-items:baseline; justify-content:space-between; gap:10px;}
  .phead h2{font-size:10.5px; font-weight:760; text-transform:uppercase; letter-spacing:.22em; color:var(--cyan-ink);
    text-shadow:0 0 12px rgba(89,227,255,.35);}
  .phead h2::before{content:"◢ "; color:var(--cyan); font-size:8px; vertical-align:2px;}
  .phead .cap{font-size:11px; color:var(--faint); margin-top:4px;}
  .phead .note{font-size:11px; color:var(--faint); font-family:var(--mono);}
  .empty{color:var(--faint); font-size:12.5px; padding:12px 0; font-family:var(--mono);}
  .pagehead{font-size:19px; font-weight:740; letter-spacing:.12em; text-transform:uppercase; margin-bottom:4px; color:#eaffff;
    text-shadow:0 0 18px rgba(89,227,255,.4);}
  .pagesub{color:var(--muted); font-size:12.5px; margin-bottom:18px;}

  /* hero + cards */
  .hero{display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; flex-wrap:wrap;}
  .hero-l{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
  .hero-name{font-size:20px; font-weight:740; letter-spacing:.06em; color:#eaffff; text-shadow:0 0 16px rgba(89,227,255,.45);}
  .health{font-size:10px; font-weight:760; letter-spacing:.14em; text-transform:uppercase; padding:3px 12px; clip-path:var(--cham);}
  .health.ok{background:var(--green-soft); color:var(--green-ink); box-shadow:0 0 14px -4px rgba(93,255,176,.6);}
  .health.warn{background:var(--amber-soft); color:var(--amber); box-shadow:0 0 14px -4px rgba(255,201,87,.6);}
  .hero-r{font-size:11px; color:var(--faint); font-family:var(--mono);}
  .vital{display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--muted); font-family:var(--mono);}
  .pulse-dot{width:8px; height:8px; border-radius:50%; background:var(--cyan); box-shadow:0 0 10px var(--cyan); animation:beat 1.8s infinite; display:inline-block;}
  .pulse-dot.off{background:var(--faint); box-shadow:none; animation:none;}
  .cards{display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:16px;}
  .card{padding:16px 18px;}
  .cardnum{font-size:30px; font-weight:800; letter-spacing:.01em; font-variant-numeric:tabular-nums; font-family:var(--mono);
    color:#eaffff; text-shadow:0 0 16px rgba(89,227,255,.5);}
  .cardnum.g{color:var(--cyan); text-shadow:0 0 18px rgba(89,227,255,.8);}
  .cardnum.a{color:var(--amber); text-shadow:0 0 16px rgba(255,201,87,.6);}
  .cardnum.muted{color:var(--faint); text-shadow:none;}
  .cardlbl{font-size:9.5px; color:var(--cyan-ink); opacity:.75; text-transform:uppercase; letter-spacing:.2em; margin-top:7px;}
  .cardsub{font-size:11px; color:var(--muted); margin-top:4px;}

  .didrow{display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px dashed rgba(89,227,255,.1);}
  .didrow:last-child{border-bottom:0;}
  .didkind{flex:none; font-size:9px; font-weight:760; text-transform:uppercase; letter-spacing:.1em; padding:2px 9px; clip-path:var(--cham); background:rgba(89,227,255,.08); color:var(--muted);}
  .didkind.k-resolve_conflict{background:rgba(255,122,112,.14); color:#ffb0a8;}
  .didkind.k-merge_duplicate{background:var(--blue-soft); color:#b3d2ff;}
  .didkind.k-compress_cluster{background:rgba(157,180,255,.14); color:#c8d6ff;}
  .didkind.k-reinforce{background:var(--cyan-soft); color:var(--cyan-ink);}
  .didtxt{flex:1; font-size:12.5px;}
  .didtime{flex:none; font-size:10.5px; color:var(--faint); font-family:var(--mono);}
  .injrow{display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px dashed rgba(89,227,255,.1);}
  .injrow:last-child{border-bottom:0;}
  .injc{flex:1; font-size:12.5px;}
  .injs{font-size:10.5px; color:var(--cyan); font-family:var(--mono); flex:none; text-shadow:0 0 8px rgba(89,227,255,.6);}
  .sb{font-size:9px; font-weight:760; text-transform:uppercase; letter-spacing:.1em; padding:2px 8px; clip-path:var(--cham); flex:none;}
  .sb-global{background:var(--blue-soft); color:#b3d2ff;} .sb-project{background:rgba(89,227,255,.07); color:var(--muted);}
  .review{border-color:rgba(255,201,87,.4);}
  .revrow{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0; border-bottom:1px dashed rgba(89,227,255,.1);}
  .revrow:last-child{border-bottom:0;}
  .revtxt{font-size:12.5px;} .revtxt b{color:var(--ink); font-weight:640;}
  .revacts{flex:none; display:flex; gap:6px;}

  /* buttons / inputs */
  .btn{padding:8px 16px; clip-path:var(--cham); background:linear-gradient(180deg, rgba(89,227,255,.9), rgba(43,168,201,.9));
    color:#03202c; font-weight:760; font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; border:0; transition:all .15s;
    box-shadow:0 0 18px -6px rgba(89,227,255,.8);}
  .btn:hover{filter:brightness(1.12);} .btn:disabled{opacity:.45; cursor:not-allowed;}
  .btn.ghost{background:rgba(89,227,255,.06); color:var(--cyan-ink); border:1px solid var(--line2); box-shadow:none;}
  .btn.ghost:hover{background:rgba(89,227,255,.13);}
  .btn.sm{padding:4px 11px; font-size:10px;}
  .toolbar{display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap;}
  .field{flex:1; min-width:170px; display:flex; gap:8px;}
  .field input{flex:1; padding:8px 13px; border:1px solid var(--line2); clip-path:var(--cham); background:rgba(4,14,26,.85);
    font-family:var(--mono); font-size:12px; color:var(--cyan-ink);}
  .field input:focus{border-color:var(--cyan); outline:none; box-shadow:0 0 16px -6px rgba(89,227,255,.8);}
  .field input::placeholder{color:var(--faint);}
  .chips{display:flex; gap:7px; flex-wrap:wrap; margin-bottom:12px;}
  .chip{display:inline-flex; align-items:center; padding:4px 12px; clip-path:var(--cham); border:1px solid var(--line);
    background:rgba(4,14,26,.7); color:var(--muted); font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; transition:all .15s;}
  .chip:hover{background:rgba(89,227,255,.09);}
  .chip.on{background:linear-gradient(180deg, rgba(89,227,255,.85), rgba(43,168,201,.85)); border-color:var(--cyan); color:#03202c;}
  .chip .cc{margin-left:7px; color:var(--faint); font-family:var(--mono);} .chip.on .cc{color:rgba(3,32,44,.7);}

  /* records */
  .scroll{max-height:600px; overflow:auto;}
  .scroll::-webkit-scrollbar{width:7px;} .scroll::-webkit-scrollbar-thumb{background:#12374d; border-radius:4px;}
  .rec{padding:10px 4px; border-bottom:1px dashed rgba(89,227,255,.1);} .rec:last-child{border-bottom:0;}
  .rec.hl{background:var(--cyan-soft);}
  .rec.pinned{background:rgba(89,227,255,.05); border-left:2px solid var(--cyan); padding-left:8px;}
  .recline{display:flex; align-items:center;}
  .sd{display:inline-block; width:7px; height:7px; border-radius:50%; flex:none; margin-right:8px;}
  .sd.active{background:var(--green); box-shadow:0 0 8px rgba(93,255,176,.8);}
  .sd.superseded{background:var(--violet);} .sd.stale{background:var(--amber);} .sd.conflicted{background:var(--red); box-shadow:0 0 8px rgba(255,122,112,.7);}
  .sd.archived{background:var(--faint);}
  .sd.processed{background:var(--green);} .sd.skipped{background:var(--amber);} .sd.failed{background:var(--red);}
  .rtype{font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--cyan); font-weight:760; flex:none; margin-right:10px; min-width:76px; text-shadow:0 0 8px rgba(89,227,255,.4);}
  .rcontent{font-size:13px; flex:1;}
  .rec.superseded .rcontent,.rec.stale .rcontent{color:var(--muted); text-decoration:line-through; text-decoration-color:rgba(157,180,255,.5);}
  .editin{flex:1; padding:6px 10px; border:1px solid var(--cyan); background:rgba(4,14,26,.9); color:var(--ink); margin-right:8px; font-family:var(--mono); font-size:12px;}
  .racts{flex:none; display:flex; gap:3px; margin-left:8px; opacity:0; transition:opacity .12s;}
  .rec:hover .racts{opacity:1;}
  .ract{width:25px; height:25px; background:transparent; border:1px solid transparent; color:var(--muted); font-size:12px; display:grid; place-items:center; padding:0;}
  .ract:hover{background:rgba(89,227,255,.1); border-color:var(--line2); color:var(--cyan-ink);}
  .ract.on{color:var(--cyan);} .ract.del:hover{color:var(--red); border-color:var(--red);}
  .recmeta{display:flex; align-items:center; gap:11px; margin-top:7px; padding-left:86px; flex-wrap:wrap;}
  .g{display:inline-flex; align-items:center; gap:6px; font-size:9.5px; color:var(--faint); text-transform:uppercase; letter-spacing:.08em; font-family:var(--mono);} .g b{color:var(--muted); font-weight:700;}
  .bar{display:inline-block; width:44px; height:3px; background:rgba(89,227,255,.1); overflow:hidden;}
  .bar i{display:block; height:100%; background:linear-gradient(90deg, #2ba8c9, var(--cyan)); box-shadow:0 0 6px rgba(89,227,255,.8);}
  .bar i.b2{background:linear-gradient(90deg, #4a72c4, var(--blue));}
  .ent{padding:1.5px 8px; clip-path:var(--cham); background:rgba(89,227,255,.06); border:1px solid var(--line); color:var(--muted);}
  .pcg{color:var(--cyan); font-weight:760; text-shadow:0 0 8px rgba(89,227,255,.5);}
  .why{margin-top:7px; margin-left:86px; font-size:11px; color:var(--cyan-ink); background:var(--cyan-soft); clip-path:var(--cham); padding:6px 11px; font-family:var(--mono);}
  pre.inject{margin:0; font-family:var(--mono); font-size:10.5px; line-height:1.55; color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; max-height:300px; overflow:auto; background:rgba(3,10,20,.8); border:1px solid var(--line); padding:12px;}

  .cols{display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:18px; align-items:start;}
  .cols .panel{margin-bottom:0;}
  .col{display:flex; flex-direction:column; gap:16px;}

  .netgrid{display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px;}
  .pcard{text-align:left; padding:15px 16px; transition:all .16s;}
  .pcard:hover{border-color:var(--cyan); box-shadow:0 0 26px -8px rgba(89,227,255,.6); transform:translateY(-2px);}
  .pcard .pcname{font-weight:700; font-size:14px; margin-bottom:6px; letter-spacing:.03em; color:#eaffff;}
  .pcdis{font-weight:400; font-size:11px; color:var(--faint);}
  .pcard .pcstats{font-size:11.5px; color:var(--muted); font-family:var(--mono);}
  .pcgo{font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--cyan); margin-top:10px; opacity:0; transition:opacity .15s; text-shadow:0 0 8px rgba(89,227,255,.6);}
  .pcard:hover .pcgo{opacity:1;}

  /* ops */
  .bignums{display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:16px;}
  .bignum{padding:15px 17px;}
  .bignum .n{font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; font-family:var(--mono); color:#eaffff; text-shadow:0 0 14px rgba(89,227,255,.45);}
  .bignum.accent .n{color:var(--cyan); text-shadow:0 0 18px rgba(89,227,255,.8);}
  .bignum .l{font-size:9px; color:var(--cyan-ink); opacity:.7; text-transform:uppercase; letter-spacing:.18em; margin-top:6px;}
  .trow{display:grid; grid-template-columns:150px 1fr 110px; gap:12px; align-items:center; padding:8px 0; border-bottom:1px dashed rgba(89,227,255,.1);}
  .trow:last-child{border-bottom:0;}
  .tlabel{font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;} .tlabel.cur{color:var(--cyan); font-weight:700;}
  .tbar{height:6px; background:rgba(89,227,255,.08); overflow:hidden;}
  .tbar i{display:block; height:100%; background:linear-gradient(90deg,#2b78c9,var(--blue));}
  .tbar i.g{background:linear-gradient(90deg,#2ba8c9,var(--cyan)); box-shadow:0 0 10px rgba(89,227,255,.7);}
  .tval{font-size:11px; color:var(--muted); text-align:right; font-family:var(--mono);}
  .row{padding:8px 0; border-bottom:1px dashed rgba(89,227,255,.1);} .row:last-child{border-bottom:0;} .row.tight{padding:6px 0;}
  .rmain{display:flex; align-items:baseline; justify-content:space-between; gap:8px;}
  .rt{font-size:12px; font-weight:620; display:inline-flex; align-items:center; gap:6px;}
  .rs{font-size:10px; color:var(--faint); font-family:var(--mono); flex:none;}
  .rsub{font-size:11px; color:var(--muted); margin-top:2px; overflow-wrap:anywhere;} .rsub.err{color:var(--red);} .rsub.strong{color:var(--cyan-ink);}
  .abnote{font-size:11.5px; color:var(--muted); margin-bottom:16px; font-family:var(--mono);} .abnote a{color:var(--cyan-ink);}
  .backlink{color:var(--muted); text-decoration:none; font-size:13px; font-weight:500; margin-right:6px;} .backlink:hover{color:var(--cyan-ink);}

  /* ── reactor core ── */
  .bhwrap{display:grid; grid-template-columns:360px minmax(0,1fr); gap:22px; align-items:center; margin-bottom:18px;}
  .bhviz{position:relative; display:flex; flex-direction:column; align-items:center; gap:8px;}
  .bhpulse{display:inline-flex; align-items:center; gap:7px; font-size:10px; color:var(--muted); font-family:var(--mono); letter-spacing:.16em; text-transform:uppercase;}
  .brainviz{width:320px; height:320px; filter:drop-shadow(0 0 34px rgba(89,227,255,.3));}
  .brainviz .btick{stroke:rgba(89,227,255,.25); stroke-width:1;}
  .brainviz .btick.maj{stroke:rgba(89,227,255,.55); stroke-width:1.4;}
  .brainviz .bring{fill:none; stroke:rgba(89,227,255,.4); stroke-width:1.1; transform-origin:150px 150px;}
  .brainviz .bring.rA{stroke-dasharray:60 22 8 22; animation:spin 26s linear infinite;}
  .brainviz .bring.rB{stroke-dasharray:34 14; stroke:rgba(89,227,255,.28); animation:spin 38s linear infinite reverse;}
  .brainviz .bring.rC{stroke-dasharray:10 7; stroke:rgba(89,227,255,.5); stroke-width:1.6; animation:spin 17s linear infinite;}
  .brainviz .bsweep{transform-origin:150px 150px; animation:spin 6s linear infinite; opacity:.8;}
  .brainviz .bsegs{transform-origin:150px 150px; animation:spin 48s linear infinite reverse;}
  .brainviz .bseg{fill:rgba(89,227,255,.5);}
  .brainviz .bcore-halo{fill:rgba(89,227,255,.14); animation:halo2 3.2s ease-in-out infinite;}
  .brainviz .bcore{filter:drop-shadow(0 0 16px rgba(89,227,255,.95));}
  .brainviz .bcore-rim{fill:none; stroke:rgba(200,245,255,.7); stroke-width:1.2; stroke-dasharray:4 9;
    transform-origin:150px 150px; animation:spin 9s linear infinite reverse;}
  .brainviz .bcore-spark{fill:none; stroke:#eaffff; stroke-width:1.5; opacity:0; transform-origin:150px 150px;}
  .brainviz .bcore-label{font-family:var(--mono); font-size:8.5px; font-weight:700; letter-spacing:.3em; fill:rgba(185,242,255,.85);}
  .brainviz .orbit{transform-origin:150px 150px; animation:spin linear infinite;}
  .brainviz .bnode{fill:var(--cyan); filter:drop-shadow(0 0 5px rgba(89,227,255,.9));}
  .brainviz .bnode.r1{fill:#eaffff;} .brainviz .bnode.r2{fill:#7db4ff; filter:drop-shadow(0 0 5px rgba(125,180,255,.9));} .brainviz .bnode.r3{fill:#9db4ff; filter:drop-shadow(0 0 5px rgba(157,180,255,.9));}
  .brainviz.flash .bcore-halo{fill:rgba(234,255,255,.4);}
  .brainviz.flash .bcore-spark{opacity:1; animation:spark .9s ease-out;}
  @keyframes halo2{0%,100%{opacity:.6;} 50%{opacity:.15;}}
  @keyframes spark{0%{stroke-width:1.5; opacity:.95; r:30;} 100%{stroke-width:0; opacity:0; r:110;}}
  .cards3{display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;}
  .bhtypes{display:flex; flex-wrap:wrap; gap:8px;}
  .tchip{font-size:10px; letter-spacing:.1em; text-transform:uppercase; padding:3px 11px; clip-path:var(--cham); background:rgba(89,227,255,.06); border:1px solid var(--line); color:var(--muted);}
  .tchip b{color:var(--cyan-ink); margin-left:4px; font-family:var(--mono);}

  /* ── neural universe ── */
  .uniwrap{position:relative; height:76vh; min-height:520px; margin-bottom:18px; border:1px solid var(--line);
    background:radial-gradient(900px 500px at 50% 40%, rgba(43,168,201,.08), transparent 70%), rgba(2,8,16,.6); clip-path:var(--cham); overflow:hidden;}
  .uniwrap::before{content:""; position:absolute; top:0; left:0; width:16px; height:16px; border-top:1.5px solid var(--line2); border-left:1.5px solid var(--line2); z-index:5; pointer-events:none;}
  .uniwrap::after{content:""; position:absolute; bottom:0; right:0; width:16px; height:16px; border-bottom:1.5px solid var(--line2); border-right:1.5px solid var(--line2); z-index:5; pointer-events:none;}
  #uni{position:absolute; inset:0; width:100%; height:100%; cursor:crosshair;}
  .uni-search{position:absolute; top:68px; left:50%; transform:translateX(-50%); z-index:6; display:flex; gap:8px; align-items:center; width:min(560px,72%);}
  .uni-search input{flex:1; padding:9px 16px; border:1px solid rgba(89,227,255,.5); clip-path:var(--cham); background:rgba(3,12,22,.88);
    font-family:var(--mono); font-size:12px; color:var(--cyan-ink); backdrop-filter:blur(8px);}
  .uni-search input:focus{border-color:var(--cyan); outline:none; box-shadow:0 0 22px -6px rgba(89,227,255,.9);}
  .uni-search input::placeholder{color:var(--faint);}
  #uq-hits{color:var(--cyan); font-size:10px; letter-spacing:.12em; text-shadow:0 0 8px rgba(89,227,255,.6); min-width:80px;}
  .uni-hud{position:absolute; z-index:6; font-family:var(--mono); font-size:10px; letter-spacing:.12em; color:var(--muted);
    background:rgba(3,12,22,.72); border:1px solid var(--line); padding:7px 12px; clip-path:var(--cham); backdrop-filter:blur(6px);}
  .uni-hud b{color:var(--cyan-ink); font-weight:700;} .uni-hud b.warn{color:var(--amber);}
  .uni-hud.tl{top:14px; left:14px; max-width:58%;} .uni-hud.tr{top:14px; right:14px;}
  .stl-dot{display:inline-block; width:8px; height:8px; border-radius:50%; margin-left:6px; vertical-align:-1px; box-shadow:0 0 8px currentColor;}
  .uni-legend{position:absolute; left:14px; bottom:76px; z-index:6; display:flex; flex-wrap:wrap; gap:9px; max-width:70%;}
  .ul{display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);}
  .ul i{width:7px; height:7px; border-radius:50%; display:inline-block; box-shadow:0 0 6px rgba(89,227,255,.4);}
  .ul.dim i{background:#48708a; opacity:.4;}
  .uni-tip{position:absolute; z-index:7; max-width:320px; pointer-events:none; background:rgba(3,12,22,.92); border:1px solid var(--line2);
    padding:8px 11px; font-size:10.5px; line-height:1.5; color:var(--ink); clip-path:var(--cham);}
  .uni-tip .tt-type{text-transform:uppercase; letter-spacing:.12em; font-weight:700; margin-right:6px;}
  .uni-inspect{position:absolute; top:60px; left:14px; z-index:8; width:330px; max-height:calc(100% - 130px); overflow:auto;
    background:linear-gradient(165deg, rgba(8,26,42,.96), rgba(4,14,26,.96)); border:1px solid var(--cyan); clip-path:var(--cham);
    padding:16px; box-shadow:0 0 34px -8px rgba(89,227,255,.5);}
  .ui-x{position:absolute; top:8px; right:10px; background:none; border:0; color:var(--muted); font-size:13px;}
  .ui-x:hover{color:var(--cyan-ink);}
  .ui-type{font-family:var(--mono); font-size:10px; letter-spacing:.18em; text-transform:uppercase; margin-bottom:9px; text-shadow:0 0 10px currentColor;}
  .ui-content{font-size:13px; line-height:1.55; margin-bottom:11px;}
  .ui-meta{display:flex; gap:14px; margin-bottom:9px;}
  .ui-ents{display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px;}
  .ui-proj{color:var(--faint); font-size:10px; margin-bottom:11px;}
  .uni-ticker{position:absolute; left:0; right:0; bottom:0; z-index:6; padding:8px 16px 10px;
    background:linear-gradient(180deg, transparent, rgba(2,8,16,.9) 40%); font-family:var(--mono); font-size:10px; color:var(--muted);}
  .utk{padding:2px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .utk-k{color:var(--cyan); text-transform:uppercase; letter-spacing:.1em;}
  .utk-t{color:var(--faint);}

  /* toasts */
  .toasts{position:fixed; top:64px; right:20px; z-index:90; display:flex; flex-direction:column; gap:10px; pointer-events:none;}
  .toast{display:flex; gap:11px; align-items:flex-start; width:330px; background:linear-gradient(165deg, rgba(8,26,42,.96), rgba(4,14,26,.96));
    border:1px solid var(--cyan); clip-path:var(--cham); padding:12px 15px;
    box-shadow:0 14px 44px -10px rgba(0,0,0,.7), 0 0 24px -6px rgba(89,227,255,.6);
    transform:translateX(370px); opacity:0; transition:transform .4s cubic-bezier(.2,.9,.3,1.15), opacity .4s;}
  .toast.in{transform:translateX(0); opacity:1;}
  .toast .ti{font-size:17px; line-height:1.2; flex:none;}
  .toast .tt{font-size:11px; font-weight:760; letter-spacing:.1em; text-transform:uppercase; color:var(--cyan-ink);} .toast .tp{color:#eaffff;}
  .toast .td{font-size:11.5px; color:var(--muted); margin-top:3px; line-height:1.45;}

  @media (max-width:980px){ .cols{grid-template-columns:1fr;} .cards{grid-template-columns:1fr;} .bignums{grid-template-columns:repeat(2,1fr);} .trow{grid-template-columns:110px 1fr 90px;} .bhwrap{grid-template-columns:1fr;} }
</style>
</head>
<body>
<header>
  <div class="brand"><div class="logo">P</div><h1>Peon</h1></div>
  <nav>
    <a id="nav-brain" href="#/brain">Neural Core</a>
    <a id="nav-projects" href="#/projects">Sectors</a>
    <a id="nav-ops" href="#/ops">Systems</a>
  </nav>
  <select class="switcher" id="switcher" aria-label="Active project"></select>
  <div class="live"><span class="dot" id="dot"></span><span id="status">linking…</span></div>
</header>

<div class="toasts" id="toasts"></div>

<div class="wrap">
  <!-- NEURAL CORE — the living memory universe -->
  <section id="page-brain" hidden>
    <div class="uniwrap">
      <canvas id="uni"></canvas>
      <div class="uni-search"><input id="uq" placeholder="ask the memory field… (type to light up matching beliefs)" autocomplete="off"><span id="uq-hits" class="mono"></span><button class="btn ghost sm" id="uni-fit" title="reset view">⤢</button></div>
      <div class="uni-hud tl" id="uni-stats"></div>
      <div class="uni-hud tr" id="uni-health"></div>
      <div class="uni-legend" id="uni-legend"></div>
      <div class="uni-tip mono" id="uni-tip" hidden></div>
      <div class="uni-inspect" id="uni-inspect" hidden></div>
      <div class="uni-ticker" id="uni-ticker"></div>
    </div>
    <div id="bh-body"></div>
  </section>

  <!-- SECTORS (projects) -->
  <section id="page-projects" hidden>
    <div class="pagehead">Sectors</div>
    <div class="pagesub">Each project runs its own memory brain. Open one for insights, beliefs, and autonomous activity.</div>
    <div class="netgrid" id="projgrid"></div>
  </section>

  <!-- OVERVIEW -->
  <section id="page-overview" hidden>
    <div class="pagehead"><a href="#/projects" class="backlink">← Sectors</a> Insights <a href="#/memory" class="backlink" style="float:right;font-size:12px">all beliefs →</a></div>
    <div class="pagesub">What your AI knows here, what Peon injected last, and what needs attention.</div>
    <div id="ov-body"></div>
  </section>

  <!-- MEMORY -->
  <section id="page-memory" hidden>
    <div class="pagehead"><a href="#/overview" class="backlink">← Insights</a> Memory Banks <span class="mono" style="color:var(--faint);font-weight:400" id="memScope"></span></div>
    <div class="pagesub">Every belief in this sector's brain. Hover a belief to pin, edit, or delete.</div>
    <div class="cols">
      <div class="col">
        <section class="panel">
          <div class="phead"><div class="ht"><h2>Beliefs</h2><span class="note" id="memCount"></span></div></div>
          <div class="toolbar">
            <div class="field"><input id="q" placeholder="query the memory banks…" autocomplete="off"><button class="btn" id="go">Scan</button><button class="btn ghost" id="clear" hidden>Clear</button></div>
            <button class="btn ghost" id="process" title="Run consolidation now (uses the LLM)">Consolidate</button>
          </div>
          <div class="chips" id="filters"></div>
          <div class="scroll" id="records"><div class="empty">No sector selected</div></div>
        </section>
      </div>
      <div class="col">
        <section class="panel">
          <div class="phead"><div class="ht"><h2>Uplink Preview</h2></div><div class="cap">the exact context Peon hands your AI next prompt</div></div>
          <pre class="inject" id="inject">—</pre>
        </section>
      </div>
    </div>
  </section>

  <!-- SYSTEMS (ops) -->
  <section id="page-ops" hidden>
    <div class="pagehead">Systems</div>
    <div class="pagesub">Peon's own LLM cost, consolidation activity, and telemetry. (Your main AI's tokens live in its own usage view.)</div>
    <div class="abnote">Comparing Peon-on vs Peon-off token usage? See the <a href="/token-ab-monitor">token A/B monitor</a>.</div>
    <div class="bignums">
      <div class="bignum accent"><div class="n" id="tok-total">0</div><div class="l">Peon tokens (total)</div></div>
      <div class="bignum"><div class="n" id="tok-runs">0</div><div class="l">consolidation runs</div></div>
      <div class="bignum"><div class="n" id="tok-avg">0</div><div class="l">avg tokens / run</div></div>
      <div class="bignum"><div class="n" id="tok-cost">≈ $0</div><div class="l">est. cost (approx)</div></div>
    </div>
    <div class="bignums">
      <div class="bignum"><div class="n" id="hl-lat">–</div><div class="l">injection latency avg / p95 (24h)</div></div>
      <div class="bignum"><div class="n" id="hl-count">–</div><div class="l">injections served (24h)</div></div>
      <div class="bignum"><div class="n" id="hl-tok">–</div><div class="l">avg tokens / injection</div></div>
    </div>
    <div class="abnote" id="hl-stl">Daily self-check: no report yet.</div>
    <div class="cols">
      <div class="col">
        <section class="panel"><div class="phead"><div class="ht"><h2>Tokens by sector</h2></div></div><div id="tok-projects"></div></section>
        <section class="panel"><div class="phead"><div class="ht"><h2>Cost gate · processing</h2></div></div><div class="scroll" style="max-height:300px" id="jobs"></div></section>
      </div>
      <div class="col">
        <section class="panel"><div class="phead"><div class="ht"><h2>Recent consolidations</h2></div></div><div class="scroll" style="max-height:240px" id="tok-recent"></div></section>
        <section class="panel"><div class="phead"><div class="ht"><h2>Active uplinks</h2></div></div><div class="scroll" style="max-height:160px" id="sessions"></div></section>
        <section class="panel"><div class="phead"><div class="ht"><h2>System log</h2></div></div><div class="scroll" style="max-height:220px" id="logs"></div></section>
      </div>
    </div>
  </section>
</div>

<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
