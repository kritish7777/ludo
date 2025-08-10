
// ludo-client.js — client with avatar upload + mic + WebRTC signalling (simplified)
const socket = io("https://ludo-2td8.onrender.com");

// UI refs
const nameInput = document.getElementById('nameInput');
const avatarInput = document.getElementById('avatarInput');
const createBtn = document.getElementById('create');
const joinBtn = document.getElementById('join');
const roomInput = document.getElementById('roomInput');
const roomsList = document.getElementById('roomsList');
const lobbyPanel = document.getElementById('lobbyPanel');
const playersList = document.getElementById('playersList');
const readyBtn = document.getElementById('readyBtn');
const leaveBtn = document.getElementById('leaveBtn');
const startBtn = document.getElementById('startBtn');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const lobby = document.getElementById('lobby');
const gameWrap = document.getElementById('gameWrap');
const roomTag = document.getElementById('roomTag');
const rollBtn = document.getElementById('rollBtn');
const diceEl = document.getElementById('dice');
const turnInfo = document.getElementById('turnInfo');
const chatLogGame = document.getElementById('chatLogGame');
const chatInputGame = document.getElementById('chatInputGame');
const chatSendGame = document.getElementById('chatSendGame');
const micToggle = document.getElementById('micToggle');
const micStatus = document.getElementById('micStatus');

// canvas refs
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

// state
let localRoom = null, players = [], localPlayer = null, isHost=false;
let gameState = null, localStream = null;
let peers = {}; // peer connections by socket id

// avatar handling
let pendingAvatarBase64 = null;
avatarInput.addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const dataUrl = await toBase64(file);
  pendingAvatarBase64 = dataUrl;
});

// create/join with avatar
createBtn.onclick = ()=>{
  const name = nameInput.value.trim() || 'Player';
  socket.emit('createRoom', { name, avatar: pendingAvatarBase64 }, (res)=>{
    if(!res) return; localRoom = res.roomId; players = res.players; isHost = true; openLobby(res);
  });
};
joinBtn.onclick = ()=>{
  const name = nameInput.value.trim() || 'Guest'; const code = roomInput.value.trim();
  if(!code) return; socket.emit('joinRoom', { roomId: code, name, avatar: pendingAvatarBase64 }, (res)=>{
    if(res && res.error){ alert(res.error); return; }
    localRoom = code; players = res.players; isHost = (res.hostId===socket.id); openLobby(res);
  });
};

socket.on('roomsList', list=>{
  roomsList.innerHTML=''; list.forEach(r=>{
    const el = document.createElement('div'); el.className='roomRow'; el.innerText = `${r.id} — ${r.players} players`;
    el.onclick = ()=>{ roomInput.value = r.id; }; roomsList.appendChild(el);
  });
});

socket.on('roomUpdate', (room)=>{
  players = room.players || []; renderLobby(room);
});

socket.on('chat', msg=>{
  const el = document.createElement('div'); el.innerText = `${new Date(msg.ts).toLocaleTimeString()} ${msg.from}: ${msg.text}`;
  if(gameWrap.classList.contains('hidden')) chatLog.appendChild(el); else chatLogGame.appendChild(el);
});

socket.on('gameStarted', (state)=>{ gameState = state; enterGame(); });
socket.on('gameAction', (act)=>{ handleRemoteAction(act); });
socket.on('gameState', (st)=>{ gameState = st; draw(); });
socket.on('errorMsg', m=> alert(m));

function openLobby(){ lobbyPanel.classList.remove('hidden'); renderLobby({players}); }

function renderLobby(room){
  playersList.innerHTML='';
  (room.players||players).forEach(p=>{
    const row = document.createElement('div'); row.className='playerRow';
    const dot = document.createElement('div'); dot.className='playerDot';
    const img = document.createElement('img');
    if(p.avatar) img.src = p.avatar; else img.src = 'assets/avatars/avatar1.svg';
    dot.appendChild(img);
    const txt = document.createElement('div'); txt.innerText = p.name + (p.id===socket.id? ' (you)' : '') + (p.ready? ' ✅' : '');
    const mic = document.createElement('img'); mic.className='micIcon'; mic.src = p.muted ? 'assets/icons/mic_off.svg' : 'assets/icons/mic_on.svg';
    row.appendChild(dot); row.appendChild(txt); row.appendChild(mic); playersList.appendChild(row);
  });
  isHost = room.hostId === socket.id;
  startBtn.style.display = isHost ? 'inline-block' : 'none';
}

// avatar upload to server (base64)
function uploadAvatarNow(){
  if(!pendingAvatarBase64) return;
  socket.emit('uploadAvatar', { avatarBase64: pendingAvatarBase64 }, (res)=>{ pendingAvatarBase64 = null; });
}

// ready/start/leave
readyBtn.onclick = ()=>{ socket.emit('toggleReady'); };
leaveBtn.onclick = ()=>{ socket.emit('leaveRoom'); location.reload(); };
startBtn.onclick = ()=>{ socket.emit('startGame'); };

chatSend.onclick = ()=>{ const t = chatInput.value.trim(); if(!t) return; socket.emit('sendChat',{ text: t}); chatInput.value=''; };
chatSendGame.onclick = ()=>{ const t = chatInputGame.value.trim(); if(!t) return; socket.emit('sendChat',{ text: t}); chatInputGame.value=''; };

// mic toggle & WebRTC setup
micToggle.onclick = async ()=>{
  if(!localStream){
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
      micStatus.innerText = 'Mic: on';
      uploadAvatarNow();
      // inform others we're unmuted
      socket.emit('setMuted', { muted:false });
      // create peer connections and send offers
      startVoiceConnections();
    } catch(e){ alert('Microphone access denied'); }
  } else {
    // stop stream
    localStream.getTracks().forEach(t=>t.stop()); localStream = null; micStatus.innerText = 'Mic: off';
    socket.emit('setMuted', { muted:true });
    // close peers
    for(let id in peers){ try{ peers[id].close(); }catch(e){} delete peers[id]; }
  }
};

// Simple WebRTC signalling workflow: when joining a room, you will receive roomUpdate; to connect voice peers we will perform offer/answer exchange on demand
socket.on('webrtc-offer', async ({ from, offer })=>{
  // create peer, set remote desc, create answer
  const pc = createPeer(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { to: from, answer: pc.localDescription });
});
socket.on('webrtc-answer', async ({ from, answer })=>{
  const pc = peers[from];
  if(pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});
socket.on('webrtc-ice', ({ from, candidate })=>{
  const pc = peers[from];
  if(pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate));
});

function createPeer(peerId){
  if(peers[peerId]) return peers[peerId];
  const pc = new RTCPeerConnection();
  peers[peerId] = pc;
  pc.onicecandidate = (e)=>{ if(e.candidate) socket.emit('webrtc-ice',{ to: peerId, candidate: e.candidate }); };
  pc.ontrack = (e)=>{ // attach remote audio to hidden audio element
    let audio = document.getElementById('audio-'+peerId);
    if(!audio){ audio = document.createElement('audio'); audio.id = 'audio-'+peerId; audio.autoplay = true; audio.controls = false; audio.style.display='none'; document.body.appendChild(audio); }
    audio.srcObject = e.streams[0];
  };
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t, localStream));
  return pc;
}

async function startVoiceConnections(){
  // create offers to each peer in room
  const roomPlayers = players.filter(p=>p.id !== socket.id);
  for(const p of roomPlayers){
    const pc = createPeer(p.id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { to: p.id, offer: pc.localDescription });
  }
}

// Canvas & game rendering (simplified — uses server state)
function enterGame(){ lobby.classList.add('hidden'); gameWrap.classList.remove('hidden'); roomTag.innerText = 'Room: '+localRoom; resizeCanvas(); draw(); }
function resizeCanvas(){ const w = Math.min(window.innerWidth-80, 720); canvas.width = w; canvas.height = w; draw(); }
window.addEventListener('resize', resizeCanvas);

function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#f8fbff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  // draw simple tokens if state present
  if(!gameState) return;
  const outer = computeOuterPath();
  gameState.players.forEach((pl,pi)=>{
    pl.tokens.forEach((tok,ti)=>{
      let coord = {x:50+pi*30 + ti*10, y:50}; // placeholder
      ctx.beginPath(); ctx.arc(coord.x, coord.y, 16, 0, Math.PI*2); ctx.fillStyle = ['#e63946','#2a9d8f','#e9c46a','#457b9d'][pl.colorIndex]; ctx.fill();
    });
  });
}

function computeOuterPath(){ const positions=[] ; for(let i=0;i<52;i++) positions.push({x:20+ i*5, y:200}); return positions; }

function handleRemoteAction(act){
  if(act.type==='roll'){ diceEl.innerText = act.value; return; }
  if(act.type==='move'){ socket.emit('requestMove', { playerIndex: act.player, tokenIndex: act.token }, ()=>{}); return; }
}

// roll button requests server-side roll
rollBtn.onclick = ()=>{ if(!gameState) return; socket.emit('requestRoll', { playerIndex: gameState.currentPlayer }, (res)=>{ if(res && res.error) alert(res.error); }); };

// helper
function toBase64(file){ return new Promise((res, rej)=>{ const reader = new FileReader(); reader.onload = ()=> res(reader.result); reader.onerror = rej; reader.readAsDataURL(file); }); }
