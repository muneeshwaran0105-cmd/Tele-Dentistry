/**
 * webrtc.js — Teledentistry Phase 4: WebRTC + WebSocket Integration
 * ==================================================================
 * Handles two distinct roles detected from the DOM:
 *   • DENTIST   (dentist.html)  — creates a room, sends all local tracks
 *   • SUPERIOR  (superior.html) — joins a room, receives remote tracks,
 *                                  manages Focus Mode click-to-swap UI
 *
 * Reads Phase 3 media streams from the globals exposed by media.js:
 *   window.pcStream   — primary webcam / rear mobile camera
 *   window.usbStream  — USB intraoral camera (desktop only)
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

let socket = null;   // WebSocket connection to the Python server
let peerConn = null;   // RTCPeerConnection (one per session)
let currentRoomId = null;   // Confirmed room ID after create/join
let role = null;   // 'dentist' | 'superior'

// ---------------------------------------------------------------------------
// Utility: log with role prefix
// ---------------------------------------------------------------------------
function log(...args) { console.log(`[webrtc/${role}]`, ...args); }
function warn(...args) { console.warn(`[webrtc/${role}]`, ...args); }

// ---------------------------------------------------------------------------
// Utility: show a transient toast banner (reuses media.js helper if present,
//          or creates a standalone one for superior.html)
// ---------------------------------------------------------------------------
function showToast(message, type = 'info') {
  // Reuse showError from media.js on the dentist page if available
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

  toaster.style.background = type === 'error' ? '#e74c3c'
    : type === 'success' ? '#27ae60'
      : '#4A90E2';
  toaster.textContent = message;
  toaster.style.opacity = '1';
  toaster.style.display = 'block';
  clearTimeout(toaster._t);
  toaster._t = setTimeout(() => { toaster.style.opacity = '0'; }, 4000);
}

// ===========================================================================
// SECTION A — WebSocket Connection & Message Router
// ===========================================================================

/**
 * Opens the WebSocket to the signaling server and wires all event handlers.
 * Called once when the user clicks Create/Join Room.
 *
 * @param {Function} onOpenCallback  — called when the connection is established
 */
function connectSignaling(onOpenCallback) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    onOpenCallback();
    return;
  }

  log('Connecting to signaling server:', WS_URL);

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('WebSocket onopen: Successfully connected to ' + WS_URL);
    log('WebSocket connected.');
    onOpenCallback();
  };

  socket.onmessage = (event) => {
    console.log('WebSocket onmessage: Received data:', event.data);
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { warn('Received non-JSON message:', event.data); return; }

    routeSignalingMessage(msg);
  };

  socket.onerror = (err) => {
    console.log('WebSocket onerror: Connection error:', err);
    warn('WebSocket error:', err);
    showToast('Could not connect to signaling server. Is server.py running?', 'error');
  };

  socket.onclose = () => {
    console.log('WebSocket onclose: Disconnected from ' + WS_URL);
    log('WebSocket disconnected.');
    showToast('Disconnected from signaling server.', 'info');
  };
}

/**
 * Sends a JSON payload to the signaling server.
 * @param {object} payload
 */
function sendSignal(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    warn('Cannot send — WebSocket not open.');
    return;
  }
  socket.send(JSON.stringify(payload));
}

/**
 * Central dispatcher for all incoming server messages.
 * Routes to the appropriate handler based on event / type field.
 *
 * @param {object} msg — parsed JSON from server
 */
async function routeSignalingMessage(msg) {
  log('↓ Received:', msg.event ?? msg.type ?? msg.action, msg);

  switch (msg.event) {

    // ── Room lifecycle ─────────────────────────────────────
    case 'room_created':
      handleRoomCreated(msg);
      break;

    case 'room_joined':
      await handleRoomJoined(msg);
      break;

    case 'peer_joined':
      // A new peer joined OUR room. If we are the dentist, send an offer.
      if (role === 'dentist') {
        log(`Peer joined (count=${msg.peer_count}). Initiating offer…`);
        await sendOffer();
      }
      break;

    case 'peer_left':
      log(`A peer left. Remaining: ${msg.peer_count}`);
      showToast('A participant has disconnected.', 'info');
      if (role === 'superior') handlePeerLeft();
      break;

    case 'error':
      warn('Server error:', msg.message);
      showToast(msg.message, 'error');
      break;

    // ── WebRTC relay payloads ──────────────────────────────
    default:
      if (msg.type === 'offer') { await handleOffer(msg); break; }
      if (msg.type === 'answer') { await handleAnswer(msg); break; }
      if (msg.type === 'ice-candidate') { await handleIceCandidate(msg); break; }
      if (msg.type === 'camera_stopped') { handleCameraStoppedMsg(msg); break; }
      log('Unhandled message:', msg);
  }
}

// ===========================================================================
// SECTION B — Room Creation & Joining (Dentist + Superior)
// ===========================================================================

// ── Dentist: Create Room ────────────────────────────────────────────────────

function onCreateRoomClick() {
  const pinInput = document.getElementById('roomPin');
  const roomInput = document.getElementById('roomId');

  const customPin = pinInput?.value.trim();
  const customRoom = roomInput?.value.trim() || undefined;

  // Validate PIN if user typed one manually
  if (customPin && !/^\d{4}$/.test(customPin)) {
    showToast('PIN must be exactly 4 digits.', 'error');
    return;
  }

  connectSignaling(() => {
    const payload = { action: 'create_room' };
    if (customRoom) payload.room_id = customRoom;
    sendSignal(payload);
  });
}

function handleRoomCreated(msg) {
  currentRoomId = msg.room_id;

  log(`Room created | id=${msg.room_id} pin=${msg.pin}`);
  showToast(`Room "${msg.room_id}" created! PIN: ${msg.pin}`, 'success');

  // Display the PIN and Room ID in the input fields and lock them
  const pinEl = document.getElementById('roomPin');
  if (pinEl) { pinEl.value = msg.pin; pinEl.setAttribute('readonly', true); }
  const roomEl = document.getElementById('roomId');
  if (roomEl) { roomEl.value = msg.room_id; roomEl.setAttribute('readonly', true); }

  // Lock connection buttons so the user can't create another room accidentally
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (createBtn) createBtn.disabled = true;
  if (joinBtn) joinBtn.disabled = true;

  // Room is ready — build the peer connection and wait for peers to join
  buildPeerConnection();
}

// ── Superior: Join Room ─────────────────────────────────────────────────────

function onJoinRoomClick() {
  const pinInput = document.getElementById('roomPin');
  const roomInput = document.getElementById('roomId');

  const pin = pinInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!roomId) { showToast('Please enter a Room ID.', 'error'); return; }
  if (!/^\d{4}$/.test(pin)) { showToast('Please enter the 4-digit PIN.', 'error'); return; }

  connectSignaling(() => {
    sendSignal({ action: 'join_room', room_id: roomId, pin });
  });
}

async function handleRoomJoined(msg) {
  currentRoomId = msg.room_id;
  log(`Joined room | id=${msg.room_id} peers=${msg.peer_count}`);
  showToast(`Joined room "${msg.room_id}"!`, 'success');

  // Lock the join button to prevent duplicate joins
  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.disabled = true;

  // Build peer connection; dentist will send the offer once they detect us
  buildPeerConnection();
}

// ===========================================================================
// SECTION C — RTCPeerConnection Setup
// ===========================================================================

/**
 * Creates the RTCPeerConnection, attaches local tracks (dentist) or
 * prepares to receive remote tracks (superior).
 *
 * ───────────────────────────────────────────────────────────────────
 * PHASE 3 INTEGRATION POINT
 * Local streams captured in media.js are read here:
 *   window.pcStream   — built-in webcam / rear mobile camera
 *   window.usbStream  — USB intraoral camera (desktop only)
 * ───────────────────────────────────────────────────────────────────
 */
function buildPeerConnection() {
  // Clean up any previous connection
  if (peerConn) {
    peerConn.close();
    peerConn = null;
  }

  peerConn = new RTCPeerConnection(RTC_CONFIG);
  log('RTCPeerConnection created.');

  // ── ICE candidate handler: relay via the signaling server ──────────
  peerConn.onicecandidate = ({ candidate }) => {
    if (candidate) {
      sendSignal({
        action: 'relay',
        room_id: currentRoomId,
        type: 'ice-candidate',
        candidate: candidate.toJSON(),
      });
    }
  };

  peerConn.oniceconnectionstatechange = () => {
    log('ICE state:', peerConn.iceConnectionState);
    if (peerConn.iceConnectionState === 'failed') {
      showToast('ICE connection failed. Check your network.', 'error');
    }
  };

  peerConn.onconnectionstatechange = () => {
    log('Connection state:', peerConn.connectionState);
    if (peerConn.connectionState === 'connected') {
      showToast('Peer-to-peer connection established!', 'success');
    }
    if (peerConn.connectionState === 'disconnected') {
      showToast('Peer disconnected.', 'info');
    }
  };

  // ── DENTIST: Add all local media tracks + wire renegotiation ───────
  if (role === 'dentist') {
    addLocalTracks(); // attach any already-running streams

    // onnegotiationneeded fires when tracks are added/removed after initial setup.
    // This handles the race condition where camera starts AFTER peer joins.
    peerConn.onnegotiationneeded = async () => {
      if (!currentRoomId) return; // no peer yet, skip
      log('onnegotiationneeded — sending updated offer with new tracks...');
      await sendOffer();
    };
  }

  // ── SUPERIOR: Handle incoming remote tracks ────────────────────────
  if (role === 'superior') {
    peerConn.ontrack = (event) => {
      // Robust stream fallback: if event.streams is empty, construct one from the track
      const stream = (event.streams && event.streams[0]) || (() => {
        const s = new MediaStream();
        s.addTrack(event.track);
        return s;
      })();
      log('Remote track received:', event.track.kind, 'stream:', stream.id);
      handleRemoteTrack(event.track, stream);
    };

    peerConn.onconnectionstatechange = () => {
      log('Connection state:', peerConn.connectionState);
      if (peerConn.connectionState === 'connected') {
        showToast('Peer-to-peer connection established!', 'success');
      }
      if (peerConn.connectionState === 'disconnected' || peerConn.connectionState === 'failed') {
        showToast('Provider disconnected.', 'info');
        handlePeerLeft();
      }
    };
  }
}

// ===========================================================================
// SECTION D — SDP Offer / Answer Exchange
// ===========================================================================

/**
 * Adds all available local streams (pcStream, usbStream) to the peer connection.
 * Safe to call multiple times — skips already-added tracks.
 * Called at buildPeerConnection time, and again from media.js after camera starts.
 */
function addLocalTracks() {
  if (!peerConn || role !== 'dentist') return;

  const streams = [window.pcStream, window.usbStream].filter(Boolean);
  if (streams.length === 0) {
    log('addLocalTracks: no streams available yet.');
    return;
  }

  // Get all senders already in the connection to avoid duplicates
  const existingSenders = peerConn.getSenders();
  const existingTrackIds = new Set(existingSenders.map(s => s.track?.id).filter(Boolean));

  let added = 0;
  streams.forEach((stream) => {
    stream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        peerConn.addTrack(track, stream);
        log('Added track:', track.kind, track.label);
        added++;
      }
    });
  });

  if (added > 0) {
    log(`${added} new track(s) added. Total senders: ${peerConn.getSenders().length}`);
  }
}

// Expose so media.js can call it after camera starts
window.addLocalTracksIfConnected = function () {
  if (peerConn && currentRoomId) {
    addLocalTracks();
  }
};

/**
 * Dentist creates and sends an SDP offer to the room.
 */
async function sendOffer() {
  if (!peerConn) { warn('No peer connection — cannot send offer.'); return; }

  try {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);

    sendSignal({
      action: 'relay',
      room_id: currentRoomId,
      type: 'offer',
      sdp: peerConn.localDescription,
    });

    log('Offer sent.');
  } catch (err) {
    warn('createOffer failed:', err);
    showToast('Failed to create WebRTC offer: ' + err.message, 'error');
  }
}

/**
 * Superior receives an offer, creates an answer, sends it back.
 * @param {object} msg — relayed offer message from server
 */
async function handleOffer(msg) {
  if (!peerConn) { warn('No peer connection — ignoring offer.'); return; }

  try {
    await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);

    sendSignal({
      action: 'relay',
      room_id: currentRoomId,
      type: 'answer',
      sdp: peerConn.localDescription,
    });

    log('Answer sent.');
  } catch (err) {
    warn('handleOffer failed:', err);
    showToast('WebRTC offer/answer exchange failed: ' + err.message, 'error');
  }
}

/**
 * Dentist receives the answer from the superior and sets it as the remote SDP.
 * @param {object} msg
 */
async function handleAnswer(msg) {
  if (!peerConn) return;
  
  // Requirement: Wrap setRemoteDescription in a signalingState check
  if (peerConn.signalingState === 'have-local-offer' || peerConn.signalingState === 'have-remote-offer') {
    try {
      await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      log('Remote description (answer) set.');
    } catch (err) {
      warn('handleAnswer failed:', err);
    }
  } else {
    warn(`Ignored stray answer to prevent InvalidStateError. Current state: ${peerConn.signalingState}`);
  }
}

/**
 * Both sides receive ICE candidates from the other peer and add them.
 * @param {object} msg
 */
async function handleIceCandidate(msg) {
  if (!peerConn || !msg.candidate) return;
  try {
    await peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate));
    log('ICE candidate added.');
  } catch (err) {
    warn('addIceCandidate failed:', err);
  }
}

// ===========================================================================
// SECTION E — Superior: Remote Track Handling + Focus Mode
// ===========================================================================

// Tracks injected remote streams in the sidebar, keyed by stream.id
const remoteStreams = new Map();

/**
 * Called when the superior's RTCPeerConnection fires an ontrack event.
 * Signature changed: receives (track, stream) directly for clarity.
 *
 * @param {MediaStreamTrack} track
 * @param {MediaStream}      stream
 */
// Static PiP slot index counter — increments as streams arrive
let pipSlotIndex = 0;

/**
 * Called when the superior's RTCPeerConnection fires an ontrack event.
 * Injects video into the correct static PiP container by slot index.
 *
 * @param {MediaStreamTrack} track
 * @param {MediaStream}      stream
 */
function handleRemoteTrack(track, stream) {
  // Deduplicate: if stream already registered, just add missing track to it
  if (remoteStreams.has(stream.id)) {
    const existing = remoteStreams.get(stream.id);
    if (!existing.stream.getTrackById(track.id)) {
      existing.stream.addTrack(track);
    }
    return;
  }

  const mainContainer = document.getElementById('mainVideoContainer');

  // ── FIRST STREAM: Goes into the central main viewer ───────────────
  if (remoteStreams.size === 0 && mainContainer) {
    injectVideo(mainContainer, stream, 'primary');
    remoteStreams.set(stream.id, { stream, slotEl: mainContainer, slotIndex: -1 });

    // Hide the waiting overlay
    const overlay = document.getElementById('mainFeedOverlay');
    if (overlay) overlay.style.display = 'none';
    updateMainFeedLabel('Active Focus Feed (Provider PC)');

    // Turn the Provider PC PiP dot green (slot 0 is always PC)
    const dot0 = document.getElementById('pipDot0');
    if (dot0) {
      dot0.className = 'h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)]';
    }

    track.onended = () => clearRemoteSlot(stream.id);
    return;
  }

  // ── ADDITIONAL STREAMS: fill the next available static PiP slot ───
  const slotIndex = pipSlotIndex; // 0-based index into pipVideoN
  pipSlotIndex++;

  const pipVideoContainer = document.getElementById(`pipVideo${slotIndex}`);
  const pipDot = document.getElementById(`pipDot${slotIndex}`);
  const pipSlot = document.getElementById(`pipSlot${slotIndex}`);

  if (pipVideoContainer) {
    injectVideo(pipVideoContainer, stream, 'pip');
    remoteStreams.set(stream.id, { stream, slotEl: pipVideoContainer, slotIndex });

    // Light up the status dot
    if (pipDot) {
      pipDot.className = 'h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)]';
    }

    // Wire click-to-focus on the whole card
    if (pipSlot && !pipSlot.dataset.focusWired) {
      pipSlot.dataset.focusWired = 'true';
      pipSlot.addEventListener('click', () => focusStream(stream));
    }

    track.onended = () => clearRemoteSlot(stream.id);
    log(`PiP slot ${slotIndex} filled. Total: ${remoteStreams.size}`);
  } else {
    // Fallback: all 3 static slots are full — build a dynamic card
    const pipSidebar = document.getElementById('pipSidebar');
    if (pipSidebar) {
      const slot = buildPipSlot(stream, remoteStreams.size);
      pipSidebar.appendChild(slot);
      const pipContainer = slot.querySelector('[data-pip-video]');
      injectVideo(pipContainer, stream, 'pip');
      remoteStreams.set(stream.id, { stream, slotEl: pipContainer, slotIndex: -2 });
      track.onended = () => clearRemoteSlot(stream.id);
    }
  }
}

/**
 * Clears a remote slot when a track ends or camera_stopped is received.
 * @param {string} streamId
 */
function clearRemoteSlot(streamId) {
  const entry = remoteStreams.get(streamId);
  if (!entry) return;

  const { slotEl, slotIndex } = entry;

  // Remove the injected <video> from the container
  const existingVideo = slotEl.querySelector('video');
  if (existingVideo) existingVideo.remove();

  if (slotIndex === -1) {
    // Was in mainVideoContainer — restore the waiting overlay
    const overlay = document.getElementById('mainFeedOverlay');
    if (overlay) overlay.style.display = '';
    updateMainFeedLabel('Active Focus Feed');
    // Reset the PC dot
    const dot0 = document.getElementById('pipDot0');
    if (dot0) dot0.className = 'h-2 w-2 rounded-full bg-gray-500';
  } else if (slotIndex >= 0) {
    // Was in a static PiP slot — reset its dot
    const dot = document.getElementById(`pipDot${slotIndex}`);
    if (dot) dot.className = 'h-2 w-2 rounded-full bg-gray-500';
    pipSlotIndex = Math.max(0, pipSlotIndex - 1);
  } else {
    // Was a dynamic fallback card — remove it
    slotEl.closest('[data-stream-id]')?.remove();
  }

  remoteStreams.delete(streamId);
  log('Cleared remote slot for stream:', streamId);
}

/**
 * Called on Superior when dentist sends a camera_stopped relay message.
 */
function handleCameraStoppedMsg(msg) {
  log('camera_stopped received for device:', msg.device);
  showToast('Provider turned off their camera.', 'info');

  // Update all status dots in the PiP sidebar to gray
  const statusDots = document.querySelectorAll('#pipSidebar .rounded-full');
  statusDots.forEach(dot => {
    dot.classList.remove('bg-green-500', 'shadow-[0_0_8px_rgba(74,222,128,0.8)]');
    dot.classList.add('bg-gray-500');
  });
}

/** Called when the peer disconnects entirely — clear all remote feeds. */
function handlePeerLeft() {
  // Clear all remote streams
  [...remoteStreams.keys()].forEach(id => clearRemoteSlot(id));

  // Reset all PiP status dots to gray
  const statusDots = document.querySelectorAll('#pipSidebar .rounded-full');
  statusDots.forEach(dot => {
    dot.classList.remove('bg-green-500', 'shadow-[0_0_8px_rgba(74,222,128,0.8)]');
    dot.classList.add('bg-gray-500');
  });
}

/**
 * Creates a styled PiP sidebar card for a new remote stream.
 *
 * @param {MediaStream} stream
 * @param {number}      index     — 0-based count of existing streams
 * @returns {HTMLElement}
 */
function buildPipSlot(stream, index) {
  const labels = ['Provider PC', 'Intraoral / USB', 'Mobile Cam', `Feed ${index + 1}`];
  const label = labels[index] ?? `Feed ${index + 1}`;

  const wrapper = document.createElement('div');
  wrapper.className = [
    'bg-slate-800 rounded-lg shadow-md border-2 border-transparent',
    'hover:border-medical-blue overflow-hidden flex flex-col',
    'shrink-0 w-44 sm:w-64 lg:w-full aspect-video lg:aspect-auto lg:flex-grow',
    'transition-all cursor-pointer group',
  ].join(' ');
  wrapper.dataset.streamId = stream.id;

  wrapper.innerHTML = `
    <div class="bg-gray-800/80 py-1.5 px-3 flex justify-between items-center text-xs backdrop-blur-sm z-10 border-b border-gray-700">
      <span class="font-medium text-gray-200">${label}</span>
      <span class="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)]"></span>
    </div>
    <div data-pip-video class="flex-grow relative bg-slate-900 overflow-hidden">
      <video autoplay playsinline muted class="absolute inset-0 w-full h-full object-cover z-10 hidden"></video>
    </div>
  `;

  // Click-to-focus: swap this PiP stream with the central viewer
  wrapper.addEventListener('click', () => focusStream(stream));

  return wrapper;
}

/**
 * Creates a <video> element and appends it into *container*.
 * Uses absolute positioning so it covers the icon placeholder without
 * destroying it (no innerHTML = '' — the icon is just visually hidden).
 *
 * @param {HTMLElement}          container
 * @param {MediaStream}          stream
 * @param {'primary'|'pip'}      type
 */
function injectVideo(container, stream, type) {
  // Try to find an existing placeholder video element first
  let video = container.querySelector('video');
  
  if (!video) {
    video = document.createElement('video');
    container.appendChild(video);
  }

  // Force required attributes for autoplay/visibility
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  
  // Absolute fill — covers the placeholder icon beneath it
  video.className = 'absolute inset-0 w-full h-full z-10 ' +
    (type === 'primary' ? 'object-contain' : 'object-cover');
    
  // Assign stream and unhide
  video.srcObject = stream;
  video.classList.remove('hidden');

  // Requirement: Explicitly call play() after assigning srcObject
  video.play().catch(e => {
    console.error("Autoplay blocked or playback failed:", e);
    // Fallback: wait for user interaction or attempt again
  });

  log('Video injected into', container.id || container.className, '— stream:', stream.id);
}

// Keep old name as alias for any remaining callers
function injectVideoSuperior(container, stream, type) {
  return injectVideo(container, stream, type);
}

// ===========================================================================
// SECTION F — Superior: Focus Mode (Click-to-Swap)
// ===========================================================================

/**
 * Swaps a PiP stream into the central main focus viewer.
 * The stream currently displayed in the main viewer moves BACK into the sidebar
 * slot that was clicked, creating a seamless swap.
 *
 * @param {MediaStream} streamToFocus — the stream the superior clicked on
 */
function focusStream(streamToFocus) {
  const mainContainer = document.getElementById('mainVideoContainer');
  const mainFeed = document.getElementById('mainFeed');
  if (!mainContainer) return;

  const mainVideo = mainContainer.querySelector('video');
  if (!mainVideo) return;

  const currentMainStream = mainVideo.srcObject;
  const currentMainStreamId = currentMainStream?.id;

  // Don't swap if it's already the focused stream
  if (currentMainStreamId === streamToFocus.id) return;

  // Find the sidebar slot that holds the stream to be focused
  const clickedEntry = [...remoteStreams.values()].find(e => e.stream.id === streamToFocus.id);
  if (!clickedEntry) return;

  const pipSlot = clickedEntry.slotEl;
  const pipVideoEl = pipSlot.querySelector('video');

  // Grab the labels to swap them too
  const pipLabelText = getPipLabel(pipSlot);
  const mainLabelEl = document.getElementById('mainFeedLabel');

  // Extract the inner name from "Active Focus Feed (...)"
  const mainLabelMatch = mainLabelEl?.textContent.match(/Active Focus Feed \((.*?)\)/);
  const currentMainName = mainLabelMatch ? mainLabelMatch[1] : 'Provider PC';

  // ── Swap srcObject references ──────────────────────────────────────
  mainVideo.srcObject = streamToFocus;
  mainVideo.play().catch(e => console.error('Autoplay blocked (main):', e));

  if (pipVideoEl && currentMainStream) {
    pipVideoEl.srcObject = currentMainStream;
    pipVideoEl.play().catch(e => console.error('Autoplay blocked (pip):', e));
  }

  // Update the remoteStreams map to reflect the new locations
  clickedEntry.slotEl = mainContainer;
  const mainEntry = [...remoteStreams.values()].find(e => e.stream.id === currentMainStreamId);
  if (mainEntry) mainEntry.slotEl = pipSlot;

  // Swap Labels
  updateMainFeedLabel(`Active Focus Feed (${pipLabelText})`);
  const pipLabelTag = pipSlot.querySelector('.font-medium');
  if (pipLabelTag) {
    pipLabelTag.textContent = currentMainName;
  }

  // Visual feedback: briefly highlight the main feed
  if (mainFeed) {
    mainFeed.classList.add('ring-2', 'ring-green-400');
    setTimeout(() => mainFeed.classList.remove('ring-2', 'ring-green-400'), 800);
  }

  log('Focus swapped to stream:', streamToFocus.id);
}

/** Extracts the label text from a PiP card. */
function getPipLabel(slotEl) {
  return slotEl.querySelector('.font-medium')?.textContent ?? 'Feed';
}

/** Updates the main feed overlay label. */
function updateMainFeedLabel(label) {
  const el = document.getElementById('mainFeedLabel');
  if (el) el.textContent = label;
}

function endCall() {
  console.log('Ending call / turning off camera...');

  // Notify the remote peer that the camera is being stopped (before closing socket)
  if (socket && socket.readyState === WebSocket.OPEN && currentRoomId) {
    sendSignal({
      action: 'relay',
      room_id: currentRoomId,
      type: 'camera_stopped',
      device: 'all',
    });
  }

  if (typeof stopMediaTracks === 'function') {
    stopMediaTracks();
  }
  if (peerConn) {
    peerConn.close();
    peerConn = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }

  currentRoomId = null;

  // Reset input fields and unlock them
  ['roomId', 'roomPin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.removeAttribute('readonly'); }
  });

  // Re-enable connection buttons
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (createBtn) createBtn.disabled = false;
  if (joinBtn) joinBtn.disabled = false;

  showToast('Call ended.', 'info');
}

// ===========================================================================
// SECTION G — DOM Wiring (runs after page load)
// ===========================================================================

document.addEventListener('DOMContentLoaded', () => {

  // ── Detect role from DOM landmarks ────────────────────────────────
  // dentist.html has #startCamerasBtn; superior.html has #pipSidebar but NOT startCamerasBtn
  const isDentist = !!document.getElementById('startCamerasBtn');
  const isSuperior = !!document.getElementById('pipSidebar') && !isDentist;

  if (isDentist) role = 'dentist';
  if (isSuperior) role = 'superior';

  if (!role) {
    console.warn('[webrtc.js] Could not detect role. No matching DOM element found.');
    return;
  }
  log('Role detected:', role);

  // ── Wire Create/Join buttons ───────────────────────────────────────
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');

  if (createBtn) createBtn.addEventListener('click', onCreateRoomClick);
  if (joinBtn) joinBtn.addEventListener('click', onJoinRoomClick);

  // ── Wire End Call button ───────────────────────────────────────────
  const endCallBtn = document.getElementById('endCallBtn');
  if (endCallBtn) endCallBtn.addEventListener('click', endCall);

  // ── Superior: wire the existing static PiP cards to focus mode ────
  if (role === 'superior') {
    // Static placeholder cards get focus wiring once streams arrive via ontrack.
    // The click handlers for dynamically created slots are set in buildPipSlot().

    // Wire snapshot button
    const snapshotBtn = document.getElementById('snapshotBtn');
    if (snapshotBtn) {
      snapshotBtn.addEventListener('click', takeSnapshot);
    }

    // Wire fullscreen button
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        const mainFeed = document.getElementById('mainFeed');
        if (mainFeed?.requestFullscreen) mainFeed.requestFullscreen();
      });
    }
  }

  log('DOM wired.');
});

// ===========================================================================
// SECTION H — Bonus: Snapshot (Superior)
// ===========================================================================

/**
 * Captures the current frame from the main focus viewer as a PNG and
 * triggers a browser download.
 */
function takeSnapshot() {
  const mainContainer = document.getElementById('mainVideoContainer');
  const video = mainContainer?.querySelector('video');
  if (!video || !video.srcObject) {
    showToast('No active feed to snapshot.', 'error');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const link = document.createElement('a');
  link.download = `teledentistry-snapshot-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();

  showToast('Snapshot saved!', 'success');
  log('Snapshot captured:', link.download);
}
