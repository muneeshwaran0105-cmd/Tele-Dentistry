/**
 * ui.js — UI interactions, hardware selection, and log functions
 * 
 * Loaded on both dentist.html and superior.html to handle DOM events,
 * populate device selects, and toggle mic/video.
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Hardware Selection Dropdowns
// ---------------------------------------------------------------------------

async function populateDeviceDropdowns() {
    const cameraSelect = document.getElementById('cameraSelect');
    const micSelect = document.getElementById('micSelect');
    const intaoralSelect = document.getElementById('intaoralSelect');

    // Only run if the dropdowns exist (dentist view)
    if (!cameraSelect && !micSelect && !intaoralSelect) return;

    try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        const hasBlankLabels = devices.some(d => !d.label && d.deviceId);

        // If labels are missing, we need permission first
        if (hasBlankLabels) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    video: { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } }, 
                    audio: true 
                });
                stream.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
            } catch (err) {
                console.warn('Could not get permissions to read device labels.', err);
            }
        }

        updateDropdownUI(devices);

    } catch (err) {
        console.error('Error enumerating devices:', err);
    }
}

function updateDropdownUI(devices) {
    const cameraSelect = document.getElementById('cameraSelect');
    const micSelect = document.getElementById('micSelect');
    const intaoralSelect = document.getElementById('intaoralSelect');

    const populate = (select, kind, defaultText) => {
        if (!select) return;
        select.innerHTML = `<option value="">${defaultText}</option>`;
        devices.filter(d => d.kind === kind).forEach((d, i) => {
            const option = document.createElement('option');
            option.value = d.deviceId;
            option.text = d.label || `Unnamed ${kind} ${i + 1}`;
            select.appendChild(option);
        });
    };

    populate(cameraSelect, 'videoinput', 'Default PC Camera');
    populate(intaoralSelect, 'videoinput', 'None / Auto-Detect USB');
    populate(micSelect, 'audioinput', 'Default Microphone');
}

navigator.mediaDevices.addEventListener('devicechange', populateDeviceDropdowns);

// ---------------------------------------------------------------------------
// 2. Mic / Camera Toggles (Dentist Bottom Bar / Mobile Nav)
// ---------------------------------------------------------------------------

let isMicMuted = false;
let isCameraPaused = false;

function setupMediaToggles() {
    const micBtn = document.getElementById('micToggleBtn');
    const camBtn = document.getElementById('cameraToggleBtn');

    if (micBtn) {
        micBtn.addEventListener('click', () => {
            isMicMuted = !isMicMuted;
            
            // Toggle Audio Tracks
            if (window.pcStream) {
                window.pcStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
            }
            
            // Update UI
            const icon = micBtn.querySelector('.material-icons') || micBtn.querySelector('i');
            const bgDiv = micBtn.querySelector('.rounded-full') || micBtn.firstElementChild;
            
            if (isMicMuted) {
                if (icon) {
                    icon.className = 'fa-solid fa-microphone-slash text-red-500 text-xl sm:text-2xl transition-all duration-300';
                }
                if (bgDiv && bgDiv.classList) bgDiv.classList.add('bg-red-50');
            } else {
                if (icon) {
                    icon.className = 'fa-solid fa-microphone text-gray-600 group-hover:text-medical-blue text-xl sm:text-2xl transition-all duration-300';
                }
                if (bgDiv && bgDiv.classList) bgDiv.classList.remove('bg-red-50');
            }
        });
    }

    if (camBtn) {
        camBtn.addEventListener('click', () => {
            isCameraPaused = !isCameraPaused;
            
            // Soft-Toggle: Set enabled flag on local tracks across all active streams
            if (window.pcStream) {
                window.pcStream.getVideoTracks().forEach(t => t.enabled = !isCameraPaused);
            }
            if (window.usbStream) {
                window.usbStream.getVideoTracks().forEach(t => t.enabled = !isCameraPaused);
            }
            
            // Update UI Button appearance
            const icon = camBtn.querySelector('i') || camBtn.querySelector('.material-icons');
            const bgDiv = camBtn.querySelector('.rounded-full') || camBtn.querySelector('div');
            
            if (isCameraPaused) {
                if (icon) {
                    icon.className = 'fa-solid fa-video-slash text-red-500 text-xl sm:text-2xl transition-all duration-300';
                }
                if (bgDiv && bgDiv.classList) bgDiv.classList.add('bg-red-50');
            } else {
                if (icon) {
                    icon.className = 'fa-solid fa-video text-gray-600 group-hover:text-medical-blue text-xl sm:text-2xl transition-all duration-300';
                }
                if (bgDiv && bgDiv.classList) bgDiv.classList.remove('bg-red-50');
            }

            // Broadcast state to peers via signaling (webrtc.js)
            if (typeof window.sendMediaState === 'function') {
                window.sendMediaState(!isCameraPaused);
            }
            console.log('[ui.js] Camera toggled:', isCameraPaused ? 'PAUSED' : 'RESUMED');
        });
    }
}

// ---------------------------------------------------------------------------
// 3. Superior Dashboard - UI Helpers
// ---------------------------------------------------------------------------

function setupSidebarToggle() {
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
    const leftSidebar = document.getElementById('leftSidebar');
    
    if (sidebarToggleBtn && leftSidebar) {
        sidebarToggleBtn.addEventListener('click', () => {
            leftSidebar.classList.toggle('hidden');
        });
    }
}

/**
 * Expose globally so webrtc.js or server events can call it to log to the side panel
 */
window.appendEventLog = function(message) {
    const logContainer = document.getElementById('eventLog');
    if (!logContainer) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'text-xs mb-1.5 border-l-2 border-medical-blue pl-2 py-0.5 fade-in';
    entry.innerHTML = `<span class="text-gray-400 font-mono text-[10px] mr-1">[${time}]</span> <span class="text-gray-700">${message}</span>`;
    
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
};

// ---------------------------------------------------------------------------
// 4. Draggable PiP Utility (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Makes any positioned element draggable via mouse and touch.
 * The element is constrained to stay within the browser viewport.
 *
 * @param {HTMLElement} element — the element to make draggable
 */
function makeDraggable(element) {
    if (!element) return;

    // Ensure the element is absolutely positioned so top/left work
    const computed = window.getComputedStyle(element);
    if (computed.position === 'static') {
        element.style.position = 'absolute';
    }

    let isDragging = false;
    let startX, startY;       // pointer start coords
    let origLeft, origTop;    // element position at drag start
    let hasMoved = false;     // distinguishes drag from click

    function getPointerPos(e) {
        if (e.touches && e.touches.length) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function onPointerDown(e) {
        // Ignore right-click
        if (e.button && e.button !== 0) return;

        isDragging = true;
        hasMoved = false;

        const pos = getPointerPos(e);
        startX = pos.x;
        startY = pos.y;

        // Read current position (support both fixed and absolute)
        const rect = element.getBoundingClientRect();
        origLeft = rect.left;
        origTop  = rect.top;

        // Boost z-index while dragging
        element._savedZIndex = element.style.zIndex;
        element.style.zIndex = '9999';
        element.style.transition = 'none'; // disable transitions during drag
        element.style.cursor = 'grabbing';
    }

    function onPointerMove(e) {
        if (!isDragging) return;

        const pos = getPointerPos(e);
        const dx = pos.x - startX;
        const dy = pos.y - startY;

        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            hasMoved = true;
        }

        let newLeft = origLeft + dx;
        let newTop  = origTop  + dy;

        // Constrain to viewport
        const elW = element.offsetWidth;
        const elH = element.offsetHeight;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;

        newLeft = Math.max(0, Math.min(newLeft, vpW - elW));
        newTop  = Math.max(0, Math.min(newTop,  vpH - elH));

        // Apply via fixed positioning (since PiP containers use position:fixed)
        element.style.position = 'fixed';
        element.style.left  = newLeft + 'px';
        element.style.top   = newTop  + 'px';
        // Clear right/bottom so they don't conflict
        element.style.right  = 'auto';
        element.style.bottom = 'auto';

        // Prevent page scroll on touch devices
        if (e.cancelable) e.preventDefault();
    }

    function onPointerUp() {
        if (!isDragging) return;
        isDragging = false;

        // Restore z-index and cursor
        element.style.zIndex = element._savedZIndex || '';
        element.style.transition = '';
        element.style.cursor = 'move';
    }

    // Mouse events
    element.addEventListener('mousedown', onPointerDown);
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);

    // Touch events
    element.addEventListener('touchstart', onPointerDown, { passive: false });
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend', onPointerUp);

    // Visual hint
    element.style.cursor = 'move';
}

// ---------------------------------------------------------------------------
// 5. Snapshot API (Phase 18)
// ---------------------------------------------------------------------------

function setupSnapshot() {
    const snapshotBtn = document.getElementById('snapshotBtn2');
    if (!snapshotBtn) return;

    snapshotBtn.addEventListener('click', () => {
        // 1. Find the currently active remote video
        // Check for Focused Tile first
        let video = document.querySelector('#dynamicVideoGrid .video-tile.focused video');
        
        // If none focused, check for any video in the grid
        if (!video) {
            video = document.querySelector('#dynamicVideoGrid .video-tile video');
        }

        if (!video) {
            console.warn('[Snapshot] No remote video found in grid.');
            if (typeof showToast === 'function') showToast('No remote video to capture.', 'error');
            return;
        }

        // 2. Check readyState (>= 2 is 'metadata' or higher)
        if (video.readyState < 2) {
            console.warn('[Snapshot] Video not ready for capture.');
            return;
        }

        try {
            // 3. Create in-memory canvas
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // 4. Draw the frame
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            // 5. Convert to image
            const dataUrl = canvas.toDataURL('image/png');
            
            // 6. Render the Snapshot
            const gallery = document.getElementById('snapshotGallery');
            if (gallery) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.className = 'w-full rounded-lg shadow-md mb-3 border border-slate-200 transition-all hover:scale-105 cursor-pointer fade-in';
                
                // Clicking the thumbnail opens it in a new tab
                img.onclick = () => {
                    const win = window.open();
                    win.document.write(`<iframe src="${dataUrl}" frameborder="0" style="border:0; top:0px; left:0px; bottom:0px; right:0px; width:100%; height:100%;" allowfullscreen></iframe>`);
                };

                gallery.prepend(img); // Newest at top
                
                if (typeof window.appendEventLog === 'function') {
                    window.appendEventLog('Clinical snapshot captured.');
                }
            } else {
                console.error('[Snapshot] Gallery container not found.');
            }
        } catch (err) {
            console.error('[Snapshot] Capture failed:', err);
        }
    });
}

// ---------------------------------------------------------------------------
// 6. Entry Modal Transitions (Phase 22)
// ---------------------------------------------------------------------------

/**
 * Smoothly closes the entry modal with a scale-up + fade + blur effect.
 * Then reveals the main dashboard and media bar.
 */
window.closeEntryModal = function() {
    const overlay = document.getElementById('entryModalOverlay');
    const card = document.getElementById('entryModalCard');
    const main = document.getElementById('dashboardMain');
    const mediaBar = document.getElementById('mediaBar');

    if (!overlay || !card) return;

    // 1. Apply exit animations via classes
    card.classList.add('modal-exit');
    overlay.classList.add('backdrop-exit');
    
    // 2. Wait for animation to finish (400ms)
    setTimeout(() => {
        overlay.style.display = 'none';
        
        // 3. Reveal Dashboard
        if (main) {
            main.style.display = 'flex';
            main.classList.add('fade-in');
        }

        // 4. Reveal Media Bar with slide-up effect
        if (mediaBar) {
            mediaBar.style.display = 'block';
            // Trigger browser reflow to ensure transition works
            void mediaBar.offsetWidth; 
            mediaBar.style.transform = 'translate(-50%, 0)';
            mediaBar.style.opacity = '1';
        }
    }, 450);
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    populateDeviceDropdowns();
    setupMediaToggles();
    setupSidebarToggle();
    setupSnapshot(); // Phase 18
});
