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
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
            
            // Toggle Video Tracks across streams
            if (window.pcStream) {
                window.pcStream.getVideoTracks().forEach(t => t.enabled = !isCameraPaused);
            }
            if (window.usbStream) {
                window.usbStream.getVideoTracks().forEach(t => t.enabled = !isCameraPaused);
            }
            
            // Update UI
            const icon = camBtn.querySelector('.material-icons') || camBtn.querySelector('i');
            const bgDiv = camBtn.querySelector('.rounded-full') || camBtn.firstElementChild;
            
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
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    populateDeviceDropdowns();
    setupMediaToggles();
    setupSidebarToggle();
});
