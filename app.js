/**
 * PiWiFi Web App
 * Web Bluetooth interface for the PiWiFi diagnostic tool
 */

// BLE UUIDs (must match server)
const SERVICE_UUID = 'a1b2c3d4-0001-1000-8000-00805f9b34fb';
const COMMAND_UUID = 'a1b2c3d4-0002-1000-8000-00805f9b34fb';
const RESPONSE_UUID = 'a1b2c3d4-0003-1000-8000-00805f9b34fb';

// State
let device = null;
let server = null;
let commandChar = null;
let responseChar = null;
let signalChart = null;
let channelsChart = null;
let signalData = [];
const MAX_SIGNAL_POINTS = 30;

// Chunking state
let chunks = [];
let expectedChunks = 0;

// DOM Elements
const connectBtn = document.getElementById('connect-btn');
const connectionStatus = document.getElementById('connection-status');
const controlsSection = document.getElementById('controls');
const scanBtn = document.getElementById('scan-btn');
const channelsBtn = document.getElementById('channels-btn');
const networksSection = document.getElementById('networks-section');
const networksList = document.getElementById('networks-list');
const monitorSection = document.getElementById('monitor-section');
const monitorSsid = document.getElementById('monitor-ssid');
const stopMonitorBtn = document.getElementById('stop-monitor-btn');
const currentRssi = document.getElementById('current-rssi');
const channelsSection = document.getElementById('channels-section');
const logDiv = document.getElementById('log');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    connectBtn.addEventListener('click', connect);
    scanBtn.addEventListener('click', scanNetworks);
    channelsBtn.addEventListener('click', analyzeChannels);
    stopMonitorBtn.addEventListener('click', stopMonitor);

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchBand(tab.dataset.band));
    });

    initCharts();
    log('App initialisée. Prêt à connecter.');
});

// Logging
function log(message, type = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logDiv.insertBefore(entry, logDiv.firstChild);

    // Keep log size manageable
    while (logDiv.children.length > 50) {
        logDiv.removeChild(logDiv.lastChild);
    }
}

// BLE Connection
async function connect() {
    if (!navigator.bluetooth) {
        log('Web Bluetooth non supporté. Utilisez Bluefy sur iOS.', 'error');
        return;
    }

    try {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connexion...';
        log('Recherche du Pi...');

        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            // Fallback: accept all devices if service filter fails
            // optionalServices: [SERVICE_UUID]
        });

        device.addEventListener('gattserverdisconnected', onDisconnected);

        log(`Appareil trouvé: ${device.name || device.id}`);

        server = await device.gatt.connect();
        log('Connecté au serveur GATT');

        const service = await server.getPrimaryService(SERVICE_UUID);
        log('Service PiWiFi trouvé');

        commandChar = await service.getCharacteristic(COMMAND_UUID);
        responseChar = await service.getCharacteristic(RESPONSE_UUID);

        // Subscribe to notifications
        await responseChar.startNotifications();
        responseChar.addEventListener('characteristicvaluechanged', onResponse);

        log('Caractéristiques connectées', 'success');

        // Update UI
        setConnected(true);

        // Test connection
        await sendCommand({ cmd: 'ping' });

    } catch (error) {
        log(`Erreur: ${error.message}`, 'error');
        setConnected(false);
    }
}

function onDisconnected() {
    log('Déconnecté du Pi', 'error');
    setConnected(false);
}

function setConnected(connected) {
    if (connected) {
        connectionStatus.className = 'status connected';
        connectionStatus.querySelector('.text').textContent = 'Connecté';
        connectBtn.textContent = 'Connecté';
        controlsSection.classList.remove('hidden');
    } else {
        connectionStatus.className = 'status disconnected';
        connectionStatus.querySelector('.text').textContent = 'Déconnecté';
        connectBtn.textContent = 'Connecter au Pi';
        connectBtn.disabled = false;
        controlsSection.classList.add('hidden');
        networksSection.classList.add('hidden');
        monitorSection.classList.add('hidden');
        channelsSection.classList.add('hidden');
    }
}

// Commands
async function sendCommand(cmd) {
    if (!commandChar) {
        log('Non connecté', 'error');
        return;
    }

    const data = JSON.stringify(cmd);
    log(`Envoi: ${data}`);

    const encoder = new TextEncoder();
    await commandChar.writeValue(encoder.encode(data));
}

function onResponse(event) {
    const value = new Uint8Array(event.target.value.buffer);

    // First 2 bytes are chunk header: [index, total]
    const chunkIndex = value[0];
    const totalChunks = value[1];
    const chunkData = value.slice(2);

    log(`Chunk ${chunkIndex + 1}/${totalChunks} reçu (${chunkData.length} bytes)`);

    // Reset if new message
    if (chunkIndex === 0) {
        chunks = [];
        expectedChunks = totalChunks;
    }

    chunks[chunkIndex] = chunkData;

    // Check if all chunks received
    const receivedCount = chunks.filter(c => c !== undefined).length;
    if (receivedCount === expectedChunks) {
        // Reassemble message
        const fullData = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            fullData.set(chunk, offset);
            offset += chunk.length;
        }

        const decoder = new TextDecoder();
        const data = decoder.decode(fullData);

        try {
            const response = JSON.parse(data);
            handleResponse(response);
        } catch (e) {
            log(`Erreur JSON: ${e.message}`, 'error');
        }

        // Reset
        chunks = [];
        expectedChunks = 0;
    }
}

function handleResponse(response) {
    log(`Reçu: ${response.type}`);

    switch (response.type) {
        case 'pong':
            log('Connexion vérifiée', 'success');
            break;

        case 'scan_result':
            displayNetworks(response.networks);
            break;

        case 'signal':
            updateSignal(response);
            break;

        case 'channels':
            displayChannels(response);
            break;

        case 'monitor_started':
            log(`Monitoring: ${response.ssid}`, 'success');
            break;

        case 'monitor_stopped':
            log('Monitoring arrêté');
            break;

        case 'error':
            log(`Erreur: ${response.message}`, 'error');
            break;
    }
}

// WiFi Scan
async function scanNetworks() {
    scanBtn.classList.add('scanning');
    scanBtn.disabled = true;
    log('Scan en cours...');

    try {
        await sendCommand({ cmd: 'scan' });
    } finally {
        setTimeout(() => {
            scanBtn.classList.remove('scanning');
            scanBtn.disabled = false;
        }, 1000);
    }
}

function displayNetworks(networks) {
    networksSection.classList.remove('hidden');
    networksList.innerHTML = '';

    networks.forEach(net => {
        const item = document.createElement('div');
        item.className = 'network-item';
        item.innerHTML = `
            <div class="network-info">
                <div class="network-ssid">${net.ssid || '(Réseau caché)'}</div>
                <div class="network-details">Ch ${net.channel} · ${net.security}</div>
            </div>
            <div class="network-signal">
                ${getSignalBars(net.rssi)}
                <span>${net.rssi} dBm</span>
            </div>
        `;

        if (net.ssid) {
            item.addEventListener('click', () => startMonitor(net.ssid));
        }

        networksList.appendChild(item);
    });

    log(`${networks.length} réseaux trouvés`, 'success');
}

function getSignalBars(rssi) {
    const strength = rssiToStrength(rssi);
    let bars = '';
    for (let i = 1; i <= 4; i++) {
        bars += `<div class="signal-bar ${i <= strength ? 'active' : ''}"></div>`;
    }
    return `<div class="signal-bars">${bars}</div>`;
}

function rssiToStrength(rssi) {
    if (rssi >= -50) return 4;
    if (rssi >= -60) return 3;
    if (rssi >= -70) return 2;
    return 1;
}

// Signal Monitor
async function startMonitor(ssid) {
    monitorSection.classList.remove('hidden');
    monitorSsid.textContent = ssid;
    signalData = [];
    updateSignalChart();

    await sendCommand({ cmd: 'monitor', ssid });
}

async function stopMonitor() {
    monitorSection.classList.add('hidden');
    await sendCommand({ cmd: 'stop' });
}

function updateSignal(data) {
    currentRssi.textContent = `${data.rssi} dBm`;

    signalData.push({
        time: new Date(data.timestamp),
        rssi: data.rssi
    });

    if (signalData.length > MAX_SIGNAL_POINTS) {
        signalData.shift();
    }

    updateSignalChart();
}

// Channels Analysis
async function analyzeChannels() {
    channelsBtn.classList.add('scanning');
    channelsBtn.disabled = true;

    try {
        await sendCommand({ cmd: 'channels' });
    } finally {
        setTimeout(() => {
            channelsBtn.classList.remove('scanning');
            channelsBtn.disabled = false;
        }, 1000);
    }
}

let channelsData = null;

function displayChannels(data) {
    channelsSection.classList.remove('hidden');
    channelsData = data;
    updateChannelsChart('2g');
}

function switchBand(band) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-band="${band}"]`).classList.add('active');
    updateChannelsChart(band);
}

// Charts
function initCharts() {
    // Signal Chart
    const signalCtx = document.getElementById('signal-chart').getContext('2d');
    signalChart = new Chart(signalCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Signal (dBm)',
                data: [],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    min: -100,
                    max: -20,
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });

    // Channels Chart
    const channelsCtx = document.getElementById('channels-chart').getContext('2d');
    channelsChart = new Chart(channelsCtx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Réseaux',
                data: [],
                backgroundColor: '#3b82f6'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8', stepSize: 1 }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function updateSignalChart() {
    signalChart.data.labels = signalData.map(d =>
        d.time.toLocaleTimeString('fr-FR', { minute: '2-digit', second: '2-digit' })
    );
    signalChart.data.datasets[0].data = signalData.map(d => d.rssi);
    signalChart.update('none');
}

function updateChannelsChart(band) {
    if (!channelsData) return;

    const data = band === '2g' ? channelsData.band_2g : channelsData.band_5g;

    channelsChart.data.labels = data.map(c => `Ch ${c.channel}`);
    channelsChart.data.datasets[0].data = data.map(c => c.networks);

    // Color channels by congestion
    channelsChart.data.datasets[0].backgroundColor = data.map(c => {
        if (c.networks === 0) return '#22c55e';
        if (c.networks <= 2) return '#f59e0b';
        return '#ef4444';
    });

    channelsChart.update();
}
