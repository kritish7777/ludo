
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

// Rooms: { roomId: { players:[{id,name,colorIndex,ready,avatar,muted}], hostId, state }} 
const rooms = {};

function makeRoomId(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function makePlayer(socket, name){ return { id: socket.id, name: name||'Player', colorIndex:0, ready:false, avatar:null, muted:false }; }

function broadcastRooms(){ 
  const list = Object.keys(rooms).map(id=>({ id, players: rooms[id].players.length }));
  io.emit('roomsList', list);
}

io.on('connection', socket=>{
  console.log('conn', socket.id);

  socket.on('createRoom', ({name, avatar}, cb)=>{
    const id = makeRoomId();
    rooms[id] = { players: [], hostId: socket.id, state: null };
    socket.join(id);
    const p = makePlayer(socket, name);
    p.colorIndex = 0; p.avatar = avatar || null;
    rooms[id].players.push(p);
    socket.roomId = id;
    cb && cb({ roomId: id, players: rooms[id].players, hostId: rooms[id].hostId });
    io.to(id).emit('roomUpdate', rooms[id]);
    broadcastRooms();
  });

  socket.on('joinRoom', ({roomId, name, avatar}, cb)=>{
    const room = rooms[roomId];
    if(!room) return cb && cb({ error:'Room not found' });
    if(room.players.length >= 4) return cb && cb({ error:'Room is full' });
    socket.join(roomId); socket.roomId = roomId;
    const p = makePlayer(socket, name);
    p.colorIndex = room.players.length; p.avatar = avatar || null;
    room.players.push(p);
    cb && cb({ ok:true, players: room.players, hostId: room.hostId });
    io.to(roomId).emit('roomUpdate', room);
    broadcastRooms();
  });

  socket.on('uploadAvatar', ({avatarBase64}, cb)=>{
    const room = rooms[socket.roomId]; if(!room) return;
    const pl = room.players.find(p=>p.id===socket.id); if(!pl) return;
    pl.avatar = avatarBase64;
    io.to(socket.roomId).emit('roomUpdate', room);
    cb && cb({ ok:true });
  });

  socket.on('toggleReady', (cb)=>{
    const room = rooms[socket.roomId]; if(!room) return;
    const pl = room.players.find(p=>p.id===socket.id); if(!pl) return;
    pl.ready = !pl.ready;
    io.to(socket.roomId).emit('roomUpdate', room);
    cb && cb({ ok:true, ready:pl.ready });
  });

  socket.on('setMuted', ({muted})=>{
    const room = rooms[socket.roomId]; if(!room) return;
    const pl = room.players.find(p=>p.id===socket.id); if(!pl) return;
    pl.muted = !!muted;
    io.to(socket.roomId).emit('roomUpdate', room);
  });

  socket.on('sendChat', ({text})=>{
    const roomId = socket.roomId; if(!roomId) return;
    const room = rooms[roomId];
    const pl = room.players.find(p=>p.id===socket.id) || { name:'Unknown' };
    const msg = { from: pl.name, text, ts: Date.now() };
    io.to(roomId).emit('chat', msg);
  });

  socket.on('startGame', ()=>{
    const room = rooms[socket.roomId]; if(!room) return;
    if(room.hostId !== socket.id) return;
    if(room.players.length < 2){ socket.emit('errorMsg','Need at least 2 players to start'); return; }
    if(!room.players.every(p=>p.ready)){ socket.emit('errorMsg','All players must be ready'); return; }
    const state = createInitialGameState(room.players.length);
    room.state = state;
    io.to(socket.roomId).emit('gameStarted', state);
  });

  // Authoritative dice roll
  socket.on('requestRoll', ({playerIndex}, cb)=>{
    const room = rooms[socket.roomId]; if(!room) return;
    if(!room.state) return;
    if(room.state.currentPlayer !== playerIndex){ return cb && cb({ error:'Not your turn' }); }
    const value = Math.floor(Math.random()*6)+1;
    // store last roll for move validation
    room.state.pendingRoll = value;
    io.to(socket.roomId).emit('gameAction', { type:'roll', player: playerIndex, value });
    cb && cb({ ok:true, value });
  });

  // Move validation: minimal rules (enter on 6, not exceeding finish, etc.)
  socket.on('requestMove', ({playerIndex, tokenIndex, target}, cb)=>{
    const room = rooms[socket.roomId]; if(!room) return;
    const state = room.state; if(!state) return;
    if(state.currentPlayer !== playerIndex) return cb && cb({ error:'Not your turn' });
    const roll = state.pendingRoll;
    if(typeof roll !== 'number') return cb && cb({ error:'No pending roll' });

    // Simple validation: allow enter if token at home and roll==6
    const tok = state.players[playerIndex].tokens[tokenIndex];
    if(tok.status === 'home'){
      if(roll !== 6) return cb && cb({ error:'Need a 6 to enter' });
      // move to start index
      tok.status = 'onboard'; tok.pos = state.startIndices[playerIndex];
      state.pendingRoll = null;
      // broadcast validated move
      io.to(socket.roomId).emit('gameAction', { type:'move', player:playerIndex, token:tokenIndex, fromPos:null, toPos:tok.pos, toStatus:'onboard' });
      // capture if applicable
      captureAt(room, tok.pos, playerIndex);
      // handle turn advance (unless roll was 6)
      if(roll !== 6) state.currentPlayer = (state.currentPlayer+1) % state.players.length;
      io.to(socket.roomId).emit('gameState', state);
      return cb && cb({ ok:true });
    } else if(tok.status === 'onboard'){
      // simple forward movement along 52 positions, no home-stretch logic for simplicity
      const newPos = (tok.pos + roll) % 52;
      tok.pos = newPos;
      state.pendingRoll = null;
      io.to(socket.roomId).emit('gameAction', { type:'move', player:playerIndex, token:tokenIndex, fromPos:tok.pos - roll, toPos:tok.pos, toStatus:'onboard' });
      captureAt(room, tok.pos, playerIndex);
      if(roll !== 6) state.currentPlayer = (state.currentPlayer+1) % state.players.length;
      io.to(socket.roomId).emit('gameState', state);
      return cb && cb({ ok:true });
    } else {
      return cb && cb({ error:'Token already finished' });
    }
  });

  // WebRTC signaling for voice: relay offers/answers/ICE to peers in room
  socket.on('webrtc-offer', ({to, offer})=>{
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });
  socket.on('webrtc-answer', ({to, answer})=>{
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });
  socket.on('webrtc-ice', ({to, candidate})=>{
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  socket.on('leaveRoom', ()=>{
    const roomId = socket.roomId;
    if(roomId && rooms[roomId]){
      rooms[roomId].players = rooms[roomId].players.filter(p=>p.id!==socket.id);
      io.to(roomId).emit('roomUpdate', rooms[roomId]);
      if(rooms[roomId].players.length===0) { delete rooms[roomId]; }
      else { if(rooms[roomId].hostId===socket.id) rooms[roomId].hostId = rooms[roomId].players[0].id; }
      broadcastRooms();
    }
    socket.leave(roomId);
    delete socket.roomId;
  });

  socket.on('disconnect', ()=>{
    const roomId = socket.roomId;
    if(roomId && rooms[roomId]){
      rooms[roomId].players = rooms[roomId].players.filter(p=>p.id!==socket.id);
      io.to(roomId).emit('roomUpdate', rooms[roomId]);
      if(rooms[roomId].players.length===0) delete rooms[roomId];
      else if(rooms[roomId].hostId===socket.id) rooms[roomId].hostId = rooms[roomId].players[0].id;
      broadcastRooms();
    }
  });
});

function createInitialGameState(count){
  const st = { players:[], currentPlayer:0, startIndices:[0,13,26,39], pendingRoll:null };
  for(let i=0;i<count;i++) st.players.push({ colorIndex:i, tokens:[ {status:'home'},{status:'home'},{status:'home'},{status:'home'} ] });
  return st;
}

function captureAt(room, pos, ownerIndex){
  room.players.forEach((p,pi)=>{
    if(pi===ownerIndex) return;
    const stp = room.state.players[pi];
    stp.tokens.forEach((t,ti)=>{
      if(t.status==='onboard' && t.pos === pos){
        t.status = 'home'; t.pos = -1;
        io.to(room.hostId).emit('chat', { from:'Server', text: `${room.players[ownerIndex].name} captured ${room.players[pi].name}'s token ${ti+1}`, ts: Date.now() });
      }
    });
  });
}

server.listen(PORT, ()=> console.log('listening', PORT));
