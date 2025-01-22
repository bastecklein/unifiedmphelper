import commonHelpers from "common-helpers";
import { io } from "socket.io-client";

const RTC_CHUNK_SIZE = 16000;

const SECOND = 1000;
const MINUTE = SECOND * 60;

const QUEUE_THRESH = 2024;

const USE_ICE_SERVERS = [
    {urls: "stun:stun.l.google.com:19302"},
    {urls: "stun:stun.stunprotocol.org:3478"},
    {urls: "stun:stun1.l.google.com:19302"},
    {urls: "stun:stun2.l.google.com:19302"},
    {urls: "stun:stun3.l.google.com:19302"},
    {urls: "stun:stun4.l.google.com:19302"}
];

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

export function GameLobby(options) {
    this.id = commonHelpers.guid();

    this.name = null;
    this.listener = null;
    this.signalingServer = null;

    this.socket = null;

    this.connected = false;
    this.wasClosed = false;

    this.refresh = refreshLobby;
    this.postCustomData = postCustomLobbyData;
    this.createServer = createServer;
    this.joinServer = joinServer;
    this.close = closeLobby;
    this.connect = bootUpLobby;

    this.remoteServers = {};
    this.localServers = {};

    this.gameTimeoutChecker = null;

    if(options) {
        if(options.name) {
            this.name = options.name;
        }

        if(options.listener) {
            this.listener = options.listener;
        }

        if(options.signalingServer) {
            this.signalingServer = options.signalingServer;
        }
    }

    if(this.name && this.listener && this.signalingServer) {
        this.connect();
    }
}

function LocalServer() {
    this.id = commonHelpers.guid();

    this.isLocal = true;

    this.close = closeLocalServer;
    this.updateExtras = updateServerExtras;
    this.sendMessage = sendMessage;
    this.pingAll = pingAll;
    this.approveJoin = approveJoin;

    this.active = true;

    // local server is always connected to itself
    this.connected = true;

    this.listener = null;
    this.extras = null;
    this.lobby = null;

    this.clients = {};

    this.pendingMessages = {};

    const server = this;
    
    setTimeout(function() {
        server.pingAll();
    }, 4000);
}

function RemoteServer() {
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

    this.client = null;
    this.dataChannel = null;
    this.queue = [];

    this.ping = pingServer;
    this.connect = connectToServer;
    this.sendMessage = sendMessage;
    this.close = closeRemoteServer;

    this.pendingMessages = {};
}

function bootUpLobby() {
    const lobby = this;

    if(lobby.connected) {
        return;
    }

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

function refreshLobby(withReping = false) {
    const lobby = this;

    if(!lobby || !lobby.socket || !lobby.connected) {
        return;
    }

    postLobbyMessage(lobby, {
        m: "roomAnnounce"
    });

    if(withReping) {
        setTimeout(lobby.refresh, 6000);
    }
    
}

function postCustomLobbyData(data) {
    const lobby = this;

    if(!lobby || !lobby.socket) {
        return;
    }

    postLobbyMessage(lobby, {
        m: "customLobbyData",
        d: data,
        r: lobby.id
    });
}

function createServer(listener, useId) {
    const lobby = this;

    if(!lobby) {
        return;
    }

    const server = new LocalServer();
    server.lobby = lobby;

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

function closeRemoteServer() {
    const server = this;

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

function closeLocalServer() {
    const server = this;

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

    delete server.lobby.localServers[server.id];

    server.active = false;
    server.listener = null;
    server.clients = {};
}

function joinServer(id, listener) {
    const lobby = this;

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

function closeLobby() {
    const lobby = this;

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

function updateServerExtras(extras) {
    const server = this;

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

function sendMessage(message, to = null) {
    const server = this;

    if(!server || !server.connected) {
        return;
    }

    let sendData = null;

    try {
        sendData = encodeLanSocketPacket(message);
    } catch(ex) {
        console.log(ex);
        return;
    }

    const chunks = commonHelpers.chunkString(sendData, RTC_CHUNK_SIZE);

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
    if(client.dataChannel.bufferedAmount > QUEUE_THRESH || !client.queue || client.queue.length == 0) {
        return;
    }

    const nextMsg = client.queue.shift();

    client.dataChannel.send(nextMsg);

    processQueueItem(client);
}

function pingAll() {
        
    const server = this;

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
    }, 4000);
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

function approveJoin(remoteId) {
    const server = this;

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

function pingServer() {
    const server = this;

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

function connectToServer(listener) {
        
    const server = this;

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
        queue: []
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

function onMessageFromRtc(server, from, message) {
    if(!server || !server.listener) {
        return;
    }

    let fullIncomingMessage = null;

    if(message.indexOf(":#:") == 0) {
        server.pendingMessages[from] = message;
    } else {
        server.pendingMessages[from] += message;
    }

    if(!message.endsWith("#:#")) {
        return;
    }

    fullIncomingMessage = server.pendingMessages[from];

    if(!fullIncomingMessage) {
        return;
    }

    const decodedObj = decodeLanSocketPacket(fullIncomingMessage);

    if(decodedObj) {
        handleDecodedMessage(server, from, decodedObj);
    }
    
}

function decodeLanSocketPacket(packet) {

    const cleaned = packet.substring(3,packet.length - 3);

    try {
        const obj = JSON.parse(cleaned);
        return obj;
    } catch(ex) {
        return null;
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

function encodeLanSocketPacket(dataObj) {
    const str = JSON.stringify(dataObj);
    return ":#:" + str + "#:#";
}

export function getClientId() {
    return clientUid;
}

export default {
    GameLobby,
    getClientId
};