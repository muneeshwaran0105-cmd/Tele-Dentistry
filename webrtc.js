/**
 * webrtc.js — Teledentistry Phase 10: Dynamic Video Grid & Focus Mode
 * ====================================================================
 * Full two-way video & audio conferencing over a multi-peer mesh,
 * with a Zoom/Meet-style dynamic CSS grid on the Consultant dashboard.
 *
 * Roles:
 *   • DENTIST   (dentist.html)  — sends local camera/USB tracks,
 *                                  receives Consultant AV into floating PiP
 *   • SUPERIOR  (superior.html) — receives Provider tracks into a dynamic
 *                                  grid, supports Focus Mode per tile,
 *                                  captures & broadcasts own camera/mic
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_URL = 'wss://tele-dentistry-server.onrender.com';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ---------------------------------------------------------------------------
// Shared State
// ---------------------------------------------------------------------------

const localPeerId = 'p-' + Math.random().toString(36).substr(2, 6);
let socket = null;
let currentRoomId = null;
let role = null;

// Dictionary of active RTCPeerConnections: { [remotePeerId]: RTCPeerConnection }
const peerConnections = {};

// Tracks injected remote streams on Superior: { [streamId]: { stream, peerId, slotEl, slotIndex } }
const remoteStreams = new Map();

// ── Phase 8: Consultant local media ─────────────────────────────────────
let localConsultantStream = null;   // MediaStream from getUserMedia on Superior
let consultantMicMuted = false;
let consultantCamPaused = false;

// ---------------------------------------------------------------------------
// Utility: logging & UI
// ---------------------------------------------------------------------------
function log(...args) { console.log(`[webrtc/${role}/${localPeerId}]`, ...args); }
function warn(...args) { console.warn(`[webrtc/${role}/${localPeerId}]`, ...args); }

function showToast(message, type = 'info') {
  if (typeof showError === 'function' && type === 'error') {
    showError(message);
    return;
  }
  let toaster = document.getElementById('rtc-toaster');
  if (!toaster) {
    toaster = document.createElement('div');
    toaster.id = 'rtc-toaster';
    toaster.style.cssText = `
      position:fixed; top:76px; left:50%; transform:translateX(-50%);
      padding:10px 20px; border-radius:8px; font-size:14px; z-index:9999;
      box-shadow:0 4px 12px rgba(0,0,0,0.2); max-width:90vw; text-align:center;
      color:#fff; transition:opacity 0.3s;
    `;
    document.body.appendChild(toaster);
  }
  toaster.style.background = type === 'error' ? '#e74c3c' : type === 'success' ? '#27ae60' : '#4A90E2';
  toaster.textContent = message;
  toaster.style.opacity = '1';
  toaster.style.display = 'block';
  clearTimeout(toaster._t);
  toaster._t = setTimeout(() => { toaster.style.opacity = '0'; }, 4000);
}

// ===========================================================================
// SECTION A — WebSocket Connection & Message Router
// ===========================================================================

function connectSignaling(onOpenCallback) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    onOpenCallback();
    return;
  }

  log('Connecting to signaling server:', WS_URL);
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    log('WebSocket connected.');
    onOpenCallback();
    startNetworkMonitoring(); // Phase 21: Start health checks
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { warn('Non-JSON message:', event.data); return; }
    routeSignalingMessage(msg);
  };

  socket.onerror = (err) => {
    warn('WebSocket error:', err);
    showToast('Signaling connection error.', 'error');
  };

  socket.onclose = () => {
    log('WebSocket disconnected.');
  };
}

function sendSignal(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!payload.peer_id) payload.peer_id = localPeerId;
  if (!payload.sender_id) payload.sender_id = localPeerId;
  socket.send(JSON.stringify(payload));
}

async function routeSignalingMessage(msg) {
  const eventType = msg.event ?? msg.type ?? msg.action;
  log('↓ Received:', eventType, msg);

  switch (msg.event) {
    case 'room_created':
      currentRoomId = msg.room_id;
      handleRoomCreated(msg);
      break;

    case 'room_joined':
      currentRoomId = msg.room_id;
      handleRoomJoined(msg);
      break;

    case 'peer_joined':
      if (msg.peer_id !== localPeerId) {
        log(`New peer joined: ${msg.peer_id}. Initiating mesh connection...`);
        initiatePeerConnection(msg.peer_id);
      }
      break;

    case 'peer_left':
      log(`Peer left: ${msg.peer_id}`);
      cleanupPeer(msg.peer_id);
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;

    default:
      // WebRTC Signaling Relay
      const senderId = msg.sender_id;
      if (!senderId) return;

      if (msg.type === 'offer')          { await handleOffer(msg); }
      else if (msg.type === 'answer')    { await handleAnswer(msg); }
      else if (msg.type === 'ice-candidate') { await handleIceCandidate(msg); }
      else if (msg.type === 'camera_stopped') { handleCameraStoppedMsg(msg); }
      else if (msg.type === 'media_state') { handleMediaStateMsg(msg); }
  }
}

// ===========================================================================
// SECTION B — Room Management
// ===========================================================================

function onCreateRoomClick() {
  const roomInput = document.getElementById('roomId');
  const customRoom = roomInput?.value.trim() || undefined;

  connectSignaling(() => {
    const payload = { action: 'create_room', peer_id: localPeerId };
    if (customRoom) payload.room_id = customRoom;
    sendSignal(payload);
  });
}

function handleRoomCreated(msg) {
  log(`Room created | id=${msg.room_id} pin=${msg.pin}`);
  showToast(`Room created! PIN: ${msg.pin}`, 'success');

  const pinEl = document.getElementById('roomPin');
  if (pinEl) { pinEl.value = msg.pin; pinEl.setAttribute('readonly', true); }
  const roomEl = document.getElementById('roomId');
  if (roomEl) { roomEl.value = msg.room_id; roomEl.setAttribute('readonly', true); }

  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (createBtn) createBtn.disabled = true;
  if (joinBtn) joinBtn.disabled = true;

  // Phase 25: Update Room Info Display
  const displayId = document.getElementById('displayRoomId');
  const displayPin = document.getElementById('displayRoomPin');
  if (displayId) displayId.textContent = msg.room_id;
  if (displayPin) displayPin.textContent = msg.pin;

  // Phase 22: Trigger smooth UI transition
  if (typeof window.closeEntryModal === 'function') {
    window.closeEntryModal();
  }
}

function onJoinRoomClick() {
  const pinInput = document.getElementById('roomPin');
  const roomInput = document.getElementById('roomId');
  const pin = pinInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!roomId || !/^\d{4}$/.test(pin)) {
    showToast('Invalid Room ID or PIN.', 'error');
    return;
  }

  connectSignaling(() => {
    sendSignal({ action: 'join_room', room_id: roomId, pin, peer_id: localPeerId });
  });
}

function handleRoomJoined(msg) {
  log(`Joined room | id=${msg.room_id}`);
  showToast(`Joined room "${msg.room_id}"!`, 'success');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.disabled = true;

  // Phase 25: Update Room Info Display
  const displayId = document.getElementById('displayRoomId');
  const displayPin = document.getElementById('displayRoomPin');
  if (displayId) displayId.textContent = msg.room_id || currentRoomId;
  if (displayPin) displayPin.textContent = msg.pin || '****';

  // Phase 22: Trigger smooth UI transition
  if (typeof window.closeEntryModal === 'function') {
    window.closeEntryModal();
  }
}

// ===========================================================================
// SECTION C — Multi-Peer Connection Management (Mesh Core)
// ===========================================================================

function getLocalStream() {
    return window.localConsultantStream || window.localStream;
}

/**
 * Factory: creates or retrieves an RTCPeerConnection for a remote peer.
 * Both roles add their local tracks and bind ontrack handlers.
 */
function getOrCreatePeerConnection(remotePeerId) {
  if (peerConnections[remotePeerId]) {
    return peerConnections[remotePeerId];
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[remotePeerId] = pc;
  log(`RTCPeerConnection created for ${remotePeerId}`);

  // Auto-add local tracks if available
  const currentStream = getLocalStream();
  if (currentStream) {
    currentStream.getTracks().forEach(track => {
      pc.addTrack(track, currentStream);
      log(`Added local track (${track.kind}) to new connection with ${remotePeerId}`);
    });
  }

  // ── ICE relay ──────────────────────────────────────────────────────
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      sendSignal({
        action: 'relay',
        room_id: currentRoomId,
        target_id: remotePeerId,
        type: 'ice-candidate',
        candidate: candidate.toJSON(),
      });
    }
  };

  pc.onconnectionstatechange = () => {
    log(`Connection state with ${remotePeerId}:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      showToast('Peer connected!', 'success');
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      cleanupPeer(remotePeerId);
    }
  };

  // ── DENTIST: add local camera/USB tracks + receive Consultant AV ──
  if (role === 'dentist') {
    addDentistTracksToConnection(pc);

    pc.onnegotiationneeded = async () => {
      log(`Negotiation needed for ${remotePeerId}`);
      await initiateOffer(remotePeerId);
    };

    // Phase 8: Provider receives Consultant's remote AV stream
    pc.ontrack = (event) => {
      // Prevent local stream from playing in the remote video element
      if (window.localStream && event.streams[0] && event.streams[0].id === window.localStream.id) {
          console.warn("Caught local stream attempting to play in remote element. Blocking.");
          return; 
      }
      
      let stream = event.streams && event.streams[0];
      if (!stream) {
        if (!pc.remotePipedStream) pc.remotePipedStream = new MediaStream();
        pc.remotePipedStream.addTrack(event.track);
        stream = pc.remotePipedStream;
      }
      log(`[DENTIST] Remote track from consultant ${remotePeerId}:`, event.track.kind);
      handleConsultantRemoteTrack(stream);
    };
  }

  // ── SUPERIOR (Consultant): add local tracks + receive Provider feeds ─
  if (role === 'superior') {
    // Phase 14: Force the connection to negotiate bidirectional media lines
    // safely, before `addConsultantTracksToConnection` modifies them.
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });

    // Phase 8: Add consultant's local camera/mic tracks to this connection
    addConsultantTracksToConnection(pc);

    pc.ontrack = (event) => {
      // Prevent local stream from playing in the remote video element
      if (window.localStream && event.streams[0] && event.streams[0].id === window.localStream.id) {
          console.warn("Caught local stream attempting to play in remote element. Blocking.");
          return; 
      }
      
      let stream = event.streams && event.streams[0];
      if (!stream) {
        if (!pc.remotePipedStream) pc.remotePipedStream = new MediaStream();
        pc.remotePipedStream.addTrack(event.track);
        stream = pc.remotePipedStream;
      }
      log(`[SUPERIOR] Remote track from provider ${remotePeerId}:`, event.track.kind);
      
      let existingStreamsForPeer = Array.from(remoteStreams.values()).filter(x => x.peerId === remotePeerId);
      let isPrimaryFound = existingStreamsForPeer.length > 0;
      let isTrackInNewStream = existingStreamsForPeer.every(x => x.stream.id !== stream.id);

      if (isPrimaryFound && isTrackInNewStream && event.track.kind === 'video') {
          log('[SUPERIOR] Secondary intraoral track received from Provider');
          const intraFeed = document.getElementById('intraoralVideoFeed');
          const parentGrid = document.getElementById('videoGridContainer');
          
          if (intraFeed) {
              intraFeed.srcObject = stream;
              intraFeed.classList.remove('hidden');
          }
          if (parentGrid) {
              parentGrid.classList.remove('grid-cols-1');
              parentGrid.classList.add('grid-cols-2');
          }
          remoteStreams.set(stream.id, { stream, peerId: remotePeerId, type: 'intraoral' });
      } else {
          handleRemoteTrack(event.track, stream, remotePeerId);
      }
    };
  }

  return pc;
}

/**
 * Adds Provider's local camera/USB tracks to a peer connection.
 */
function addDentistTracksToConnection(pc) {
  const streams = [window.pcStream, window.usbStream].filter(Boolean);
  const existingTrackIds = new Set(pc.getSenders().map(s => s.track?.id).filter(Boolean));

  streams.forEach(stream => {
    stream.getTracks().forEach(track => {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, stream);
        log('Dentist track added:', track.kind, track.label);
      }
    });
  });
}

/**
 * Phase 18: Adds Consultant's local camera/mic tracks to a peer connection.
 * Uses explicit transceiver routing to ensure Safari encoders wake up.
 */
function addConsultantTracksToConnection(pc) {
  if (!window.localConsultantStream) return;

  window.localConsultantStream.getTracks().forEach(track => {
    const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === track.kind);
    if (transceiver) {
      transceiver.sender.replaceTrack(track).catch(e => console.error("replaceTrack error:", e));
      transceiver.direction = 'sendrecv'; // Force encoder wake-up
      log(`Consultant ${track.kind} track (transceiver) replaced & direction set to sendrecv`);
    } else {
      pc.addTrack(track, window.localConsultantStream);
      log(`Consultant ${track.kind} track added via addTrack`);
    }
  });
}

/**
 * Phase 32: Intercept explicitly added intraoral hardware
 */
window.addIntraoralTrackToMesh = () => {
    if (!window.localIntraoralStream) return;
    const track = window.localIntraoralStream.getVideoTracks()[0];
    if (!track) return;
    
    for (const peerId in peerConnections) {
        const pc = peerConnections[peerId];
        const existingTrackIds = new Set(pc.getSenders().map(s => s.track && s.track.id).filter(Boolean));
        if (!existingTrackIds.has(track.id)) {
            pc.addTrack(track, window.localIntraoralStream); 

            // Force renegotiation to send the second video
            pc.createOffer()
              .then(offer => pc.setLocalDescription(offer))
              .then(() => {
                  sendSignal({
                      action: 'relay', 
                      room_id: currentRoomId, 
                      target_id: peerId, 
                      sender_id: localPeerId, 
                      type: 'offer', 
                      sdp: pc.localDescription
                  });
              });
        }
    }
};


/**
 * Initiator sends an offer to a specific peer.
 */
async function initiatePeerConnection(remotePeerId) {
  getOrCreatePeerConnection(remotePeerId);
  await initiateOffer(remotePeerId);
}

async function initiateOffer(remotePeerId) {
  const pc = peerConnections[remotePeerId];
  if (!pc) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({
      action: 'relay',
      room_id: currentRoomId,
      target_id: remotePeerId,
      type: 'offer',
      sdp: pc.localDescription,
    });
    log(`Offer sent to ${remotePeerId}`);
  } catch (err) {
    warn(`Offer failed for ${remotePeerId}:`, err);
  }
}

// ===========================================================================
// SECTION D — Signaling Message Handlers
// ===========================================================================

async function handleOffer(msg) {
  const senderId = msg.sender_id;
  const pc = getOrCreatePeerConnection(senderId);

  // 2. INJECT TRACKS IMMEDIATELY (Critical Fix Phase 27)
  const currentStream = getLocalStream();
  if (currentStream) {
      currentStream.getTracks().forEach(track => {
          const existingTrackIds = new Set(pc.getSenders().map(s => s.track?.id).filter(Boolean));
          if (!existingTrackIds.has(track.id)) {
              pc.addTrack(track, currentStream);
              log(`[webrtc] Added local track (${track.kind}) to answer for ${senderId}`);
          }
      });
  } else {
      warn(`[webrtc] Warning: No local streams available when answering offer from ${senderId}`);
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({
      action: 'relay',
      room_id: currentRoomId,
      target_id: senderId,
      type: 'answer',
      sdp: pc.localDescription,
    });
    log(`Answer sent to ${senderId}`);
  } catch (err) {
    warn(`handleOffer failed for ${senderId}:`, err);
  }
}

async function handleAnswer(msg) {
  const senderId = msg.sender_id;
  const pc = peerConnections[senderId];
  if (!pc) return;

  if (pc.signalingState === 'have-local-offer') {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      log(`Answer accepted from ${senderId}`);
    } catch (err) {
      warn(`handleAnswer failed for ${senderId}:`, err);
    }
  } else {
    warn(`Ignored stray answer from ${senderId}. State: ${pc.signalingState}`);
  }
}

async function handleIceCandidate(msg) {
  const pc = peerConnections[msg.sender_id];
  if (!pc || !msg.candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch (err) {
    warn(`addIceCandidate failed for ${msg.sender_id}:`, err);
  }
}

// ===========================================================================
// SECTION E — Provider: Receiving Consultant's Remote AV
// ===========================================================================

/**
 * Called on the DENTIST side when a Consultant's track arrives.
 * Attaches the stream to the floating PiP video element.
 */
function handleConsultantRemoteTrack(stream) {
  const videoEl = document.getElementById('consultantRemoteVideo');
  const container = document.getElementById('consultantPipContainer');
  if (!videoEl) return;

  // Show the container
  if (container) container.style.display = '';

  // Phase 19 fix: Guard srcObject assignment to prevent "Double-Fire" AbortError
  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
    // CRITICAL: do NOT mute — Provider must hear Consultant
    videoEl.muted = false;

    // Phase 26: Hide waiting overlay if it exists
    const overlay = document.getElementById('cameraWaitingOverlay');
    if (overlay) overlay.style.display = 'none';
  }
  log('Consultant remote stream attached to PiP.');
}

// ===========================================================================
// SECTION F — Superior: Dynamic Video Grid, Focus Mode & Cleanup
// ===========================================================================

/**
 * Creates or retrieves a video tile for a given senderId.
 * Each tile contains: <video>, a floating label, and a Focus button.
 *
 * @param {string} senderId — the remote peer ID
 * @returns {{ tile: HTMLElement, video: HTMLVideoElement }}
 */
function getOrCreateVideoTile(senderId) {
  const grid = document.getElementById('dynamicVideoGrid');
  if (!grid) return { tile: null, video: null };

  // ── State Preservation: Reuse existing tile ──────────────────────
  const existingVideo = document.getElementById(`video-${senderId}`);
  if (existingVideo) {
    const existingTile = document.getElementById(`tile-${senderId}`);
    return { tile: existingTile, video: existingVideo };
  }

  // ── Build new tile ───────────────────────────────────────────────
  const tile = document.createElement('div');
  tile.className = 'video-tile fade-in';
  tile.id = `tile-${senderId}`;

  // Video element
  const video = document.createElement('video');
  video.id = `video-${senderId}`;
  
  // Phase 16: iOS Safari Attributes (Attributes FIRST, then srcObject later)
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.playsInline = true; 
  video.autoplay = true;
  video.muted = false; // Phase 34: explicitly ensure remote feeds are unmuted
  // DO NOT set muted here for remote feeds
  
  tile.appendChild(video);

  // Label overlay (bottom-left)
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.innerHTML = `<span class="status-dot"></span><span>${senderId}</span>`;
  tile.appendChild(label);

  // Focus button (top-right, visible on hover)
  const focusBtn = document.createElement('button');
  focusBtn.className = 'focus-btn';
  focusBtn.innerHTML = '<i class="fa-solid fa-expand"></i> Focus';
  focusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFocusMode(senderId);
  });
  tile.appendChild(focusBtn);

  // Hide the empty-state placeholder
  const emptyState = document.getElementById('gridEmptyState');
  if (emptyState) emptyState.style.display = 'none';

  grid.appendChild(tile);
  updateGridLayout();

  return { tile, video };
}

/**
 * Counts children video-tiles in the grid and applies the correct
 * CSS grid class (grid-1, grid-2, …, grid-many).
 */
function updateGridLayout() {
  const grid = document.getElementById('dynamicVideoGrid');
  if (!grid) return;

  const tiles = grid.querySelectorAll('.video-tile');
  const count = tiles.length;

  // Strip old grid-* classes
  grid.className = grid.className.replace(/\bgrid-\S+/g, '').trim();

  if (count === 0) {
    grid.classList.add('grid-1');
    const emptyState = document.getElementById('gridEmptyState');
    if (emptyState) emptyState.style.display = '';
  } else if (count <= 6) {
    grid.classList.add(`grid-${count}`);
  } else {
    grid.classList.add('grid-many');
  }
}

/**
 * Phase 10: Dynamic ontrack handler for the Superior role.
 * Checks if a tile for the senderId already exists (state preservation for
 * camera toggle re-negotiation) and creates one if it doesn't.
 */
function handleRemoteTrack(track, stream, peerId) {
  const { tile, video } = getOrCreateVideoTile(peerId);
  if (!video || !tile) return;

  // Phase 26: Hide the waiting overlay on first remote track
  const overlay = document.getElementById('cameraWaitingOverlay');
  if (overlay) overlay.style.display = 'none';

  // Phase 19 fix: Guard srcObject assignment to prevent "Double-Fire" AbortError
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    
    // Phase 19 fix: Delay playback slightly to allow tracks to settle
    setTimeout(() => {
      video.play().catch(error => {
        console.warn("[webrtc] Safari Autoplay Blocked. Spawning Play button.", error);
        
        // Check if button already exists
        if (tile.querySelector('.safari-play-btn')) return;

        const playBtn = document.createElement('button');
        playBtn.innerHTML = '<i class="fa-solid fa-play mr-2"></i> Tap to Play Video';
        playBtn.className = "safari-play-btn absolute inset-0 m-auto w-48 h-12 bg-blue-600 text-white rounded-full z-50 shadow-lg font-bold flex items-center justify-center transform active:scale-95 transition-all";

        playBtn.onclick = (e) => {
            e.stopPropagation();
            video.play().then(() => {
                playBtn.remove(); 
            }).catch(err => console.error("Play failed even after click:", err));
        };

        tile.appendChild(playBtn);
      });
    }, 100);
  }

  // Track the stream for cleanup
  remoteStreams.set(stream.id, { stream, peerId, tileId: `tile-${peerId}` });

  // If the track ends (e.g. camera stopped), we keep the tile but can gray it out
  track.onended = () => {
    log(`Track ended from ${peerId}: ${track.kind}`);
  };
}

/**
 * Toggles Focus Mode on a specific tile.
 * - Focus: hides all other tiles, expands the focused tile to fill the grid.
 * - Exit:  restores all tiles to normal grid layout.
 */
function toggleFocusMode(senderId) {
  const grid = document.getElementById('dynamicVideoGrid');
  const tile = document.getElementById(`tile-${senderId}`);
  if (!grid || !tile) return;

  const isFocused = tile.classList.contains('focused');

  if (isFocused) {
    // ── Exit Focus Mode ───────────────────────────────────────────
    tile.classList.remove('focused');
    grid.classList.remove('focus-active');

    const btn = tile.querySelector('.focus-btn');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-expand"></i> Focus';

    log(`Exited focus mode for ${senderId}`);
  } else {
    // ── Enter Focus Mode ──────────────────────────────────────────
    // Remove focus from any other tile first
    grid.querySelectorAll('.video-tile.focused').forEach(t => {
      t.classList.remove('focused');
      const b = t.querySelector('.focus-btn');
      if (b) b.innerHTML = '<i class="fa-solid fa-expand"></i> Focus';
    });

    tile.classList.add('focused');
    grid.classList.add('focus-active');

    const btn = tile.querySelector('.focus-btn');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-compress"></i> Exit Focus';

    log(`Entered focus mode for ${senderId}`);
  }
}

/**
 * Removes a disconnected peer's tile from the grid and recalculates layout.
 */
function cleanupPeer(peerId) {
  log(`Cleaning up peer: ${peerId}`);

  // Close the RTCPeerConnection
  const pc = peerConnections[peerId];
  if (pc) {
    pc.close();
    delete peerConnections[peerId];
  }

  // Clear tracked streams belonging to this peer
  [...remoteStreams.entries()].forEach(([streamId, entry]) => {
    if (entry.peerId === peerId) {
      remoteStreams.delete(streamId);
    }
  });

  // ── Phase 10: Remove the tile from the dynamic grid ─────────────
  if (role === 'superior') {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      // If this tile was focused, exit focus mode first
      const grid = document.getElementById('dynamicVideoGrid');
      if (tile.classList.contains('focused') && grid) {
        grid.classList.remove('focus-active');
      }

      // Cleanly stop the video
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = null;

      tile.remove();
      updateGridLayout();
    }
  }

  // On dentist side, hide consultant PiP if the consultant left
  if (role === 'dentist') {
    const container = document.getElementById('consultantPipContainer');
    const videoEl = document.getElementById('consultantRemoteVideo');
    if (container) container.style.display = 'none';
    if (videoEl) videoEl.srcObject = null;
  }

  showToast(`Peer ${peerId} disconnected.`, 'info');
}

// ---------------------------------------------------------------------------
// UI Helpers (kept for dentist side compatibility)
// ---------------------------------------------------------------------------

function injectVideo(container, stream, type) {
  let video = container.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    container.appendChild(video);
  }
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.playsInline = true;
  video.autoplay = true;
  // For remote Consultant feed on Dentist side, we want audio
  
  video.className = 'absolute inset-0 w-full h-full z-10 ' + (type === 'primary' ? 'object-contain' : 'object-cover');
  
  // Phase 19 fix: Guard srcObject assignment
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    video.classList.remove('hidden');
    
    // Phase 19 fix: 100ms settled delay
    setTimeout(() => {
      video.play().catch(error => {
        console.warn("[webrtc] Safari Autoplay (PiP) Blocked. Spawning Play button.", error);
        if (container.querySelector('.safari-play-btn')) return;

        const playBtn = document.createElement('button');
        playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        playBtn.className = "safari-play-btn absolute inset-0 m-auto w-12 h-12 bg-blue-600 text-white rounded-full z-50 shadow-lg flex items-center justify-center";

        playBtn.onclick = (e) => {
            e.stopPropagation();
            video.play().then(() => {
                playBtn.remove();
            });
        };
        container.appendChild(playBtn);
      });
    }, 100);
  }
}

function updateMainFeedLabel(label) {
  const el = document.getElementById('mainFeedLabel');
  if (el) el.textContent = label;
}

function handleCameraStoppedMsg(msg) {
  showToast(`Peer ${msg.sender_id} stopped their camera.`, 'info');
}

function handleMediaStateMsg(msg) {
  const isVideoOn = msg.video;
  const peerId = msg.sender_id;

  if (role === 'superior') {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const video = tile.querySelector('video');
      let placeholder = tile.querySelector('.cam-paused-overlay');
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'cam-paused-overlay absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 text-slate-300 z-10 transition-opacity';
        placeholder.innerHTML = '<i class="fa-solid fa-circle-pause text-4xl mb-2"></i><span class="text-sm font-semibold tracking-wide">Camera Paused</span>';
        tile.insertBefore(placeholder, tile.firstChild);
      }
      if (isVideoOn) {
        if (video) video.style.opacity = '1';
        placeholder.style.display = 'none';
        // Phase 19: REMOVED video.play() to avoid Safari block/interruption
      } else {
        if (video) video.style.opacity = '0';
        placeholder.style.display = 'flex';
        // Phase 19: REMOVED video.pause() to avoid Safari block/interruption
      }
    }
  }

  if (role === 'dentist') {
    const consultantVideo = document.getElementById('consultantRemoteVideo');
    if (consultantVideo) {
      const container = document.getElementById('consultantPipContainer');
      let placeholder = container.querySelector('.cam-paused-overlay');
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'cam-paused-overlay absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 text-slate-300 z-10 rounded-2xl overflow-hidden transition-opacity';
        placeholder.innerHTML = '<i class="fa-solid fa-circle-pause text-3xl mb-1"></i><span class="text-xs font-semibold">Paused</span>';
        container.insertBefore(placeholder, container.firstChild);
      }
      if (isVideoOn) {
        consultantVideo.style.opacity = '1';
        placeholder.style.display = 'none';
        // Phase 19: REMOVED playback calls
      } else {
        consultantVideo.style.opacity = '0';
        placeholder.style.display = 'flex';
        // Phase 19: REMOVED playback calls
      }
    }
  }
}

// ===========================================================================
// SECTION G — Phase 8: Consultant Local Media Capture
// ===========================================================================

/**
 * Starts the Consultant's local camera and microphone.
 * Displays the local preview and adds tracks to all existing peer connections.
 */
async function startConsultantMedia() {
  if (localConsultantStream) {
    log('Consultant media already running.');
    return;
  }

  try {
    localConsultantStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 }
      },
      audio: true,
    });
    window.localConsultantStream = localConsultantStream; // Phase 18: Make global for transceiver logic
    log('Consultant local media captured:', localConsultantStream.getTracks().map(t => t.kind));

    // Show local preview
    const previewVideo = document.getElementById('localConsultantVideo');
    const previewContainer = document.getElementById('localPreviewContainer');
    if (previewVideo) {
      previewVideo.muted = true;       // CRITICAL for Safari local autoplay
      previewVideo.playsInline = true; // CRITICAL for iOS
      previewVideo.autoplay = true;
      previewVideo.srcObject = localConsultantStream;
      previewVideo.play().catch(e => console.error("Local play failed:", e));
    }
    if (previewContainer) previewContainer.style.display = '';

    // Phase 26: Hide overlays on successful local media
    const overlay = document.getElementById('cameraWaitingOverlay');
    if (overlay) overlay.style.display = 'none';

    // Phase 28: Force Unconditional Renegotiation with all peers (Rigid Requirement)
    const activePeers = Object.keys(peerConnections);
    log(`Force-renegotiating with ${activePeers.length} active peers...`);

    for (const peerId of activePeers) {
        const pc = peerConnections[peerId];

        window.localConsultantStream.getTracks().forEach(track => {
            // Find transceiver matching this track kind
            const transceiver = pc.getTransceivers().find(t => 
                (t.sender && t.sender.track && t.sender.track.kind === track.kind) || 
                (t.receiver && t.receiver.track && t.receiver.track.kind === track.kind)
            );

            if (transceiver) {
                log(`Existing transceiver for ${track.kind} to ${peerId}. Replacing track...`);
                transceiver.sender.replaceTrack(track).catch(e => warn("replaceTrack failed:", e));
                transceiver.direction = 'sendrecv'; // Keep as sendrecv
            } else {
                log(`No transceiver for ${track.kind} on ${peerId}. Calling addTrack...`);
                pc.addTrack(track, window.localConsultantStream);
            }
        });

        // UNCONDITIONAL OFFER (Replacing fast-track logic per strict Phase 28 requirement)
        log(`Executing formal renegotiation (Offer) for ${peerId}`);
        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .then(() => {
              sendSignal({
                  action: "relay",
                  room_id: currentRoomId,
                  target_id: peerId,
                  type: "offer",
                  sdp: pc.localDescription,
              });
              log(`Renegotiation offer sent to ${peerId}`);
          })
          .catch(e => warn(`Renegotiation failed for ${peerId}:`, e));
    }

    showToast('Camera & mic started.', 'success');
  } catch (err) {
    warn('Failed to start consultant media:', err);
    showToast('Could not access camera/mic: ' + err.message, 'error');
  }
}

/**
 * Stops the Consultant's local media.
 */
async function stopConsultantMedia() {
  if (!localConsultantStream) return;

  // REPLACED WITH SOFT TOGGLE: DO NOT use track.stop() or removeTrack()
  consultantCamPaused = true;
  localConsultantStream.getVideoTracks().forEach(t => { t.enabled = false; });
  
  const btn = document.getElementById('consultantCamToggleBtn');
  updateToggleButtonUI(btn, false);

  // Send WS media_state false payload
  sendSignal({ action: 'relay', room_id: currentRoomId, type: 'media_state', video: false });

  log('Consultant media soft-paused.');
}

function updateToggleButtonUI(btn, enabled) {
    if (!btn) return;
    const icon = btn.querySelector('i') || btn.querySelector('svg');
    const bgDiv = btn.querySelector('.rounded-full') || btn.querySelector('div') || btn;

    if (enabled) {
        btn.classList.remove('text-red-500');
        if (bgDiv && bgDiv.classList) bgDiv.classList.remove('bg-red-500/20');
    } else {
        btn.classList.add('text-red-500');
        if (bgDiv && bgDiv.classList) bgDiv.classList.add('bg-red-500/20');
    }
}

/**
 * Toggles the Consultant's microphone mute state.
 */
function toggleConsultantMic() {
  if (!localConsultantStream) {
    showToast('Start your camera first.', 'error');
    return;
  }
  const track = localConsultantStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    consultantMicMuted = !track.enabled;

    const btn = document.getElementById('consultantMicToggleBtn');
    const icon = btn?.querySelector('i');
    if (icon) {
      icon.className = consultantMicMuted
        ? 'fa-solid fa-microphone-slash text-red-500 text-xl sm:text-2xl transition-all block w-6 h-6 text-center leading-6'
        : 'fa-solid fa-microphone text-xl sm:text-2xl group-hover:scale-110 transition-transform block w-6 h-6 text-center leading-6';
    }
    updateToggleButtonUI(btn, !consultantMicMuted);

    // Phase 26: Signal state change
    sendSignal({ 
      action: 'relay', 
      room_id: currentRoomId, 
      type: 'media_state', 
      audio: track.enabled 
    });
    log('Consultant mic:', consultantMicMuted ? 'MUTED' : 'LIVE');
  }
}

/**
 * Toggles the Consultant's camera on/off.
 */
function toggleConsultantCam() {
  if (!localConsultantStream) {
    showToast('Start your camera first.', 'error');
    return;
  }
  const track = localConsultantStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    consultantCamPaused = !track.enabled;

    const btn = document.getElementById('consultantCamToggleBtn');
    const icon = btn?.querySelector('i');
    if (icon) {
      icon.className = consultantCamPaused
        ? 'fa-solid fa-video-slash text-red-500 text-xl sm:text-2xl transition-all block w-6 h-6 text-center leading-6'
        : 'fa-solid fa-camera text-xl sm:text-2xl group-hover:scale-110 transition-transform block w-6 h-6 text-center leading-6';
    }
    updateToggleButtonUI(btn, !consultantCamPaused);

    // Phase 26: Signal state change
    sendSignal({ 
      action: 'relay', 
      room_id: currentRoomId, 
      type: 'media_state', 
      video: track.enabled 
    });
    log('Consultant cam:', consultantCamPaused ? 'OFF' : 'ON');
  }
}

// ===========================================================================
// SECTION H — Initialization & DOM Wiring
// ===========================================================================

document.addEventListener('DOMContentLoaded', () => {
  role = document.title.toLowerCase().includes('consultant') ? 'superior' : 'dentist';
  log(`Role initialized: ${role} | peerId: ${localPeerId}`);

  // Room buttons
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (createBtn) createBtn.addEventListener('click', onCreateRoomClick);
  if (joinBtn) joinBtn.addEventListener('click', onJoinRoomClick);

  // Phase 8: Consultant media controls (superior.html only)
  if (role === 'superior') {
    const startCamBtn = document.getElementById('consultantStartCamBtn');
    const micToggle = document.getElementById('consultantMicToggleBtn');
    const camToggle = document.getElementById('consultantCamToggleBtn');

    if (startCamBtn) {
      startCamBtn.addEventListener('click', () => {
        if (!localConsultantStream) {
          startConsultantMedia().then(() => {
            if (localConsultantStream) {
               sendSignal({ action: 'relay', room_id: currentRoomId, type: 'media_state', video: true });
               const span = startCamBtn.querySelector('span');
               if (span) span.textContent = 'Pause Cam';
            }
          });
        } else {
          // Soft toggle logic matching Phase 13
          consultantCamPaused = !consultantCamPaused;
          localConsultantStream.getVideoTracks().forEach(t => { t.enabled = !consultantCamPaused; });
          
          sendSignal({ action: 'relay', room_id: currentRoomId, type: 'media_state', video: !consultantCamPaused });
          
          const span = startCamBtn.querySelector('span');
          if (span) span.textContent = consultantCamPaused ? 'Resume Cam' : 'Pause Cam';
          
          // Also sync the minor toggle button
          const camToggle = document.getElementById('consultantCamToggleBtn');
          const minorIcon = camToggle?.querySelector('i');
          if (minorIcon) {
            minorIcon.className = consultantCamPaused
              ? 'fa-solid fa-video-slash text-red-500 text-xl sm:text-2xl transition-all block w-6 h-6 text-center leading-6'
              : 'fa-solid fa-camera text-xl sm:text-2xl group-hover:scale-110 transition-transform block w-6 h-6 text-center leading-6';
          }
        }
      });
    }
    if (micToggle) micToggle.addEventListener('click', toggleConsultantMic);
    if (camToggle) camToggle.addEventListener('click', toggleConsultantCam);
  }

  const endCallBtn = document.getElementById('endCallBtn');
  if (endCallBtn) {
    endCallBtn.addEventListener('click', () => {
      if (socket) socket.close();
      window.location.reload(); // Quick way to reset state
    });
  }

  // Handle tab closing explicitly
  window.addEventListener('beforeunload', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      // WS close triggers peer_left from the server automatically
      socket.close();
    }
  });

});

// ===========================================================================
// SECTION I — Phase 21: Network Health Monitoring
// ===========================================================================

/**
 * Polls active peer connections every 3 seconds to calculate worst-case RTT.
 * Updates the #network-monitor UI elements.
 */
async function startNetworkMonitoring() {
  log('Network monitoring started.');
  
  setInterval(async () => {
    const pcs = Object.values(peerConnections);
    const dot = document.getElementById('net-dot');
    const text = document.getElementById('net-text');
    if (!dot || !text) return;

    if (pcs.length === 0) {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-300 transition-colors duration-500';
      text.textContent = 'Waiting...';
      text.className = 'text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none';
      return;
    }

    let worstRTT = 0;
    let isDisconnected = false;

    for (const pc of pcs) {
      // Check for connection failure
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        isDisconnected = true;
        break;
      }

      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          // Identify the active candidate pair
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const rtt = (report.currentRoundTripTime || 0) * 1000;
            if (rtt > worstRTT) worstRTT = rtt;
          }
        });
      } catch (e) {
        // Stats might not be available yet
      }
    }

    // UI Translation Logic
    if (isDisconnected) {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-colors duration-500';
      text.textContent = 'Poor';
      text.className = 'text-[10px] font-bold text-red-500 uppercase tracking-widest leading-none';
    } else if (worstRTT < 150) {
      // Good Connection
      dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] transition-colors duration-500';
      text.textContent = 'Strong';
      text.className = 'text-[10px] font-bold text-emerald-500 uppercase tracking-widest leading-none';
    } else if (worstRTT < 400) {
      // Fair Connection
      dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)] transition-colors duration-500';
      text.textContent = 'Fair';
      text.className = 'text-[10px] font-bold text-amber-500 uppercase tracking-widest leading-none';
    } else {
      // Poor Connection (> 400ms)
      dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-colors duration-500';
      text.textContent = 'Poor';
      text.className = 'text-[10px] font-bold text-red-500 uppercase tracking-widest leading-none';
    }
  }, 3000);
}

// Expose for ui.js specifically for Provider
window.sendMediaState = function(isVideoOn) {
  sendSignal({ action: 'relay', room_id: currentRoomId, type: 'media_state', video: isVideoOn });
};

// Expose so media.js can call it after camera starts on dentist side
window.addLocalTracksIfConnected = function () {
  Object.entries(peerConnections).forEach(([peerId, pc]) => {
    addDentistTracksToConnection(pc);
  });
};
