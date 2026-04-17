/**
 * media.js — Teledentistry Phase 3: Multi-Device Media Controller
 * ================================================================
 * Responsibilities (local only – no WebRTC peer logic yet):
 *   1. Detect mobile vs desktop
 *   2. Request camera streams via getUserMedia / enumerateDevices
 *   3. Inject live <video> elements into the placeholder divs
 *   4. Toggle the mobile torch via ImageCapture / applyConstraints
 *   5. Hot-swap the intraoral/USB camera when a new device is plugged in
 *   6. Handle permission errors gracefully
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM refs — resolved after DOMContentLoaded
// ---------------------------------------------------------------------------
let pcFeedPlaceholder;       // wrapper div — PC / rear cam
let intaoralPlaceholder;     // wrapper div — USB / intraoral cam
let startCamerasBtn;
let flashlightBtn;
let flashlightBgEl;
let flashlightIconEl;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
var pcStream       = null;   // MediaStream for the primary camera
var usbStream      = null;   // MediaStream for the USB / intraoral camera
var activeTrack    = null;   // VideoTrack used for torch control (mobile only)
var torchOn        = false;  // Current torch state
var camerasStarted = false;  // Guard so "Start Cameras" fires only once
window.localIntraoralStream = null; // Phase 32: Intraoral/USB dedicated stream

// ---------------------------------------------------------------------------
// 1. Device Detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the page is loaded on a mobile / tablet device.
 * Uses the User-Agent string as a heuristic; screen width is used as a
 * secondary signal for edge cases (tablets in landscape mode).
 */
function isMobileDevice() {
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const narrowScreen = window.innerWidth < 768;
  return uaMobile || narrowScreen;
}

// ---------------------------------------------------------------------------
// 2. Video Injection Helper
// ---------------------------------------------------------------------------

/**
 * Creates (or reuses) a <video> element inside *container*, sets its stream,
 * and starts playback.
 *
 * @param {HTMLElement} container  — the placeholder div
 * @param {MediaStream} stream     — the MediaStream to display
 * @param {string}      label      — fallback label shown if stream is null
 */
function injectVideo(container, stream, label = 'Live Feed') {
  // Remove any existing video element
  const existing = container.querySelector('video');
  if (existing) existing.remove();

  if (!stream) return;

  const video = document.createElement('video');
  
  // Phase 16: iOS Safari Attributes (Attributes FIRST, then srcObject)
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.playsInline = true;
  video.autoplay   = true;
  video.muted      = true;   // local preview MUST be muted for autoplay
  
  video.srcObject  = stream;
  video.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;';

  // Phase 25: Hide the "waiting" overlay once the video is playing
  video.addEventListener('playing', () => {
    const overlay = document.getElementById('cameraWaitingOverlay') || container.querySelector('[data-overlay]');
    if (overlay) overlay.style.display = 'none';
  }, { once: true });

  container.appendChild(video);
  video.play().catch(error => {
    // Autoplay blocked — show a tap-to-play message or just log
    console.warn("[media.js] Local autoplay blocked:", error);
    showError(`Tap the ${label} to start playback.`);
  });
}

// ---------------------------------------------------------------------------
// 3. Indicator dot helper
// ---------------------------------------------------------------------------

/**
 * Sets the status indicator dot on a feed card.
 * @param {'pc' | 'intraoral'} feed
 * @param {'live' | 'idle'}    state
 */
function setIndicator(feed, state) {
  const id = feed === 'pc' ? 'pcIndicator' : 'intaoralIndicator';
  const dot = document.getElementById(id);
  if (!dot) return;

  if (state === 'live') {
    dot.className = 'relative inline-flex rounded-full h-3 w-3 bg-green-500 shadow-[0_0_8px_2px_rgba(74,222,128,0.6)]';
  } else {
    dot.className = 'relative inline-flex rounded-full h-3 w-3 bg-gray-400';
  }
}

// ---------------------------------------------------------------------------
// 4. Error display
// ---------------------------------------------------------------------------

function showError(message) {
  // Non-blocking: show a toaster-style banner at the top of the viewport
  let toaster = document.getElementById('media-toaster');
  if (!toaster) {
    toaster = document.createElement('div');
    toaster.id = 'media-toaster';
    toaster.style.cssText = `
      position: fixed; top: 76px; left: 50%; transform: translateX(-50%);
      background: #e74c3c; color: #fff; padding: 10px 20px;
      border-radius: 8px; font-size: 14px; z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2); max-width: 90vw; text-align:center;
    `;
    document.body.appendChild(toaster);
  }
  toaster.textContent = message;
  toaster.style.display = 'block';
  // Auto-dismiss after 5 s
  clearTimeout(toaster._timer);
  toaster._timer = setTimeout(() => { toaster.style.display = 'none'; }, 5000);
}

// ---------------------------------------------------------------------------
// 5. Mobile Path — rear camera + torch
// ---------------------------------------------------------------------------

async function startMobileCamera() {
  try {
    const constraints = {
      video: { 
        facingMode: { exact: 'environment' },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 }
      }, // rear-facing only
      audio: true, // Phase 19 fix: enable two-way audio
    };

    pcStream   = await navigator.mediaDevices.getUserMedia(constraints);
    window.pcStream = pcStream;
    window.localStream = pcStream; // Phase 19: Align for handleOffer in webrtc.js
    activeTrack = pcStream.getVideoTracks()[0];

    injectVideo(pcFeedPlaceholder, pcStream, 'Mobile Camera');
    setIndicator('pc', 'live');

    // Update Start Cameras button to show success
    updateStartBtn(true);

  } catch (err) {
    handleCameraError(err, 'mobile camera');
  }
}

// ---------------------------------------------------------------------------
// 6. Desktop Path — primary webcam + USB/intraoral hot-swap
// ---------------------------------------------------------------------------

async function startDesktopCameras() {
  // --- Primary webcam -------------------------------------------
  try {
    pcStream = await navigator.mediaDevices.getUserMedia({ 
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 }
      }, 
      audio: true 
    });
    window.pcStream = pcStream;
    window.localStream = pcStream; // Phase 19: Align for handleOffer in webrtc.js
    injectVideo(pcFeedPlaceholder, pcStream, 'PC Camera');
    setIndicator('pc', 'live');
    updateStartBtn(true);
  } catch (err) {
    handleCameraError(err, 'PC webcam');
    return; // No point continuing if primary fails
  }

  // --- Enumerate for a second (USB) camera ----------------------
  await detectAndStartUSBCamera();

  // --- Watch for hot-plug events --------------------------------
  navigator.mediaDevices.ondevicechange = async () => {
    console.log('[media.js] Device change detected — re-enumerating cameras...');
    await detectAndStartUSBCamera();
  };
}

/**
 * Phase 32: Populate camera dropdown for explicit Intraoral/USB Camera selection
 */
async function detectAndStartUSBCamera() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    console.log(`[media.js] Found ${videoInputs.length} video input(s):`, videoInputs.map(d => d.label || d.deviceId));

    const dropdown = document.getElementById('intaoralSelect');
    if (dropdown) {
      dropdown.innerHTML = '<option value="">Select Intraoral Camera</option>';
      // For development robustness, allow standard PC cams too since we're just picking by ID
      videoInputs.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = device.label || `Camera ${dropdown.options.length}`;
        dropdown.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('[media.js] Error populating camera options:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 7. Torch Toggle (mobile only)
// ---------------------------------------------------------------------------

/**
 * Toggles the torch/flashlight on the active mobile camera track.
 * Falls back to a UI-only toggle with an informative message on desktops
 * or when the hardware does not support torch.
 */
async function handleTorchToggle() {
  // --- Mobile with an active track ---
  if (activeTrack) {
    const capabilities = activeTrack.getCapabilities?.() ?? {};

    if (capabilities.torch) {
      torchOn = !torchOn;
      try {
        await activeTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
        updateTorchUI(torchOn);
        return;
      } catch (err) {
        showError('Could not toggle torch: ' + err.message);
        torchOn = !torchOn; // revert state on failure
        return;
      }
    } else {
      showError('This device does not support the torch/flashlight API.');
    }
  } else if (!isMobileDevice()) {
    showError('The flashlight is a mobile-only feature. Please open this page on your phone.');
  } else {
    showError('Start the mobile camera first, then toggle the flashlight.');
  }

  // UI-only toggle so the button still gives visual feedback
  torchOn = !torchOn;
  updateTorchUI(torchOn);
}

/**
 * Updates the flashlight button's visual state.
 * @param {boolean} on
 */
function updateTorchUI(on) {
  if (!flashlightBgEl || !flashlightIconEl) return;

  if (on) {
    flashlightBgEl.classList.replace('bg-gray-100', 'bg-yellow-100');
    // textContent removed for Icon-Only requirement
    flashlightIconEl.classList.add('text-yellow-600');
  } else {
    flashlightBgEl.classList.replace('bg-yellow-100', 'bg-gray-100');
    // textContent removed for Icon-Only requirement
    flashlightIconEl.classList.remove('text-yellow-600');
  }
}

// ---------------------------------------------------------------------------
// 8. Permission Error Handler
// ---------------------------------------------------------------------------

function handleCameraError(err, source) {
  const messages = {
    NotAllowedError:    `Camera permission denied for ${source}. Please allow camera access in your browser settings.`,
    NotFoundError:      `No camera found for ${source}. Please connect a camera and try again.`,
    NotReadableError:   `Camera for ${source} is already in use by another app. Close the other app and refresh.`,
    OverconstrainedError: `Camera constraints could not be satisfied for ${source}. Trying relaxed constraints...`,
  };

  const msg = messages[err.name] ?? `Camera error (${source}): ${err.message}`;
  console.error('[media.js]', err);
  showError(msg);
}

// ---------------------------------------------------------------------------
// 9. "Start Cameras" Button Feedback
// ---------------------------------------------------------------------------

function updateStartBtn(active) {
  if (!startCamerasBtn) return;
  const icon = startCamerasBtn.querySelector('.material-icons');
  const label = startCamerasBtn.querySelector('span:not(.material-icons)');

  if (active) {
    startCamerasBtn.classList.add('text-green-600');
    if (icon)  icon.textContent  = 'videocam';
    if (label) label.textContent = 'Cameras On';
  } else {
    startCamerasBtn.classList.remove('text-green-600');
    if (icon)  icon.textContent  = 'videocam_off';
    if (label) label.textContent = 'Start Cameras';
  }
}

// ---------------------------------------------------------------------------
// 10. Entry Point
// ---------------------------------------------------------------------------

async function startCameras() {
  if (camerasStarted) {
    stopMediaTracks(); // If already running, turn off video
    return;
  }
  camerasStarted = true;

  if (isMobileDevice()) {
    console.log('[media.js] Mobile device detected — requesting rear camera.');
    await startMobileCamera();
  } else {
    console.log('[media.js] Desktop device detected — requesting webcam + USB scan.');
    await startDesktopCameras();
  }

  // If a peer connection already exists (camera started after room was created),
  // add the new tracks now — onnegotiationneeded will fire and send a new offer.
  if (typeof window.addLocalTracksIfConnected === 'function') {
    window.addLocalTracksIfConnected();
  }
}

function stopMediaTracks() {
  console.log('[media.js] Stopping media tracks...');
  if (pcStream) {
    pcStream.getTracks().forEach(track => track.stop());
    pcStream = null;
  }
  if (usbStream) {
    usbStream.getTracks().forEach(track => track.stop());
    usbStream = null;
  }
  if (activeTrack) {
    activeTrack.stop();
    activeTrack = null;
  }
  torchOn = false;
  updateTorchUI(false);
  
  if (pcFeedPlaceholder) {
    const video = pcFeedPlaceholder.querySelector('video');
    if (video) video.srcObject = null;
  }
  if (intaoralPlaceholder) {
    const video = intaoralPlaceholder.querySelector('video');
    if (video) video.srcObject = null;
  }
  
  setIndicator('pc', 'idle');
  setIndicator('intraoral', 'idle');
  updateStartBtn(false);
  camerasStarted = false;
}


// ---------------------------------------------------------------------------
// 11. DOM Wiring — runs after the page has loaded
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Resolve DOM references
  pcFeedPlaceholder   = document.getElementById('pcFeedPlaceholder');
  intaoralPlaceholder = document.getElementById('intaoralPlaceholder');
  startCamerasBtn     = document.getElementById('startCamerasBtn');
  flashlightBtn       = document.getElementById('flashlightToggle');
  flashlightBgEl      = document.getElementById('flashlightBg');
  flashlightIconEl    = document.getElementById('flashlightIcon');

  // "Start Cameras" button
  if (startCamerasBtn) {
    startCamerasBtn.addEventListener('click', startCameras);
  }

  // Flashlight toggle — replaces the inline onclick from Phase 1
  if (flashlightBtn) {
    // Remove any previous inline handler
    flashlightBtn.removeAttribute('onclick');
    flashlightBtn.addEventListener('click', handleTorchToggle);
  }

  // Phase 32: Third hardware dropdown listener
  const intraSelect = document.getElementById('intaoralSelect');
  if (intraSelect) {
      intraSelect.addEventListener('change', async (e) => {
          const selectedDeviceId = e.target.value;
          
          if (!selectedDeviceId) {
              if (window.localIntraoralStream) {
                  window.localIntraoralStream.getTracks().forEach(t => t.stop());
              }
              const intraFeed = document.getElementById('intraoralVideoFeed');
              if (intraFeed) {
                  intraFeed.srcObject = null;
                  intraFeed.classList.add('hidden');
              }
              const parentGrid = document.getElementById('videoGridContainer');
              if (parentGrid) {
                  parentGrid.classList.remove('grid-cols-2');
                  parentGrid.classList.add('grid-cols-1');
              }
              return;
          }

          try {
              const stream = await navigator.mediaDevices.getUserMedia({
                  video: { deviceId: { exact: selectedDeviceId } }, audio: false
              });
              
              window.localIntraoralStream = stream;
              
              const intraFeed = document.getElementById('intraoralVideoFeed');
              if (intraFeed) {
                  intraFeed.srcObject = stream;
                  intraFeed.muted = true;
                  intraFeed.classList.remove('hidden');
              }

              const parentGrid = document.getElementById('videoGridContainer');
              if (parentGrid) {
                  parentGrid.classList.remove('grid-cols-1');
                  parentGrid.classList.add('grid-cols-2');
              }

              if (typeof window.addIntraoralTrackToMesh === 'function') {
                  window.addIntraoralTrackToMesh();
              }
              console.log("[media.js] Intraoral stream started.");
          } catch (err) {
              console.error("[media.js] Failed to capture intraoral device", err);
              showError("Failed to start Intraoral camera.");
          }
      });
  }

  console.log('[media.js] Loaded. isMobile =', isMobileDevice());
});
