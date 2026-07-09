/* Repostaje Camper — app real (PWA). Datos: Geoportal de Carburantes (Minetur). */
'use strict';

// ---------- Config ----------
const API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes';
const STORE = 'repostaje_camper_v1';
const ACCENTS = ['#E0890F', '#2A6FDB', '#C2410C', '#1FA45B'];
const NEAR_KM = 25;        // radio de búsqueda "cerca de ti"
const MAX_NEAR = 80;       // máx. estaciones que guardamos en caché
const STALE_MS = 30 * 60 * 1000; // refrescar si los datos tienen más de 30 min

const PROV = {"10":"CÁCERES","11":"CÁDIZ","12":"CASTELLÓN / CASTELLÓ","13":"CIUDAD REAL","14":"CÓRDOBA","15":"CORUÑA (A)","16":"CUENCA","17":"GIRONA","18":"GRANADA","19":"GUADALAJARA","20":"GIPUZKOA","21":"HUELVA","22":"HUESCA","23":"JAÉN","24":"LEÓN","25":"LLEIDA","26":"RIOJA (LA)","27":"LUGO","28":"MADRID","29":"MÁLAGA","30":"MURCIA","31":"NAVARRA","32":"OURENSE","33":"ASTURIAS","34":"PALENCIA","35":"PALMAS (LAS)","36":"PONTEVEDRA","37":"SALAMANCA","38":"SANTA CRUZ DE TENERIFE","39":"CANTABRIA","40":"SEGOVIA","41":"SEVILLA","42":"SORIA","43":"TARRAGONA","44":"TERUEL","45":"TOLEDO","46":"VALENCIA / VALÈNCIA","47":"VALLADOLID","48":"BIZKAIA","49":"ZAMORA","50":"ZARAGOZA","51":"CEUTA","52":"MELILLA","02":"ALBACETE","03":"ALICANTE","04":"ALMERÍA","01":"ARABA/ÁLAVA","05":"ÁVILA","06":"BADAJOZ","07":"BALEARS (ILLES)","08":"BARCELONA","09":"BURGOS"};

const norm = s => (s||'').toString().normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
// alias de cada provincia para casar con Nominatim
const PROV_ALIAS = {};
for (const id in PROV) {
  const aliases = new Set();
  PROV[id].split('/').forEach(part => {
    part = part.replace(/\(.*?\)/g,'').trim();
    if (part) aliases.add(norm(part));
    const m = PROV[id].match(/\((.*?)\)/); // "CORUÑA (A)" -> "A CORUÑA"
    if (m) aliases.add(norm(m[1] + part));
  });
  PROV_ALIAS[id] = aliases;
}

const FUELS = {
  diesel:   { key:'Precio Gasoleo A',                   label:'Diésel' },
  gasolina: { key:'Precio Gasolina 95 E5',              label:'Gasolina 95' },
  glp:      { key:'Precio Gases licuados del petróleo', label:'GLP' },
};

const LOWCOST = ['ballenoil','petroprix','plenoil','plenergy','gmoil','gmfuel','tamoil','easygas','carrefour','alcampo','eroski','eleclerc','leclerc','bonarea','bonpreu','esclat','meroil','autonetoil','petromax','agla','q8easy','okenergy','okgasolineras'];
const BRANDS = {
  repsol:{label:'Repsol',color:'#F47C20',match:['repsol','campsa','petronieves']},
  cepsa:{label:'Cepsa',color:'#E2231A',match:['cepsa']},
  bp:{label:'BP',color:'#0A9D58',match:['bp']},
  galp:{label:'Galp',color:'#FF6A13',match:['galp']},
  petronor:{label:'Petronor',color:'#0046AD',match:['petronor']},
  lowcost:{label:'Low-cost',color:'#1FA45B',match:LOWCOST},
};
const OTHER = {label:'', color:'#8A9389'};

function brandOf(rotulo){
  const n = norm(rotulo);
  for (const k in BRANDS){ if (BRANDS[k].match.some(m => n.includes(norm(m)))) return k; }
  return 'otra';
}
function brandMeta(k){ return BRANDS[k] || OTHER; }
function prettyName(rotulo){
  if (!rotulo) return 'Estación de servicio';
  return rotulo.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- Estado ----------
let S = {
  tab:'lista', detail:null, fuel:'diesel', brands:[], theme:'day', accent:ACCENTS[0],
  tank:70, routeSheet:false, exportSheet:false, zoneSheet:false,
  favorites:[], visits:{}, camper:{}, history:{},
  route:null, // {origin, dest, road, km, time, stops:[]}
};
let DATA = { stations:[], updated:0, source:'', user:null, province:'' };
let mapObj = null, mapMarkers = [];

function save(){
  try { localStorage.setItem(STORE, JSON.stringify({
    theme:S.theme, accent:S.accent, tank:S.tank, fuel:S.fuel,
    favorites:S.favorites, visits:S.visits, camper:S.camper, history:S.history,
    cache:{ stations:DATA.stations, updated:DATA.updated, source:DATA.source, user:DATA.user, province:DATA.province },
  })); } catch(e){}
}
function load(){
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || '{}');
    S.theme = s.theme || 'day'; S.accent = s.accent || ACCENTS[0]; S.tank = s.tank || 70;
    S.fuel = s.fuel || 'diesel';
    S.favorites = s.favorites || []; S.visits = s.visits || {}; S.camper = s.camper || {}; S.history = s.history || {};
    if (s.cache && s.cache.stations) {
      DATA.stations = s.cache.stations; DATA.updated = s.cache.updated || 0;
      DATA.source = s.cache.source || ''; DATA.user = s.cache.user || null; DATA.province = s.cache.province || '';
    }
  } catch(e){}
}

// ---------- Utilidades ----------
const num = v => { if (v==null) return NaN; const n = parseFloat(String(v).replace('.','').replace(',','.')); return isNaN(n)?NaN:n; };
// precios vienen "1,439"; coords "39,211417" o "-1,539167" (sin separador de miles)
const coord = v => parseFloat(String(v||'').replace(',','.'));
const fmtP = p => (p==null||isNaN(p)) ? '—' : p.toFixed(3).replace('.', ',');
const fmtE = v => v.toFixed(2).replace('.', ',') + ' €';
const fmtKm = v => v.toFixed(1).replace('.', ',');
function haversine(a,b,c,d){ const R=6371,r=Math.PI/180; const dLa=(c-a)*r,dLo=(d-b)*r; const u=Math.sin(dLa/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(dLo/2)**2; return 2*R*Math.asin(Math.sqrt(u)); }
function priceOf(st, fuel){ return st.prices[fuel||S.fuel]; }
function isOpenNow(horario){
  if (!horario) return null;
  if (/24H|24 H|L-D: 24/i.test(horario)) return true;
  // parse "L-D: 07:00-22:00" etc. — heurística por día/hora
  try {
    const now = new Date(); const dow = now.getDay(); // 0=Dom
    const map = {L:1,M:2,X:3,J:4,V:5,S:6,D:0};
    const segs = horario.split(';');
    for (const seg of segs){
      const m = seg.match(/([LMXJVSD-]+):\s*([\d:]+)-([\d:]+)/i);
      if (!m) continue;
      const days = expandDays(m[1], map);
      if (!days.includes(dow)) continue;
      const [h1,m1] = m[2].split(':').map(Number), [h2,m2] = m[3].split(':').map(Number);
      const t = now.getHours()*60+now.getMinutes(), a=h1*60+m1, b=h2*60+m2;
      if (b<=a){ if (t>=a||t<=b) return true; } else if (t>=a && t<=b) return true;
    }
    return false;
  } catch(e){ return null; }
}
function expandDays(str, map){
  const out=[]; const parts = str.split(',');
  for (let p of parts){ p=p.trim();
    const r = p.match(/([LMXJVSD])-([LMXJVSD])/);
    if (r){ let a=map[r[1]], b=map[r[2]]; a=a===0?7:a; b=b===0?7:b; for(let d=a; d<=b; d++) out.push(d%7); }
    else if (map[p]!=null) out.push(map[p]);
  }
  return out;
}

// ---------- Capa de datos ----------
function parseStation(e, user){
  const lat = coord(e['Latitud']), lng = coord(e['Longitud (WGS84)']);
  const prices = {};
  for (const f in FUELS) prices[f] = num(e[FUELS[f].key]);
  const extra = { premium:num(e['Precio Gasoleo Premium']), g95:num(e['Precio Gasolina 95 E5']), adblue:num(e['Precio Adblue']) };
  const bk = brandOf(e['Rótulo']);
  return {
    id: String(e['IDEESS']),
    rotulo: e['Rótulo'], brandKey: bk, brandName: brandMeta(bk).label || prettyName(e['Rótulo']),
    name: prettyName(e['Rótulo']) + (e['Municipio'] ? ' · ' + e['Municipio'] : ''),
    addr: ([e['Dirección'], e['Localidad']].filter(Boolean).join(', ')).toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()),
    lat, lng, hours: e['Horario'] || '', open: isOpenNow(e['Horario']),
    prices, extra,
    dist: user ? haversine(user.lat,user.lng,lat,lng) : null,
  };
}

async function fetchJSON(url, ms){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), ms||20000);
  try { const r = await fetch(url, {signal:ctrl.signal}); if(!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function getLocation(){
  return new Promise((res)=>{
    if (!navigator.geolocation || /[?&]nogps/.test(location.search)) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({lat:p.coords.latitude, lng:p.coords.longitude}),
      () => res(null),
      { enableHighAccuracy:true, timeout:8000, maximumAge:120000 }
    );
  });
}

async function provinceFromGPS(user){
  try {
    const j = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?lat=${user.lat}&lon=${user.lng}&format=json&accept-language=es&zoom=8`, 8000);
    const a = j.address || {};
    const cands = [a.province, a.county, a.state_district, a.city, a.town, a.region, a.state].filter(Boolean).map(norm);
    for (const id in PROV_ALIAS){
      for (const al of PROV_ALIAS[id]){ if (cands.some(c => c===al || c.includes(al) || al.includes(c))) return {id, name:PROV[id]}; }
    }
  } catch(e){}
  return null;
}

async function refreshData(){
  const user = await getLocation();
  if (user) DATA.user = user;
  const u = DATA.user;
  let list = null, source = '', provName = '';

  if (u) {
    const prov = await provinceFromGPS(u);
    if (prov){
      try {
        const j = await fetchJSON(`${API}/EstacionesTerrestresFiltroProvincia/${prov.id}`);
        list = j.ListaEESSPrecio || []; source = 'provincia'; provName = prov.name;
      } catch(e){}
    }
  }
  if (!list) { // fallback nacional (pesado, pero funciona en cualquier sitio)
    const j = await fetchJSON(`${API}/EstacionesTerrestres/`, 40000);
    list = j.ListaEESSPrecio || []; source = 'nacional';
  }

  let parsed = list.map(e => parseStation(e, u)).filter(s => !isNaN(s.lat) && !isNaN(s.lng) && !isNaN(s.prices.diesel));
  if (u){
    parsed = parsed.filter(s => s.dist <= NEAR_KM).sort((a,b)=>a.dist-b.dist).slice(0, MAX_NEAR);
    if (parsed.length < 8){ // amplía radio si hay pocas
      parsed = list.map(e=>parseStation(e,u)).filter(s=>!isNaN(s.lat)&&!isNaN(s.prices.diesel)).sort((a,b)=>a.dist-b.dist).slice(0, MAX_NEAR);
    }
  } else {
    parsed = parsed.slice(0, MAX_NEAR);
  }

  DATA.stations = parsed; DATA.updated = Date.now(); DATA.source = source;
  DATA.province = provName || (parsed[0] ? '' : DATA.province);
  recordHistory(parsed);
  save();
  return parsed.length;
}

function recordHistory(list){
  const today = new Date().toISOString().slice(0,10);
  list.forEach(s=>{
    if (!S.favorites.includes(s.id)) return;
    const h = S.history[s.id] = S.history[s.id] || [];
    if (!isNaN(s.prices.diesel) && (!h.length || h[h.length-1].d !== today)){
      h.push({d:today, p:s.prices.diesel}); if (h.length>30) h.shift();
    }
  });
}

// ---------- Datos derivados ----------
function stationById(id){ return DATA.stations.find(s=>s.id===id) || (_national ? _national.find(s=>s.id===id) : null) || null; }
function medianPrice(fuel){
  const ps = DATA.stations.map(s=>priceOf(s,fuel)).filter(p=>!isNaN(p)).sort((a,b)=>a-b);
  if (!ps.length) return NaN;
  return ps[Math.floor(ps.length/2)];
}
function filtered(){
  const f = S.fuel;
  let list = DATA.stations.filter(s => !isNaN(priceOf(s,f)));
  if (S.brands.length) list = list.filter(s => S.brands.includes(s.brandKey));
  return list.sort((a,b)=>priceOf(a,f)-priceOf(b,f));
}

// ---------- Helpers de render ----------
const $ = sel => document.querySelector(sel);
const el = (html) => { const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstChild; };
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2200); }
function moon(stroke){ return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8Z" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/></svg>`; }
function moonBtn(){
  const night = S.theme==='night';
  const st = night ? 'background:#224E40;border:none;' : 'background:var(--card);border:1px solid var(--line);';
  return `<button class="iconbtn" style="${st}" data-act="theme">${moon(night?'#fff':'var(--ink)')}</button>`;
}
function camperOf(id){ return S.camper[id] || {easy:false,water:false,overnight:false}; }
function pumpIcon(stroke){ return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 21h14M15 9h2.5a2 2 0 0 1 2 2v5.5a1.5 1.5 0 0 0 3 0V9l-2.5-3" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }

// ---------- Render principal ----------
function setAccent(){ document.getElementById('app').style.setProperty('--acc', S.accent); }
function render(){
  const app = document.getElementById('app');
  app.className = S.theme==='night' ? 'night' : 'day';
  app.style.setProperty('--acc', S.accent);
  app.style.setProperty('--navactive', S.theme==='night' ? '#7FC9B4' : '#224E40');
  app.style.setProperty('--navidle', S.theme==='night' ? '#6E867C' : '#A6AEA4');

  const c = $('#content');
  if (mapObj){ mapObj.remove(); mapObj=null; }
  if (S.tab==='mapa') renderMapa(c);
  else if (S.tab==='lista') renderLista(c);
  else if (S.tab==='ruta') renderRuta(c);
  else if (S.tab==='favoritos') renderFav(c);
  else if (S.tab==='ahorro') renderAhorro(c);
  renderNav();
  renderLayer();
}

function renderNav(){
  const items = [
    ['lista','Lista','<path d="M8 6h12M8 12h12M8 18h12" stroke="C" stroke-width="2" stroke-linecap="round"/><circle cx="4" cy="6" r="1.4" fill="C"/><circle cx="4" cy="12" r="1.4" fill="C"/><circle cx="4" cy="18" r="1.4" fill="C"/>'],
    ['mapa','Mapa','<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" stroke="C" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" stroke="C" stroke-width="2"/>'],
    ['ruta','Ruta','<path d="M6 20a3 3 0 0 1 0-6h9a3 3 0 0 0 0-6H6" stroke="C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="6" r="2.2" fill="C"/><circle cx="18" cy="20" r="2.2" fill="C"/>'],
    ['favoritos','Favoritas','<path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 3.5C19 15.7 12 20 12 20Z" stroke="C" stroke-width="2" stroke-linejoin="round"/>'],
    ['ahorro','Ahorro','<ellipse cx="12" cy="8" rx="7" ry="3" stroke="C" stroke-width="2"/><path d="M5 8v8c0 1.7 3.1 3 7 3s7-1.3 7-3V8" stroke="C" stroke-width="2"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" stroke="C" stroke-width="2"/>'],
  ];
  const nav = $('#nav');
  nav.innerHTML = items.map(([k,label,svg])=>{
    const on = S.tab===k;
    const col = on ? 'var(--navactive)' : 'var(--navidle)';
    return `<button class="navb ${on?'on':''}" data-tab="${k}"><svg width="23" height="23" viewBox="0 0 24 24" fill="none">${svg.replace(/C/g,col)}</svg>${label}</button>`;
  }).join('');
}

function dataAgeLabel(){
  if (!DATA.updated) return 'sin datos aún';
  const min = Math.round((Date.now()-DATA.updated)/60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min/60); return 'hace ' + h + ' h';
}

// ---------- LISTA ----------
function renderLista(c){
  const list = filtered();
  const med = medianPrice(S.fuel);
  const T = S.tank;
  const zone = DATA.province ? (prettyName(DATA.province)) : (DATA.stations[0] ? 'Cerca de ti' : 'Sin ubicación');
  const offline = !navigator.onLine;

  const fuelPills = Object.keys(FUELS).map(f=>{
    const on = S.fuel===f;
    const ic = f==='diesel' ? pumpIcon(on?'#fff':'var(--soft)') : '';
    return `<button class="fpill ${on?'on':''}" data-fuel="${f}">${ic}${FUELS[f].label}</button>`;
  }).join('');

  const chipDefs = [['todas','Todas'],['lowcost','Low-cost'],['repsol','Repsol'],['cepsa','Cepsa'],['bp','BP'],['galp','Galp'],['petronor','Petronor']];
  const chips = chipDefs.map(([k,label])=>{
    const active = k==='todas' ? S.brands.length===0 : S.brands.includes(k);
    const dot = k==='todas' ? '' : `<span class="dot" style="background:${brandMeta(k).color}"></span>`;
    return `<button class="chip ${active?'on':''}" data-brand="${k}">${dot}${label}</button>`;
  }).join('');

  c.innerHTML = `
  <div class="pad pt">
    <div class="topbar">
      <button class="zone" data-act="zone">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" stroke="#2E7D5B" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" fill="#2E7D5B"/></svg>
        <span>${esc(zone)}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="var(--soft)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="row" style="gap:9px">${moonBtn()}<div class="avatar"><span>R</span></div></div>
    </div>
    <h1 class="h1">${FUELS[S.fuel].label} más barato<br>cerca de ti</h1>
    <div class="fuels">${fuelPills}</div>
    <div class="chips scr">${chips}</div>
    ${offline ? `<div class="banner"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v5m0 8v5M3 12h5m8 0h5" stroke="var(--mintInk)" stroke-width="2" stroke-linecap="round"/></svg><span>Sin conexión · mostrando últimos precios guardados (${dataAgeLabel()}).</span></div>`:''}
    <div class="meta"><span class="c" id="count">${list.length} estaciones</span><span class="u">Actualizado ${dataAgeLabel()}</span></div>
    <div class="official"><span class="d"></span><span>Precios oficiales · Ministerio para la Transición Ecológica</span></div>
    <div class="list" id="stationList"></div>
  </div>`;

  const wrap = c.querySelector('#stationList');
  if (!DATA.stations.length){
    wrap.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  } else if (!list.length){
    wrap.innerHTML = `<div class="empty"><div class="t">Sin resultados</div><div class="s">No hay estaciones con ${FUELS[S.fuel].label} para ese filtro.</div></div>`;
  } else {
    list.forEach((s,i)=> wrap.appendChild(stationCard(s,i,med,T)));
  }
}

function stationCard(s,i,med,T){
  const p = priceOf(s,S.fuel);
  const cheap = i===0;
  const save = isNaN(med) ? NaN : (med-p)*T;
  const bm = brandMeta(s.brandKey);
  const cm = camperOf(s.id);
  const badges = [];
  if (cm.easy) badges.push(`<span class="bdg">${pumpIcon('currentColor')}Acceso fácil</span>`);
  if (cm.water) badges.push(`<span class="bdg"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Agua/vaciado</span>`);
  if (cm.overnight) badges.push(`<span class="bdg"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Pernocta</span>`);
  const saveHtml = isNaN(save) ? '' :
    `<span class="save" style="color:${save>=0?'#2E7D5B':(S.theme==='night'?'#E8A06A':'#B4541F')}">${save>=0?'−':'+'}${fmtE(Math.abs(save))}</span>`;
  const openHtml = s.open===null ? '' : `<span class="open ${s.open?'':'closed'}">${s.open?'Abierto':'Cerrado'}</span>`;

  const node = el(`<button class="card ${cheap?'cheap':''}" data-open="${s.id}">
    ${cheap?`<div class="ribbon">★ Más barata</div>`:''}
    <div class="rank ${cheap?'cheap':''}">${i+1}</div>
    <div class="cbody">
      <div class="cbrand"><span class="dot" style="background:${bm.color};margin:0"></span><span class="bn">${esc(s.brandName)}</span>${openHtml}</div>
      <div class="cname">${esc(s.name)}</div>
      <div class="caddr">${esc(s.addr)}</div>
      ${badges.length?`<div class="badges">${badges.join('')}</div>`:''}
    </div>
    <div class="cprice">
      <div class="pv"><span class="n">${fmtP(p)}</span><span class="l">€/L</span></div>
      ${saveHtml}
      ${s.dist!=null?`<span class="dist">${fmtKm(s.dist)} km</span>`:''}
    </div>
  </button>`);
  return node;
}

// ---------- MAPA ----------
function renderMapa(c){
  const list = filtered();
  const med = medianPrice(S.fuel);
  c.innerHTML = `
    <div id="map"></div>
    <div class="map-overlay">
      <input class="searchbox" placeholder="Buscar gasolinera o zona" data-act="mapsearch" />
      <button class="iconbtn" style="background:${S.theme==='night'?'#224E40':'var(--field)'};box-shadow:0 4px 14px rgba(0,0,0,0.1)" data-act="theme">${moon(S.theme==='night'?'#fff':'var(--ink)')}</button>
    </div>
    <div id="peek"></div>`;

  const u = DATA.user || (list[0] ? {lat:list[0].lat,lng:list[0].lng} : {lat:40.4168,lng:-3.7038});
  setTimeout(()=>{
    mapObj = L.map('map', {zoomControl:false, attributionControl:false}).setView([u.lat,u.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(mapObj);
    L.control.attribution({prefix:false, position:'bottomleft'}).addAttribution('© OpenStreetMap').addTo(mapObj);
    if (DATA.user) L.marker([u.lat,u.lng], {icon: L.divIcon({className:'', html:`<div style="width:18px;height:18px;border-radius:50%;background:#2A6FDB;border:3px solid #fff;box-shadow:0 0 0 6px rgba(42,111,219,0.18),0 2px 6px rgba(0,0,0,0.2)"></div>`, iconSize:[18,18], iconAnchor:[9,9]})}).addTo(mapObj);
    const cheapId = list[0] ? list[0].id : null;
    const bounds = [];
    list.forEach(s=>{
      const cheap = s.id===cheapId; const p = priceOf(s,S.fuel);
      const icon = L.divIcon({ className:'', html:`<div class="map-pin ${cheap?'cheap':''}">${fmtP(p)}<span class="l">€</span></div>`, iconSize:[54,26], iconAnchor:[27,30] });
      const mk = L.marker([s.lat,s.lng], {icon, zIndexOffset: cheap?1000:0}).addTo(mapObj);
      mk.on('click', ()=>{ S.detail=s.id; renderLayer(); });
      bounds.push([s.lat,s.lng]);
    });
    if (bounds.length>1 && !DATA.user) mapObj.fitBounds(bounds, {padding:[60,60], maxZoom:14});
    setTimeout(()=>mapObj.invalidateSize(), 100);
  }, 30);

  const peek = c.querySelector('#peek');
  if (list[0]){
    const s = list[0]; const p = priceOf(s,S.fuel); const save = isNaN(med)?NaN:(med-p)*S.tank;
    peek.className = 'peek'; peek.dataset.open = s.id;
    peek.innerHTML = `
      <div class="box"><span class="a">Nº1</span><span class="b">BARATA</span></div>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:6px"><span class="dot" style="background:${brandMeta(s.brandKey).color};margin:0"></span><span style="font-size:12px;font-weight:700;color:var(--soft)">${esc(s.brandName)}</span></div>
        <div style="font-size:15px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
        <div style="font-size:12px;color:var(--muted)">${s.dist!=null?'A '+fmtKm(s.dist)+' km':''}${!isNaN(save)?' · '+(save>=0?'−':'+')+fmtE(Math.abs(save))+' vs media':''}</div>
      </div>
      <div class="pv"><span class="n" style="font-size:23px">${fmtP(p)}</span><span class="l">€/L</span></div>`;
  }
}

// ---------- RUTA ----------
function renderRuta(c){
  const r = S.route;
  c.innerHTML = `
  <div class="pad pt">
    <div class="topbar"><h1 class="h1 h1s">Tu ruta</h1>${moonBtn()}</div>
    <button class="rt-card" data-act="routesheet">
      <div class="row" style="gap:11px;padding-bottom:10px">
        <div style="width:10px;height:10px;border-radius:50%;border:2.5px solid #2A6FDB;flex-shrink:0"></div>
        <span style="flex:1;font-size:15px;font-weight:600;color:var(--ink)">${r?esc(r.origin):'Elige origen'}</span>
        <span style="font-size:12px;font-weight:700;color:var(--acc)">Cambiar</span>
      </div>
      <div style="border-top:1px dashed var(--line);padding-top:10px" class="row"><div class="row" style="gap:11px;flex:1">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" fill="#B4541F"/></svg>
        <span style="flex:1;font-size:15px;font-weight:600;color:var(--ink)">${r?esc(r.dest):'Elige destino'}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="var(--muted2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div></div>
      ${r?`<div class="row" style="gap:14px;margin-top:12px;padding-top:11px;border-top:1px solid var(--track)">
        <span style="font-size:12.5px;font-weight:600;color:var(--soft)">${esc(r.road)}</span>
        <span style="font-size:12.5px;color:var(--muted)">${esc(r.km)}</span>
        <span style="font-size:12.5px;color:var(--muted)">${esc(r.time)}</span></div>`:''}
    </button>
    ${r&&r.coords?`<div id="routeMap" style="height:210px;border-radius:18px;overflow:hidden;margin-bottom:14px;border:1px solid var(--line);position:relative;z-index:0"></div>`:''}
    <div id="routeBody"></div>
  </div>`;

  if (r&&r.coords) buildRouteMap(r);
  const body = c.querySelector('#routeBody');
  if (!r){
    body.innerHTML = `<div class="empty"><div class="circle"><svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M6 20a3 3 0 0 1 0-6h9a3 3 0 0 0 0-6H6" stroke="var(--mintInk)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="6" r="2.2" fill="var(--mintInk)"/><circle cx="18" cy="20" r="2.2" fill="var(--mintInk)"/></svg></div><div class="t">Planifica tu ruta</div><div class="s">Indica origen y destino y te diré dónde repostar más barato a lo largo del camino.</div></div>`;
    return;
  }
  if (!r.stops || !r.stops.length){
    body.innerHTML = `<div class="banner"><span>No se han encontrado gasolineras con datos a lo largo de esta ruta.</span></div>`;
    return;
  }
  const rMin = Math.min(...r.stops.map(s=>s.price));
  const reco = r.stops.find(s=>s.price===rMin);
  body.innerHTML = `
    <div class="reco">
      <div class="ic">${pumpIcon('#17140E')}</div>
      <div style="flex:1">
        <div style="font-size:14.5px;font-weight:700;color:#fff;line-height:1.3">Reposta en ${esc(reco.brand)} · km ${reco.km}</div>
        <div style="font-size:13px;color:#B9C7BE;margin-top:3px;line-height:1.4">La más barata de tu ruta a ${fmtP(reco.price)} €/L. ${reco.onHwy?'Está casi en tu trazado, sin apenas desvío.':'Solo te desvías '+reco.detour+'.'}</div>
      </div>
    </div>
    <div style="font-size:13px;font-weight:700;color:var(--soft);margin-bottom:12px">Gasolineras en tu ruta</div>
    <div class="timeline"><div class="line"></div><div id="stops"></div></div>`;
  const stops = body.querySelector('#stops');
  r.stops.forEach(s=>{
    const cheap = s.price===rMin; const bm = brandMeta(s.brandKey);
    stops.appendChild(el(`<div class="stop">
      <span class="sd" style="background:${bm.color}"></span>
      <button class="sc ${cheap?'cheap':''}" data-open="${s.id}">
        <div style="min-width:0">
          <div class="row" style="gap:7px"><span class="sg" style="font-size:11.5px;font-weight:700;color:var(--muted2)">km ${s.km}</span><span style="font-size:14.5px;font-weight:700;color:var(--ink)">${esc(s.brand)}</span></div>
          <div style="font-size:12.5px;color:var(--muted);margin:1px 0 7px">${esc(s.place)}</div>
          <span class="exit" style="background:${s.onHwy?'var(--mint)':'#FBEED6'};color:${s.onHwy?'#2E7D5B':'#B4541F'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${s.onHwy?'En ruta · '+s.detour:'Desvío '+s.detour}</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0">
          <div class="pv"><span class="n" style="font-size:20px">${fmtP(s.price)}</span><span class="l">€/L</span></div>
          ${cheap?`<span style="font-size:10.5px;font-weight:800;color:var(--acc);text-transform:uppercase">Más barata</span>`:''}
        </div>
      </button>
    </div>`));
  });
}

function buildRouteMap(r){
  setTimeout(()=>{
    if (typeof L==='undefined' || S.tab!=='ruta' || !document.getElementById('routeMap')) return;
    const rm = L.map('routeMap', {zoomControl:false, attributionControl:false});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(rm);
    L.control.attribution({prefix:false, position:'bottomright'}).addAttribution('© OSM').addTo(rm);
    const line = L.polyline(r.coords, {color:'#224E40', weight:5, opacity:0.9}).addTo(rm);
    L.polyline(r.coords, {color:'#fff', weight:1.5, opacity:0.5}).addTo(rm);
    // origen (azul) y destino (terracota)
    if (r.o) L.marker([r.o.lat,r.o.lng], {icon:L.divIcon({className:'', html:`<div style="width:16px;height:16px;border-radius:50%;background:#2A6FDB;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`, iconSize:[16,16], iconAnchor:[8,8]})}).addTo(rm);
    if (r.d) L.marker([r.d.lat,r.d.lng], {icon:L.divIcon({className:'', html:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 23s8-7.2 8-13a8 8 0 1 0-16 0c0 5.8 8 13 8 13Z" fill="#B4541F" stroke="#fff" stroke-width="1.5"/></svg>`, iconSize:[24,24], iconAnchor:[12,23]})}).addTo(rm);
    // gasolineras
    const rMin = r.stops.length ? Math.min(...r.stops.map(s=>s.price)) : NaN;
    r.stops.forEach(s=>{
      if (isNaN(s.lat)||isNaN(s.lng)) return;
      const cheap = s.price===rMin;
      const icon = L.divIcon({ className:'', html:`<div class="map-pin ${cheap?'cheap':''}" style="font-size:${cheap?13:11}px;padding:3px 7px">${fmtP(s.price)}<span class="l">€</span></div>`, iconSize:[48,22], iconAnchor:[24,26] });
      L.marker([s.lat,s.lng], {icon, zIndexOffset: cheap?1000:0}).addTo(rm).on('click', ()=>{ S.detail=s.id; renderLayer(); });
    });
    rm.fitBounds(line.getBounds(), {padding:[28,28]});
    mapObj = rm;
    setTimeout(()=>rm.invalidateSize(), 80);
  }, 30);
}

async function planRoute(originText, destText){
  toast('Calculando ruta…');
  try {
    const geo = async q => { const j = await fetchJSON(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q+', España')}&format=json&limit=1`, 9000); return j[0]?{lat:+j[0].lat,lng:+j[0].lon,name:j[0].display_name.split(',')[0]}:null; };
    const [o,d] = await Promise.all([geo(originText), geo(destText)]);
    if (!o||!d){ toast('No encuentro origen o destino'); return; }
    const rj = await fetchJSON(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`, 15000);
    if (!rj.routes||!rj.routes[0]){ toast('No se pudo trazar la ruta'); return; }
    const route = rj.routes[0];
    const coords = route.geometry.coordinates.map(c=>[c[1],c[0]]); // [lat,lng]
    const km = Math.round(route.distance/1000), mins = Math.round(route.duration/60);
    const time = (mins>=60?Math.floor(mins/60)+' h '+String(mins%60).padStart(2,'0'):mins+' min');

    // estaciones a lo largo del corredor (usa dataset nacional, cacheado)
    toast('Buscando gasolineras…');
    const all = await nationalStations();
    const corridor = 4; // km
    const sampled = coords.filter((_,i)=> i % Math.max(1, Math.floor(coords.length/300)) === 0);
    const near = [];
    for (const st of all){
      if (isNaN(st.prices.diesel)) continue;
      let best = Infinity, atKm = 0;
      for (let i=0;i<sampled.length;i++){
        const dd = haversine(st.lat,st.lng,sampled[i][0],sampled[i][1]);
        if (dd<best){ best=dd; atKm = Math.round(km * i/sampled.length); }
        if (best<0.6) break;
      }
      if (best<=corridor){ st._detour=best; st._atKm=atKm; near.push(st); }
    }
    near.sort((a,b)=>a._atKm-b._atKm);
    // quedarnos con las mejores por tramos, máx ~6
    const stops = pickRouteStops(near);
    S.route = { origin:o.name, dest:d.name, o, d, road:'Por carretera', km:km+' km', time, coords, stops };
    save(); render();
    toast(stops.length? 'Ruta lista': 'Ruta trazada (sin gasolineras con datos)');
  } catch(e){ toast('Error planificando la ruta'); }
}

function pickRouteStops(near){
  if (!near.length) return [];
  const segs = 6; const maxKm = near[near.length-1]._atKm || 1;
  const chosen = [];
  for (let s=0;s<segs;s++){
    const lo = maxKm*s/segs, hi = maxKm*(s+1)/segs;
    const inSeg = near.filter(n=>n._atKm>=lo && n._atKm<hi);
    if (!inSeg.length) continue;
    const best = inSeg.sort((a,b)=>a.prices.diesel-b.prices.diesel)[0];
    chosen.push(best);
  }
  return chosen.map(st=>({
    id:st.id, brand:prettyName(st.rotulo), brandKey:st.brandKey, place:st.addr.split(',')[0]||'Estación',
    lat:st.lat, lng:st.lng,
    km:st._atKm, price:st.prices.diesel, onHwy:st._detour<1.2,
    detour: st._detour<1.2 ? '0 min' : '+'+Math.max(1,Math.round(st._detour*1.5))+' min',
  }));
}

let _national = null;
async function nationalStations(){
  if (_national) return _national;
  const j = await fetchJSON(`${API}/EstacionesTerrestres/`, 45000);
  _national = (j.ListaEESSPrecio||[]).map(e=>parseStation(e,null)).filter(s=>!isNaN(s.lat)&&!isNaN(s.lng));
  // añade al detalle: precio diesel del dataset
  return _national;
}

// ---------- FAVORITAS ----------
function renderFav(c){
  const med = medianPrice('diesel');
  const favStations = S.favorites.map(id=>stationById(id) || cachedFav(id)).filter(Boolean);
  const has = favStations.length>0;

  let trips=0, liters=0, spent=0, saved=0;
  favStations.forEach(s=>{ (S.visits[s.id]||[]).forEach(v=>{ trips++; liters+=v.liters; spent+=v.liters*v.price; if(!isNaN(med)&&med>v.price) saved+=(med-v.price)*v.liters; }); });

  c.innerHTML = `
  <div class="pad pt">
    <div class="topbar"><h1 class="h1 h1s">Favoritas</h1>
      <div class="row" style="gap:9px">
        ${has?`<button class="iconbtn" style="width:auto;padding:0 14px;height:38px;border-radius:100px;background:var(--card);border:1px solid var(--line);color:var(--ink);font-size:13px;font-weight:700;gap:6px" data-act="export"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Exportar</button>`:''}
        ${moonBtn()}
      </div>
    </div>
    ${has?`
      <div class="hero" style="border-radius:20px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:#B9C7BE;margin-bottom:14px">Tus repostajes registrados</div>
        <div class="row" style="gap:20px">
          <div><div class="sg" style="font-weight:700;font-size:24px;color:#fff">${trips}</div><div style="font-size:11.5px;color:#9FB0A5">paradas</div></div>
          <div><div class="sg" style="font-weight:700;font-size:24px;color:#fff">${Math.round(liters)} L</div><div style="font-size:11.5px;color:#9FB0A5">repostados</div></div>
          <div><div class="sg" style="font-weight:700;font-size:24px;color:#fff">${fmtE(spent)}</div><div style="font-size:11.5px;color:#9FB0A5">gastado</div></div>
        </div>
        <div class="row" style="gap:7px;margin-top:14px;padding-top:13px;border-top:1px solid rgba(255,255,255,0.12)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 17l5-5 4 4 8-8" stroke="var(--acc)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span style="font-size:12.5px;color:#B9C7BE;font-weight:600">Ahorro estimado vs media: <b style="color:var(--acc)">${fmtE(saved)}</b></span>
        </div>
      </div>
      <div id="favList"></div>
    `:`
      <div class="empty"><div class="circle"><svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 3.5C19 15.7 12 20 12 20Z" stroke="var(--mintInk)" stroke-width="2" stroke-linejoin="round"/></svg></div>
        <div class="t">Sin favoritas todavía</div><div class="s">Toca el ♥ en una gasolinera para guardarla y registrar tus repostajes.</div></div>
    `}
  </div>`;

  if (has){
    const wrap = c.querySelector('#favList');
    favStations.forEach(s=>{
      const visits = (S.visits[s.id]||[]);
      const vh = visits.map(v=>`<div class="row" style="justify-content:space-between;padding:9px 0;border-top:1px solid var(--track)">
        <div class="row" style="gap:9px"><span style="width:8px;height:8px;border-radius:50%;background:${v.date==='Hoy'?'var(--acc)':'var(--mintInk)'};flex-shrink:0"></span>
        <div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">${esc(v.date)}</div><div style="font-size:11.5px;color:var(--muted)">${v.liters} L · ${fmtP(v.price)} €/L</div></div></div>
        <span class="sg" style="font-weight:700;font-size:15px;color:var(--head)">${fmtE(v.liters*v.price)}</span></div>`).join('');
      wrap.appendChild(el(`<div class="panel" style="border-radius:20px;margin-bottom:12px;overflow:hidden;padding:0">
        <div class="row" style="gap:10px;padding:14px 16px">
          <button data-open="${s.id}" style="flex:1;min-width:0;text-align:left;background:none;border:none;cursor:pointer;padding:0">
            <div class="row" style="gap:7px"><span class="dot" style="background:${brandMeta(s.brandKey).color};margin:0"></span><span style="font-size:12.5px;font-weight:700;color:var(--soft)">${esc(s.brandName)}</span></div>
            <div style="font-size:15.5px;font-weight:700;color:var(--ink);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:1px">${!isNaN(priceOf(s,'diesel'))?'Hoy a '+fmtP(priceOf(s,'diesel'))+' €/L':''}${s.dist!=null?' · '+fmtKm(s.dist)+' km':''}</div>
          </button>
          <button class="iconbtn" style="background:var(--mint)" data-unfav="${s.id}"><svg width="19" height="19" viewBox="0 0 24 24"><path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 3.5C19 15.7 12 20 12 20Z" fill="var(--acc)"/></svg></button>
        </div>
        ${visits.length?`<div style="padding:0 16px 8px"><div style="font-size:11px;font-weight:800;color:var(--muted2);text-transform:uppercase;letter-spacing:0.4px;padding:4px 0">Paradas aquí</div>${vh}</div>`:''}
      </div>`));
    });
  }
}
function cachedFav(id){
  // estación favorita que ya no está en el dataset cercano: recupera datos mínimos del historial/visitas
  const v = (S.visits[id]||[])[0];
  return { id, brandKey:'otra', brandName:'Favorita', name:'Estación guardada', addr:'', dist:null,
    prices:{diesel: v?v.price:NaN, gasolina:NaN, glp:NaN}, extra:{}, hours:'', open:null, lat:NaN, lng:NaN };
}

// ---------- AHORRO ----------
function renderAhorro(c){
  const list = filtered();
  const T = S.tank;
  const med = medianPrice('diesel');
  const cheapest = DATA.stations.map(s=>s.prices.diesel).filter(p=>!isNaN(p)).sort((a,b)=>a-b)[0];
  const dearest = DATA.stations.map(s=>s.prices.diesel).filter(p=>!isNaN(p)).sort((a,b)=>b-a)[0];
  const fillC = cheapest*T, fillM = med*T, fillE = dearest*T;
  const perFill = (med-cheapest)*T, month = perFill*6, year = month*12;
  const ok = !isNaN(cheapest) && !isNaN(med) && !isNaN(dearest);

  c.innerHTML = `
  <div class="pad pt">
    <div class="topbar" style="align-items:flex-start"><h1 class="h1 h1s">Tu ahorro</h1>${moonBtn()}</div>
    <p style="margin:0 0 16px;font-size:13.5px;color:var(--soft);line-height:1.4">Repostando en la más barata frente a la media de tu zona.</p>
    ${!ok?`<div class="banner"><span>Necesito precios de tu zona para calcular el ahorro. Abre la pestaña Lista con conexión.</span></div>`:`
    <div class="hero" style="margin-bottom:16px">
      <div class="blob"></div>
      <div style="font-size:13px;font-weight:600;color:#B9C7BE">Ahorro por depósito (<button data-act="tank" style="background:none;border:none;color:var(--acc);font-weight:700;cursor:pointer;font-size:13px;padding:0">${T} L ✎</button>)</div>
      <div class="sg" style="font-weight:700;font-size:52px;line-height:1;color:var(--acc);letter-spacing:-1px;margin:6px 0 2px">${fmtE(perFill)}</div>
      <div class="row" style="gap:22px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.12)">
        <div><div class="sg" style="font-weight:700;font-size:20px;color:#fff">${fmtE(month)}</div><div style="font-size:11.5px;color:#9FB0A5">al mes · 6 repostajes</div></div>
        <div><div class="sg" style="font-weight:700;font-size:20px;color:#fff">${fmtE(year)}</div><div style="font-size:11.5px;color:#9FB0A5">al año</div></div>
      </div>
    </div>
    <div class="panel">
      <div style="font-size:13px;font-weight:700;color:var(--soft);margin-bottom:16px">Coste de llenar el depósito</div>
      ${bar('Más barata', fillC, fillE, 'var(--acc)', 'var(--head)')}
      ${bar('Media de la zona', fillM, fillE, '#C9B98F', 'var(--soft)')}
      ${bar('Más cara', fillE, fillE, S.theme==='night'?'#3A4D44':'#D9CDB4', 'var(--muted)')}
    </div>
    <div style="text-align:center;font-size:12px;color:var(--muted2);margin-top:14px;line-height:1.4">Cálculo sobre diésel · media de ${DATA.stations.length} estaciones cercanas.<br>Precios oficiales · ${dataAgeLabel()}.</div>
    `}
  </div>`;
}
function bar(label, val, max, color, txt){
  return `<div style="margin-bottom:15px">
    <div class="row" style="justify-content:space-between;margin-bottom:6px"><span style="font-size:13px;font-weight:${label==='Más barata'?700:600};color:${txt}">${label}</span><span class="sg" style="font-weight:700;font-size:14px;color:${txt}">${fmtE(val)}</span></div>
    <div style="height:14px;background:var(--track);border-radius:8px;overflow:hidden"><div style="width:${(val/max*100).toFixed(1)}%;background:${color};height:100%;border-radius:8px"></div></div>
  </div>`;
}

// ---------- DETALLE + sheets (capa overlay) ----------
function renderLayer(){
  const layer = $('#layer');
  let html = '';
  if (S.zoneSheet) html += zoneSheetHtml();
  if (S.routeSheet) html += routeSheetHtml();
  if (S.exportSheet) html += exportSheetHtml();
  if (S.detail) html += detailHtml(S.detail);
  layer.innerHTML = html;
}

function detailHtml(id){
  const s = stationById(id);
  if (!s) return '';
  const T = S.tank;
  const isLocal = DATA.stations.some(x=>x.id===id);
  const med = isLocal ? medianPrice('diesel') : NaN; // solo comparamos contra la media si es de tu zona
  const sorted = DATA.stations.filter(x=>!isNaN(x.prices.diesel)).sort((a,b)=>a.prices.diesel-b.prices.diesel);
  const idx = isLocal ? sorted.findIndex(x=>x.id===id) : -1;
  const cheap = idx===0;
  const p = s.prices.diesel;
  const save = isNaN(med)?NaN:(med-p)*T;
  const fav = S.favorites.includes(id);
  const cm = camperOf(id);
  const hist = (S.history[id]||[]);
  const visits = (S.visits[id]||[]);

  let spark = '';
  if (hist.length>=2){
    const vals = hist.map(h=>h.p); const mn=Math.min(...vals), mx=Math.max(...vals), rng=(mx-mn)||1;
    const pts = vals.map((v,i)=>`${(i*(100/(vals.length-1))).toFixed(1)},${(34-((v-mn)/rng)*28).toFixed(1)}`).join(' ');
    spark = `<div class="panel" style="border-radius:20px;padding:16px 18px;margin-top:14px">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><span style="font-size:13px;font-weight:700;color:var(--soft)">Precio diésel registrado</span><span style="font-size:11.5px;color:var(--muted2)">${fmtP(mn)} – ${fmtP(mx)} €/L</span></div>
      <svg width="100%" height="56" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#3E8A72" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></div>`;
  }

  const fuels = [
    ['Diésel', s.prices.diesel, true],
    ['Diésel Premium', s.extra.premium, false],
    ['Gasolina 95', s.extra.g95, false],
    ['GLP', s.prices.glp, false],
    ['AdBlue', s.extra.adblue, false],
  ].filter(f=>!isNaN(f[1])).map(([label,val,main])=>`
    <div class="row" style="justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--track)">
      <div class="row" style="gap:8px"><span style="font-size:14.5px;font-weight:600;color:var(--ink)">${label}</span>${main?`<span style="font-size:10px;font-weight:800;color:var(--mintInk);background:var(--mint);padding:2px 6px;border-radius:6px;text-transform:uppercase">Tu combustible</span>`:''}</div>
      <div class="pv"><span class="sg" style="font-weight:700;font-size:${main?20:17}px;color:${main?(S.theme==='night'?'#7FC9B4':'#224E40'):'var(--ink)'}">${fmtP(val)}</span><span class="l">€/L</span></div>
    </div>`).join('');

  const visitsHtml = visits.length ? visits.map(v=>`
    <div class="row" style="justify-content:space-between;padding:10px 0;border-top:1px solid var(--track)">
      <div class="row" style="gap:9px"><span style="width:8px;height:8px;border-radius:50%;background:${v.date==='Hoy'?'var(--acc)':'var(--mintInk)'};flex-shrink:0"></span>
      <div><div style="font-size:13.5px;font-weight:600;color:var(--ink)">${esc(v.date)}</div><div style="font-size:11.5px;color:var(--muted)">${v.liters} L · ${fmtP(v.price)} €/L</div></div></div>
      <span class="sg" style="font-weight:700;font-size:15px;color:var(--head)">${fmtE(v.liters*v.price)}</span></div>`).join('')
    : `<div style="font-size:12.5px;color:var(--muted);padding:6px 0 14px;line-height:1.4">Aún no has parado aquí. Pulsa «Registrar» al repostar para guardar el litraje y el precio del día.</div>`;

  const camperRow = (k,icon,title,onLabel,offLabel)=>{
    const on = cm[k];
    return `<button data-camper="${id}:${k}" style="width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 15px;display:flex;align-items:center;gap:13px;cursor:pointer">
      <div style="width:38px;height:38px;border-radius:11px;background:var(--mint);color:var(--mintInk);display:flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
      <div style="flex:1"><div style="font-size:14px;font-weight:700;color:var(--ink)">${title}</div><div style="font-size:12.5px;color:var(--muted)">${on?onLabel:offLabel}</div></div>
      <span style="display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;border-radius:8px;font-weight:800;font-size:15px;background:${on?'var(--mint)':'var(--track)'};color:${on?'#2E7D5B':'var(--muted2)'}">${on?'✓':'—'}</span>
    </button>`;
  };

  return `<div class="overlay scr">
    <div style="height:calc(42px + env(safe-area-inset-top))"></div>
    <div style="padding:4px 18px 30px">
      <div class="row" style="justify-content:space-between;padding:6px 0 14px">
        <button class="iconbtn" style="width:40px;height:40px;background:var(--card);border:1px solid var(--line)" data-act="closeDetail"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="m15 5-7 7 7 7" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="row" style="gap:8px">
          <button class="iconbtn" style="width:40px;height:40px;background:var(--card);border:1px solid var(--line)" data-fav="${id}"><svg width="19" height="19" viewBox="0 0 24 24" fill="${fav?'var(--acc)':'none'}"><path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 3.5C19 15.7 12 20 12 20Z" stroke="${fav?'var(--acc)':'var(--soft)'}" stroke-width="2" stroke-linejoin="round"/></svg></button>
          <button class="iconbtn" style="width:40px;height:40px;background:var(--card);border:1px solid var(--line)" data-share="${id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="12" r="2" fill="var(--soft)"/><circle cx="18" cy="6" r="2" fill="var(--soft)"/><circle cx="18" cy="18" r="2" fill="var(--soft)"/><path d="m8 11 8-4M8 13l8 4" stroke="var(--soft)" stroke-width="1.6"/></svg></button>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-bottom:5px"><span class="dot" style="width:12px;height:12px;border-radius:4px;background:${brandMeta(s.brandKey).color};margin:0"></span><span style="font-size:13px;font-weight:700;color:var(--soft)">${esc(s.brandName)}</span>${s.open!==null?`<span style="font-size:12px;font-weight:700;color:${s.open?'#2E7D5B':'#D06A5A'}">· ${s.open?'Abierto ahora':'Cerrado'}</span>`:''}</div>
      <h1 class="h1 h1s" style="font-size:26px">${esc(s.name)}</h1>
      <div style="font-size:13.5px;color:var(--muted);margin-top:5px">${esc(s.addr)}${s.dist!=null?' · a '+fmtKm(s.dist)+' km':''}</div>

      <div class="panel" style="border-radius:22px;padding:20px;margin-top:18px">
        <div style="font-size:12.5px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${cheap?'La más barata de la zona':(idx>=0?'#'+(idx+1)+' más barata cerca':'')}</div>
        <div class="row" style="align-items:baseline;gap:4px"><span class="sg" style="font-weight:700;font-size:54px;line-height:1;color:${cheap?'var(--acc)':'var(--ink)'};letter-spacing:-1px">${fmtP(p)}</span><span style="font-size:15px;font-weight:600;color:var(--muted)">€/L</span></div>
        ${!isNaN(save)?`<div style="font-size:13px;font-weight:700;color:${save>=0?'#2E7D5B':(S.theme==='night'?'#E8A06A':'#B4541F')};margin-top:6px">${save>=0?'Ahorras '+fmtE(save)+' por depósito vs media':'+'+fmtE(-save)+' sobre la media de la zona'}</div>`:''}
        <div class="row" style="gap:10px;margin-top:18px">
          <button class="btn-pine" style="flex:1" data-go="${id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 11 22 2l-9 19-2-8-8-2Z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>Cómo llegar</button>
          <button data-fav="${id}" style="background:${fav?'var(--acc)':'var(--card)'};color:${fav?'#17140E':'#3E7A66'};border:1.5px solid ${fav?'var(--acc)':'#3E7A66'};border-radius:14px;padding:14px 16px;font-size:15px;font-weight:700;cursor:pointer">${fav?'Guardada':'Guardar'}</button>
        </div>
      </div>

      ${spark}

      <div class="panel" style="border-radius:20px;padding:6px 18px;margin-top:14px">${fuels||'<div style="padding:14px 0;font-size:13px;color:var(--muted)">Sin más combustibles con datos.</div>'}</div>

      <div class="panel" style="border-radius:20px;padding:16px 18px 8px;margin-top:14px">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><span style="font-size:13px;font-weight:700;color:var(--soft)">Tus paradas aquí</span>
          <button data-addvisit="${id}" style="display:inline-flex;align-items:center;gap:5px;background:var(--mint);color:var(--mintInk);border:none;border-radius:10px;padding:7px 11px;font-size:12.5px;font-weight:700;cursor:pointer"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>Registrar</button></div>
        ${visitsHtml}
      </div>

      <div style="margin-top:14px">
        <div style="font-size:13px;font-weight:700;color:var(--soft);margin:4px 0 10px">Para tu autocaravana <span style="font-weight:500;color:var(--muted2);font-size:11.5px">· tú lo marcas</span></div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${camperRow('easy', pumpIcon('currentColor'),'Surtidor accesible','Acceso amplio sin maniobra','Toca para marcar')}
          ${camperRow('water','<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>','Agua y vaciado','Punto de agua/vaciado cerca','Toca para marcar')}
          ${camperRow('overnight','<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>','Área de pernocta','Zona de pernocta cerca','Toca para marcar')}
        </div>
      </div>

      <div class="row" style="gap:8px;margin-top:16px;font-size:12.5px;color:var(--muted2)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>${s.hours?'Horario '+esc(s.hours)+' · ':''}precio oficial ${dataAgeLabel()}</div>
    </div>
  </div>`;
}

function zoneSheetHtml(){
  return `<div class="scrim" data-close="zone"><div class="sheet" data-stop>
    <div class="grab"></div>
    <h3 class="sg" style="font-weight:700;font-size:19px;color:var(--head);margin-bottom:4px">Tu zona</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Usamos tu ubicación para mostrar las gasolineras más cercanas.</p>
    <button class="btn-pine" style="width:100%" data-act="locate"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" stroke="#fff" stroke-width="2"/></svg>Usar mi ubicación actual</button>
    <p style="font-size:12px;color:var(--muted2);margin-top:12px;text-align:center">${DATA.province?'Zona actual: '+esc(prettyName(DATA.province)):'Sin ubicación detectada'} · ${DATA.stations.length} estaciones</p>
  </div></div>`;
}

function routeSheetHtml(){
  return `<div class="scrim" data-close="route"><div class="sheet" data-stop>
    <div class="grab"></div>
    <h3 class="sg" style="font-weight:700;font-size:19px;color:var(--head);margin-bottom:4px">Planifica tu ruta</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Escribe origen y destino. Calculo el camino y las gasolineras más baratas por el trayecto.</p>
    <input class="input" id="ro" placeholder="Origen (p. ej. Zaragoza)" value="${S.route?esc(S.route.origin):''}" style="margin-bottom:10px" autocomplete="off">
    <input class="input" id="rd" placeholder="Destino (p. ej. Barcelona)" value="${S.route?esc(S.route.dest):''}" style="margin-bottom:16px" autocomplete="off">
    <button class="btn-pine" style="width:100%" data-act="doroute"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 20a3 3 0 0 1 0-6h9a3 3 0 0 0 0-6H6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Calcular ruta</button>
    <p style="font-size:11.5px;color:var(--muted2);margin-top:12px;text-align:center">Rutas por OpenStreetMap (OSRM) · gasolineras del Ministerio</p>
  </div></div>`;
}

function exportSheetHtml(){
  const favStations = S.favorites.map(id=>stationById(id)||cachedFav(id)).filter(Boolean);
  const monthFull = {ene:'Enero',feb:'Febrero',mar:'Marzo',abr:'Abril',may:'Mayo',jun:'Junio',jul:'Julio',ago:'Agosto',sep:'Septiembre',oct:'Octubre',nov:'Noviembre',dic:'Diciembre'};
  const order = {ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12};
  const allV = [];
  favStations.forEach(s=>{ (S.visits[s.id]||[]).forEach(v=>{ const m = v.date==='Hoy' ? monthKeyNow() : (v.date.split(' ')[1]||monthKeyNow()); allV.push({m, station:s.name, date:v.date, liters:v.liters, price:v.price, total:v.liters*v.price}); }); });
  const grp = {};
  allV.forEach(v=>{ (grp[v.m] = grp[v.m]||{m:v.m,trips:0,liters:0,total:0}); grp[v.m].trips++; grp[v.m].liters+=v.liters; grp[v.m].total+=v.total; });
  const rows = Object.values(grp).sort((a,b)=>order[b.m]-order[a.m]).map(g=>`
    <div class="row" style="justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--track)">
      <div><div style="font-size:14.5px;font-weight:700;color:var(--ink)">${monthFull[g.m]||g.m}</div><div style="font-size:12px;color:var(--muted)">${g.trips} repostajes · ${Math.round(g.liters)} L</div></div>
      <span class="sg" style="font-weight:700;font-size:17px;color:var(--head)">${fmtE(g.total)}</span></div>`).join('');
  const total = allV.reduce((a,v)=>a+v.total,0);
  return `<div class="scrim" data-close="export"><div class="sheet" data-stop>
    <div class="grab"></div>
    <h3 class="sg" style="font-weight:700;font-size:19px;color:var(--head);margin-bottom:4px">Exportar gastos</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Resumen de tus repostajes registrados, por mes.</p>
    <div class="panel" style="border-radius:18px;padding:4px 16px">${rows||'<div style="padding:14px 0;font-size:13px;color:var(--muted)">Sin repostajes registrados todavía.</div>'}
      <div class="row" style="justify-content:space-between;padding:14px 0"><span style="font-size:13.5px;font-weight:700;color:var(--soft)">Total</span><span class="sg" style="font-weight:700;font-size:20px;color:var(--acc)">${fmtE(total)}</span></div>
    </div>
    <div class="row" style="gap:10px;margin-top:16px">
      <button class="btn-pine" style="flex:1" data-act="csv"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Descargar CSV</button>
      <button class="btn-ghost" data-act="sharecsv">Compartir</button>
    </div>
  </div></div>`;
}
function monthKeyNow(){ return ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][new Date().getMonth()]; }

// ---------- Acciones ----------
function toggleFav(id){
  const i = S.favorites.indexOf(id);
  if (i>=0) S.favorites.splice(i,1); else { S.favorites.push(id); recordHistory(DATA.stations); }
  save(); render();
}
function addVisit(id){
  const s = stationById(id); if (!s||isNaN(s.prices.diesel)) { toast('Sin precio para registrar'); return; }
  const arr = (S.visits[id]||[]).slice();
  arr.unshift({date:'Hoy', liters:S.tank, price:s.prices.diesel});
  S.visits[id] = arr;
  if (!S.favorites.includes(id)) S.favorites.push(id);
  save(); render(); toast('Repostaje registrado · '+S.tank+' L');
}
function toggleCamper(id, k){
  const cm = {...camperOf(id)}; cm[k] = !cm[k]; S.camper[id] = cm; save(); render();
}
function csv(share){
  const favStations = S.favorites.map(id=>stationById(id)||cachedFav(id)).filter(Boolean);
  const lines = ['Fecha,Gasolinera,Litros,Precio EUR/L,Total EUR'];
  favStations.forEach(s=>{ (S.visits[s.id]||[]).forEach(v=>{ lines.push([v.date,'"'+s.name.replace(/"/g,'')+'"',v.liters,fmtP(v.price),(v.liters*v.price).toFixed(2).replace('.',',')].join(',')); }); });
  const text = lines.join('\n');
  if (share && navigator.share){ navigator.share({title:'Mis repostajes', text}).catch(()=>{}); return; }
  const blob = new Blob([text], {type:'text/csv;charset=utf-8'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='repostajes-camper.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  S.exportSheet=false; render(); toast('CSV descargado');
}
function navigateTo(id){
  const s = stationById(id); if (!s||isNaN(s.lat)) return;
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, '_blank');
}
function shareStation(id){
  const s = stationById(id); if (!s) return;
  const text = `${s.name} · Diésel ${fmtP(s.prices.diesel)} €/L`;
  if (navigator.share) navigator.share({title:s.name, text, url: !isNaN(s.lat)?`https://maps.google.com/?q=${s.lat},${s.lng}`:undefined}).catch(()=>{});
  else { navigator.clipboard?.writeText(text); toast('Copiado al portapapeles'); }
}

// ---------- Eventos ----------
document.addEventListener('click', async (ev)=>{
  const t = ev.target.closest('[data-tab],[data-open],[data-brand],[data-fuel],[data-act],[data-fav],[data-unfav],[data-addvisit],[data-camper],[data-go],[data-share],[data-close],[data-stop]');
  if (!t) return;

  if (t.dataset.stop!==undefined){ ev.stopPropagation(); return; }
  if (t.dataset.close!==undefined){ S.zoneSheet=S.routeSheet=S.exportSheet=false; renderLayer(); return; }

  if (t.dataset.tab){ S.tab=t.dataset.tab; S.detail=null; render(); return; }
  if (t.dataset.open){ S.detail=t.dataset.open; renderLayer(); return; }
  if (t.dataset.fuel){ S.fuel=t.dataset.fuel; save(); render(); return; }
  if (t.dataset.brand){
    const k=t.dataset.brand;
    if (k==='todas') S.brands=[]; else { const i=S.brands.indexOf(k); if(i>=0) S.brands.splice(i,1); else S.brands.push(k); }
    render(); return;
  }
  if (t.dataset.fav){ toggleFav(t.dataset.fav); return; }
  if (t.dataset.unfav){ toggleFav(t.dataset.unfav); return; }
  if (t.dataset.addvisit){ addVisit(t.dataset.addvisit); return; }
  if (t.dataset.camper){ const [id,k]=t.dataset.camper.split(':'); toggleCamper(id,k); return; }
  if (t.dataset.go){ navigateTo(t.dataset.go); return; }
  if (t.dataset.share){ shareStation(t.dataset.share); return; }

  const act = t.dataset.act;
  if (act==='theme'){ S.theme = S.theme==='night'?'day':'night'; save(); render(); }
  else if (act==='closeDetail'){ S.detail=null; renderLayer(); }
  else if (act==='zone'){ S.zoneSheet=true; renderLayer(); }
  else if (act==='routesheet'){ S.routeSheet=true; renderLayer(); }
  else if (act==='export'){ S.exportSheet=true; renderLayer(); }
  else if (act==='csv'){ csv(false); }
  else if (act==='sharecsv'){ csv(true); }
  else if (act==='locate'){ S.zoneSheet=false; renderLayer(); toast('Buscando estaciones…'); await refreshData(); render(); }
  else if (act==='doroute'){ const o=$('#ro').value.trim(), d=$('#rd').value.trim(); if(!o||!d){toast('Rellena origen y destino');return;} S.routeSheet=false; renderLayer(); await planRoute(o,d); }
  else if (act==='tank'){ const v=prompt('Tamaño del depósito en litros:', S.tank); const n=parseInt(v); if(n>=20&&n<=200){ S.tank=n; save(); render(); } }
});

// búsqueda en mapa (enter)
document.addEventListener('keydown', async (ev)=>{
  if (ev.key==='Enter' && ev.target.dataset && ev.target.dataset.act==='mapsearch'){
    const q = ev.target.value.trim(); if(!q) return;
    try { const j = await fetchJSON(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q+', España')}&format=json&limit=1`,8000);
      if (j[0] && mapObj) mapObj.setView([+j[0].lat,+j[0].lon], 14); else toast('No encontrado'); } catch(e){ toast('Error buscando'); }
  }
});

// ---------- Init ----------
async function init(){
  load();
  setAccent();
  render();
  if (navigator.onLine && (!DATA.stations.length || Date.now()-DATA.updated > STALE_MS)){
    try { await refreshData(); render(); }
    catch(e){ if (!DATA.stations.length) toast('No se pudieron cargar los precios'); }
  }
}
window.addEventListener('online', ()=>{ if (!DATA.stations.length || Date.now()-DATA.updated>STALE_MS) refreshData().then(render); });
init();
