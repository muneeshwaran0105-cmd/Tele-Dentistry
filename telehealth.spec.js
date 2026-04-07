const { test, expect, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let signalingServer;

test.describe('Teledentistry WebRTC Flow', () => {

  // Setup: Start the Python signaling server before tests run
  test.beforeAll(async () => {
    console.log('Starting Python signaling server...');
    signalingServer = spawn('python', ['server.py'], {
      cwd: __dirname,
      stdio: 'pipe'
    });

    signalingServer.stdout.on('data', (data) => {
      console.log(`[Server] ${data.toString().trim()}`);
    });

    signalingServer.stderr.on('data', (data) => {
      console.error(`[Server Error] ${data.toString().trim()}`);
    });

    // Give the server a moment to bind to the port
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  // Teardown: Kill the server after tests finish
  test.afterAll(() => {
    if (signalingServer) {
      console.log('Shutting down signaling server...');
      signalingServer.kill('SIGINT');
    }
  });

  // Use Chromium with synthetic media devices
  test.use({
    actionTimeout: 10000,
    navigationTimeout: 10000,
  });

  test('Dentist creates room and Superior joins successfully with video', async ({}) => {
    // 1. Launch browser with special flags to bypass camera permissions and use a synthetic feed
    const browser = await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream'
      ]
    });

    // 2. Create Context A (Dentist)
    const dentistContext = await browser.newContext();
    const dentistPage = await dentistContext.newPage();

    // 3. Create Context B (Superior)
    const superiorContext = await browser.newContext();
    const superiorPage = await superiorContext.newPage();

    // Define test credentials
    const ROOM_ID = 'test-room-123';
    const PIN = '4321';

    // --- DENTIST FLOW ---
    console.log('Dentist: Opening page...');
    const dentistUrl = `file:///${path.join(__dirname, 'dentist.html').replace(/\\/g, '/')}`;
    await dentistPage.goto(dentistUrl);

    // Enter Room ID & PIN
    await dentistPage.fill('#roomId', ROOM_ID);
    await dentistPage.fill('#roomPin', PIN);

    // Start Cameras
    console.log('Dentist: Starting cameras...');
    await dentistPage.click('#startCamerasBtn');
    
    // Wait for the local video to start playing to confirm stream capture
    await dentistPage.waitForFunction(() => {
      const video = document.querySelector('#pcFeedPlaceholder video');
      return video && video.currentTime > 0;
    }, { timeout: 5000 });

    // Create Room
    console.log('Dentist: Creating room...');
    await dentistPage.click('#createRoomBtn');

    // Assert: Dentist WebSocket is OPEN (readyState === 1)
    await dentistPage.waitForFunction(() => window.socket && window.socket.readyState === 1);
    console.log('Dentist: WebSocket is CONNECTED.');


    // --- SUPERIOR FLOW ---
    console.log('Superior: Opening page...');
    const superiorUrl = `file:///${path.join(__dirname, 'superior.html').replace(/\\/g, '/')}`;
    await superiorPage.goto(superiorUrl);

    // Enter Room ID & PIN
    await superiorPage.fill('#roomId', ROOM_ID);
    await superiorPage.fill('#roomPin', PIN);

    // Join Room
    console.log('Superior: Joining room...');
    await superiorPage.click('#joinRoomBtn');

    // Assert: Superior WebSocket is OPEN
    await superiorPage.waitForFunction(() => window.socket && window.socket.readyState === 1);
    console.log('Superior: WebSocket is CONNECTED.');


    // --- WEBRTC VERIFICATION ---
    // Wait for ICE connection state to become 'connected' or 'completed' on the Superior's side
    console.log('Waiting for WebRTC ICE state to connect...');
    await superiorPage.waitForFunction(() => {
      const state = window.peerConn && window.peerConn.iceConnectionState;
      return state === 'connected' || state === 'completed';
    }, { timeout: 10000 });
    console.log('Superior: ICE Connection is ESTABLISHED.');

    // Assert: Check that a remote video track is established and playing
    console.log('Waiting for remote video to render and play...');
    await superiorPage.waitForFunction(() => {
      // Find the main video container or any injected video block
      const video = document.querySelector('#mainVideoContainer video');
      if (!video) return false;
      
      // Ensure the srcObject exists and the video has played something
      return video.srcObject !== null && video.currentTime > 0;
    }, { timeout: 10000 });
    
    console.log('Superior: Remote video stream is actively playing!');

    // Cleanup contexts
    await dentistContext.close();
    await superiorContext.close();
    await browser.close();
  });
});
