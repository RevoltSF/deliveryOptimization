/* ---------- In-memory app state, cached to localStorage as a safety net ---------- */
const LS_STATE = 'wp_app_state_cache';
let appState = {
  places: [],
  startPoints: [],
  refreshIntervalDays: 7,
  lastImportAt: null
};
let googleApiKey = '';   // mirrored to localStorage — see onApiKeyInput/restoreApiKey below
const LS_API_KEY = 'wp_google_api_key';
function onApiKeyInput(value){
  googleApiKey = value.trim();
  try{ localStorage.setItem(LS_API_KEY, googleApiKey); }catch(e){ console.error('Save failed:', e); }
  ensureMapLoaded();
}
function restoreApiKey(){
  try{
    const saved = localStorage.getItem(LS_API_KEY);
    if(saved){
      googleApiKey = saved;
      document.getElementById('api-key').value = saved;
    }
  }catch(e){ console.error('Restore failed:', e); }
}
function clearApiKey(){
  googleApiKey = '';
  document.getElementById('api-key').value = '';
  localStorage.removeItem(LS_API_KEY);
}

// Mirrors appState into localStorage on every change, so the browser remembers
// places, saved starts, and settings between visits.
function persistLocal(){
  try{
    localStorage.setItem(LS_STATE, JSON.stringify(appState));
  }catch(e){
    console.error('Save failed:', e);
  }
}
function restoreLocal(){
  try{
    const raw = localStorage.getItem(LS_STATE);
    if(!raw) return false;
    const cached = JSON.parse(raw);
    appState.places = cached.places||[];
    appState.startPoints = cached.startPoints||[];
    appState.refreshIntervalDays = cached.refreshIntervalDays||7;
    appState.lastImportAt = cached.lastImportAt||null;
    return true;
  }catch(e){
    console.error('Restore failed:', e);
    return false;
  }
}

function loadPlaces(){ return appState.places; }
function savePlaces(list){ appState.places = list; persistLocal(); }

function loadStartPoints(){ return appState.startPoints; }
function saveStartPoints(list){ appState.startPoints = list; persistLocal(); }

/* ---------- Merge / dedupe ---------- */
function dedupeKey(p){ return p.name.trim().toLowerCase()+'|'+p.lat.toFixed(4)+'|'+p.lng.toFixed(4); }

function mergePlaces(newOnes){
  const existing = loadPlaces();
  const seen = new Set(existing.map(dedupeKey));
  let added = 0;
  newOnes.forEach(p=>{
    if(!p.name || isNaN(p.lat) || isNaN(p.lng)) return;
    const key = dedupeKey(p);
    if(!seen.has(key)){
      existing.push({...p, checked:false, id: crypto.randomUUID()});
      seen.add(key);
      added++;
    }
  });
  savePlaces(existing);
  appState.lastImportAt = Date.now();
  persistLocal();
  renderPlaceList();
  checkRefreshBanner();
  return added;
}

/* ---------- Parsing ---------- */
function parsePastedContent(text){
  text = text.trim();
  if(!text) return [];

  // Try JSON (Google Takeout "Saved Places.json" format: {features:[{geometry:{coordinates:[lng,lat]}, properties:{...}}]})
  try{
    const data = JSON.parse(text);

    // Waypoint's own export format: flat array of {name, lat, lng, ...}
    if(Array.isArray(data) && data.length>0 && data[0].lat!==undefined && data[0].lng!==undefined){
      return data.map(p=>({name:p.name||'Unnamed place', lat:p.lat, lng:p.lng, src:p.src||'backup'}))
        .filter(p=>!isNaN(p.lat) && !isNaN(p.lng));
    }

    if(data.features){
      const geocoded = [];
      const needsGeocode = [];
      data.features.forEach(f=>{
        const coords = f.geometry && f.geometry.coordinates;
        const props = f.properties || {};
        const name = props.name || props.location?.name || null;
        if(!coords) return;
        const [lng, lat] = coords;
        // Takeout often writes [0,0] placeholder coords when it couldn't resolve
        // a location, and puts the real address in google_maps_url's "q" param instead.
        if((lat===0 && lng===0) || isNaN(lat) || isNaN(lng)){
          let address = null;
          if(props.google_maps_url){
            try{
              const u = new URL(props.google_maps_url);
              address = u.searchParams.get('q');
            }catch(e){ /* ignore malformed url */ }
          }
          if(address) needsGeocode.push(name || address);
        } else {
          geocoded.push({name: name || 'Unnamed place', lat, lng, src:'takeout'});
        }
      });
      return {geocoded, needsGeocode};
    }
  }catch(e){ /* not JSON, fall through */ }

  // Try KML
  if(text.includes('<kml') || text.includes('<Placemark')){
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const placemarks = Array.from(xml.getElementsByTagName('Placemark'));
    return placemarks.map(pm=>{
      const name = pm.getElementsByTagName('name')[0]?.textContent || 'Unnamed place';
      const coordText = pm.getElementsByTagName('coordinates')[0]?.textContent;
      if(!coordText) return null;
      const [lng, lat] = coordText.trim().split(',').map(Number);
      return {name, lat, lng, src:'kml'};
    }).filter(Boolean);
  }

  // Try plain "Name, lat, lng" lines
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const results = [];
  lines.forEach(line=>{
    const parts = line.split(',');
    if(parts.length>=3){
      const lat = parseFloat(parts[parts.length-2]);
      const lng = parseFloat(parts[parts.length-1]);
      const name = parts.slice(0,parts.length-2).join(',').trim();
      if(!isNaN(lat) && !isNaN(lng)) results.push({name, lat, lng, src:'manual'});
    }
  });
  return results;
}

function importFromPaste(){
  const text = document.getElementById('paste-box').value;
  const parsed = parsePastedContent(text);
  const status = document.getElementById('import-status');

  // Normalize: parser returns either a flat array, or {geocoded, needsGeocode} when
  // Takeout gave us [0,0] placeholder coords and only an address.
  const geocoded = Array.isArray(parsed) ? parsed : parsed.geocoded;
  const needsGeocode = Array.isArray(parsed) ? [] : parsed.needsGeocode;

  if(geocoded.length===0 && needsGeocode.length===0){
    status.style.color = 'var(--danger)';
    status.textContent = "Couldn't find any places in that text. Check the format and try again.";
    return;
  }

  const added = geocoded.length ? mergePlaces(geocoded) : 0;

  let msg = '';
  if(geocoded.length) msg += `Found ${geocoded.length} places with coordinates, added ${added} new. `;
  if(needsGeocode.length){
    msg += `${needsGeocode.length} place(s) had no coordinates in the export (a known Takeout gap) — moved their addresses into "Add places by name/address" below. Add your API key there and click "Look up & add" to finish importing them.`;
    const box = document.getElementById('bulk-geocode-box');
    box.value = (box.value ? box.value + '\n' : '') + needsGeocode.join('\n');
    document.getElementById('bulk-geocode-box').scrollIntoView({behavior:'smooth', block:'center'});
  }
  status.style.color = needsGeocode.length ? 'var(--amber)' : 'var(--teal)';
  status.textContent = msg;
  document.getElementById('paste-box').value = '';
}

function importFromFile(evt){
  const file = evt.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    document.getElementById('paste-box').value = e.target.result;
    importFromPaste();
  };
  reader.readAsText(file);
  evt.target.value = '';
}

function focusPasteBox(){ document.getElementById('paste-box').focus(); }

// Opens the Advanced panel (where Import places now lives) and scrolls/focuses the paste box.
// Used by the "Refresh now" banner button, since the import card is no longer in the main flow.
function openImportInAdvanced(){
  document.getElementById('advanced-panel').style.display = 'block';
  document.getElementById('paste-card').scrollIntoView({behavior:'smooth'});
  focusPasteBox();
}

/* ---------- Refresh reminder ---------- */
function checkRefreshBanner(){
  const last = appState.lastImportAt;
  const intervalDays = appState.refreshIntervalDays;
  const banner = document.getElementById('refresh-banner');
  if(!last){ banner.style.display='none'; return; }
  const daysSince = Math.floor((Date.now()-last)/86400000);
  if(daysSince >= intervalDays){
    banner.style.display='flex';
    document.getElementById('refresh-banner-text').textContent =
      `Last updated ${daysSince} day${daysSince===1?'':'s'} ago — refresh from Google Maps to catch new saves?`;
  } else {
    banner.style.display='none';
  }
}

function toggleSettings(){
  const panel = document.getElementById('settings-panel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
}
function toggleAdvanced(){
  const panel = document.getElementById('advanced-panel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
}
function saveRefreshInterval(){
  appState.refreshIntervalDays = parseInt(document.getElementById('refresh-interval').value);
  persistLocal();
  checkRefreshBanner();
}
function clearAllData(){
  if(confirm('This resets your places, saved starts, and settings — permanently, in this browser. Continue?')){
    appState = { places: [], startPoints: [], refreshIntervalDays: 7, lastImportAt: null };
    sessionStorage.removeItem(SS_PINS);
    localStorage.removeItem(LS_STATE);
    document.getElementById('refresh-interval').value = 7;
    startLocation = null;
    document.getElementById('start-status').textContent = '';
    persistLocal();
    renderPlaceList();
    renderSavedStarts();
    checkRefreshBanner();
    syncMapMarkers();
    clearRoutePolyline();
  }
}

/* ---------- Place list rendering ---------- */
function renderPlaceList(){
  const places = loadPlaces();
  const filterText = (document.getElementById('place-filter')?.value || '').trim().toLowerCase();
  const filtered = filterText ? places.filter(p=>
    p.name.toLowerCase().includes(filterText) ||
    (p.address && p.address.toLowerCase().includes(filterText))
  ) : places;

  document.getElementById('place-count').textContent =
    filterText ? `(${filtered.length} of ${places.length})` : `(${places.length})`;

  const list = document.getElementById('place-list');
  if(places.length===0){
    list.innerHTML = '<div class="empty">No places yet — add one above, or import from Takeout under Advanced.</div>';
    return;
  }
  if(filtered.length===0){
    list.innerHTML = `<div class="empty">No places match "${escapeHtml(filterText)}".</div>`;
    return;
  }
  const checkedCount = places.filter(p=>p.checked).length;
  const pinMax = Math.max(checkedCount, 1);
  list.innerHTML = filtered.map(p=>`
    <div class="place">
      <input type="checkbox" ${p.checked?'checked':''} onchange="toggleChecked('${p.id}', this.checked)">
      <input type="number" class="pin-order" min="1" max="${pinMax}" placeholder="#" value="${p.pinOrder||''}"
        title="Set a number to force this stop's position in the route (1–${pinMax}, based on how many places are checked). Leave blank to let the optimizer place it."
        onchange="setPinOrder('${p.id}', this.value)">
      <span class="name">${escapeHtml(p.name)}${p.address ? ` <span style="color:var(--paper-dim);font-weight:400;">(${escapeHtml(p.address)})</span>` : ''}</span>
      <span class="src">${p.src||''}</span>
      <button class="rm" onclick="regeocodePlace('${p.id}')" title="Re-check this location">↻</button>
      <button class="rm" onclick="removePlace('${p.id}')">✕</button>
    </div>
  `).join('');
  syncMapMarkers();
}

function setPinOrder(id, value){
  const places = loadPlaces();
  const p = places.find(p=>p.id===id);
  if(!p) return;
  let n = parseInt(value);
  if(value==='' || isNaN(n)){
    p.pinOrder = null;
  } else {
    const checkedCount = places.filter(pl=>pl.checked).length;
    const max = Math.max(checkedCount, 1);
    n = Math.min(Math.max(n, 1), max);
    p.pinOrder = n;
  }
  appState.places = places; // pins are session-only — not written to the persisted local cache
  savePinsToSession(places);
  renderPlaceList(); // re-render so the input reflects any clamping, and so other rows' max stays current
}

/* ---------- Pin order: survives a refresh (sessionStorage) but wipes when the browser tab closes ---------- */
const SS_PINS = 'wp_pin_order_session';
function savePinsToSession(places){
  const pins = {};
  places.forEach(p=>{ if(p.pinOrder!=null) pins[p.id] = p.pinOrder; });
  sessionStorage.setItem(SS_PINS, JSON.stringify(pins));
}
function applySessionPins(){
  let pins = {};
  try{ pins = JSON.parse(sessionStorage.getItem(SS_PINS) || '{}'); }catch(e){ pins = {}; }
  appState.places.forEach(p=>{ p.pinOrder = pins[p.id] ?? null; });
}

// Re-geocodes a single place object in place. Returns {changed, error}. Does not save/render —
// callers handle that, so regeocodeAll can batch without a save+render per item.
async function regeocodeOne(key, p){
  const query = p.address || p.name;
  const {result, error} = await lookupPlace(key, query);
  if(error) return {error};
  const oldCoords = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  p.name = result.name;
  p.address = result.address || p.address;
  p.lat = result.lat;
  p.lng = result.lng;
  p.src = 're-checked';
  const newCoords = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  return {changed: oldCoords !== newCoords};
}

async function regeocodePlace(id){
  const key = googleApiKey;
  if(!key){ alert('Add your Google Places API key under Advanced first.'); return; }
  const places = loadPlaces();
  const p = places.find(p=>p.id===id);
  if(!p) return;
  const result = await regeocodeOne(key, p);
  if(result.error){
    alert(`Couldn't re-check "${p.name}": ${result.error}.`);
    return;
  }
  savePlaces(places);
  renderPlaceList();
  alert(result.changed
    ? `Updated "${p.name}" — coordinates changed.`
    : `"${p.name}" already had the correct location — no change needed.`);
}

async function regeocodeAll(){
  const key = googleApiKey;
  if(!key){ alert('Add your Google Places API key under Advanced first.'); return; }
  const places = loadPlaces();
  if(places.length===0){ alert('No places to re-check yet.'); return; }
  if(!confirm(`Re-check all ${places.length} places against Google Maps? This uses ${places.length} API lookups.`)) return;

  const status = document.getElementById('bulk-geocode-status');
  let changed = 0, failed = [];
  for(let i=0;i<places.length;i++){
    const p = places[i];
    if(status) status.textContent = `Re-checking ${i+1}/${places.length}: ${p.name}…`;
    const result = await regeocodeOne(key, p);
    if(result.error) failed.push(`${p.name} (${result.error})`);
    else if(result.changed) changed++;
    await new Promise(r=>setTimeout(r, 150)); // gentle pacing between requests
  }
  savePlaces(places);
  renderPlaceList();
  const msg = `Re-checked ${places.length} places — ${changed} had coordinates corrected.` +
    (failed.length ? ` ${failed.length} couldn't be matched: ${failed.join(', ')}.` : '');
  if(status){ status.style.color = failed.length ? 'var(--amber)' : 'var(--teal)'; status.textContent = msg; }
  alert(msg);
}

function exportPlaces(){
  const places = loadPlaces();
  if(places.length===0){ alert('No places to export yet.'); return; }
  const exportable = places.map(({pinOrder, ...rest})=>rest); // pins are session-only, not part of the exported record
  const blob = new Blob([JSON.stringify(exportable, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `waypoint-places-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toggleChecked(id, checked){
  const places = loadPlaces();
  const p = places.find(p=>p.id===id);
  if(p) p.checked = checked;
  savePlaces(places);
  renderPlaceList(); // pin-order max depends on the checked count, so refresh it
}

function removePlace(id){
  const places = loadPlaces().filter(p=>p.id!==id);
  savePlaces(places);
  renderPlaceList();
}

function setAllChecked(val){
  const places = loadPlaces();
  places.forEach(p=>p.checked=val);
  savePlaces(places);
  renderPlaceList();
}

/* ---------- Location bias helper (fixes ambiguous short addresses like "1933 Union St" 
   resolving to the wrong city entirely) ---------- */
function getSearchBias(){
  if(startLocation) return {lat: startLocation.lat, lng: startLocation.lng};
  const places = loadPlaces().filter(p=>!isNaN(p.lat) && !isNaN(p.lng));
  if(places.length>0){
    const lat = places.reduce((s,p)=>s+p.lat,0)/places.length;
    const lng = places.reduce((s,p)=>s+p.lng,0)/places.length;
    return {lat, lng};
  }
  return null;
}
function locationBiasPayload(){
  const bias = getSearchBias();
  if(!bias) return {};
  return {locationBias: {circle: {center: {latitude: bias.lat, longitude: bias.lng}, radius: 50000}}};
}

/* ---------- Address vs. business lookups ----------
   Places Text Search is built to find businesses/POIs — for a query that's just a street
   address, it can match whichever business Google has registered at or near that address
   instead of the literal address point. Google's separate Geocoding API resolves the literal
   address, but that endpoint doesn't support CORS for browser JS (server-side only) — calling
   it from here fails 100% of the time regardless of key setup. Instead, we stay on the
   CORS-friendly Places API and use its `includedType: street_address` filter to force a
   literal-address match. */
function looksLikeAddress(query){
  return /^\d+\s/.test(query.trim());
}

function isSameLocation(a, b){
  return Math.abs(a.lat-b.lat)<0.0002 && Math.abs(a.lng-b.lng)<0.0002; // ~20m
}

async function placesTextSearchLookup(key, query, opts={}){
  const body = {textQuery: query, ...locationBiasPayload()};
  if(opts.includedType){ body.includedType = opts.includedType; body.strictTypeFiltering = true; }
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':'places.displayName,places.formattedAddress,places.location'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if(!res.ok) return {error: data.error?.message || `HTTP ${res.status}`};
  const places = (data.places||[]).map(pl=>({
    name: pl.displayName.text, address: pl.formattedAddress||null,
    lat: pl.location.latitude, lng: pl.location.longitude,
    src: opts.includedType ? 'geocoded-address' : 'search'
  }));
  return {places};
}

// Single best-guess match for one query — used by bulk geocode and re-check, where there's
// no dropdown to pick from. For address-shaped queries, a strict street_address match wins
// over whatever business match a plain Places Text Search would otherwise auto-pick.
async function lookupPlace(key, query){
  try{
    if(looksLikeAddress(query)){
      const addr = await placesTextSearchLookup(key, query, {includedType:'street_address'});
      if(addr.places && addr.places[0]) return {result: addr.places[0]};
      // no strict address match (or the lookup errored) — fall through to a normal search
    }
    const {places, error} = await placesTextSearchLookup(key, query);
    if(error) return {error};
    if(places && places[0]) return {result: places[0]};
    return {error: 'no match found'};
  }catch(e){
    return {error: e.message};
  }
}

/* ---------- Live map ----------
   Loads the Maps JavaScript API on demand once a key is present (it's a separate
   API from Places, but usually enabled on the same project/key), then keeps a
   plain marker per place plus one for the start point. syncMapMarkers() is cheap
   enough to just call after every state change instead of tracking diffs. */
let gMap = null;
let mapMarkers = [];
let startMarker = null;
let routePolylines = [];
let routeDrawToken = 0;
let mapsLoadState = 'idle'; // idle | loading | ready | error

function setMapStatus(text){
  const el = document.getElementById('map-status');
  if(el) el.textContent = text;
}

// Reads the live CSS custom property so marker/route colors always match the
// current theme (light/dark) instead of a color baked in at draw time.
function getCssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ensureMapLoaded(){
  if(mapsLoadState==='ready' || mapsLoadState==='loading') return;
  if(!googleApiKey){
    setMapStatus('Add your Google Places API key under Advanced to enable the live map.');
    return;
  }
  mapsLoadState = 'loading';
  setMapStatus('Loading map…');
  window.__onMapsReady = initMap;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleApiKey)}&callback=__onMapsReady`;
  script.async = true;
  script.onerror = ()=>{
    mapsLoadState = 'error';
    setMapStatus('Could not load Google Maps — check that Maps JavaScript API is enabled for this key.');
  };
  document.head.appendChild(script);
}

function initMap(){
  mapsLoadState = 'ready';
  setMapStatus('');
  const center = getSearchBias() || {lat:39.8283, lng:-98.5795}; // fallback: roughly center of the US
  gMap = new google.maps.Map(document.getElementById('map-canvas'), {
    center, zoom:11, mapTypeControl:false, streetViewControl:false, fullscreenControl:false
  });
  syncMapMarkers(true);
}

// Maps each checked place's id to its stop number: follows the current pending
// route order once one's been built, otherwise falls back to list order. Any
// checked place not yet part of a built route (e.g. checked after the fact)
// gets the next number after the route so every dot still gets one.
function currentStopNumbers(){
  const checked = loadPlaces().filter(p=>p.checked);
  const numberMap = {};
  if(pendingOrder && pendingOrder.length>0){
    pendingOrder.forEach((p,i)=>{ numberMap[p.id] = i+1; });
    let next = pendingOrder.length+1;
    checked.forEach(p=>{ if(!(p.id in numberMap)) numberMap[p.id] = next++; });
  } else {
    checked.forEach((p,i)=>{ numberMap[p.id] = i+1; });
  }
  return numberMap;
}

// Redraws every marker from current state. Called after any place/check/start
// change so the map is always live — never holds onto stale positions. Only
// checked places get a marker; unchecked ones stay off the map entirely. Each
// dot is labeled with its stop number so it matches the route list below.
// By default this does NOT move the viewport — only pass fit=true for changes
// that genuinely warrant re-framing (first load, a new start point, a freshly
// built route). Otherwise routine edits (check/uncheck, reorder, alt-route
// pick, theme toggle) would keep yanking the zoom back out.
function syncMapMarkers(fit=false){
  if(!gMap) return;
  mapMarkers.forEach(m=>m.setMap(null));
  mapMarkers = [];
  if(startMarker){ startMarker.setMap(null); startMarker = null; }

  const checkedColor = getCssVar('--amber');
  const startColor = getCssVar('--teal');
  const numberMap = currentStopNumbers();
  const bounds = new google.maps.LatLngBounds();
  let any = false;

  loadPlaces().filter(p=>p.checked).forEach(p=>{
    if(isNaN(p.lat) || isNaN(p.lng)) return;
    const marker = new google.maps.Marker({
      position:{lat:p.lat, lng:p.lng},
      map:gMap,
      title:p.name,
      label:{text:String(numberMap[p.id]), color:'#ffffff', fontSize:'11px', fontWeight:'700'},
      icon:{
        path:google.maps.SymbolPath.CIRCLE,
        scale:10,
        fillColor:checkedColor,
        fillOpacity:1,
        strokeColor:'#f3eddb',
        strokeWeight:1.5
      }
    });
    mapMarkers.push(marker);
    bounds.extend(marker.getPosition());
    any = true;
  });

  if(startLocation){
    startMarker = new google.maps.Marker({
      position:{lat:startLocation.lat, lng:startLocation.lng},
      map:gMap,
      title:`Start: ${startLocation.label}`,
      label:{text:'S', color:'#ffffff', fontSize:'11px', fontWeight:'700'},
      icon:{
        path:google.maps.SymbolPath.CIRCLE,
        scale:10,
        fillColor:startColor,
        fillOpacity:1,
        strokeColor:'#f3eddb',
        strokeWeight:1.5
      },
      zIndex:999
    });
    bounds.extend(startMarker.getPosition());
    any = true;
  }

  if(any && fit) gMap.fitBounds(bounds, 60);
}

/* ---------- Route polyline (actual driving roads) ----------
   Uses the Directions service so the line follows real streets instead of a
   straight line. Draws one segment per consecutive stop-to-stop hop (start->stop1,
   stop1->stop2, ...) rather than one call covering the whole multi-stop trip —
   Google only returns alternate routes on a Directions call with no waypoints
   in between, so per-hop segments are what it takes to offer alternates
   between every individual pair of stops. This means N stops costs N-1
   Directions calls per route build, versus ~1 call under a chunked multi-stop
   approach — a real increase, paced with a short delay between requests.

   legRouteChoices[] caches each hop's raw DirectionsResult + which alternative
   index is currently drawn, so switching alternatives via the UI never
   re-fetches — only a genuine reorder, stop add/remove, or rebuild triggers
   new Directions calls. */
function clearRoutePolyline(){
  routePolylines.forEach(p=>p.setMap(null));
  routePolylines = [];
}

// One entry per stop-to-stop hop: {points: [from,to] (each with lat/lng/label), result (raw DirectionsResult or null), selected (index into result.routes), fallback (bool)}
let legRouteChoices = [];

function legDistanceLabel(route){
  let meters=0, seconds=0;
  route.legs.forEach(l=>{ meters += l.distance?.value||0; seconds += l.duration?.value||0; });
  const miles = (meters/1609.34).toFixed(1);
  const mins = Math.round(seconds/60);
  const hrs = Math.floor(mins/60), remMins = mins%60;
  const timeStr = hrs>0 ? `${hrs}h ${remMins}m` : `${mins} min`;
  return `${miles} mi · ${timeStr}`;
}

async function drawRoutePolyline(fit=false){
  const myToken = ++routeDrawToken;
  clearRoutePolyline();
  legRouteChoices = [];
  renderLegAlternates(); // clear any stale alt-picker UI while we recompute
  if(!gMap || mapsLoadState!=='ready' || !startLocation || pendingOrder.length===0) return;

  // One named stop per point in the full sequence (start + every checked place),
  // used only for segment labels in the alt-picker.
  const fullSeq = [
    {lat:startLocation.lat, lng:startLocation.lng, label: startLocation.label},
    ...pendingOrder.map(s=>({lat:s.lat, lng:s.lng, label: s.name}))
  ];

  // Segment-per-pair: one Directions call per consecutive stop-to-stop hop, with
  // no waypoints in between. Google only offers alternate routes on a leg with
  // no intermediate stopovers, so this is what it takes to get alternates for
  // every individual gap rather than just the overall multi-stop trip. Cost:
  // N stops -> N-1 calls per route build (vs. ~1 call under a chunked
  // multi-stop-leg approach).
  const segments = [];
  for(let i=0;i<fullSeq.length-1;i++){
    segments.push([fullSeq[i], fullSeq[i+1]]);
  }

  // Show something on the map immediately: a straight line per hop, upgraded
  // to the real driving route as each Directions call resolves. Waiting for
  // every hop to finish before drawing anything left the map blank for
  // seconds on longer routes — this way the route's shape appears instantly
  // and fills in road-by-road.
  const choices = segments.map(segPoints => ({points: segPoints, result: null, selected: 0, fallback: true}));
  legRouteChoices = choices;
  redrawAllLegPolylines(fit);

  const svc = new google.maps.DirectionsService();
  let anyRoadFailure = false;

  // Fetch hops with limited concurrency instead of one at a time: much faster
  // wall-clock time on longer routes while still capping how many requests
  // fire at once (Directions doesn't need one-at-a-time pacing the way a tight
  // geocoding loop might, but an unbounded burst isn't ideal either).
  const CONCURRENCY = 4;
  let nextIndex = 0;

  async function worker(){
    while(true){
      if(myToken !== routeDrawToken) return; // a newer edit superseded this draw — abandon
      const i = nextIndex++;
      if(i >= segments.length) return;
      const segPoints = segments[i];
      const origin = {lat:segPoints[0].lat, lng:segPoints[0].lng};
      const destination = {lat:segPoints[1].lat, lng:segPoints[1].lng};
      let result = null;
      let isFallback = false;
      try{
        result = await new Promise((resolve,reject)=>{
          svc.route({
            origin, destination,
            travelMode: google.maps.TravelMode.DRIVING,
            provideRouteAlternatives: true
          }, (res,status)=>{
            if(status==='OK') resolve(res); else reject(status);
          });
        });
      }catch(err){
        // No drivable route for this hop (e.g. overseas stop) — keep the
        // straight-line placeholder for just that hop rather than dropping it.
        anyRoadFailure = true;
        isFallback = true;
      }
      if(myToken !== routeDrawToken) return;
      choices[i] = {points: segPoints, result, selected: 0, fallback: isFallback};
      // Redraw as each hop lands so the route fills in progressively rather
      // than popping in all at once at the end.
      redrawAllLegPolylines();
      renderLegAlternates();
    }
  }

  await Promise.all(Array.from({length: Math.min(CONCURRENCY, segments.length)}, worker));
  if(myToken !== routeDrawToken) return;

  setMapStatus(anyRoadFailure ? "Couldn't find a driving route between some stops — showing a straight line for those hops." : '');
}

// Draws routePolylines from legRouteChoices' current `selected` index per leg,
// without touching the network — used both after a fresh fetch and whenever the
// user clicks a different alternate. Does NOT move the viewport unless fit=true
// is passed — alt-route picks and theme toggles just redraw in place.
function redrawAllLegPolylines(fit=false){
  clearRoutePolyline();
  const routeColor = getCssVar('--amber');
  const b = new google.maps.LatLngBounds();
  legRouteChoices.forEach(choice=>{
    let path;
    let geodesic = false;
    if(choice.result){
      const route = choice.result.routes[choice.selected] || choice.result.routes[0];
      path = [];
      route.legs.forEach(l=> l.steps.forEach(s=> path.push(...s.path)) );
    } else {
      path = choice.points.map(p=>({lat:p.lat, lng:p.lng}));
      geodesic = true;
    }
    const poly = new google.maps.Polyline({
      path, geodesic, strokeColor:routeColor, strokeOpacity:0.9, strokeWeight:4, map:gMap
    });
    routePolylines.push(poly);
    path.forEach(pt=>b.extend(pt));
  });
  if(fit && !b.isEmpty() && gMap) gMap.fitBounds(b, 60);
}

// Renders one alt-picker block per hop that actually got more than one route
// back from Google. Since every hop is now a plain point-to-point Directions
// call (no waypoints), most hops should offer 2-3 alternatives; a hop with
// only one option (e.g. a rural stretch with no real alternate road) just
// shows nothing to pick between. Writes the same markup into both
// #leg-alts-left (shown on desktop, left column) and #leg-alts-mobile (shown
// under the map on narrow screens) — CSS decides which one is visible.
function renderLegAlternates(){
  const targets = ['leg-alts-left','leg-alts-mobile']
    .map(id=>document.getElementById(id))
    .filter(Boolean);
  if(targets.length===0) return;
  if(legRouteChoices.length===0){ targets.forEach(t=>t.innerHTML=''); return; }

  const blocks = legRouteChoices.map((choice, legIdx)=>{
    if(!choice.result || choice.result.routes.length<2) return '';
    const fromLabel = escapeHtml(choice.points[0].label || 'Start');
    const toLabel = escapeHtml(choice.points[1].label || 'Stop');
    const btns = choice.result.routes.map((route, ri)=>{
      const summary = route.summary ? escapeHtml(route.summary) : `Option ${ri+1}`;
      return `<button class="alt-btn ${ri===choice.selected?'active':''}" onclick="selectLegAlternate(${legIdx}, ${ri})">
        <span class="alt-title">${summary}</span>
        <span class="alt-meta">${legDistanceLabel(route)}</span>
      </button>`;
    }).join('');
    return `<div class="leg-alts">
      <div class="leg-alts-label">${fromLabel} → ${toLabel}</div>
      <div class="alt-options">${btns}</div>
    </div>`;
  }).join('');

  const html = blocks || '<div class="alt-status">No alternate routes found between any of your stops for this trip.</div>';
  targets.forEach(t=>{ t.innerHTML = html; });
}

// User picked a different alternate for one leg. No network call — just redraw
// from the already-cached DirectionsResult for that leg.
function selectLegAlternate(legIdx, routeIdx){
  const choice = legRouteChoices[legIdx];
  if(!choice || !choice.result || !choice.result.routes[routeIdx]) return;
  choice.selected = routeIdx;
  redrawAllLegPolylines();
  renderLegAlternates();
}

/* ---------- Places Autocomplete (manual add + start search) ---------- */
let autocompleteTimer;
function wirePlaceSearch(inputId, resultsId, onSelect){
  const input = document.getElementById(inputId);
  input.addEventListener('input', ()=>{
    clearTimeout(autocompleteTimer);
    const q = input.value.trim();
    const resultsDiv = document.getElementById(resultsId);
    if(q.length<3){ resultsDiv.innerHTML=''; return; }
    autocompleteTimer = setTimeout(()=>runTextSearch(q, resultsDiv, onSelect), 400);
  });
}

async function runTextSearch(query, resultsDiv, onSelect){
  const key = googleApiKey;
  if(!key){
    resultsDiv.innerHTML = '<div class="search-result" style="color:var(--danger);cursor:default;">Add your Google Places API key under Advanced (bottom of the page) to search.</div>';
    return;
  }
  resultsDiv.innerHTML = '<div class="search-result" style="cursor:default;">Searching…</div>';

  const results = [];
  const addressLike = looksLikeAddress(query);

  // Address-shaped query: put the strict street_address match first, ahead of any business
  // match, so a full street address doesn't silently resolve to whichever tenant Google
  // has registered there.
  if(addressLike){
    try{
      const {places} = await placesTextSearchLookup(key, query, {includedType:'street_address'});
      if(places) results.push(...places);
    }catch(e){
      console.error('Address-type search failed:', e);
    }
  }

  let placesError = null;
  try{
    const {places, error} = await placesTextSearchLookup(key, query);
    if(error) placesError = error;
    else if(places){
      // skip business results that sit on the same spot as an address result we already have
      places.slice(0,5).forEach(p=>{
        if(!results.some(r=>isSameLocation(r,p))) results.push(p);
      });
    }
  }catch(e){
    placesError = e.message;
  }

  if(results.length===0){
    resultsDiv.innerHTML = placesError
      ? `<div class="search-result" style="color:var(--danger);cursor:default;">Google API error: ${escapeHtml(placesError)}</div>`
      : '<div class="search-result" style="cursor:default;">No results for that search.</div>';
    return;
  }

  resultsDiv.innerHTML = results.map((r,i)=>`
    <div class="search-result" onclick='selectSearchResult(${i})'>${escapeHtml(r.name)}${r.src==='geocoded-address' ? ' <span style="color:var(--teal);font-size:10.5px;text-transform:uppercase;">exact address</span>' : ''}${r.address ? `<br><span style="color:var(--paper-dim);font-size:11.5px;">${escapeHtml(r.address)}</span>` : ''}</div>
  `).join('');
  window.__lastSearchResults = results;
  window.__lastSearchCallback = onSelect;
}

function selectSearchResult(i){
  const r = window.__lastSearchResults[i];
  window.__lastSearchCallback({name: r.name, address: r.address, lat: r.lat, lng: r.lng});
}

wirePlaceSearch('place-search','search-results', (place)=>{
  mergePlaces([{...place, src:'search'}]);
  document.getElementById('place-search').value='';
  document.getElementById('search-results').innerHTML='';
});

/* ---------- Bulk geocode (for lists that can't be exported, e.g. shared lists) ---------- */
async function bulkGeocode(){
  const key = googleApiKey;
  const status = document.getElementById('bulk-geocode-status');
  if(!key){
    status.style.color = 'var(--danger)';
    status.textContent = 'Add your Google Places API key under Advanced first.';
    return;
  }
  const lines = document.getElementById('bulk-geocode-box').value
    .split('\n').map(l=>l.trim()).filter(Boolean);
  if(lines.length===0){
    status.textContent = 'Paste at least one place first.';
    return;
  }
  status.style.color = 'var(--paper-dim)';
  status.textContent = `Looking up ${lines.length} places… (0/${lines.length})`;

  const found = [];
  const failed = [];
  for(let i=0;i<lines.length;i++){
    const query = lines[i];
    const {result, error} = await lookupPlace(key, query);
    if(error){
      console.error('Geocode error for', query, error);
      failed.push(`${query} (${error})`);
    } else {
      found.push(result);
    }
    status.textContent = `Looking up ${lines.length} places… (${i+1}/${lines.length})`;
    await new Promise(r=>setTimeout(r, 150)); // gentle pacing between requests
  }

  const added = mergePlaces(found);
  status.style.color = failed.length ? 'var(--amber)' : 'var(--teal)';
  status.textContent = `Added ${added} of ${lines.length}.` +
    (failed.length ? ` Couldn't match: ${failed.join(', ')} — try adding city/state or a fuller address.` : '');
  if(added>0) document.getElementById('bulk-geocode-box').value = '';
}

let startLocation = null; // {lat, lng, label}
wirePlaceSearch('start-search','start-search-results', (place)=>{
  startLocation = {lat: place.lat, lng: place.lng, label: place.name};
  document.getElementById('start-status').textContent = `Start: ${place.name}`;
  document.getElementById('start-search').value='';
  document.getElementById('start-search-results').innerHTML='';
  document.getElementById('saved-start-select').value = '';
  syncMapMarkers(true);
});

function useCurrentLocation(){
  const status = document.getElementById('start-status');
  if(!navigator.geolocation){ status.textContent='Geolocation not supported in this browser.'; return; }
  status.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(pos=>{
    startLocation = {lat: pos.coords.latitude, lng: pos.coords.longitude, label:'Current location'};
    status.textContent = `Start: current location (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`;
    document.getElementById('saved-start-select').value = '';
    syncMapMarkers(true);
  }, err=>{
    status.textContent = 'Could not get your location — check browser permissions.';
  });
}

/* ---------- Saved starting points ---------- */
function renderSavedStarts(){
  const points = loadStartPoints();
  const select = document.getElementById('saved-start-select');
  const prevValue = select.value;
  select.innerHTML = '<option value="">— choose a saved start —</option>' +
    points.map(p=>`<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
  select.value = points.some(p=>p.id===prevValue) ? prevValue : '';

  const list = document.getElementById('saved-start-list');
  if(points.length===0){ list.innerHTML=''; return; }
  list.innerHTML = points.map(p=>`
    <div class="saved-start-row">
      <span class="name">${escapeHtml(p.label)}</span>
      <button class="mini-btn" onclick="selectSavedStart('${p.id}')" title="Use this as start">Use</button>
      <button class="mini-btn rm-mini" onclick="removeSavedStart('${p.id}')" title="Delete">✕</button>
    </div>`).join('');
}

function selectSavedStart(id){
  if(!id) return;
  const points = loadStartPoints();
  const p = points.find(p=>p.id===id);
  if(!p) return;
  startLocation = {lat: p.lat, lng: p.lng, label: p.label};
  document.getElementById('start-status').textContent = `Start: ${p.label}`;
  document.getElementById('saved-start-select').value = id;
  syncMapMarkers(true);
}

function removeSavedStart(id){
  const points = loadStartPoints().filter(p=>p.id!==id);
  saveStartPoints(points);
  renderSavedStarts();
}

function saveCurrentStart(){
  if(!startLocation){
    alert('Set a starting point first (current location, search, or a saved one) before saving it.');
    return;
  }
  const nameInput = document.getElementById('save-start-name');
  const label = nameInput.value.trim() || startLocation.label;
  const points = loadStartPoints();
  // avoid piling up exact duplicates under different names
  const dupe = points.find(p=>Math.abs(p.lat-startLocation.lat)<1e-6 && Math.abs(p.lng-startLocation.lng)<1e-6);
  if(dupe){
    dupe.label = label;
  } else {
    points.push({id: crypto.randomUUID(), label, lat: startLocation.lat, lng: startLocation.lng});
  }
  saveStartPoints(points);
  nameInput.value = '';
  renderSavedStarts();
}

/* ---------- Route optimization (nearest-neighbor + 2-opt) ----------
   dist(a,b) is pluggable: haversine (straight-line, default) or a driving-time
   lookup built from the Distance Matrix API when "optimize by driving time" is on. */
function haversine(a,b){
  const R=6371;
  const dLat=(b.lat-a.lat)*Math.PI/180;
  const dLng=(b.lng-a.lng)*Math.PI/180;
  const la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function nearestNeighborOrder(start, stops, dist=haversine){
  const remaining = [...stops];
  const order = [];
  let current = start;
  while(remaining.length){
    let bestIdx=0, bestDist=Infinity;
    remaining.forEach((s,i)=>{
      const d = dist(current, s);
      if(d<bestDist){bestDist=d; bestIdx=i;}
    });
    const next = remaining.splice(bestIdx,1)[0];
    order.push(next);
    current = next;
  }
  return order;
}

function routeLength(start, order, dist=haversine){
  let total=0, prev=start;
  order.forEach(s=>{ total+=dist(prev,s); prev=s; });
  return total;
}

function twoOpt(start, order, dist=haversine){
  let improved = true;
  while(improved){
    improved = false;
    for(let i=0;i<order.length-1;i++){
      for(let j=i+1;j<order.length;j++){
        const newOrder = order.slice(0,i).concat(order.slice(i,j+1).reverse(), order.slice(j+1));
        if(routeLength(start,newOrder,dist) < routeLength(start,order,dist) - 1e-6){
          order = newOrder;
          improved = true;
        }
      }
    }
  }
  return order;
}

// Given a fixed skeleton of pinned stops (in absolute slot order), thread the
// remaining unpinned stops into the open slots between/after them, always
// choosing whichever unpinned stop is nearest (by dist) to the current point in the walk.
function computeOrder(dist=haversine){
  const allChecked = loadPlaces().filter(p=>p.checked);
  const pinned = allChecked.filter(p=>p.pinOrder!=null).sort((a,b)=>a.pinOrder-b.pinOrder);
  const unpinned = allChecked.filter(p=>p.pinOrder==null);

  let order;
  let pinNote = '';
  if(pinned.length>0){
    const total = allChecked.length;

    // Ties: multiple places sharing the same pin number. Group them, then within
    // each group walk nearest-neighbor starting from whatever precedes the group
    // (the previous distinct-numbered pin, or the start point for the first group).
    const pinnedSorted = [...pinned].sort((a,b)=>a.pinOrder-b.pinOrder);
    const resolved = [];
    let refPoint = startLocation;
    let gi = 0;
    while(gi < pinnedSorted.length){
      let gj = gi;
      while(gj < pinnedSorted.length && pinnedSorted[gj].pinOrder === pinnedSorted[gi].pinOrder) gj++;
      const group = pinnedSorted.slice(gi, gj);
      const remaining = [...group];
      let current = refPoint;
      while(remaining.length){
        let bestIdx=0, bestDist=Infinity;
        remaining.forEach((p,idx)=>{ const d=dist(current,p); if(d<bestDist){bestDist=d; bestIdx=idx;} });
        const next = remaining.splice(bestIdx,1)[0];
        resolved.push(next);
        current = next;
      }
      refPoint = current; // next group (or the unpinned-fill logic) chains off the last-placed tied pin
      gi = gj;
    }

    const anchors = resolved.map(p=>({point:p, slot: p.pinOrder}));
    // resolve duplicate/out-of-range slots by nudging forward, keeping the tie-broken order
    let lastSlot = 0;
    anchors.forEach(a=>{ a.slot = Math.max(Math.min(a.slot, total), lastSlot+1); lastSlot = a.slot; });

    let available = [...unpinned];
    let current = startLocation;
    const finalOrder = new Array(Math.max(lastSlot, total)).fill(null);
    let prevSlot = 0;
    anchors.forEach(a=>{
      const gap = a.slot - prevSlot - 1; // open unpinned slots before this anchor
      for(let i=0;i<gap && available.length;i++){
        let bestIdx=0, bestDist=Infinity;
        available.forEach((s,idx)=>{ const d=dist(current,s); if(d<bestDist){bestDist=d; bestIdx=idx;} });
        const next = available.splice(bestIdx,1)[0];
        finalOrder[prevSlot+i] = next;
        current = next;
      }
      finalOrder[a.slot-1] = a.point;
      current = a.point;
      prevSlot = a.slot;
    });
    // fill remaining unpinned after the last anchor, same nearest-next logic
    let idx = prevSlot;
    while(available.length){
      let bestIdx=0, bestDist=Infinity;
      available.forEach((s,i)=>{ const d=dist(current,s); if(d<bestDist){bestDist=d; bestIdx=i;} });
      const next = available.splice(bestIdx,1)[0];
      finalOrder[idx] = next;
      current = next;
      idx++;
    }
    order = finalOrder.filter(Boolean);
    const hadTies = pinnedSorted.some((p,idx)=> idx>0 && p.pinOrder===pinnedSorted[idx-1].pinOrder);
    pinNote = `<div class="pin-note">${pinned.length} stop(s) locked to their exact position.${hadTies ? ' Some pins shared the same slot number, so ties were broken by picking whichever was closer to the previous stop.' : ''} Adjust freely below before confirming.</div>`;
  } else {
    order = nearestNeighborOrder(startLocation, allChecked, dist);
    if(order.length<=12) order = twoOpt(startLocation, order, dist);
  }
  return {order, pinNote};
}

/* ---------- Driving-time matrix (optional optimization mode) ----------
   Builds a duration lookup between the start point and every checked place using
   the Distance Matrix service, chunked into <=10x10 blocks per request (the
   service's element-count limit). Returns null on any failure so the caller can
   fall back to straight-line distance. */
async function fetchDrivingMatrix(points){
  if(mapsLoadState!=='ready') return null;
  const svc = new google.maps.DistanceMatrixService();
  const CHUNK = 10;
  const durations = {};
  points.forEach(p=>{ durations[p.id] = {}; });

  for(let i=0;i<points.length;i+=CHUNK){
    const originsChunk = points.slice(i, i+CHUNK);
    for(let j=0;j<points.length;j+=CHUNK){
      const destChunk = points.slice(j, j+CHUNK);
      let result;
      try{
        result = await new Promise((resolve,reject)=>{
          svc.getDistanceMatrix({
            origins: originsChunk.map(p=>({lat:p.lat,lng:p.lng})),
            destinations: destChunk.map(p=>({lat:p.lat,lng:p.lng})),
            travelMode: google.maps.TravelMode.DRIVING
          }, (res,status)=>{
            if(status==='OK') resolve(res); else reject(status);
          });
        });
      }catch(err){
        return null;
      }
      result.rows.forEach((row,ri)=>{
        row.elements.forEach((el,ci)=>{
          const originId = originsChunk[ri].id;
          const destId = destChunk[ci].id;
          durations[originId][destId] = (el.status==='OK') ? el.duration.value : null;
        });
      });
      await new Promise(r=>setTimeout(r,120)); // gentle pacing between chunk requests
    }
  }

  return {
    getDuration(idA, idB){
      if(idA===idB) return 0;
      const v = durations[idA] && durations[idA][idB];
      return (v==null) ? null : v;
    }
  };
}

// Builds a dist(a,b) function backed by the driving matrix, falling back to
// haversine for any pair the matrix couldn't resolve (e.g. no driving route).
function drivingDistFn(matrix){
  const idOf = o => o.id || 'start';
  return (a,b)=>{
    const d = matrix.getDuration(idOf(a), idOf(b));
    return d==null ? haversine(a,b)*1000 : d;
  };
}

/* ---------- Review / adjust / confirm step ---------- */
let pendingOrder = [];   // the order currently shown for editing
let lastComputedOrder = []; // freshly optimized order, for "reset"
let currentPinNote = '';

async function buildRoute(){
  const allChecked = loadPlaces().filter(p=>p.checked);
  const outputCard = document.getElementById('route-output');
  if(allChecked.length===0){
    alert('Check at least one place first.');
    return;
  }
  if(!startLocation){
    alert('Set a starting point first (current location or search).');
    return;
  }

  const useDriving = document.getElementById('optimize-driving')?.checked;
  const buildBtn = document.getElementById('build-route-btn');
  let dist = haversine;

  if(useDriving){
    if(mapsLoadState!=='ready'){
      alert("The map (and its driving-time lookup) isn't ready yet — add your API key under Advanced and let the map load, or uncheck \"optimize by driving time\".");
      return;
    }
    if(buildBtn){ buildBtn.disabled = true; buildBtn.textContent = 'Calculating driving times…'; }
    const points = [
      {id:'start', lat:startLocation.lat, lng:startLocation.lng},
      ...allChecked.map(p=>({id:p.id, lat:p.lat, lng:p.lng}))
    ];
    const matrix = await fetchDrivingMatrix(points);
    if(buildBtn){ buildBtn.disabled = false; buildBtn.textContent = 'Get optimized route'; }
    if(matrix){
      dist = drivingDistFn(matrix);
    } else {
      alert("Couldn't fetch driving times (API error or quota) — optimizing by straight-line distance instead.");
    }
  }

  const {order, pinNote} = computeOrder(dist);
  pendingOrder = order.slice();
  lastComputedOrder = order.slice();
  currentPinNote = pinNote;

  // Reset the confirmed map-link state — it needs to be regenerated for the new order.
  document.getElementById('legs-container').innerHTML = '';
  document.getElementById('legs-note').textContent = '';
  document.getElementById('confirmed-badge').classList.remove('show');

  renderEditableOrder(true); // fresh build: okay to re-frame the map to the new route
  outputCard.classList.add('show');
  outputCard.scrollIntoView({behavior:'smooth'});
}

// fit=true re-frames the map to the new route/markers (used for a fresh "Get
// optimized route" build). Reorders, drops, and resets pass fit=false (the
// default) so the map stays put instead of zooming back out on every edit.
function renderEditableOrder(fit=false){
  document.getElementById('pin-note-area').innerHTML = currentPinNote;

  const startRow = `
    <div class="stop-row start-row">
      <span class="n">0</span>
      <span class="name">${escapeHtml(startLocation.label)} (start)</span>
    </div>`;

  const stopRows = pendingOrder.map((s,i)=>`
    <div class="stop-row">
      <span class="n">${i+1}</span>
      <span class="name">${escapeHtml(s.name)}${s.pinOrder!=null?' <span class="pin-flag">📌</span>':''}${s.address ? `<span class="addr">${escapeHtml(s.address)}</span>` : ''}</span>
      <button class="mini-btn" onclick="movePendingStop(${i},-1)" ${i===0?'disabled':''} title="Move earlier">↑</button>
      <button class="mini-btn" onclick="movePendingStop(${i},1)" ${i===pendingOrder.length-1?'disabled':''} title="Move later">↓</button>
      <button class="mini-btn rm-mini" onclick="removePendingStop(${i})" title="Drop this stop">✕</button>
    </div>`).join('');

  document.getElementById('editable-order').innerHTML = startRow + stopRows;

  // Any manual reorder invalidates the previously generated map link until re-confirmed.
  document.getElementById('legs-container').innerHTML = '';
  document.getElementById('legs-note').textContent = '';
  document.getElementById('confirmed-badge').classList.remove('show');

  drawRoutePolyline(fit);
  syncMapMarkers(fit);
}

function movePendingStop(i, dir){
  const j = i + dir;
  if(j<0 || j>=pendingOrder.length) return;
  [pendingOrder[i], pendingOrder[j]] = [pendingOrder[j], pendingOrder[i]];
  renderEditableOrder();
}

function removePendingStop(i){
  pendingOrder.splice(i,1);
  renderEditableOrder();
}

function resetToOptimized(){
  pendingOrder = lastComputedOrder.slice();
  renderEditableOrder();
}

function confirmRoute(){
  if(pendingOrder.length===0){
    alert('Your route has no stops left — add some back or re-run the optimizer.');
    return;
  }

  // Google Maps' web/app Directions UI caps at 10 total stops
  // (origin + up to 9 waypoints + destination). Split into legs if we're over.
  const MAX_STOPS_PER_LEG = 10;
  const legsContainer = document.getElementById('legs-container');
  const legsNote = document.getElementById('legs-note');
  legsContainer.innerHTML = '';

  const fullSeq = [startLocation, ...pendingOrder];
  const legs = [];
  let i = 0;
  while(i < fullSeq.length-1){
    const legPoints = fullSeq.slice(i, Math.min(i+MAX_STOPS_PER_LEG, fullSeq.length));
    legs.push(legPoints);
    i += MAX_STOPS_PER_LEG - 1; // overlap last point as next leg's start
  }

  if(legs.length>1){
    legsNote.textContent = `${fullSeq.length} total stops exceeds Google Maps' 10-stop limit per trip — split into ${legs.length} legs. Open and complete them in order.`;
  } else {
    legsNote.textContent = '';
  }

  legs.forEach((legPoints, idx)=>{
    const origin = `${legPoints[0].lat},${legPoints[0].lng}`;
    const destination = `${legPoints[legPoints.length-1].lat},${legPoints[legPoints.length-1].lng}`;
    const mid = legPoints.slice(1,-1).map(s=>`${s.lat},${s.lng}`).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
    if(mid) url += `&waypoints=${encodeURIComponent(mid)}`;
    const a = document.createElement('a');
    a.className = 'maps-link';
    a.href = url;
    a.target = '_blank';
    a.style.marginTop = idx===0 ? '10px' : '8px';
    a.textContent = legs.length>1 ? `Open leg ${idx+1} of ${legs.length} →` : 'Open in Google Maps →';
    legsContainer.appendChild(a);
  });

  const badge = document.getElementById('confirmed-badge');
  badge.textContent = `Route confirmed with ${pendingOrder.length} stop(s). Reorder or drop stops above any time — you'll just need to confirm again.`;
  badge.classList.add('show');
  legsContainer.scrollIntoView({behavior:'smooth', block:'nearest'});
}

/* ---------- Init ---------- */
function applyThemeButtonLabel(){
  const isDark = document.documentElement.getAttribute('data-theme')==='dark';
  document.getElementById('theme-toggle').textContent = isDark ? 'Light mode' : 'Dark mode';
}
function toggleTheme(){
  const isDark = document.documentElement.getAttribute('data-theme')==='dark';
  if(isDark){
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('wp_theme','light');
  } else {
    document.documentElement.setAttribute('data-theme','dark');
    localStorage.setItem('wp_theme','dark');
  }
  applyThemeButtonLabel();
  syncMapMarkers();
  redrawAllLegPolylines();
}

applyThemeButtonLabel();
restoreLocal();
restoreApiKey();
renderPlaceList();
renderSavedStarts();
checkRefreshBanner();
ensureMapLoaded();
