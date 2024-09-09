const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});

admin.initializeApp();
const db = admin.database();

const MAX_PLAYERS = 8;
const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

exports.webRTCSignaling = functions.https.onRequest(async (request, response) => {
    return cors(request, response, async () => {
        console.log('Received request:', request.method, request.body, request.query);

        let action, roomId, playerId, targetId, data;

        if (request.method === 'GET' && request.query.action) {
            ({ action, roomId, playerId } = request.query);
        } else {
            ({ action, roomId, playerId, targetId, data } = request.body);
        }

        try {
            let result;
            switch (action) {
                case 'create_room':
                    result = await createRoom(roomId, playerId);
                    break;
                case 'join_room':
                    result = await joinRoom(roomId, playerId);
                    break;
                case 'poll_notifications':
                    result = await pollNotifications(roomId, playerId);
                    break;
                case 'leave_room':
                    result = await leaveRoom(roomId, playerId);
                    break;
                case 'offer':
                    result = await sendOffer(roomId, playerId, targetId, data);
                    break;
                case 'answer':
                    result = await sendAnswer(roomId, playerId, targetId, data);
                    break;
                case 'ice_candidates':
                    result = await sendIceCandidates(roomId, playerId, targetId, data);
                    break;
                default:
                    throw new Error('Invalid action: ' + action);
            }
            console.log('Operation result:', result);
            response.json({ success: true, ...result });
        } catch (error) {
            console.error('Error:', error);
            response.status(400).json({ success: false, message: error.message });
        }
    });
});

async function createRoom(roomId, hostId) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    if (roomSnapshot.exists()) {
        throw new Error('Room already exists');
    }
    await roomRef.set({
        host: hostId,
        players: {[hostId]: true},
        createdAt: admin.database.ServerValue.TIMESTAMP
    });
    return { message: 'Room created', roomId };
}

async function joinRoom(roomId, playerId) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    const roomData = roomSnapshot.val();
    if (!roomData) {
        throw new Error('Room not found');
    }
    if (Object.keys(roomData.players || {}).length >= MAX_PLAYERS) {
        throw new Error('Room is full');
    }
    await roomRef.child('players').update({[playerId]: true});

    // Notify only the host about the new player
    await addNotification(roomId, roomData.host, {
        type: 'new_player',
        playerId: playerId
    });

    return { message: 'Joined room', hostId: roomData.host, roomId };
}

async function leaveRoom(roomId, playerId) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    const roomData = roomSnapshot.val();

    if (!roomData) {
        throw new Error('Room not found');
    }

    await roomRef.child('players').child(playerId).remove();

    const updatedPlayersSnapshot = await roomRef.child('players').once('value');
    const updatedPlayers = updatedPlayersSnapshot.val();

    if (!updatedPlayers) {
        await roomRef.remove();
        return { message: 'Room closed (last player left)' };
    }

    // If the host left, assign a new host
    if (playerId === roomData.host) {
        const newHost = Object.keys(updatedPlayers)[0];
        await roomRef.update({ host: newHost });
    }

    // Notify remaining players about the player who left
    for (let remainingPlayerId in updatedPlayers) {
        await addNotification(roomId, remainingPlayerId, {
            type: 'player_left',
            playerId: playerId
        });
    }

    return { message: 'Left room' };
}

async function sendOffer(roomId, senderId, targetId, offer) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    const roomData = roomSnapshot.val();

    if (!roomData) {
        throw new Error('Room not found');
    }

    // Ensure the offer is from the host to a client or from a client to the host
    if (senderId !== roomData.host && targetId !== roomData.host) {
        throw new Error('Invalid offer direction');
    }

    await roomRef.child(`offers/${senderId}`).set(offer);

    // Notify the target about the new offer
    await addNotification(roomId, targetId, {
        type: 'offer',
        from: senderId,
        offer: offer
    });

    return { message: 'Offer sent' };
}

async function sendAnswer(roomId, senderId, targetId, answer) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    const roomData = roomSnapshot.val();

    if (!roomData) {
        throw new Error('Room not found');
    }

    await roomRef.child(`answers/${senderId}`).set(answer);

    // Notify the target about the new answer
    await addNotification(roomId, targetId, {
        type: 'answer',
        from: senderId,
        answer: answer
    });

    return { message: 'Answer sent' };
}

async function sendIceCandidates(roomId, senderId, targetId, candidates) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.once('value');
    if (!roomSnapshot.exists()) {
        throw new Error('Room not found');
    }

    const updates = {};
    candidates.forEach((candidate, index) => {
        updates[`ice_candidates/${senderId}/candidate_${Date.now()}_${index}`] = candidate;
    });

    await roomRef.update(updates);

    // Notify the target about the new ICE candidates
    await addNotification(roomId, targetId, {
        type: 'new_ice_candidates',
        from: senderId,
        candidates: candidates
    });

    return { message: 'ICE candidates sent' };
}

async function pollNotifications(roomId, playerId) {
    const notificationsRef = db.ref(`rooms/${roomId}/notifications/${playerId}`);
    const snapshot = await notificationsRef.once('value');
    const notifications = snapshot.val() || {};

    // Clear the notifications after reading them
    await notificationsRef.remove();

    console.log(`Polling notifications for room ${roomId}, player ${playerId}:`, notifications);

    return { notifications: Object.values(notifications) };
}

async function addNotification(roomId, playerId, notification) {
    await db.ref(`rooms/${roomId}/notifications/${playerId}`).push(notification);
}

// Cleanup inactive rooms
exports.cleanupInactiveRooms = functions.pubsub.schedule('every 24 hours').onRun(async (context) => {
    const roomsRef = db.ref('rooms');
    const now = Date.now();
    const cutoff = now - ROOM_TIMEOUT;

    const snapshot = await roomsRef.once('value');
    const rooms = snapshot.val();

    for (let roomId in rooms) {
        if (rooms[roomId].createdAt < cutoff) {
            await roomsRef.child(roomId).remove();
            console.log(`Removed inactive room: ${roomId}`);
        }
    }

    return null;
});