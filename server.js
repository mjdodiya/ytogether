// YTogether - Sync Server
// Node.js WebSocket server that manages rooms, relays sync events, and handles queue

const { WebSocketServer } = require('ws');
const { parse } = require('url');

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

// rooms: Map<roomId, Room>
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.members = new Map(); // username -> { ws, isHost }
    this.queue = [];
    this.currentIndex = 0;
    this.createdAt = Date.now();
  }

  get memberList() {
    return Array.from(this.members.entries()).map(([username, data]) => ({
      username,
      isHost: data.isHost
    }));
  }

  broadcast(msg, excludeUsername = null) {
    const data = JSON.stringify(msg);
    for (const [username, { ws }] of this.members) {
      if (username === excludeUsername) continue;
      if (ws.readyState === 1) ws.send(data);
    }
  }

  broadcastAll(msg) {
    this.broadcast(msg, null);
  }

  send(username, msg) {
    const member = this.members.get(username);
    if (member && member.ws.readyState === 1) {
      member.ws.send(JSON.stringify(msg));
    }
  }
}

// ── Connection Handler ────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const { query } = parse(req.url, true);
  const roomId = (query.room || '').toUpperCase().slice(0, 10);
  const username = decodeURIComponent(query.user || 'Anonymous').slice(0, 20);
  const isHost = query.host === 'true';

  if (!roomId || !username) {
    ws.close(1008, 'Missing room or username');
    return;
  }

  // Get or create room
  if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId));
  const room = rooms.get(roomId);

  // Handle duplicate usernames
  let finalUsername = username;
  let suffix = 2;
  while (room.members.has(finalUsername)) {
    finalUsername = `${username}${suffix++}`;
  }

  room.members.set(finalUsername, { ws, isHost: isHost || room.members.size === 0 });

  console.log(`[+] ${finalUsername} joined room ${roomId} (${room.members.size} members)`);

  // Send current room state to the new joiner
  ws.send(JSON.stringify({
    type: 'ROOM_STATE',
    members: room.memberList,
    queue: room.queue,
    currentIndex: room.currentIndex
  }));

  // Notify others
  room.broadcast({
    type: 'MEMBER_JOIN',
    username: finalUsername,
    members: room.memberList
  }, finalUsername);

  // ── Message Handler ──────────────────────────────────────────────────────

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    msg.username = finalUsername; // Always use server-verified username

    switch (msg.type) {

      // ── Sync (relay to others) ──────────────────────────────────────────
      case 'PLAY':
      case 'PAUSE':
      case 'SEEK':
        room.broadcast(msg, finalUsername);
        break;

      // ── Queue: Add video ────────────────────────────────────────────────
      case 'ADD_VIDEO':
        if (msg.video && msg.video.videoId) {
          room.queue.push(msg.video);
          room.broadcastAll({
            type: 'QUEUE_UPDATE',
            queue: room.queue,
            currentIndex: room.currentIndex,
            action: 'add',
            addedBy: finalUsername
          });
          // If this is the first video, navigate everyone to it
          if (room.queue.length === 1) {
            room.broadcastAll({
              type: 'VIDEO_CHANGE',
              videoId: msg.video.videoId,
              currentIndex: 0
            });
          }
        }
        break;

      // ── Queue: Remove video ─────────────────────────────────────────────
      case 'REMOVE_VIDEO':
        const idx = parseInt(msg.index);
        if (!isNaN(idx) && idx >= 0 && idx < room.queue.length) {
          room.queue.splice(idx, 1);
          if (room.currentIndex >= room.queue.length) {
            room.currentIndex = Math.max(0, room.queue.length - 1);
          }
          room.broadcastAll({
            type: 'QUEUE_UPDATE',
            queue: room.queue,
            currentIndex: room.currentIndex
          });
        }
        break;

      // ── Queue: Play specific index ──────────────────────────────────────
      case 'PLAY_INDEX':
        const playIdx = parseInt(msg.index);
        if (!isNaN(playIdx) && playIdx >= 0 && playIdx < room.queue.length) {
          room.currentIndex = playIdx;
          const video = room.queue[playIdx];
          room.broadcastAll({
            type: 'VIDEO_CHANGE',
            videoId: video.videoId,
            currentIndex: playIdx,
            queue: room.queue
          });
        }
        break;

      // ── Video ended: auto-advance ───────────────────────────────────────
      case 'VIDEO_ENDED':
        // Only let the first person who reports this trigger advance
        if (room.currentIndex < room.queue.length - 1) {
          room.currentIndex++;
          const next = room.queue[room.currentIndex];
          room.broadcastAll({
            type: 'VIDEO_CHANGE',
            videoId: next.videoId,
            currentIndex: room.currentIndex,
            queue: room.queue
          });
        }
        break;

      // ── Chat ────────────────────────────────────────────────────────────
      case 'CHAT':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          room.broadcastAll({
            type: 'CHAT',
            username: finalUsername,
            text: msg.text.trim().slice(0, 500),
            ts: Date.now()
          });
        }
        break;

      default:
        break;
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────

  ws.on('close', () => {
    room.members.delete(finalUsername);
    console.log(`[-] ${finalUsername} left room ${roomId} (${room.members.size} members)`);

    if (room.members.size === 0) {
      // Clean up empty rooms after a delay
      setTimeout(() => {
        if (rooms.get(roomId)?.members.size === 0) {
          rooms.delete(roomId);
          console.log(`[x] Room ${roomId} deleted (empty)`);
        }
      }, 60_000);
    } else {
      // If host left, transfer to next person
      const leftWasHost = isHost;
      if (leftWasHost) {
        const [newHostName, newHostData] = room.members.entries().next().value;
        newHostData.isHost = true;
        room.members.set(newHostName, newHostData);
        room.broadcastAll({ type: 'HOST_TRANSFER', newHost: newHostName });
      }

      room.broadcastAll({
        type: 'MEMBER_LEAVE',
        username: finalUsername,
        members: room.memberList
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] Error for ${finalUsername}:`, err.message);
  });
});

console.log(`\n🎬 YTogether Server running on ws://localhost:${PORT}`);
console.log(`   Waiting for connections...\n`);

// Periodic cleanup of stale rooms (>6 hours old, empty)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.members.size === 0 && now - room.createdAt > 6 * 3600 * 1000) {
      rooms.delete(id);
    }
  }
}, 3600_000);
