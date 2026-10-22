import * as engine from './engine.js';
import {pieceSVG} from './pieces.js';
import {LESSONS} from './tutorial.js';
import {SERVERS} from './config.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const title = text => text ? text[0].toUpperCase() + text.slice(1) : '';
const nameOf = type => engine.TYPES[type]?.name || title(type);
const moveKind = move => move.kind || 'move';
const sameMove = (a,b) => a.from === b.from && a.to === b.to && moveKind(a) === moveKind(b);
const squareName = key => engine.squareName(key);
const STORAGE = 'great-chess.solo.v1';
const SEATS = 'great-chess.seats.v1';
let storageAvailable = true;
function readStored(key,fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key,value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { storageAvailable = false; return false; } }
function usableState(state) {
  return state && state.board && ['white','black'].includes(state.turn) && Number.isInteger(state.ply) && state.ply >= 0 && Array.isArray(state.history) && Object.values(state.board).every(piece => piece && engine.TYPES[piece.type] && ['white','black'].includes(piece.color));
}
const saved = readStored(STORAGE,null);
let soloState = usableState(saved?.state) ? saved.state : engine.initialState();
let side = ['white','black','both'].includes(saved?.side) ? saved.side : 'white';
let difficulty = saved?.difficulty === 'easy' ? 'easy' : 'standard';
let flipped = saved?.flipped ?? side === 'black';
let mode = 'solo';
let selected = null;
let inspected = null;
let focusKey = '5,1';
let currentMoves = [];
let worker = null;
let generation = 0;
let thinking = false;
let botError = '';
let lessonIndex = 0;
let lessonState = LESSONS[0].createState();
let lessonComplete = false;
let lessonFeedback = '';
let seatList = readStored(SEATS,[]);
if (!Array.isArray(seatList)) seatList = [];
seatList = seatList.filter(seat => typeof seat?.roomId === 'string' && typeof seat?.token === 'string' && typeof seat?.server === 'string');
const configuredServers = Array.isArray(SERVERS) ? SERVERS : [];
const localHost = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
let apiBase = localHost ? location.origin : configuredServers[0]?.url;
let online = {room:null,state:null,you:null,drawOffer:null};
let activeSeat = null;
let socket = null;
let connectionGeneration = 0;
let reconnectTimer = null;
let refreshTimer = null;
let stateEvents = 0;
let actionPending = false;
let roomListRequest = 0;
let seatFetchRequest = 0;
let reconnectAttempt = 0;
let networkMessage = '';
let lastOnlinePly = -1;
let onlineHealthy = false;
let onlineIdentity = '';
const knownKeys = [];
for (let y=9;y>=0;y--) for(let x=-1;x<=11;x++) if ((x>=0 && x<=10) || (x===-1 && y===8) || (x===11 && y===1)) knownKeys.push(`${x},${y}`);
const keySet = new Set(knownKeys);

function notify(message,error=false) {
  $('notice').hidden = !message;
  $('notice').textContent = message;
  $('notice').classList.toggle('error',error);
}
function stateNow() { return mode === 'learn' ? lessonState : mode === 'online' ? online.state || soloState : soloState; }
function canPlay() {
  const state = stateNow();
  if (state.result) return false;
  if (mode === 'learn') return !lessonComplete || Boolean(state.pendingCitadel);
  if (mode === 'online') return Boolean(activeSeat && online.state && online.room?.players?.length === 2 && online.you === state.turn && !actionPending && onlineHealthy);
  return !thinking && !botError && (side === 'both' || side === state.turn);
}
function safeMoves(state) {
  try { return state.result ? [] : engine.legalMoves(state); }
  catch(error) { notify(`The position could not be read: ${error.message}`,true); return []; }
}
function saveSolo() {
  const success = store(STORAGE,{state:soloState,side,difficulty,flipped});
  $('save-status').textContent = success ? 'Solo game saved automatically on this device.' : 'Device storage is unavailable. Keep this tab open to retain your solo game.';
}
function cancelBot() {
  generation++;
  if (worker) worker.terminate();
  worker = null; thinking = false;
}
function scheduleBot() {
  if (mode !== 'solo' || side === 'both' || soloState.result || soloState.turn === side || thinking || botError) return;
  cancelBot();
  const myGeneration = generation;
  const sourceState = soloState;
  const signature = JSON.stringify(sourceState);
  thinking = true;
  render();
  try { worker = new Worker(new URL('./bot-worker.js',import.meta.url),{type:'module'}); }
  catch(error) { failBot(error.message); return; }
  function failBot(message) {
    if (myGeneration !== generation) return;
    cancelBot(); botError = message || 'The opponent could not calculate a move.';
    notify(`Solo opponent paused: ${botError} Start a new game or choose local two-player.`,true); render();
  }
  worker.onerror = event => { event.preventDefault(); failBot(event.message); };
  worker.onmessage = ({data}) => {
    if (myGeneration !== generation || mode !== 'solo' || soloState !== sourceState || JSON.stringify(soloState) !== signature) return;
    if (data.error) { failBot(data.error); return; }
    const candidate = data.move && safeMoves(soloState).find(move=>sameMove(move,data.move));
    if (!candidate) { failBot('No legal move was returned.'); return; }
    cancelBot();
    try { soloState = engine.applyMove(soloState,candidate); selected = null; saveSolo(); render(); scheduleBot(); }
    catch(error) { failBot(error.message); }
  };
  worker.postMessage({state:sourceState,depth:difficulty==='easy'?1:2,timeMs:difficulty==='easy'?250:850});
}

function renderBoard(state) {
  const activeKey = document.activeElement?.dataset?.square;
  currentMoves = safeMoves(state);
  const destinations = new Set(selected && canPlay() ? currentMoves.filter(move=>move.from===selected).map(move=>move.to) : []);
  const last = state.history.at(-1);
  const checked = new Set();
  for (const color of ['white','black']) {
    try { if (engine.inCheck(state,color)) for (const [key,piece] of Object.entries(state.board)) if (piece.color===color && ['king','prince','adventitious'].includes(piece.type)) checked.add(key); } catch { /* Invalid saved positions are handled by move generation. */ }
  }
  const xs = Array.from({length:13},(_,i)=>flipped?11-i:i-1);
  const ys = Array.from({length:10},(_,i)=>flipped?i:9-i);
  const nodes = [];
  for (let row=0;row<ys.length;row++) for(let col=0;col<xs.length;col++) {
    const x=xs[col],y=ys[row],key=`${x},${y}`;
    if (!keySet.has(key)) continue;
    const piece = state.board[key];
    const citadel=x===-1 || x===11;
    const legal=destinations.has(key);
    const classes=['square',(x+y)%2?'dark':'',piece?'has-piece':'',selected===key?'selected':'',legal?'legal':'',last&&(last.from===key||last.to===key)?'last-move':'',checked.has(key)?'in-check':'',citadel?'citadel':'',col===0?'edge-left':'',row===0?'edge-top':'',citadel&&col===12?'citadel-right':''].filter(Boolean).join(' ');
    let label = `${squareName(key)}${citadel?' citadel':''}: ${piece?`${piece.color} ${nameOf(piece.type)}${piece.type==='pawn'?`, promotes to ${piece.promotion==='pawn'?'pawn-of-pawns':nameOf(piece.promotion)}`:''}${piece.dormant?', dormant':''}`:'empty'}${legal?', legal destination':''}${selected===key?', selected':''}`;
    nodes.push(`<button type="button" class="${classes}" style="grid-row:${row+1};grid-column:${col+1}" data-square="${key}" tabindex="${key===focusKey?'0':'-1'}" aria-label="${esc(label)}" aria-pressed="${selected===key}">${piece?pieceSVG(piece):''}<span class="coordinate" aria-hidden="true">${citadel?'C':squareName(key)}</span></button>`);
  }
  $('board').innerHTML=nodes.join('');
  if (activeKey) $('board').querySelector(`[data-square="${activeKey}"]`)?.focus({preventScroll:true});
}
function renderInspector(state) {
  const key=inspected || selected;
  const piece=key && state.board[key];
  if (!piece) {
    $('piece-inspector').innerHTML='<h2>A court of possibilities</h2><p>Select any piece to read its movement and see legal destinations.</p>';
    return;
  }
  const metadata = engine.TYPES[piece.type];
  const moves=currentMoves.filter(move=>move.from===key);
  const promotion=piece.type==='pawn'?`<p class="small"><strong>Promotion:</strong> ${piece.promotion==='pawn'?'Pawn-of-pawns · three-stage journey':esc(nameOf(piece.promotion))}${piece.stage?` · stage ${piece.stage}`:''}${piece.dormant?' · dormant and immune':''}</p>`:'';
  $('piece-inspector').innerHTML=`<div class="inspector-head">${pieceSVG(piece)}<div><h2>${esc(nameOf(piece.type))}</h2><p class="piece-meta">${esc(piece.color)} / ${esc(squareName(key))}</p></div></div><p class="movement">${esc(metadata?.description||'Moves one square in any direction.')}</p>${promotion}<p class="small muted">${piece.color===state.turn?`${moves.length} legal ${moves.length===1?'action':'actions'} in this position.`:'The other court moves next.'}</p>`;
}
function renderHistory(state) {
  $('history-count').textContent=`${state.history.length} ${state.history.length===1?'entry':'entries'}`;
  $('history').innerHTML=state.history.length?state.history.map((entry,index)=>`<li><span class="ply">${index+1}. ${entry.color==='black'?'B':'W'}</span><span>${esc(entry.notation || `${nameOf(entry.piece)} ${squareName(entry.from)}–${squareName(entry.to)}`)}</span></li>`).join(''):'<li class="muted">The ledger is waiting for a move.</li>';
  $('history').scrollTop=$('history').scrollHeight;
  const byColor={white:[],black:[]};
  for(const entry of state.history) if(entry.capture) {
    const type=typeof entry.capture==='object'?entry.capture.type:entry.capture;
    if(engine.TYPES[type]) byColor[entry.color==='white'?'black':'white'].push({type,color:entry.color==='white'?'black':'white'});
  }
  const topColor=flipped?'white':'black';
  $('top-captured').innerHTML=byColor[topColor==='white'?'black':'white'].map(piece=>pieceSVG(piece,{badge:false})).join('');
  $('bottom-captured').innerHTML=byColor[topColor].map(piece=>pieceSVG(piece,{badge:false})).join('');
  $('top-captured').setAttribute('aria-label',`Captured ${topColor==='white'?'black':'white'} pieces: ${byColor[topColor==='white'?'black':'white'].map(p=>nameOf(p.type)).join(', ')||'none'}`);
  $('bottom-captured').setAttribute('aria-label',`Captured ${topColor} pieces: ${byColor[topColor].map(p=>nameOf(p.type)).join(', ')||'none'}`);
}
function specialLabel(move) {
  const destination=squareName(move.to);
  return moveKind(move)==='citadel-draw'?'Declare a draw':moveKind(move)==='citadel-swap'?`Continue: royal swap with ${destination}`:moveKind(move)==='exchange'?`Royal exchange · ${squareName(move.from)} ↔ ${destination}`:`Deploy pawn at ${destination}`;
}
function renderSpecials(state) {
  const specials=currentMoves.filter(move=>moveKind(move)!=='move');
  if (!specials.length) { $('special-actions').replaceChildren(); return; }
  const pending=state.pendingCitadel;
  const deployment=specials.some(move=>moveKind(move)==='deploy');
  const visible = specials.filter(move=>moveKind(move)!=='deploy' || !selected || move.from===selected);
  $('special-actions').innerHTML=`<h3>${pending?'A choice at the citadel':deployment?'Compulsory pawn deployment':'A royal escape is available'}</h3><p>${pending?'Entering and resolving this choice use a single turn. Declare a draw, or exchange with an eligible royal to continue.':deployment?'Select the dormant pawn, then a marked square, or choose a destination below. Ordinary moves are unavailable while deployment is legal.':'Once per game, your checked or stalemated king may exchange with a friendly non-royal.'}</p><div class="button-row">${visible.map(move=>`<button data-special="${currentMoves.indexOf(move)}" ${canPlay()?'':'disabled'}>${esc(specialLabel(move))}</button>`).join('')}</div>`;
}
function render() {
  const state=stateNow();
  renderBoard(state); renderInspector(state); renderHistory(state); renderSpecials(state);
  $('solo-controls').hidden=mode!=='solo';
  $('online-controls').hidden=mode!=='online';
  $('lesson-controls').hidden=mode!=='learn';
  $('lobby').hidden=mode!=='online' || Boolean(activeSeat && online.state);
  $('solo-side').value=side; $('difficulty').value=difficulty;
  for(const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  $('move-number').textContent=`PLY ${String(state.ply).padStart(2,'0')}`;
  $('game-kicker').textContent=mode==='learn'?`Field school / Lesson ${lessonIndex+1}`:mode==='online'?'Online / Shared court':side==='both'?'Local / Two players':'Solo / The eleven-file game';
  let status;
  if(state.result) status=`${state.result.winner?`${title(state.result.winner)} wins`:'Draw'} · ${state.result.reason}`;
  else if(state.pendingCitadel) status=`${title(state.turn)} · Choose your citadel resolution`;
  else if(thinking && mode==='solo') status=`${title(state.turn)} is considering the court…`;
  else if(mode==='online' && !online.state) status='Choose or create a room above. Your solo game is safe.';
  else if(mode==='online' && online.room?.players?.length<2) status='Waiting for the second player. Share your invitation.';
  else if(mode==='online' && !onlineHealthy) status='Connection paused · Reconnecting to the authoritative game…';
  else status=`${title(state.turn)} to move${mode==='solo'&&side!=='both'&&state.turn===side?' · Your court':''}${engine.inCheck(state,state.turn)?' · Check':''}`;
  $('turn-status').textContent=status;
  const playerLabel=color=>mode==='online'&&online.state?`${title(color)} · ${online.room?.players?.find(player=>player.color===color)?.name || 'Open seat'}`:`${title(color)} · ${mode==='learn'?'Field school':side==='both'?'Local player':side===color?'Your court':'The other court'}`;
  $('top-player').textContent=playerLabel(flipped?'white':'black');
  $('bottom-player').textContent=playerLabel(flipped?'black':'white');
  if(mode==='learn') renderLesson();
  if(mode==='online') renderOnlineControls();
}

function selectSquare(key) {
  const state=stateNow();
  const candidates=selected && canPlay()?currentMoves.filter(move=>move.from===selected && move.to===key):[];
  if(candidates.length===1) { commitMove(candidates[0]); return; }
  if(candidates.length>1) { notify('More than one action reaches this square. Choose the named action below the board.'); return; }
  inspected=key;
  selected=selected===key?null:state.board[key]?key:null;
  focusKey=key;
  render();
}
async function commitMove(move) {
  if(!canPlay()) return;
  const state=stateNow();
  const legal=currentMoves.find(candidate=>sameMove(candidate,move));
  if(!legal) { notify('That action is no longer legal. Select the piece again.',true); return; }
  if(mode==='online') { await sendAction({type:'move',move:legal,expectedPly:state.ply}); return; }
  try {
    const next=engine.applyMove(state,legal);
    selected=null; inspected=legal.to;
    notify('');
    if(mode==='solo') { soloState=next; saveSolo(); }
    else {
      lessonState=next;
      if(LESSONS[lessonIndex].accepts(legal,state,next) || (lessonComplete && state.pendingCitadel)) { lessonComplete=true; lessonFeedback=next.pendingCitadel?'Good entry. Resolve the citadel choice below the board.':'Well played. You made the required legal move.'; }
      else if(moveKind(legal).startsWith('citadel-')) { lessonComplete=true; lessonFeedback='The citadel choice is resolved. Well played.'; }
      else lessonFeedback='That was legal, but not the lesson’s target. Retry to restore the exercise.';
    }
    render(); scheduleBot();
  } catch(error) { notify(error.message,true); }
}
function setMode(next) {
  if(mode===next) return;
  cancelBot(); mode=next; selected=null; inspected=null; botError=''; notify('');
  if(next==='online') { refreshRooms(); if(activeSeat) resumeSeat(activeSeat); }
  else disconnectSocket();
  if(next==='learn') flipped=false;
  else if(next==='solo') flipped=side==='black';
  render(); scheduleBot();
}
function newSolo({settings=false}={}) {
  if(soloState.ply>0 && !soloState.result && !confirm('Start a new solo game? This replaces your saved solo position.')) {
    $('solo-side').value=side; $('difficulty').value=difficulty; return;
  }
  cancelBot(); side=$('solo-side').value; difficulty=$('difficulty').value;
  botError=''; soloState=engine.initialState(); flipped=side==='black'; selected=null; inspected=null;
  notify(''); saveSolo(); render(); scheduleBot();
}
function renderLesson() {
  const lesson=LESSONS[lessonIndex];
  $('lesson-counter').textContent=`Hands-on / ${lessonIndex+1} of ${LESSONS.length}`;
  $('lesson-title').textContent=lesson.title;
  $('lesson-text').textContent=lesson.text;
  $('lesson-task').textContent=lesson.task;
  $('lesson-explanation').textContent=lesson.explanation;
  $('lesson-feedback').textContent=lessonFeedback || 'Make the required move on the board to continue.';
  $('lesson-feedback').classList.toggle('success',lessonComplete);
  $('lesson-prev').disabled=lessonIndex===0;
  $('lesson-next').disabled=!lessonComplete || Boolean(lessonState.pendingCitadel);
  $('lesson-next').textContent=lessonIndex===LESSONS.length-1?'Play solo':'Next';
}
function loadLesson(index) {
  lessonIndex=Math.max(0,Math.min(LESSONS.length-1,index)); lessonState=LESSONS[lessonIndex].createState();
  lessonComplete=false; lessonFeedback=''; selected=null; inspected=null; flipped=false; render();
}
function renderCatalog() {
  $('piece-catalog').innerHTML=Object.entries(engine.TYPES).map(([type,data])=>`<button class="piece-card" data-piece-type="${esc(type)}" aria-label="Inspect ${esc(data.name)}">${pieceSVG({type,color:'white',promotion:type==='pawn'?'rook':undefined})}<span><strong>${esc(data.name)}</strong>${esc(data.description)}</span></button>`).join('');
  const notes=engine.RULE_NOTES;
  const noteList=Array.isArray(notes)?notes:typeof notes==='string'?[notes]:notes&&typeof notes==='object'?Object.entries(notes).map(([key,value])=>`${key}: ${typeof value==='string'?value:JSON.stringify(value)}`):[];
  const baseNotes=['Pawns advance one square; no double step, en passant or castling. Each pawn promotes according to its original file. The king-pawn becomes a prince.','Royal precedence is king, then prince, then adventitious king. Only the last royal must be kept out of check. Checkmate and stalemate both lose; bare royal, repetition and fifty moves do not automatically end play.','The picket’s first diagonal square blocks it even though it cannot land there. The giraffe’s entire bent route must be clear, including intermediate squares on which it cannot stop.','A citadel entrance keeps the mover’s turn pending until a draw or eligible once-only royal swap is selected. A legal pawn-of-pawns deployment is compulsory.'];
  $('rule-notes').innerHTML=[...baseNotes,...noteList].map(note=>`<li>${esc(note)}</li>`).join('');
}

// Online positions come only from authenticated server snapshots. Never apply a local online move.
function normalizedServer(value) {
  const url=new URL(value,location.href);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS server URL, or localhost for development.');
  if(url.username || url.password) throw new Error('Server URLs cannot contain credentials.');
  return url.origin;
}
function populateServers() {
  const options=[...(localHost?[{name:'Local room service',url:location.origin}]:[]),...configuredServers];
  if(apiBase && !options.some(server=>server.url.replace(/\/$/,'')===apiBase.replace(/\/$/,''))) options.push({name:'Invitation / independent server',url:apiBase});
  $('server-select').innerHTML=options.map(server=>`<option value="${esc(server.url.replace(/\/$/,''))}">${esc(server.name)}</option>`).join('');
  $('server-select').value=apiBase;
}
async function request(path,{method='GET',body,token,server=apiBase}={}) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch(`${server}${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
    let data;
    try { data=await response.json(); } catch { throw new Error(`The room service returned an unreadable response (${response.status}).`); }
    if(!response.ok) throw new Error(data.error || data.message || `Room request failed (${response.status}).`);
    return data;
  } catch(error) { if(error.name==='AbortError') throw new Error('The room service took too long to respond.'); throw error; }
  finally { clearTimeout(timeout); }
}
function saveSeat(seat) {
  seatList=seatList.filter(item=>!(item.server===seat.server && item.roomId===seat.roomId));
  seatList.unshift({server:seat.server,roomId:seat.roomId,token:seat.token,color:seat.color,name:seat.name||'Your table'});
  seatList=seatList.slice(0,20);
  store(SEATS,seatList); renderSavedSeats();
}
function renderSavedSeats() {
  let target=$('saved-seats');
  if(!target) { target=document.createElement('div'); target.id='saved-seats'; target.className='saved-seats'; $('service-status').after(target); }
  const seats=seatList.filter(seat=>seat.server===apiBase);
  target.innerHTML=seats.length?`<h3>Your saved seats</h3><div class="button-row">${seats.map(seat=>`<button data-resume="${seatList.indexOf(seat)}">${esc(seat.name)} · ${esc(title(seat.color))}</button>`).join('')}</div><p class="small muted">Seat credentials stay on this device. Room passwords are never saved.</p>`:'';
}
async function refreshRooms() {
  const query=++roomListRequest;
  const server=apiBase;
  $('service-status').textContent='Finding open tables…';
  $('service-status').classList.remove('error');
  renderSavedSeats();
  try {
    const data=await request('/api/rooms',{server});
    if(query!==roomListRequest || server!==apiBase) return;
    $('service-status').textContent='Room service connected. Create a room or join a friend.';
    $('room-list').innerHTML=data.rooms.length?data.rooms.map(room=>`<div class="room-row"><div><strong>${esc(room.name)}</strong>${room.locked?'<span class="room-tag">Password</span>':''}<small>${room.players}/2 players · ${esc(room.status)} · ${esc(room.id)}</small></div><button data-join="${esc(room.id)}" data-locked="${room.locked?'true':'false'}" ${room.players>=2?'disabled':''}>Join</button></div>`).join(''):'<p class="muted">No tables yet. Open the first one.</p>';
  } catch(error) {
    if(query!==roomListRequest || server!==apiBase) return;
    $('service-status').textContent=`Room service unavailable. ${error.message} Solo play and lessons work without it.`;
    $('service-status').classList.add('error');
    $('room-list').innerHTML='<p class="muted">No live room list is available. Try Refresh rooms to reconnect.</p>';
  }
}
function disconnectSocket() {
  connectionGeneration++; clearTimeout(reconnectTimer); clearTimeout(refreshTimer);
  reconnectTimer=null; refreshTimer=null;
  if(socket) { socket.onclose=null; socket.close(); socket=null; }
  onlineHealthy=false;
}
function acceptSnapshot(data) {
  if(!usableState(data.state) || !data.room || !['white','black'].includes(data.you)) throw new Error('The server returned an invalid game snapshot.');
  if(onlineIdentity===activeSeat?.roomId && online.state && data.state.ply<lastOnlinePly && !(data.state.ply===0 && online.state.result)) return;
  online={room:data.room,state:data.state,you:data.you,drawOffer:data.drawOffer??null};
  onlineIdentity=activeSeat.roomId; lastOnlinePly=data.state.ply;
  onlineHealthy=true; reconnectAttempt=0;
  activeSeat.name=data.room.name; activeSeat.color=data.you;
  flipped=data.you==='black';
  selected=null; inspected=null;
  saveSeat(activeSeat); render();
}
async function fetchSnapshot(seat,expectedGeneration) {
  const sequence=++seatFetchRequest;
  const eventsAtStart=stateEvents;
  const data=await request(`/api/rooms/${encodeURIComponent(seat.roomId)}`,{token:seat.token,server:seat.server});
  if(expectedGeneration!==connectionGeneration || activeSeat!==seat || mode!=='online' || sequence!==seatFetchRequest || eventsAtStart!==stateEvents) return false;
  acceptSnapshot(data); return true;
}
function scheduleSnapshotPoll(seat,myGeneration) {
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(async()=>{
    if(myGeneration!==connectionGeneration || activeSeat!==seat || mode!=='online') return;
    try { await fetchSnapshot(seat,myGeneration); networkMessage=socket?.readyState===WebSocket.OPEN?'Live connection · Seat restored':'Connected · Checking updates'; renderOnlineControls(); }
    catch(error) { onlineHealthy=false; networkMessage=`Connection paused · ${error.message}`; render(); }
    scheduleSnapshotPoll(seat,myGeneration);
  },5000);
}
function connectSocket(seat,myGeneration) {
  if(myGeneration!==connectionGeneration || activeSeat!==seat || mode!=='online') return;
  const url=new URL('/ws',seat.server); url.protocol=url.protocol==='https:'?'wss:':'ws:';
  try { socket=new WebSocket(url); }
  catch { queueReconnect(seat,myGeneration); return; }
  const thisSocket=socket;
  socket.onopen=()=>{
    if(myGeneration!==connectionGeneration || thisSocket!==socket) return;
    networkMessage='Live connection · Seat restored';
    socket.send(JSON.stringify({type:'subscribe',roomId:seat.roomId,token:seat.token}));
    renderOnlineControls();
  };
  socket.onmessage=event=>{
    if(myGeneration!==connectionGeneration || thisSocket!==socket || activeSeat!==seat || mode!=='online') return;
    try {
      const data=JSON.parse(event.data);
      if(data.type==='state') { stateEvents++; acceptSnapshot(data); networkMessage='Live connection · All moves verified by the server'; renderOnlineControls(); }
      else if(data.type==='error') { notify(data.message || 'Room subscription failed.',true); }
    } catch(error) { notify(`Unable to read room update: ${error.message}`,true); }
  };
  socket.onerror=()=>{ networkMessage='Live connection interrupted · Checking server'; renderOnlineControls(); };
  socket.onclose=()=>{
    if(myGeneration!==connectionGeneration || thisSocket!==socket) return;
    socket=null; onlineHealthy=false;
    networkMessage='Reconnecting to your existing seat…'; render(); queueReconnect(seat,myGeneration);
  };
}
function queueReconnect(seat,myGeneration) {
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(async()=>{
    if(myGeneration!==connectionGeneration || activeSeat!==seat || mode!=='online') return;
    try { await fetchSnapshot(seat,myGeneration); connectSocket(seat,myGeneration); }
    catch(error) { networkMessage=`Reconnecting · ${error.message}`; onlineHealthy=false; render(); queueReconnect(seat,myGeneration); }
  },Math.min(15000,1000*2**Math.min(reconnectAttempt++,4)));
}
async function resumeSeat(seat) {
  disconnectSocket();
  const myGeneration=connectionGeneration;
  if(activeSeat?.roomId!==seat.roomId || activeSeat?.server!==seat.server) { online={room:null,state:null,you:null,drawOffer:null}; onlineIdentity=''; lastOnlinePly=-1; }
  activeSeat=seat; apiBase=seat.server; populateServers();
  mode='online'; networkMessage='Restoring your authenticated seat…'; render();
  try {
    const accepted=await fetchSnapshot(seat,myGeneration);
    if(myGeneration!==connectionGeneration || activeSeat!==seat) return;
    if(accepted) { networkMessage='Connected · Starting live updates'; renderOnlineControls(); }
    connectSocket(seat,myGeneration); scheduleSnapshotPoll(seat,myGeneration);
  } catch(error) {
    if(myGeneration!==connectionGeneration) return;
    networkMessage=`Unable to restore seat · ${error.message}`;
    notify(`${networkMessage} Your solo game and lessons are still available.`,true);
    render(); queueReconnect(seat,myGeneration); scheduleSnapshotPoll(seat,myGeneration);
  }
}
async function sendAction(action) {
  if(!activeSeat || !online.state || actionPending) return;
  const seat=activeSeat;
  const myGeneration=connectionGeneration;
  actionPending=true; render();
  try {
    await request(`/api/rooms/${encodeURIComponent(seat.roomId)}/action`,{method:'POST',body:action,token:seat.token,server:seat.server});
    if(activeSeat!==seat || myGeneration!==connectionGeneration) return;
    await fetchSnapshot(seat,myGeneration);
    if(action.type==='rematch') notify('Rematch requested. A new game begins after both players consent.');
    else notify('');
  } catch(error) {
    if(activeSeat!==seat || myGeneration!==connectionGeneration) return;
    notify(`Action not confirmed: ${error.message} The server position remains authoritative.`,true);
    try { await fetchSnapshot(seat,myGeneration); } catch { onlineHealthy=false; }
  } finally { actionPending=false; render(); }
}
function renderOnlineControls() {
  $('active-room-name').textContent=online.room?.name || 'Choose a room';
  $('connection-status').textContent=networkMessage || 'Join a table in the lobby to begin.';
  $('connection-status').classList.toggle('error',Boolean(activeSeat && !onlineHealthy));
  $('room-players').innerHTML=(online.room?.players||[]).map(player=>`<p><strong>${esc(title(player.color))}</strong> · ${esc(player.name)} ${player.color===online.you?'(you)':''} · ${player.connected?'connected':'reconnecting'}</p>`).join('');
  const joined=Boolean(activeSeat && online.state);
  for(const id of ['copy-invite','reconnect-room','offer-draw','resign','rematch']) $(id).disabled=!joined || actionPending;
  $('offer-draw').disabled=!joined || actionPending || Boolean(online.state?.result) || online.drawOffer===online.you;
  $('resign').disabled=!joined || actionPending || Boolean(online.state?.result);
  $('accept-draw').hidden=!online.drawOffer || online.drawOffer===online.you || Boolean(online.state?.result);
  $('accept-draw').disabled=actionPending;
  $('rematch').hidden=!online.state?.result;
  $('draw-status').textContent=online.drawOffer?online.drawOffer===online.you?'Your draw offer is waiting for the other player.':`${title(online.drawOffer)} offers a draw.`:'';
}
function inviteURL() {
  const url=new URL(location.href); url.search=''; url.hash='';
  url.searchParams.set('room',activeSeat.roomId);
  const defaultServer=localHost?location.origin:configuredServers[0]?.url?.replace(/\/$/,'');
  if(activeSeat.server!==defaultServer) url.searchParams.set('server',activeSeat.server);
  return url.href;
}
async function createOrJoin(event,join=false) {
  event.preventDefault();
  const form=event.currentTarget;
  const submit=form.querySelector('button[type="submit"]');
  const passwordInput=$(join?'join-password':'room-password');
  const password=passwordInput.value; passwordInput.value='';
  let roomId=$('join-id').value.trim();
  let server=apiBase;
  try {
    if(join && /^https?:\/\//.test(roomId)) {
      const invitation=new URL(roomId);
      roomId=invitation.searchParams.get('room') || '';
      if(invitation.searchParams.get('server')) server=normalizedServer(invitation.searchParams.get('server'));
    }
    if(join && !roomId) throw new Error('Enter a room ID or valid invitation link.');
    submit.disabled=true;
    const playerName=$('player-name').value.trim() || 'Player';
    const resume=seatList.find(seat=>seat.server===server && seat.roomId===roomId);
    const body=join?{playerName,...(password?{password}:{}),...(resume?{resumeToken:resume.token}:{})}:{name:$('room-name').value.trim(),playerName,color:$('room-color').value,...(password?{password}:{})};
    const data=await request(join?`/api/rooms/${encodeURIComponent(roomId)}/join`:'/api/rooms',{method:'POST',body,server});
    if(!data.roomId || !data.token) throw new Error('The server did not return a seat credential.');
    const seat={server,roomId:data.roomId,token:data.token,color:data.color};
    cancelBot(); saveSeat(seat); await resumeSeat(seat); notify('');
  } catch(error) { notify(`Unable to ${join?'join':'create'} room: ${error.message}`,true); }
  finally { submit.disabled=false; }
}

$('board').addEventListener('click',event=>{const button=event.target.closest('[data-square]');if(button) selectSquare(button.dataset.square);});
$('board').addEventListener('keydown',event=>{
  const button=event.target.closest('[data-square]'); if(!button) return;
  if(event.key==='Escape') { selected=null; inspected=null; render(); return; }
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[event.key]; if(!delta) return;
  event.preventDefault();
  let [x,y]=button.dataset.square.split(',').map(Number);
  const direction=flipped?-1:1;
  for(let count=0;count<13;count++) {
    x+=delta[0]*direction; y+=delta[1]*direction;
    if(x<-1 || x>11 || y<0 || y>9) break;
    const key=`${x},${y}`;
    if(keySet.has(key)) { focusKey=key; button.tabIndex=-1; const target=$('board').querySelector(`[data-square="${key}"]`);target.tabIndex=0;target.focus({preventScroll:true}); break; }
  }
});
$('special-actions').addEventListener('click',event=>{ const button=event.target.closest('[data-special]'); if(button) commitMove(currentMoves[Number(button.dataset.special)]); });
for(const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click',()=>setMode(button.dataset.mode));
$('flip-board').addEventListener('click',()=>{flipped=!flipped;if(mode==='solo')saveSolo();render();});
$('new-game').addEventListener('click',()=>newSolo());
$('solo-side').addEventListener('change',()=>newSolo({settings:true}));
$('difficulty').addEventListener('change',()=>{difficulty=$('difficulty').value;saveSolo();cancelBot();botError='';render();scheduleBot();});
$('lesson-prev').addEventListener('click',()=>loadLesson(lessonIndex-1));
$('lesson-retry').addEventListener('click',()=>loadLesson(lessonIndex));
$('lesson-next').addEventListener('click',()=>{if(!lessonComplete || lessonState.pendingCitadel)return;if(lessonIndex===LESSONS.length-1)setMode('solo');else loadLesson(lessonIndex+1);});
$('piece-catalog').addEventListener('click',event=>{
  const button=event.target.closest('[data-piece-type]');if(!button)return;
  const type=button.dataset.pieceType;
  $('piece-inspector').innerHTML=`<div class="inspector-head">${pieceSVG({type,color:'white',promotion:'rook'})}<div><h2>${esc(nameOf(type))}</h2><p class="piece-meta">Field guide / ${esc(engine.TYPES[type].short||type)}</p></div></div><p class="movement">${esc(engine.TYPES[type].description)}</p>${type==='pawn'?'<p class="small">Badge key: P pawn-of-pawns, E engine, C camel, El elephant, F ferz, K prince, V vizier, G giraffe, Pi picket, N knight, R rook. Stage numbers track the pawn-of-pawns journey.</p>':''}`;
  $('piece-inspector').scrollIntoView({behavior:'smooth',block:'center'});
});
$('refresh-rooms').addEventListener('click',refreshRooms);
$('create-room').addEventListener('submit',event=>createOrJoin(event));
$('join-room').addEventListener('submit',event=>createOrJoin(event,true));
$('lobby').addEventListener('click',event=>{
  const resume=event.target.closest('[data-resume]');if(resume){resumeSeat(seatList[Number(resume.dataset.resume)]);return;}
  const join=event.target.closest('[data-join]');if(!join)return;
  $('join-id').value=join.dataset.join;
  if(join.dataset.locked==='true') $('join-password').focus(); else $('join-room').requestSubmit();
});
$('server-form').addEventListener('submit',event=>{
  event.preventDefault();
  try {
    const next=normalizedServer($('custom-server').value.trim()||$('server-select').value);
    disconnectSocket();activeSeat=null;online={room:null,state:null,you:null,drawOffer:null};onlineIdentity='';lastOnlinePly=-1;apiBase=next;populateServers();render();refreshRooms();
    $('custom-server').value='';notify('');
  } catch(error) {notify(error.message,true);}
});
$('reconnect-room').addEventListener('click',()=>{if(activeSeat)resumeSeat(activeSeat);});
$('copy-invite').addEventListener('click',async()=>{
  if(!activeSeat)return;
  const invitation=inviteURL();
  try{await navigator.clipboard.writeText(invitation);notify('Invitation copied. Share it with your opponent; send the room password separately if needed.');}
  catch{prompt('Copy this invitation. The link contains no seat token or room password.',invitation);}
});
$('offer-draw').addEventListener('click',()=>sendAction({type:'offer-draw'}));
$('accept-draw').addEventListener('click',()=>{if(confirm('Accept the draw and end this game?'))sendAction({type:'accept-draw'});});
$('resign').addEventListener('click',()=>{if(confirm('Resign this online game? Your opponent will win.'))sendAction({type:'resign'});});
$('rematch').addEventListener('click',()=>sendAction({type:'rematch'}));
$('leave-room').addEventListener('click',()=>{disconnectSocket();activeSeat=null;online={room:null,state:null,you:null,drawOffer:null};networkMessage='';render();refreshRooms();notify('Seat saved. Rejoin it from “Your saved seats” without creating another room.');});
window.addEventListener('online',()=>{if(mode==='online'){if(activeSeat)resumeSeat(activeSeat);else refreshRooms();}});
window.addEventListener('beforeunload',()=>{cancelBot();disconnectSocket();});

populateServers(); renderCatalog(); render(); saveSolo();
const params=new URLSearchParams(location.search);
if(params.get('room')) {
  try { if(params.get('server'))apiBase=normalizedServer(params.get('server'));populateServers();$('join-id').value=params.get('room');setMode('online');notify('Invitation ready. Enter your name and room password, if needed, then join.'); }
  catch(error){notify(error.message,true);scheduleBot();}
} else scheduleBot();
