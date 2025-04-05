import commonHelpers from "common-helpers";
import { io } from "socket.io-client";

const RTC_CHUNK_SIZE = 16000;

const SECOND = 1000;
const MINUTE = SECOND * 60;

const QUEUE_THRESH = 2024;
const DEF_PING_INTERVAL = 5000;

const USE_ICE_SERVERS = [
    {urls: "stun:stun.l.google.com:19302"},
    {urls: "stun:stun.stunprotocol.org:3478"},
    {urls: "stun:stun1.l.google.com:19302"},
    {urls: "stun:stun2.l.google.com:19302"},
    {urls: "stun:stun3.l.google.com:19302"},
    {urls: "stun:stun4.l.google.com:19302"}
];

let wacUtils = null;
let hasiOSHost = false;
let hasAndroidHost = false;

if(window.wacUtils2) {
    wacUtils = window.wacUtils2;
}

let lanScanCallbacks = {};

let clientUid = null;

if(typeof localStorage === "undefined") {
    clientUid = commonHelpers.guid(); 
} else {
    clientUid = localStorage.getItem("umph-client-uid-v2");

    if(!clientUid || clientUid == "0" || clientUid.trim().length == 0) {
        clientUid = commonHelpers.guid();
        localStorage.setItem("umph-client-uid-v2", clientUid);
    }
}

export class GameLobby {

    constructor(options) {

        this.options = options || {};

        this.id = commonHelpers.guid();

        this.name = this.options.name || null;
        this.listener = this.options.listener || null;
        this.signalingServer = this.options.signalingServer || null;
        this.port = this.options.port || 0;

        if(!wacUtils && !hasiOSHost && !hasAndroidHost) {
            this.port = 0;
        }

        this.socket = null;
    
        this.connected = false;
        this.wasClosed = false;

        this.remoteServers = {};
        this.localServers = {};

        this.gameTimeoutChecker = null;

        if(this.name && this.listener && (this.signalingServer || this.port)) {
            this.connect();
        }
    }

    refresh(withReping = false) {
        refreshLobby(this, withReping);
    }

    postCustomData(data) {
        postCustomLobbyData(this, data);
    }

    createServer(listener, useId) {
        return createServer(this, listener, useId);
    }

    joinServer(id, listener) {
        return joinServer(this, id, listener);
    }

    close() {
        closeLobby(this);
    }

    connect() {
        bootUpLobby(this);
    }
}

class LocalServer {

    constructor(lobby) {
        const server = this;

        this.id = commonHelpers.guid();

        this.isLocal = true;

        this.active = true;

        // local server is always connected to itself
        this.connected = true;

        this.listener = null;
        this.extras = null;
        this.lobby = lobby;
        this.tcpSocketId = null;

        if(lobby.port) {
            bootUpLANServer(this, lobby.port);
        }

        this.clients = {};

        this.incomingBuffers = {};

        
        
        setTimeout(function() {
            server.pingAll();
        }, DEF_PING_INTERVAL);
    }

    close() {
        closeLocalServer(this);
    }
    
    updateExtras(extras) {
        updateServerExtras(this, extras);
    }

    sendMessage(message, to = null) {
        sendMessage(this, message, to);
    }

    pingAll() {
        pingAll(this);
    }

    approveJoin(remoteId) {
        approveJoin(this, remoteId);
    }
}

class RemoteServer {

    constructor() {
        this.id = null;
        this.extras = null;
        this.reportedData = null;
        this.lobby = null;
    
        this.isLocal = false;
    
        this.lastReport = new Date().getTime();
        this.pingTime = 0;
        this.pingRate = 0;
        this.missedReports = 0;
        this.missedReportTimeout = null;
        this.active = true;
    
        this.listener = null;
        this.connected = false;
        this.status = "idle";
        this.type = "rtc";
    
        this.client = null;
        this.dataChannel = null;
        this.queue = [];

        this.incomingBuffers = {};
    }

    ping() {
        pingServer(this);
    }

    connect(listener) {
        connectToServer(this, listener);
    }

    sendMessage(message, to = null) {
        sendMessage(this, message, to);
    }

    close() {
        closeRemoteServer(this);
    }
}

function bootUpLobby(lobby) {

    if(lobby.connected) {
        return;
    }

    if(lobby.signalingServer) {
        lobby.socket = io(lobby.signalingServer, {
            secure: true,
            rejectUnauthorized: false
        });
    
        lobby.socket.on("connect",function() {
            onSignalSocketConnect(lobby);
        });
    
        lobby.socket.on("message", function(message) {
            onSignalSocketMessage(lobby, message);
        });
    
        lobby.socket.on("disconnect", function() {
            lobby.connected = false;
    
            if(lobby.listener) {
                lobby.listener("disconnected");
            }
        });
    }

    if(lobby.port && wacUtils) {
        lobby.connected = true;
    }
    
    setTimeout(function() {
        lobby.refresh(true);
    }, 3000);

    lobby.gameTimeoutChecker = setInterval(function() {
        checkForDeadRemotes(lobby);
    }, MINUTE);
}

function onSignalSocketConnect(lobby) {

    if(lobby.wasClosed) {

        if(lobby.socket) {
            lobby.socket.emit("closeconnection", "");
            lobby.socket.close();
        }

        return;
    }

    lobby.connected = true;

    lobby.socket.emit("joinroom", lobby.name);
    lobby.listener("connected", lobby);

    setTimeout(function() {
        postLobbyMessage(lobby, {
            m: "roomAnnounce"
        });
    }, 200);
}

function onSignalSocketMessage(lobby, message) {

    if(lobby.wasClosed) {

        if(lobby.socket) {
            lobby.socket.emit("closeconnection", "");
            lobby.socket.close();
        }

        return;
    }

    const method = message.m;
    const data = message.d;
    const sentBy = message.r;

    if(!method) {
        return;
    }

    if(method == "gameClose") {
        onServerClose(lobby, data);
    }

    if(method == "gameInfo") {
        onRemoteServerInfo(lobby, data);
    }

    if(method == "roomAnnounce") {
        onLobbyInfoRequest(lobby);
    }

    if(method == "pingReq") {
        pongBack(lobby, data, sentBy);
    }

    if(method == "pongBack" && data == lobby.id) {
        onWasPongged(lobby, sentBy);
    }

    if(method == "estRtc") {
        beginPeerConnection(lobby, data, sentBy);
    }

    if(method == "rtcOffer") {
        if(data == lobby.id && message.o) {
            onRTCOffer(lobby, sentBy, message.o);
        }
    }

    if(method == "iceCand" && data == lobby.id && message.i) {
        onServerIce(lobby, sentBy, message.i);
    }

    if(method == "rtcAns" && message.a) {
        onRTCAnswer(lobby, data, sentBy, message.a);
    }

    if(method == "cliIce"  && message.i) {
        onClientIce(lobby, data, sentBy, message.i);
    }
}

function postLobbyMessage(lobby, data) {
    if(!lobby || !lobby.name || !lobby.listener || !lobby.socket) {
        return;
    }

    lobby.socket.emit("gamemessage", {
        destination: lobby.name,
        msg: data
    });
}

function refreshLobby(lobby, withReping = false) {

    if(!lobby || !lobby.connected) {
        return;
    }

    if(lobby.socket) {
        postLobbyMessage(lobby, {
            m: "roomAnnounce"
        });
    }
    
    if(lobby.port) {
        if(wacUtils) {

            const onConnectedName = "onWAClanScanDone" + scanId;
            const scanId = commonHelpers.guid();
            
            const callback = function(ips) {

                if(ips && ips.length > 0) {
                    for(let i = 0; i < ips.length; i++) {
                        const ip = ips[i];
                    }
                }

                if(wacUtils.removeCustomListener) {
                    wacUtils.removeCustomListener(onConnectedName);
                }
            };

            lanScanCallbacks[scanId] = callback;
            
            wacUtils.setCustomListener(onConnectedName, function(e, scanResult) {

                if(scanResult) {
                    if(callback) {
                        callback(scanResult);
                    }
                } else {
                    if(callback) {
                        callback([]);
                    }
                }
            });

            wacUtils.ipcSend("scanLocalNetwork", {
                port: lobby.port,
                id: scanId
            });
        }
    }

    if(withReping) {
        setTimeout(lobby.refresh, 6000);
    }
    
}

function postCustomLobbyData(lobby, data) {

    if(!lobby || !lobby.socket) {
        return;
    }

    postLobbyMessage(lobby, {
        m: "customLobbyData",
        d: data,
        r: lobby.id
    });
}

function createServer(lobby, listener, useId) {

    if(!lobby) {
        return;
    }

    const server = new LocalServer(lobby);

    if(useId) {
        server.id = useId;
    }

    if(listener) {
        server.listener = listener;
    }

    lobby.localServers[server.id] = server;

    return server;
}

function onLobbyInfoRequest(lobby) {
    for(let serverId in lobby.localServers) {
        const server = lobby.localServers[serverId];

        if(server.listener) {
            server.listener("pingGameInfo");
        } else {
            server.updateExtras();
        }
    }
}

function closeRemoteServer(server) {

    if(!server) {
        return;
    }

    server.sendMessage("c.dc.sd");
    clearMissedReportTimeout(server);

    shutDownRemoteClient(server.client);   

    server.active = false;
    server.connected = false;
    server.listener = null;
    server.client = null;
    server.dataChannel = null;
    server.queue = [];
}

function closeLocalServer(server) {

    if(!server) {
        return;
    }

    postLobbyMessage(server.lobby, {
        m: "gameClose",
        d: server.id
    });

    for(let clientId in server.clients) {
        const client = server.clients[clientId];
        shutDownRemoteClient(client.rtc);
    }

    if(server.tcpSocketId) {
        if(wacUtils) {
            wacUtils.ipcInvoke("closeTcpSocket", server.tcpSocketId);
        }
    }

    delete server.lobby.localServers[server.id];

    server.active = false;
    server.listener = null;
    server.clients = {};
}

function joinServer(lobby, id, listener) {

    if(!lobby) {
        return null;
    }

    const server = lobby.remoteServers[id];

    if(!server) {
        return null;
    }

    if(server.connected) {
        return server;
    }

    server.connect(listener);

    return server;
}

function closeLobby(lobby) {

    if(!lobby) {
        return;
    }

    lobby.wasClosed = true;

    if(lobby.gameTimeoutChecker) {
        clearInterval(lobby.gameTimeoutChecker);
    }

    lobby.gameTimeoutChecker = null;

    for(let cid in lobby.remoteServers) {
        const server = lobby.remoteServers[cid];
        server.close();
    }

    for(let cid in lobby.localServers) {
        const server = lobby.localServers[cid];
        server.close();
    }

    if(lobby.socket) {
        lobby.socket.emit("closeconnection", "");
        lobby.socket.close();
    }
    

    lobby.listener = null;
    lobby.socket = null;
    lobby.connected = false;
}

function checkForDeadRemotes(lobby) {

    const killList = [];

    for(let cid in lobby.remoteServers) {
        const server = lobby.remoteServers[cid];
        
        if(server.missedReports > 5) {
            killList.push(cid);
        }
    }

    for(let i = 0; i < killList.length; i++) {
        const kill = killList[i];
        onServerClose(lobby, kill);
    }
}

function onServerClose(lobby, serverId) {

    if(lobby.listener) {
        lobby.listener("gameRemoved", serverId);
    }

    const server = lobby.remoteServers[serverId];

    if(server) {
        server.close();
    }

    delete lobby.remoteServers[serverId];   
}

function onRemoteServerInfo(lobby, data) {

    if(!lobby || !data || !data.id) {
        return;
    }

    let server = lobby.remoteServers[data.id];

    if(!server) {
        server = new RemoteServer();
        server.id = data.id;
        server.lobby = lobby;
        lobby.remoteServers[data.id] = server;
    }

    server.reportedData = data;

    server.lastReport = new Date().getTime();

    if(data.ex != undefined) {
        server.ex = data.ex;
    }

    server.ping();
}

function updateServerExtras(server, extras) {

    if(!server) {
        return;
    }

    if(extras != undefined) {
        server.extras = extras;
    }

    postLobbyMessage(server.lobby, {
        m: "gameInfo",
        d: {
            id: server.id,
            ex: server.extras,
            cap: {
                sio: false,
                tcp: false,
                rtc: true,
                rtcp: false
            },
            t: "online",
            ip: null
        }
    });
}

function chunkArrayBuffer(buffer, chunkSize) {
    const result = [];
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i += chunkSize) {
        // buffer.slice() returns a new ArrayBuffer
        result.push(buffer.slice(i, i + chunkSize));
    }
    return result;
}

// Modified encode function for string/JSON messages.
function encodeLanSocketPacketBinary(jsonString, type) {
    const encoder = new TextEncoder();
    const payload = encoder.encode(jsonString);
    // Use type 0 for JSON/string data.
    return wrapMessageWithHeader(payload, type);
}

// Modified wrap function for raw ArrayBuffer messages.
function wrapArrayBufferWithHeader(buffer) {
    // Use type 1 for raw array buffer.
    return wrapMessageWithHeader(new Uint8Array(buffer), 2);
}

function isWrapped(buffer) {
    // Must be an ArrayBuffer and at least 5 bytes (header)
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) {
        return false;
    }

    const view = new DataView(buffer);
    const type = view.getUint8(0);
    // Check that type is within expected values (0 for string/JSON, 1 for object, 2 for raw ArrayBuffer)
    if (type !== 0 && type !== 1 && type !== 2) {
        return false;
    }

    const payloadLength = view.getUint32(1);
    // Expect the total length to be header (5 bytes) plus the payload length.
    if (payloadLength !== buffer.byteLength - 5) {
        return false;
    }

    return true;
}

// New header wrapping function that includes a type indicator.
// type: 0 => string, 1=> object 2 => raw ArrayBuffer. You can add more types as needed.
function wrapMessageWithHeader(buffer, type) {
    // Create a 5-byte header: 1 byte for type, 4 bytes for payload length.
    const header = new ArrayBuffer(5);
    const headerView = new DataView(header);
    headerView.setUint8(0, type);
    headerView.setUint32(1, buffer.byteLength);
    const combined = new Uint8Array(5 + buffer.byteLength);
    combined.set(new Uint8Array(header), 0);
    combined.set(new Uint8Array(buffer), 5);
    return combined.buffer;
}

function sendMessage(server, message, to = null) {

    if(!server || !server.connected) {
        return;
    }

    let sendData = null;
    let chunks = [];
    let useStrType = 0;

    if(!message) {
        return;
    }

    // If message is an object (except ArrayBuffer), stringify it.
    if (typeof message === "object" && !(message instanceof ArrayBuffer)) {
        message = JSON.stringify(message);
        useStrType = 1;
    }
    
    // If string, encode it (will be wrapped with type indicator 0).
    if (typeof message === "string") {
        message = encodeLanSocketPacketBinary(message, useStrType);
    }
    
    // If it's an ArrayBuffer, wrap it if not already wrapped (with type indicator 1).
    if (message instanceof ArrayBuffer && !isWrapped(message)) {
        message = wrapArrayBufferWithHeader(message);
    }

    try {
        sendData = message;
        chunks = chunkArrayBuffer(sendData, RTC_CHUNK_SIZE);
    } catch(ex) {
        console.log(ex);
        return;
    }

    if(server.isLocal && !to) {
        for(let cid in server.clients) {
            const client = server.clients[cid];
            const sendTo = client.dataChannel;

            if(!sendTo) {
                continue;
            }

            for(let i = 0; i < chunks.length; i++) {
                const cd = chunks[i];
                client.queue.push(cd);
            }

            processQueueItem(client);
        }
    } else {
        let sendTo = null;
        let sendServer = server;

        if(!server.isLocal) {
            sendTo = server.dataChannel;
        } else {
            const hold = server.clients[to];

            if(hold) {
                sendServer = hold;
                sendTo = hold.dataChannel;
            }
        }

        if(sendTo) {

            for(let i = 0; i < chunks.length; i++) {
                const cd = chunks[i];
                sendServer.queue.push(cd);

            }

            processQueueItem(sendServer);
        }
    }
}

function processQueueItem(client) {
    if(!client.dataChannel || !client.queue || client.queue.length == 0) {
        return;
    }

    if(client.dataChannel.bufferedAmount > QUEUE_THRESH) {
        if("requestIdleCallback" in window) {
            requestIdleCallback(function() {
                processQueueItem(client);
            });
        } else {
            setTimeout(function() {
                processQueueItem(client);
            }, 50);
        }

        return;
    }

    const nextMsg = client.queue.shift();

    client.dataChannel.send(nextMsg);

    if("requestIdleCallback" in window) {
        requestIdleCallback(function() {
            processQueueItem(client);
        });
    } else {
        setTimeout(function() {
            processQueueItem(client);
        }, 0);
    }
}

function pingAll(server) {
        
    if(!server || !server.active) {
        return;
    }

    const killList = [];

    for(let clientId in server.clients) {
        const client = server.clients[clientId];

        if(client.missedPings == 0) {
            client.lastPing = new Date().getTime();
        }

        if(client.missedPings >= 10) {
            server.listener("clientPingTimeout", {
                c: clientId,
                l: client.lastPing
            });

            killList.push(clientId);

            shutDownRemoteClient(client.rtc);
        }

        client.missedPings++;

        server.sendMessage("s.a.pi", clientId);
    }

    while(killList.length > 0) {
        const kill = killList.pop();
        delete server.clients[kill];
    }

    setTimeout(function() {
        server.pingAll();
    }, DEF_PING_INTERVAL);
}

function shutDownRemoteClient(rtcConnection) {
    if(rtcConnection) {
        try {
            rtcConnection.close();
        } catch(ex) {
            console.log(ex);
        }
    }
}

function approveJoin(server, remoteId) {

    if(!server) {
        return;
    }

    const client = server.clients[remoteId];

    if(!client) {
        return;
    }

    client.approved = true;

    server.sendMessage("aj", remoteId);
}

function pingServer(server) {

    if(!server) {
        return;
    }

    clearMissedReportTimeout(server);

    server.pingTime = new Date().getTime();
    server.missedReports++;

    postLobbyMessage(server.lobby, {
        m: "pingReq", 
        d: server.id,
        r: server.lobby.id
    });

    server.missedReportTimeout = setTimeout(function() {
        server.ping();
    }, SECOND * 5);
}

function clearMissedReportTimeout(server) {
    if(server.missedReportTimeout) {
        clearTimeout(server.missedReportTimeout);
    }

    server.missedReportTimeout = null;
}

function connectToServer(server, listener) {
        
    if(!server) {
        return;
    }

    server.listener = listener;
    server.connected = false;

    server.status = "connecting";

    postLobbyMessage(server.lobby, {
        m: "estRtc",
        d: server.id,
        r: server.lobby.id
    });
}

function pongBack(lobby, serverId, pongTo) {
    if(lobby.localServers[serverId]) {
        postLobbyMessage(lobby, {
            m: "pongBack", 
            d: pongTo,
            r: serverId
        });
    }
}

function onWasPongged(lobby, serverId) {
    if(lobby.remoteServers[serverId]) {
        const server = lobby.remoteServers[serverId];
        const now = new Date().getTime();

        server.lastReport = now;
        server.missedReports = 0;

        clearMissedReportTimeout(server);

        server.pingRate = Math.round((now - server.pingTime) / 2);

        if(lobby.listener("gameUpdated", {
            server: server.reportedData,
            pingTime: server.pingTime,
            pingRate: server.pingRate
        }));
    }
}

async function beginPeerConnection(lobby, serverId, remoteClient) {
    const server = lobby.localServers[serverId];

    if(!server) {
        return;
    }

    if(server.clients[remoteClient]) {
        shutDownRemoteClient(server.clients[remoteClient].rtc);
        delete server.clients[remoteClient];
    }

    const client = new RTCPeerConnection({
        iceServers: USE_ICE_SERVERS
    });

    server.clients[remoteClient] = {
        rtc: client,
        dataChannel: null,
        curPing: 0,
        lastPing: 0,
        missedPings: 0,
        approved: false,
        type: "rtc",
        ip: null,
        queue: [],
        incomingBuffers: {}
    };

    client.onnegotiationneeded = async function() {
        const offer = await client.createOffer();
        await client.setLocalDescription(offer);

        postLobbyMessage(lobby, {
            m: "rtcOffer",
            d: remoteClient,
            r: server.id,
            o: offer
        });
    };

    client.onicecandidate = function(e) {

        if(e && e.candidate) {

            postLobbyMessage(lobby, {
                m: "iceCand",
                d: remoteClient,
                r: serverId,
                i: e.candidate
            });
        }
    };

    client.onconnectionstatechange = function() {
        if(client.connectionState == "disconnected") {
            server.listener("clientDisconnected", remoteClient);
            shutDownRemoteClient(client);
            delete server.clients[remoteClient];
        }
    };

    const dataChannel = client.createDataChannel("serverChannel");
    dataChannel.bufferedAmountLowThreshold = 1024;

    dataChannel.onbufferedamountlow = function() {

        if(server.clients[remoteClient]) {
            processQueueItem(server.clients[remoteClient]);
        }
    };

    dataChannel.onopen = function() {
        if(server.clients[remoteClient]) {
            server.clients[remoteClient].dataChannel = dataChannel;
        }
    };

    dataChannel.onclose = function() {
        if(server.clients[remoteClient]) {
            server.clients[remoteClient].dataChannel = null;
        }
    };

    dataChannel.onmessage = function(message) {
        if(message && message.data) {
            onMessageFromRtc(server, remoteClient, message.data);
        }
    };
}

function onMessageFromRtc(server, from, chunk) {
    if(!server || !server.listener) {
        return;
    }

    // Create or update the buffer for this sender.
    if (!server.incomingBuffers[from]) {
        server.incomingBuffers[from] = { buffer: [], totalLength: null, currentLength: 0, type: null };
    }

    const senderBuffer = server.incomingBuffers[from];

    // If this is the first chunk, extract type and total length.
    if (senderBuffer.totalLength === null) {
        const view = new DataView(chunk);
        senderBuffer.type = view.getUint8(0); // 0 for JSON/string, 1 for ArrayBuffer
        senderBuffer.totalLength = view.getUint32(1);
        // Add payload starting from byte 5.
        senderBuffer.buffer.push(chunk.slice(5));
        senderBuffer.currentLength += chunk.byteLength - 5;
    } else {
        senderBuffer.buffer.push(chunk);
        senderBuffer.currentLength += chunk.byteLength;
    }

    // Reassemble if we've received enough data.
    if (senderBuffer.totalLength !== null && senderBuffer.currentLength >= senderBuffer.totalLength) {
        const fullBuffer = new Uint8Array(senderBuffer.totalLength);
        let offset = 0;
        for (const part of senderBuffer.buffer) {
            fullBuffer.set(new Uint8Array(part), offset);
            offset += part.byteLength;
        }
        
        // Process based on type.
        if (senderBuffer.type === 0) {
            // For JSON/string messages.
            const decoder = new TextDecoder();
            const jsonString = decoder.decode(fullBuffer);

            if(senderBuffer.type == 1) {
                // If it's an object, decode it.
                try {
                    const obj = JSON.parse(jsonString);
                    handleDecodedMessage(server, from, obj);
                } catch(e) {
                    console.error("Error decoding message:", e);
                }
            } else {
                // If it's a string, handle it directly.
                handleDecodedMessage(server, from, jsonString);
            }
        } else if (senderBuffer.type === 2) {
            // For raw ArrayBuffer messages.
            handleDecodedMessage(server, from, fullBuffer.buffer);
        }
        delete server.incomingBuffers[from];
    }
}

function handleDecodedMessage(server, from, message) {
    if(server.isLocal) {
        if(message == "rj") {
            server.listener("joinRequest", from);
            return;
        }

        if(message == "c.dc.sd") {
            const client = server.clients[from];

            if(client) {
                shutDownRemoteClient(client.rtc);
                delete server.clients[from];
                server.listener("clientDisconnected", from);
            }

            return;
        }

        if(message == "s.a.po") {
            const client = server.clients[from];

            if(client) {
                const now = new Date().getTime();

                client.curPing = now - client.lastPing;
                client.missedPings = 0;

                server.listener("clientPingUpdate", {
                    c: from, 
                    p: client.curPing
                });
            }

            return;
        }
    } else {
        if(message == "aj") {
            server.status = "idle";
            server.listener("joinApproved", from);
            return;
        }

        if(message == "s.a.pi") {
            server.sendMessage("s.a.po");
            return;
        }
    }

    server.listener("message", {
        gameId: server.id, 
        remoteId: from, 
        message: message
    });
}

async function onRTCOffer(lobby, serverId, offer) {

    const server = lobby.remoteServers[serverId];

    if(!server) {
        return;
    }

    if(server.client) {
        shutDownRemoteClient(server.client);
        server.client = null;
    }

    const client = new RTCPeerConnection({
        iceServers: USE_ICE_SERVERS
    });

    server.client = client;

    client.onconnectionstatechange = function() {

        if(client.connectionState == "connected") {
            server.connected = true;
        } else {
            server.connected = false;
            server.queue = [];
        }

        if(client.connectionState == "disconnected") {
            server.listener("serverDisconnected");
        }
    };


    client.onicecandidate = function(e) {

        if(e && e.candidate) {

            postLobbyMessage(lobby, {
                m: "cliIce",
                d: serverId,
                r: lobby.id,
                i: e.candidate
            });
        }
    };

    client.ondatachannel = function(e) {
        const dataChannel = e.channel;

        if(dataChannel) {

            dataChannel.bufferedAmountLowThreshold = 1024;

            dataChannel.onbufferedamountlow = function() {
                if(server) {
                    processQueueItem(server);
                }
                
            };

            dataChannel.onopen = function() {
                server.dataChannel = dataChannel;
                server.sendMessage("rj");
            };

            dataChannel.onclose = function() {
                server.dataChannel = null;
            };

            dataChannel.onmessage = function(message) {
                if(message && message.data) {
                    onMessageFromRtc(server, server.id, message.data);
                }
            };
        }
    };


    await client.setRemoteDescription(offer);
    const answer = await client.createAnswer();
    await client.setLocalDescription(answer);

    postLobbyMessage(lobby, {
        m: "rtcAns",
        d: server.id,
        r: lobby.id,
        a: answer
    });

}

async function onServerIce(lobby, serverId, ice) {
    const server = lobby.remoteServers[serverId];

    if(!server) {
        return;
    }

    const client = server.client;

    if(!client) {
        return;
    }

    try {
        await client.addIceCandidate(ice);
    } catch(ex) {
        console.log(ex);
    }
}

async function onRTCAnswer(lobby, serverId, remoteClient, answer) {
    const server = lobby.localServers[serverId];

    if(!server) {
        return;
    }

    const client = server.clients[remoteClient];

    if(!client) {
        return;
    }

    await client.rtc.setRemoteDescription(answer);
}

async function onClientIce(lobby, serverId, remoteClient, ice) {
    const server = lobby.localServers[serverId];

    if(!server) {
        return;
    }

    const client = server.clients[remoteClient];

    if(!client) {
        return;
    }

    try {
        await client.rtc.addIceCandidate(ice);
    } catch(ex) {
        console.log(ex);
    }
}

function bootUpLANServer(server, port) {
    if(!server || !port) {
        return;
    }

    if(wacUtils) {
        wacUtils.ipcInvoke("createTCPServer", port).then(function(socketId) {
            server.tcpSocketId = socketId;

            const listenerName = "onWACTCPmessage" + socketId;

            wacUtils.setCustomListener(listenerName, function(e, data) {
                if(data && data.type == "message") {
                    const from = data.client || null;
                    const to = data.server || null;
                    const data = data.data || null;

                    if(to != server.tcpSocketId) {
                        return;
                    }

                    if(!from || !data) {
                        return;
                    }

                    let client = server.clients[from];

                    if(!client) {
                        client = new RemoteServer();
                        client.id = from;
                        client.lobby = server.lobby;
                        client.listener = server.listener;
                        client.tcpSocketId = server.tcpSocketId;
                        client.type = "tcp";
                        server.clients[from] = client;
                    }
                }
            });
        });
    }
}

export function getClientId() {
    return clientUid;
}

export default {
    GameLobby,
    getClientId
};