/**
 * webrtc.js — Teledentistry Phase 8: Bi-Directional AV Mesh
 * ==========================================================
 * Full two-way video & audio conferencing over a multi-peer mesh.
 *
 * Roles:
 *   • DENTIST   (dentist.html)  — sends local camera/USB tracks,
 *                                  receives Consultant AV into floating PiP
 *   • SUPERIOR  (superior.html) — receives Provider tracks into focus view,
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
}

// ===========================================================================
// SECTION C — Multi-Peer Connection Management (Mesh Core)
// ===========================================================================

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
      const stream = (event.streams && event.streams[0]) || (() => {
        const s = new MediaStream();
        s.addTrack(event.track);
        return s;
      })();
      log(`[DENTIST] Remote track from consultant ${remotePeerId}:`, event.track.kind);
      handleConsultantRemoteTrack(stream);
    };
  }

  // ── SUPERIOR: add local consultant tracks + receive Provider feeds ─
  if (role === 'superior') {
    // Phase 8: Add consultant's local camera/mic tracks to this connection
    addConsultantTracksToConnection(pc);

    pc.ontrack = (event) => {
      const stream = (event.streams && event.streams[0]) || (() => {
        const s = new MediaStream();
        s.addTrack(event.track);
        return s;
      })();
      log(`[SUPERIOR] Remote track from provider ${remotePeerId}:`, event.track.kind);
      handleRemoteTrack(event.track, stream, remotePeerId);
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
 * Phase 8: Adds Consultant's local camera/mic tracks to a peer connection.
 * Called when a PC is created and when the consultant starts their camera.
 */
function addConsultantTracksToConnection(pc) {
  if (!localConsultantStream) return;

  const existingTrackIds = new Set(pc.getSenders().map(s => s.track?.id).filter(Boolean));

  localConsultantStream.getTracks().forEach(track => {
    if (!existingTrackIds.has(track.id)) {
      pc.addTrack(track, localConsultantStream);
      log('Consultant track added:', track.kind, track.label);
    }
  });
}

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

  videoEl.srcObject = stream;
  // CRITICAL: do NOT mute — Provider must hear Consultant
  videoEl.muted = false;
  videoEl.play().catch(e => console.error('Autoplay blocked (consultant PiP):', e));
  log('Consultant remote stream attached to PiP.');
}

// ===========================================================================
// SECTION F — Superior: Remote Track & Focus Mode UI
// ===========================================================================

let pipSlotIndex = 0;

function handleRemoteTrack(track, stream, peerId) {
  // Deduplicate streams
  if (remoteStreams.has(stream.id)) {
    const existing = remoteStreams.get(stream.id);
    if (!existing.stream.getTrackById(track.id)) existing.stream.addTrack(track);
    return;
  }

  const mainContainer = document.getElementById('mainVideoContainer');

  if (remoteStreams.size === 0 && mainContainer) {
    injectVideo(mainContainer, stream, 'primary');
    remoteStreams.set(stream.id, { stream, peerId, slotEl: mainContainer, slotIndex: -1 });

    document.getElementById('mainFeedOverlay')?.setAttribute('style', 'display:none');
    updateMainFeedLabel(`Live View (${peerId})`);

    const dot0 = document.getElementById('pipDot0');
    if (dot0) dot0.className = 'h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)]';

  } else {
    const slotIndex = pipSlotIndex++;
    const container = document.getElementById(`pipVideo${slotIndex}`);
    if (container) {
      injectVideo(container, stream, 'pip');
      remoteStreams.set(stream.id, { stream, peerId, slotEl: container, slotIndex });

      const dot = document.getElementById(`pipDot${slotIndex}`);
      if (dot) dot.className = 'h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)]';

      const slot = document.getElementById(`pipSlot${slotIndex}`);
      if (slot) slot.addEventListener('click', () => focusStream(stream));
    }
  }

  track.onended = () => {
    if (remoteStreams.has(stream.id)) clearRemoteSlot(stream.id);
  };
}

function clearRemoteSlot(streamId) {
  const entry = remoteStreams.get(streamId);
  if (!entry) return;

  const { slotEl, slotIndex } = entry;
  const vid = slotEl.querySelector('video');
  if (vid) { vid.srcObject = null; vid.classList.add('hidden'); }

  if (slotIndex === -1) {
    document.getElementById('mainFeedOverlay')?.removeAttribute('style');
    updateMainFeedLabel('Active Focus Feed');
    const dot = document.getElementById('pipDot0');
    if (dot) dot.className = 'h-2 w-2 rounded-full bg-gray-500';
  } else if (slotIndex >= 0) {
    const dot = document.getElementById(`pipDot${slotIndex}`);
    if (dot) dot.className = 'h-2 w-2 rounded-full bg-gray-500';
  }

  remoteStreams.delete(streamId);
}

function cleanupPeer(peerId) {
  log(`Cleaning up peer: ${peerId}`);

  const pc = peerConnections[peerId];
  if (pc) {
    pc.close();
    delete peerConnections[peerId];
  }

  // Clear streams from that peer
  [...remoteStreams.entries()].forEach(([streamId, entry]) => {
    if (entry.peerId === peerId) clearRemoteSlot(streamId);
  });

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
// UI Helpers
// ---------------------------------------------------------------------------

function injectVideo(container, stream, type) {
  let video = container.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    container.appendChild(video);
  }
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.className = 'absolute inset-0 w-full h-full z-10 ' + (type === 'primary' ? 'object-contain' : 'object-cover');
  video.srcObject = stream;
  video.classList.remove('hidden');
  video.play().catch(e => console.error('Autoplay blocked:', e));
}

function updateMainFeedLabel(label) {
  const el = document.getElementById('mainFeedLabel');
  if (el) el.textContent = label;
}

function focusStream(streamToFocus) {
  const mainVideo = document.getElementById('mainVideoContainer')?.querySelector('video');
  if (!mainVideo) return;

  const currentMainStream = mainVideo.srcObject;
  if (currentMainStream?.id === streamToFocus.id) return;

  const clickedEntry = [...remoteStreams.values()].find(e => e.stream.id === streamToFocus.id);
  if (!clickedEntry) return;

  const pipVideoEl = clickedEntry.slotEl.querySelector('video');

  mainVideo.srcObject = streamToFocus;
  mainVideo.play().catch(() => {});

  if (pipVideoEl && currentMainStream) {
    pipVideoEl.srcObject = currentMainStream;
    pipVideoEl.play().catch(() => {});
  }

  const mainEntry = [...remoteStreams.values()].find(e => e.slotIndex === -1);
  if (mainEntry) mainEntry.slotEl = clickedEntry.slotEl;
  clickedEntry.slotEl = document.getElementById('mainVideoContainer');

  updateMainFeedLabel(`Live View (${clickedEntry.peerId})`);
}

function handleCameraStoppedMsg(msg) {
  showToast(`Peer ${msg.sender_id} stopped their camera.`, 'info');
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
      video: true,
      audio: true,
    });
    log('Consultant local media captured:', localConsultantStream.getTracks().map(t => t.kind));

    // Show local preview
    const previewVideo = document.getElementById('localConsultantVideo');
    const previewContainer = document.getElementById('localPreviewContainer');
    if (previewVideo) {
      previewVideo.srcObject = localConsultantStream;
      previewVideo.play().catch(e => console.error('Local preview autoplay blocked:', e));
    }
    if (previewContainer) previewContainer.style.display = '';

    // Add tracks to ALL existing peer connections
    Object.entries(peerConnections).forEach(([peerId, pc]) => {
      addConsultantTracksToConnection(pc);
    });

    // If tracks were added to existing connections, renegotiation is needed.
    // onnegotiationneeded will fire automatically on the dentist side.
    // On superior side, we need to trigger renegotiation manually.
    if (role === 'superior') {
      for (const [peerId, pc] of Object.entries(peerConnections)) {
        log(`Renegotiating with ${peerId} after adding consultant tracks...`);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal({
            action: 'relay',
            room_id: currentRoomId,
            target_id: peerId,
            type: 'offer',
            sdp: pc.localDescription,
          });
        } catch (err) {
          warn(`Renegotiation offer failed for ${peerId}:`, err);
        }
      }
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
function stopConsultantMedia() {
  if (!localConsultantStream) return;

  localConsultantStream.getTracks().forEach(t => t.stop());
  localConsultantStream = null;

  const previewVideo = document.getElementById('localConsultantVideo');
  const previewContainer = document.getElementById('localPreviewContainer');
  if (previewVideo) previewVideo.srcObject = null;
  if (previewContainer) previewContainer.style.display = 'none';

  log('Consultant media stopped.');
}

/**
 * Toggles the Consultant's microphone mute state.
 */
function toggleConsultantMic() {
  if (!localConsultantStream) {
    showToast('Start your camera first.', 'error');
    return;
  }
  consultantMicMuted = !consultantMicMuted;
  localConsultantStream.getAudioTracks().forEach(t => { t.enabled = !consultantMicMuted; });

  const btn = document.getElementById('consultantMicToggleBtn');
  const icon = btn?.querySelector('i');
  if (icon) {
    icon.className = consultantMicMuted
      ? 'fa-solid fa-microphone-slash text-red-500 text-xl sm:text-2xl transition-all block w-6 h-6 text-center leading-6'
      : 'fa-solid fa-microphone text-xl sm:text-2xl group-hover:scale-110 transition-transform block w-6 h-6 text-center leading-6';
  }
  log('Consultant mic:', consultantMicMuted ? 'MUTED' : 'LIVE');
}

/**
 * Toggles the Consultant's camera on/off.
 */
function toggleConsultantCam() {
  if (!localConsultantStream) {
    showToast('Start your camera first.', 'error');
    return;
  }
  consultantCamPaused = !consultantCamPaused;
  localConsultantStream.getVideoTracks().forEach(t => { t.enabled = !consultantCamPaused; });

  const btn = document.getElementById('consultantCamToggleBtn');
  const icon = btn?.querySelector('i');
  if (icon) {
    icon.className = consultantCamPaused
      ? 'fa-solid fa-video-slash text-red-500 text-xl sm:text-2xl transition-all block w-6 h-6 text-center leading-6'
      : 'fa-solid fa-camera text-xl sm:text-2xl group-hover:scale-110 transition-transform block w-6 h-6 text-center leading-6';
  }
  log('Consultant cam:', consultantCamPaused ? 'OFF' : 'ON');
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

    if (startCamBtn) startCamBtn.addEventListener('click', startConsultantMedia);
    if (micToggle) micToggle.addEventListener('click', toggleConsultantMic);
    if (camToggle) camToggle.addEventListener('click', toggleConsultantCam);
  }
});

// Expose so media.js can call it after camera starts on dentist side
window.addLocalTracksIfConnected = function () {
  Object.entries(peerConnections).forEach(([peerId, pc]) => {
    addDentistTracksToConnection(pc);
  });
};
