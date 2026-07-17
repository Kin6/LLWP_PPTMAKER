import type { HtmlChartNode, HtmlDeckSpec, HtmlNode, HtmlTextNode } from "./types";

type BuildDocumentOptions = {
  runtimeOrigin: string;
  editMode: boolean;
  selectedNodeId?: string;
  inlineVendors?: {
    revealCss: string;
    revealJs: string;
    echartsJs: string;
  };
};

export function buildHtmlDeckDocument(deck: HtmlDeckSpec, options: BuildDocumentOptions) {
  const origin = safeOrigin(options.runtimeOrigin);
  const vendorHead = options.inlineVendors
    ? `<style>${escapeStyle(options.inlineVendors.revealCss)}</style>`
    : `<link rel="stylesheet" href="${origin}/api/html-runtime/reveal.css">`;
  const vendorScripts = options.inlineVendors
    ? `<script>${escapeScript(options.inlineVendors.revealJs)}</script><script>${escapeScript(options.inlineVendors.echartsJs)}</script>`
    : `<script src="${origin}/api/html-runtime/reveal.js"></script><script src="${origin}/api/html-runtime/echarts.js"></script>`;
  const scriptSources = options.inlineVendors ? "'unsafe-inline'" : `'unsafe-inline' ${origin}`;
  const styleSources = options.inlineVendors ? "'unsafe-inline'" : `'unsafe-inline' ${origin}`;
  const payload = JSON.stringify({
    deckId: deck.id,
    variables: Object.fromEntries(deck.variables.map((variable) => [variable.id, variable.value])),
    slides: deck.slides.map((slide) => ({ id: slide.id, interactions: slide.interactions })),
    editMode: options.editMode,
    selectedNodeId: options.selectedNodeId || "",
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSources}; style-src ${styleSources}; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(deck.title)}</title>
  ${vendorHead}
  <style>${runtimeCss(deck)}</style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
      ${deck.slides.map((slide, slideIndex) => `
        <section data-slide-id="${escapeAttribute(slide.id)}" data-index="${slideIndex}" data-transition="${escapeAttribute(slide.transition)}" style="background:${safeColor(slide.background, deck.theme.background)}">
          <div class="slide-stage">
            ${slide.nodes.filter((node) => !node.hidden).sort((left, right) => left.zIndex - right.zIndex).map((node) => renderNode(node, deck)).join("\n")}
            ${renderDrawings(deck, slide.id)}
          </div>
          <aside class="notes">${escapeHtml(slide.speakerNotes)}</aside>
        </section>`).join("\n")}
    </div>
  </div>
  ${vendorScripts}
  <script>window.__HTML_DECK__ = ${payload};</script>
  <script>${runtimeScript()}</script>
</body>
</html>`;
}

function renderNode(node: HtmlNode, deck: HtmlDeckSpec) {
  const base = [
    `left:${percent(node.x)}`,
    `top:${percent(node.y)}`,
    `width:${percent(node.w)}`,
    `height:${percent(node.h)}`,
    `z-index:${Math.max(0, Math.min(1000, Math.round(node.zIndex)))}`,
    `--animation-delay:${clamp(node.animationDelay || 0, 0, 30)}s`,
  ];
  const classes = ["deck-node", `node-${node.type}`, node.animation && node.animation !== "none" ? `animate-${node.animation}` : ""]
    .filter(Boolean).join(" ");
  const attrs = `class="${classes}" data-node-id="${escapeAttribute(node.id)}" data-node-type="${node.type}" data-node-name="${escapeAttribute(node.name)}" style="${base.join(";")}"`;

  if (node.type === "text") return `<div ${attrs} role="textbox"><div class="text-inner" style="${textStyle(node)}">${escapeHtml(node.text).replace(/\n/g, "<br>")}</div></div>`;
  if (node.type === "shape") {
    const shapeStyle = [
      `background:${safeColor(node.fill, "transparent")}`,
      `border:${Math.max(0, node.strokeWidth)}px solid ${safeColor(node.stroke, "transparent")}`,
      `border-radius:${node.shape === "circle" ? "50%" : `${Math.max(0, node.radius || 0)}px`}`,
      `opacity:${clamp(node.opacity ?? 1, 0, 1)}`,
    ];
    return `<div ${attrs}><div class="shape-inner shape-${node.shape}" style="${shapeStyle.join(";")}"></div></div>`;
  }
  if (node.type === "image") {
    const source = safeMediaUrl(node.src);
    return `<div ${attrs}><img src="${escapeAttribute(source)}" alt="${escapeAttribute(node.alt)}" style="object-fit:${node.objectFit};opacity:${clamp(node.opacity ?? 1, 0, 1)}"></div>`;
  }
  if (node.type === "chart") {
    const chart = JSON.stringify(chartOption(node, deck)).replace(/</g, "\\u003c");
    return `<div ${attrs}><div class="chart-canvas" data-chart-option="${escapeAttribute(chart)}"></div></div>`;
  }
  if (node.type === "video") {
    const source = safeMediaUrl(node.src);
    const poster = node.poster ? safeMediaUrl(node.poster) : "";
    return `<div ${attrs}><video src="${escapeAttribute(source)}" ${poster ? `poster="${escapeAttribute(poster)}"` : ""} ${node.autoplay ? "autoplay" : ""} ${node.loop ? "loop" : ""} ${node.muted ? "muted" : ""} playsinline controls></video></div>`;
  }
  const value = typeof node.props.value === "number" ? node.props.value : Number(node.props.value || 0);
  const label = String(node.props.label || node.name);
  if (node.widgetType === "progress") {
    return `<div ${attrs}><div class="widget-progress"><span style="width:${clamp(value, 0, 100)}%"></span></div><small>${escapeHtml(label)}</small></div>`;
  }
  if (node.widgetType === "particle-field") return `<div ${attrs}><canvas class="particle-canvas" data-count="${clamp(Number(node.props.count || 36), 6, 120)}"></canvas></div>`;
  if (node.widgetType === "timeline") return `<div ${attrs}><div class="widget-timeline"><span></span><strong>${escapeHtml(label)}</strong></div></div>`;
  return `<div ${attrs}><div class="widget-counter" data-value="${Number.isFinite(value) ? value : 0}">0</div><small>${escapeHtml(label)}</small></div>`;
}

function renderDrawings(deck: HtmlDeckSpec, slideId: string) {
  const drawings = deck.drawings.filter((drawing) => drawing.slideId === slideId && drawing.points.length > 1);
  if (!drawings.length) return "";
  return `<svg class="deck-drawings" viewBox="0 0 1600 900" aria-hidden="true">${drawings.map((drawing) => {
    const points = drawing.points.map((point) => `${clamp(point.x, 0, 1) * 1600},${clamp(point.y, 0, 1) * 900}`).join(" ");
    return `<polyline points="${escapeAttribute(points)}" fill="none" stroke="${safeColor(drawing.color, "#e74c36")}" stroke-width="${clamp(drawing.width, 1, 24)}" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("")}</svg>`;
}

function textStyle(node: HtmlTextNode) {
  const style = node.style;
  return [
    `font-size:${clamp(style.fontSize, 8, 160)}px`,
    `font-weight:${clamp(style.fontWeight, 100, 900)}`,
    `line-height:${clamp(style.lineHeight, 0.8, 3)}`,
    `color:${safeColor(style.color, "#111820")}`,
    `text-align:${style.align}`,
    `justify-content:${style.verticalAlign === "top" ? "flex-start" : style.verticalAlign === "bottom" ? "flex-end" : "center"}`,
    `background:${safeColor(style.backgroundColor || "transparent", "transparent")}`,
    `border:${Math.max(0, style.borderWidth || 0)}px solid ${safeColor(style.borderColor || "transparent", "transparent")}`,
    `border-radius:${Math.max(0, style.radius || 0)}px`,
    `opacity:${clamp(style.opacity ?? 1, 0, 1)}`,
    `padding:${Math.max(0, style.padding || 0)}px`,
  ].join(";");
}

function chartOption(node: HtmlChartNode, deck: HtmlDeckSpec) {
  if (node.chartType === "radar") {
    const maximums = node.labels.map((_, index) => Math.max(1, ...node.series.map((item) => Math.abs(item.values[index] || 0))) * 1.15);
    return {
      animationDuration: 900,
      backgroundColor: "transparent",
      color: [node.accentColor, deck.theme.accent, deck.theme.muted],
      textStyle: { color: deck.theme.text, fontFamily: deck.theme.fontFamily },
      tooltip: { trigger: "item" },
      legend: { show: node.showLegend, top: 0, textStyle: { color: deck.theme.muted } },
      radar: { indicator: node.labels.map((name, index) => ({ name, max: maximums[index] })), splitArea: { show: false } },
      series: [{ type: "radar", data: node.series.map((item) => ({ name: item.name, value: item.values })) }],
    };
  }
  const series = node.chartType === "pie"
    ? [{ type: "pie", radius: ["42%", "72%"], data: node.labels.map((label, index) => ({ name: label, value: node.series[0]?.values[index] || 0 })), label: { color: deck.theme.text } }]
    : node.series.map((seriesItem, index) => ({
        name: seriesItem.name,
        type: node.chartType,
        data: seriesItem.values,
        smooth: node.chartType === "line",
        itemStyle: { color: seriesItem.color || (index ? deck.theme.accent : node.accentColor) },
        lineStyle: { width: 4 },
        label: { show: node.showValues, color: deck.theme.text, position: "top" },
      }));
  return {
    animationDuration: 900,
    backgroundColor: "transparent",
    color: [node.accentColor, deck.theme.accent, deck.theme.muted],
    textStyle: { color: deck.theme.text, fontFamily: deck.theme.fontFamily },
    tooltip: { trigger: node.chartType === "pie" ? "item" : "axis" },
    legend: { show: node.showLegend, top: 0, textStyle: { color: deck.theme.muted } },
    grid: { left: 36, right: 20, top: node.showLegend ? 48 : 24, bottom: 34, containLabel: true },
    xAxis: node.chartType === "pie" ? undefined : { type: "category", data: node.labels, axisLabel: { color: deck.theme.muted }, axisLine: { lineStyle: { color: deck.theme.muted } } },
    yAxis: node.chartType === "pie" ? undefined : { type: "value", axisLabel: { color: deck.theme.muted }, splitLine: { lineStyle: { color: deck.theme.muted, opacity: 0.2 } } },
    series,
  };
}

function runtimeCss(deck: HtmlDeckSpec) {
  return `
  :root { --deck-primary:${safeColor(deck.theme.primary, "#0e6cff")}; --deck-accent:${safeColor(deck.theme.accent, "#e74c36")}; }
  html, body { width:100%; height:100%; margin:0; overflow:hidden; background:#111; font-family:${escapeStyle(deck.theme.fontFamily)}; }
  .reveal { width:100%; height:100%; }
  .reveal .slides { text-align:left; }
  .reveal .slides section { width:1600px; height:900px; padding:0; overflow:hidden; }
  .slide-stage { position:absolute; inset:0; overflow:hidden; }
  .deck-node { position:absolute; box-sizing:border-box; transform-origin:center; }
  .deck-drawings { position:absolute; inset:0; z-index:900; width:100%; height:100%; pointer-events:none; }
  .deck-node.selected { outline:3px solid #0e6cff; outline-offset:3px; }
  body.edit-mode .deck-node { cursor:move; }
  body.edit-mode .deck-node::after { content:""; position:absolute; right:-7px; bottom:-7px; width:14px; height:14px; border:2px solid #fff; background:#0e6cff; box-shadow:0 0 0 1px #0e6cff; opacity:0; pointer-events:none; }
  body.edit-mode .deck-node.selected::after { opacity:1; }
  body.edit-mode .deck-node:hover { outline:2px solid rgba(14,108,255,.55); outline-offset:2px; }
  .text-inner { width:100%; height:100%; box-sizing:border-box; display:flex; white-space:pre-wrap; overflow:hidden; letter-spacing:0; }
  .node-image img, .node-video video { width:100%; height:100%; display:block; border-radius:12px; }
  .shape-inner, .chart-canvas, .particle-canvas { width:100%; height:100%; box-sizing:border-box; }
  .widget-counter { font-size:72px; font-weight:800; color:var(--deck-primary); line-height:1; }
  .node-widget small { display:block; margin-top:8px; font-size:16px; opacity:.72; }
  .widget-progress { height:22px; border-radius:11px; background:rgba(127,127,127,.18); overflow:hidden; }
  .widget-progress span { display:block; height:100%; border-radius:inherit; background:var(--deck-primary); transition:width .4s ease; }
  .widget-timeline { display:flex; align-items:center; gap:14px; font-size:20px; }
  .widget-timeline span { width:18px; height:18px; border-radius:50%; background:var(--deck-accent); box-shadow:0 0 0 8px color-mix(in srgb,var(--deck-accent) 20%,transparent); }
  .animate-fade { animation:deckFade .65s ease both; animation-delay:var(--animation-delay,0s); }
  .animate-rise { animation:deckRise .7s ease both; animation-delay:var(--animation-delay,0s); }
  .animate-scale { animation:deckScale .75s ease both; animation-delay:var(--animation-delay,0s); }
  .animate-draw { animation:deckDraw .8s ease both; animation-delay:var(--animation-delay,0s); }
  .highlighted { filter:brightness(1.16); box-shadow:0 0 0 5px var(--deck-accent); }
  .interaction-hidden { visibility:hidden; }
  @keyframes deckFade { from { opacity:0 } to { opacity:1 } }
  @keyframes deckRise { from { opacity:0; transform:translateY(24px) } to { opacity:1; transform:translateY(0) } }
  @keyframes deckScale { from { opacity:0; transform:scale(.94) } to { opacity:1; transform:scale(1) } }
  @keyframes deckDraw { from { opacity:0; clip-path:inset(0 100% 0 0) } to { opacity:1; clip-path:inset(0 0 0 0) } }
  @media (prefers-reduced-motion:reduce) { *, *::before, *::after { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
  body.no-motion *, body.no-motion *::before, body.no-motion *::after { animation-duration:.01ms!important; transition-duration:.01ms!important; }
  `;
}

function runtimeScript() {
  return `(function(){
    const state = window.__HTML_DECK__;
    const deck = new Reveal({ embedded:true, hash:false, history:false, controls:false, progress:false, center:false, transition:'fade', width:1600, height:900, margin:0, minScale:0.1, maxScale:2, scrollActivationWidth:null });
    const charts = [];
    function post(type, detail){ parent.postMessage({ source:'llwp-html-deck', type, deckId:state.deckId, ...detail }, '*'); }
    function applyVariables(){ Object.entries(state.variables||{}).forEach(([key,value])=>document.documentElement.style.setProperty('--tweak-'+key,String(value))); document.body.classList.toggle('no-motion',state.variables['motion-enabled']===false); const primary=state.variables['primary-color'];const accent=state.variables['accent-color'];if(typeof primary==='string')document.documentElement.style.setProperty('--deck-primary',primary);if(typeof accent==='string')document.documentElement.style.setProperty('--deck-accent',accent); }
    function applyMode(){ document.body.classList.toggle('edit-mode', Boolean(state.editMode)); applyVariables(); }
    function selectNode(id){ document.querySelectorAll('.deck-node.selected').forEach((node)=>node.classList.remove('selected')); if(id){ const node=document.querySelector('[data-node-id="'+CSS.escape(id)+'"]'); if(node) node.classList.add('selected'); } }
    function currentSlideState(){ const section=deck.getCurrentSlide(); return (state.slides||[]).find((slide)=>slide.id===section?.dataset.slideId); }
    function targetNode(id){ return id ? document.querySelector('[data-node-id="'+CSS.escape(id)+'"]') : null; }
    function restartAnimation(element){ if(!element)return; const names=['animate-fade','animate-rise','animate-scale','animate-draw']; const name=names.find((item)=>element.classList.contains(item))||'animate-fade'; element.classList.remove(name); void element.offsetWidth; element.classList.add(name); }
    function runInteraction(interaction){
      const target=targetNode(interaction.targetId||interaction.sourceId);
      if(interaction.action==='next') deck.next();
      else if(interaction.action==='previous') deck.prev();
      else if(interaction.action==='toggle'&&target) target.classList.toggle('interaction-hidden');
      else if(interaction.action==='highlight'&&target) target.classList.toggle('highlighted');
      else if(interaction.action==='set-variable'&&interaction.variableId){ state.variables[interaction.variableId]=interaction.value; applyVariables(); post('variable-change',{variableId:interaction.variableId,value:interaction.value}); }
      else if(interaction.action==='animate') restartAnimation(target);
      post('interaction',{interactionId:interaction.id,action:interaction.action});
    }
    function triggerInteractions(trigger,sourceId){ const slide=currentSlideState(); const matches=(slide?.interactions||[]).filter((item)=>item.trigger===trigger&&(!item.sourceId||item.sourceId===sourceId)); matches.forEach(runInteraction); return matches.length>0; }
    function initCharts(){ document.querySelectorAll('.chart-canvas').forEach((element)=>{ try { const option=JSON.parse(element.dataset.chartOption||'{}'); const chart=echarts.init(element,null,{renderer:'svg'}); chart.setOption(option); charts.push(chart); } catch(error){ post('runtime-error',{message:'图表初始化失败'}); } }); }
    function initWidgets(){ document.querySelectorAll('.widget-counter').forEach((element)=>{ const target=Number(element.dataset.value||0); const started=performance.now(); function tick(now){ const progress=Math.min(1,(now-started)/850); element.textContent=String(Math.round(target*(1-Math.pow(1-progress,3)))); if(progress<1) requestAnimationFrame(tick); } requestAnimationFrame(tick); }); document.querySelectorAll('.particle-canvas').forEach((canvas)=>{ const context=canvas.getContext('2d'); const count=Number(canvas.dataset.count||36); const points=Array.from({length:count},(_,index)=>({x:(index*73%997)/997,y:(index*151%991)/991,r:1+(index%4)})); function draw(){ canvas.width=canvas.clientWidth*devicePixelRatio; canvas.height=canvas.clientHeight*devicePixelRatio; context.clearRect(0,0,canvas.width,canvas.height); context.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--deck-primary'); points.forEach((point)=>{context.beginPath();context.arc(point.x*canvas.width,point.y*canvas.height,point.r*devicePixelRatio,0,Math.PI*2);context.fill();}); } draw(); }); }
    let transform=null;
    document.addEventListener('pointerdown',(event)=>{ const node=event.target.closest('.deck-node'); if(!state.editMode||!node)return; event.preventDefault(); event.stopPropagation(); state.selectedNodeId=node.dataset.nodeId; selectNode(state.selectedNodeId); post('select-node',{slideId:node.closest('section').dataset.slideId,nodeId:state.selectedNodeId}); const stage=node.closest('.slide-stage'); const stageRect=stage.getBoundingClientRect(); const nodeRect=node.getBoundingClientRect(); const resize=event.clientX>nodeRect.right-22&&event.clientY>nodeRect.bottom-22; transform={pointerId:event.pointerId,node,stageRect,startX:event.clientX,startY:event.clientY,x:(nodeRect.left-stageRect.left)/stageRect.width,y:(nodeRect.top-stageRect.top)/stageRect.height,w:nodeRect.width/stageRect.width,h:nodeRect.height/stageRect.height,resize}; node.setPointerCapture(event.pointerId); });
    document.addEventListener('pointermove',(event)=>{ if(!transform||transform.pointerId!==event.pointerId)return; const dx=(event.clientX-transform.startX)/transform.stageRect.width; const dy=(event.clientY-transform.startY)/transform.stageRect.height; if(transform.resize){ transform.node.style.width=Math.max(.02,Math.min(1-transform.x,transform.w+dx))*100+'%'; transform.node.style.height=Math.max(.02,Math.min(1-transform.y,transform.h+dy))*100+'%'; } else { transform.node.style.left=Math.max(0,Math.min(1-transform.w,transform.x+dx))*100+'%'; transform.node.style.top=Math.max(0,Math.min(1-transform.h,transform.y+dy))*100+'%'; } });
    document.addEventListener('pointerup',(event)=>{ if(!transform||transform.pointerId!==event.pointerId)return; const nodeRect=transform.node.getBoundingClientRect(); const rect={x:(nodeRect.left-transform.stageRect.left)/transform.stageRect.width,y:(nodeRect.top-transform.stageRect.top)/transform.stageRect.height,w:nodeRect.width/transform.stageRect.width,h:nodeRect.height/transform.stageRect.height}; post('update-node-rect',{slideId:transform.node.closest('section').dataset.slideId,nodeId:transform.node.dataset.nodeId,rect}); transform=null; });
    document.addEventListener('click',(event)=>{ const node=event.target.closest('.deck-node'); if(state.editMode){ event.preventDefault(); event.stopPropagation(); return; } if(node){ triggerInteractions('click',node.dataset.nodeId); } else if(!triggerInteractions('click','')) { deck.next(); } });
    document.addEventListener('mouseover',(event)=>{ if(state.editMode)return; const node=event.target.closest('.deck-node'); if(node&&!node.contains(event.relatedTarget)) triggerInteractions('hover',node.dataset.nodeId); });
    document.addEventListener('keydown',(event)=>{ if(!state.editMode) triggerInteractions('key',event.key); });
    window.addEventListener('message',(event)=>{ const message=event.data||{}; if(message.source!=='llwp-html-editor') return; if(message.type==='set-mode'){ state.editMode=Boolean(message.editMode); applyMode(); } if(message.type==='select-node'){ state.selectedNodeId=message.nodeId||''; selectNode(state.selectedNodeId); } if(message.type==='go-to-slide'){ deck.slide(Number(message.index)||0); } if(message.type==='set-variables'){ state.variables={...state.variables,...message.variables}; applyVariables(); } });
    deck.on('slidechanged',(event)=>{ charts.forEach((chart)=>chart.resize()); post('slide-change',{index:event.indexh,slideId:event.currentSlide.dataset.slideId}); triggerInteractions('enter',''); });
    deck.initialize().then(()=>{ applyMode(); selectNode(state.selectedNodeId); initCharts(); initWidgets(); triggerInteractions('enter',''); post('ready',{slideCount:document.querySelectorAll('.slides>section').length}); }).catch((error)=>post('runtime-error',{message:String(error&&error.message||error)}));
    window.addEventListener('resize',()=>charts.forEach((chart)=>chart.resize()));
  })();`;
}

function safeOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "http://127.0.0.1:5173";
  }
}

function safeMediaUrl(value: string) {
  const trimmed = String(value || "").trim();
  return /^(?:data:|blob:)/i.test(trimmed) ? trimmed : "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
}

function safeColor(value: string, fallback: string) {
  const trimmed = String(value || "").trim();
  return /^(?:#[\da-f]{3,8}|rgba?\([\d\s,.%]+\)|hsla?\([\d\s,.%]+\)|transparent|white|black)$/i.test(trimmed) ? trimmed : fallback;
}

function percent(value: number) { return `${clamp(value, 0, 1) * 100}%`; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
function escapeHtml(value: string) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function escapeAttribute(value: string) { return escapeHtml(value).replace(/`/g, "&#96;"); }
function escapeStyle(value: string) { return String(value || "").replace(/<\/style/gi, "<\\/style"); }
function escapeScript(value: string) { return String(value || "").replace(/<\/script/gi, "<\\/script"); }
