require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');

const P = require('pino');

// =================== SETTINGS ===================
const settings = require('./settings');

// =================== EXPRESS SETUP ===================
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard/static files
app.use(express.static(__dirname));

// Socket.IO automatically serves:
// /socket.io/socket.io.js

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/status', (req, res) => {
    const activeSessions = Object.values(sessions)
        .filter(session => session.isConnected)
        .length;

    res.json({
        status: 'online',
        version: settings.version,
        activeBots: activeSessions,
        uptime: process.uptime()
    });
});

// =================== DATA STORAGE ===================

const AUTH_DIR = path.join(__dirname, 'auth_info');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bot_data.json');

fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync(DATA_DIR);

let botData = {
    antilinkGroups: {},
    totalBots: 0,
    registeredBots: [],
    statusSettings: {},
    antiDelete: {},
    userNames: {},
    antiCall: {},
    broadcastHistory: []
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = fs.readJsonSync(DATA_FILE);

        botData = {
            ...botData,
            ...savedData
        };
    } catch (error) {
        console.log('[DATA] Could not read bot_data.json');
    }
}

function saveBotData() {
    try {
        fs.writeJsonSync(DATA_FILE, botData, {
            spaces: 2
        });
    } catch (error) {
        console.error('[DATA] Save error:', error.message);
    }
}

// =================== GLOBAL STATE ===================

const sessions = {};
const userSockets = {};
const messageLogs = {};

// =================== FORMATTING ===================

const bold = text => `*${text}*`;
const italic = text => `_${text}_`;
const mono = text => `\`${text}\``;

// =================== BOT SESSION CLASS ===================

class BotSession {

    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.aiEnabled = false;
        this.isPublic = true;

        this.authPath = path.join(AUTH_DIR, userId);

        this.processedMessages = new Set();

        this.phoneNumber = null;
        this.tgChatId = null;
        this.initializing = false;
    }

    // =================== LOGGING ===================

    sendLog(message, type = 'info') {

        const logEntry = {
            timestamp: new Date().toLocaleTimeString(),
            message,
            type
        };

        const socketId = userSockets[this.userId];

        if (socketId) {
            io.to(socketId).emit('console', logEntry);
        }

        console.log(`[${this.userId}] ${message}`);
    }

    // =================== STATUS ===================

    sendConnectionStatus() {

        const socketId = userSockets[this.userId];

        if (socketId) {

            io.to(socketId).emit('connection-status', {
                connected: this.isConnected,
                user: this.userId,
                phoneNumber: this.phoneNumber
            });
        }

        io.emit(
            'total-active',
            Object.values(sessions)
                .filter(session => session.isConnected)
                .length
        );
    }

    // =================== AI ===================

    async getAIResponse(userMessage) {

        try {

            const apiUrl =
                `https://api.siputzx.my.id/api/ai/chatgpt?text=${encodeURIComponent(userMessage)}`;

            const response = await axios.get(apiUrl, {
                timeout: 30000
            });

            if (response.data && response.data.data) {
                return response.data.data;
            }

            return 'I am here to help! What would you like to know?';

        } catch (error) {

            console.error('[AI ERROR]', error.message);

            return 'Sorry, AI service is currently unavailable.';
        }
    }

    // =================== INITIALIZE ===================

    async initialize(pairingNumber = null) {

        if (this.initializing) {
            return;
        }

        this.initializing = true;

        try {

            await fs.ensureDir(this.authPath);

            const { version } = await fetchLatestBaileysVersion();

            const {
                state,
                saveCreds
            } = await useMultiFileAuthState(this.authPath);

            this.sock = makeWASocket({

                version,

                auth: {
                    creds: state.creds,

                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        P({
                            level: 'fatal'
                        })
                    )
                },

                printQRInTerminal: false,

                logger: P({
                    level: 'fatal'
                }),

                browser: Browsers.ubuntu('Chrome'),

                syncFullHistory: false,

                markOnlineOnConnect: true,

                connectTimeoutMs: 60000,

                defaultQueryTimeoutMs: 60000
            });

            this.sock.ev.on(
                'creds.update',
                saveCreds
            );

            // =================== PAIRING CODE ===================

            if (
                pairingNumber &&
                !state.creds.registered
            ) {

                await delay(3000);

                try {

                    let code =
                        await this.sock.requestPairingCode(
                            pairingNumber
                        );

                    if (code) {

                        code =
                            code
                                .match(/.{1,4}/g)
                                ?.join('-') || code;
                    }

                    this.sendLog(
                        `Pairing Code: ${code}`,
                        'success'
                    );

                    const socketId =
                        userSockets[this.userId];

                    if (socketId) {

                        io.to(socketId).emit(
                            'pairing-code',
                            code
                        );
                    }

                } catch (error) {

                    this.sendLog(
                        `Pairing error: ${error.message}`,
                        'error'
                    );
                }
            }

            // =================== CONNECTION ===================

            this.sock.ev.on(
                'connection.update',
                async update => {

                    const {
                        connection,
                        lastDisconnect,
                        qr
                    } = update;

                    // QR
                    if (qr) {

                        const socketId =
                            userSockets[this.userId];

                        if (socketId) {

                            io.to(socketId).emit(
                                'qr',
                                qr
                            );
                        }
                    }

                    // CONNECTION CLOSED
                    if (connection === 'close') {

                        this.isConnected = false;

                        const statusCode =
                            lastDisconnect?.error
                                ?.output
                                ?.statusCode;

                        const shouldReconnect =
                            statusCode !==
                            DisconnectReason.loggedOut;

                        this.sendLog(
                            `Connection closed. Reconnecting: ${shouldReconnect}`,
                            'warning'
                        );

                        this.sendConnectionStatus();

                        if (
                            statusCode ===
                                DisconnectReason.loggedOut ||
                            statusCode === 401
                        ) {

                            this.sendLog(
                                'Session logged out.',
                                'error'
                            );

                            delete sessions[this.userId];

                            this.sendConnectionStatus();

                        } else {

                            setTimeout(() => {

                                this.initialize()
                                    .catch(error => {

                                        console.error(
                                            `[${this.userId}] Reconnect error:`,
                                            error.message
                                        );
                                    });

                            }, 5000);
                        }
                    }

                    // CONNECTION OPEN
                    else if (connection === 'open') {

                        this.isConnected = true;

                        this.sendLog(
                            'Connected successfully!',
                            'success'
                        );

                        this.sendConnectionStatus();

                        if (this.sock.user) {

                            const botNumber =
                                jidNormalizedUser(
                                    this.sock.user.id
                                );

                            const botNumberClean =
                                botNumber.split('@')[0];

                            this.phoneNumber =
                                botNumberClean;

                            const welcomeText =
                                bold('MA BOT') +
                                '\n\n' +

                                bold('CONNECTED SUCCESSFULLY') +
                                '\n\n' +

                                bold('Bot Information:') +
                                '\n' +

                                italic('Bot Name:') +
                                ' MA BOT\n' +

                                italic('Developer:') +
                                ' MA Developers\n' +

                                italic('Founder:') +
                                ' Muhammad Ayan\n' +

                                italic('Version:') +
                                ` ${settings.version}\n` +

                                italic('Status:') +
                                ' 24/7 Active\n\n' +

                                'Type ' +
                                mono('.menu') +
                                ' to explore all features.\n\n' +

                                bold(
                                    '© MA Developers | Muhammad Ayan'
                                );

                            try {

                                if (settings.startimage) {

                                    await this.sock.sendMessage(
                                        botNumber,
                                        {
                                            image: {
                                                url: settings.startimage
                                            },
                                            caption: welcomeText
                                        }
                                    );

                                } else {

                                    await this.sock.sendMessage(
                                        botNumber,
                                        {
                                            text: welcomeText
                                        }
                                    );
                                }

                            } catch (error) {

                                console.error(
                                    '[WELCOME ERROR]',
                                    error.message
                                );
                            }
                        }
                    }
                }
            );

            // =================== MESSAGES ===================

            this.sock.ev.on(
                'messages.upsert',
                async m => {

                    if (m.type !== 'notify') {
                        return;
                    }

                    for (const msg of m.messages) {

                        try {

                            const from =
                                msg.key.remoteJid;

                            if (!from) {
                                continue;
                            }

                            const isMe =
                                msg.key.fromMe;

                            const isGroup =
                                from.endsWith('@g.us');

                            const isStatus =
                                from ===
                                'status@broadcast';

                            if (isStatus) {
                                continue;
                            }

                            const messageContent =
                                msg.message
                                    ?.ephemeralMessage
                                    ?.message ||

                                msg.message
                                    ?.viewOnceMessage
                                    ?.message ||

                                msg.message
                                    ?.viewOnceMessageV2
                                    ?.message ||

                                msg.message;

                            if (!messageContent) {
                                continue;
                            }

                            const text =
                                (
                                    messageContent.conversation ||

                                    messageContent
                                        .extendedTextMessage
                                        ?.text ||

                                    messageContent
                                        .imageMessage
                                        ?.caption ||

                                    messageContent
                                        .videoMessage
                                        ?.caption ||

                                    ''
                                ).trim();

                            if (!text) {
                                continue;
                            }

                            const msgId =
                                msg.key.id;

                            if (!msgId) {
                                continue;
                            }

                            if (
                                this.processedMessages
                                    .has(msgId)
                            ) {
                                continue;
                            }

                            this.processedMessages
                                .add(msgId);

                            if (
                                this.processedMessages
                                    .size > 1000
                            ) {

                                const first =
                                    this.processedMessages
                                        .values()
                                        .next()
                                        .value;

                                this.processedMessages
                                    .delete(first);
                            }

                            // ================= COMMAND =================

                            if (
                                !text
                                    .toLowerCase()
                                    .startsWith('.')
                            ) {
                                continue;
                            }

                            const args =
                                text
                                    .trim()
                                    .split(/\s+/)
                                    .slice(1);

                            const q =
                                args.join(' ');

                            const commandName =
                                text
                                    .trim()
                                    .slice(1)
                                    .split(/\s+/)[0]
                                    .toLowerCase();

                            const botNumber =
                                jidNormalizedUser(
                                    this.sock.user.id
                                );

                            const botNumberClean =
                                botNumber.split('@')[0];

                            const sender =
                                msg.key.participant ||
                                from;

                            const senderClean =
                                sender.split('@')[0];

                            const ownerNumbers =
                                String(
                                    settings.ownerNumber || ''
                                )
                                    .split(',')
                                    .map(n =>
                                        n.replace(/\D/g, '')
                                    )
                                    .filter(Boolean);

                            const isOwner =
                                isMe ||
                                ownerNumbers.includes(
                                    senderClean
                                ) ||
                                senderClean ===
                                    botNumberClean;

                            // ================= COMMAND SWITCH =================

                            switch (commandName) {

                                // ================= MENU =================

                                case 'menu': {

                                    const menuText =

                                        bold('MA BOT MENU') +
                                        '\n\n' +

                                        bold('SYSTEM COMMANDS:') +
                                        '\n' +

                                        mono('.ping') +
                                        ' - Check bot response\n' +

                                        mono('.uptime') +
                                        ' - Show uptime\n' +

                                        mono('.stats') +
                                        ' - Show bot stats\n\n' +

                                        bold('AI COMMAND:') +
                                        '\n' +

                                        mono('.ai <message>') +
                                        ' - AI assistant\n\n' +

                                        bold('TOOLS COMMANDS:') +
                                        '\n' +

                                        mono('.calc 2+2') +
                                        ' - Calculator\n' +

                                        mono('.shorturl URL') +
                                        ' - Shorten URL\n\n' +

                                        bold('FUN COMMANDS:') +
                                        '\n' +

                                        mono('.joke') +
                                        ' - Random joke\n' +

                                        mono('.fact') +
                                        ' - Random fact\n' +

                                        mono('.quote') +
                                        ' - Random quote\n\n' +

                                        bold('GROUP COMMANDS:') +
                                        '\n' +

                                        mono('.groupinfo') +
                                        ' - Group information\n' +

                                        mono('.tagall') +
                                        ' - Tag group members\n\n' +

                                        bold('© MA Developers');

                                    try {

                                        if (
                                            settings.startimage
                                        ) {

                                            await this.sock
                                                .sendMessage(
                                                    from,
                                                    {
                                                        image: {
                                                            url:
                                                                settings.startimage
                                                        },
                                                        caption:
                                                            menuText
                                                    },
                                                    {
                                                        quoted: msg
                                                    }
                                                );

                                        } else {

                                            await this.sock
                                                .sendMessage(
                                                    from,
                                                    {
                                                        text:
                                                            menuText
                                                    },
                                                    {
                                                        quoted: msg
                                                    }
                                                );
                                        }

                                    } catch (error) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        menuText
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );
                                    }

                                    break;
                                }

                                // ================= PING =================

                                case 'ping': {

                                    const start =
                                        Date.now();

                                    const responseTime =
                                        Date.now() -
                                        start;

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold('Pong!') +
                                                    '\n\n' +

                                                    italic(
                                                        'Response time:'
                                                    ) +
                                                    ` ${responseTime}ms`
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= UPTIME =================

                                case 'uptime': {

                                    const uptime =
                                        process.uptime();

                                    const days =
                                        Math.floor(
                                            uptime / 86400
                                        );

                                    const hours =
                                        Math.floor(
                                            (uptime % 86400) /
                                            3600
                                        );

                                    const minutes =
                                        Math.floor(
                                            (uptime % 3600) /
                                            60
                                        );

                                    const seconds =
                                        Math.floor(
                                            uptime % 60
                                        );

                                    const uptimeText =

                                        bold(
                                            'MA BOT UPTIME'
                                        ) +
                                        '\n\n' +

                                        italic('Days:') +
                                        ` ${days}\n` +

                                        italic('Hours:') +
                                        ` ${hours}\n` +

                                        italic('Minutes:') +
                                        ` ${minutes}\n` +

                                        italic('Seconds:') +
                                        ` ${seconds}\n\n` +

                                        bold(
                                            '© MA Developers'
                                        );

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    uptimeText
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= STATS =================

                                case 'stats': {

                                    const activeBots =
                                        Object.values(
                                            sessions
                                        )
                                            .filter(
                                                s =>
                                                    s.isConnected
                                            )
                                            .length;

                                    const statsText =

                                        bold(
                                            'MA BOT STATS'
                                        ) +
                                        '\n\n' +

                                        italic(
                                            'Version:'
                                        ) +
                                        ` ${settings.version}\n` +

                                        italic(
                                            'Active Bots:'
                                        ) +
                                        ` ${activeBots}\n` +

                                        italic(
                                            'Current Bot:'
                                        ) +
                                        ` ${this.phoneNumber || 'Unknown'}\n\n` +

                                        bold(
                                            '© MA Developers'
                                        );

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    statsText
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= AI =================

                                case 'ai': {

                                    if (!q) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Please provide a message!'
                                                        ) +
                                                        '\n\n' +

                                                        italic(
                                                            'Example:'
                                                        ) +
                                                        ' ' +

                                                        mono(
                                                            '.ai Hello'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    const aiResponse =
                                        await this
                                            .getAIResponse(q);

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    aiResponse
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= JOKE =================

                                case 'joke': {

                                    const jokes = [

                                        'Why do programmers prefer dark mode? Because light attracts bugs!',

                                        'Why did the developer go broke? Because he used up all his cache!',

                                        'Why did the computer go to the doctor? It caught a virus!',

                                        'There are only 10 kinds of people: those who understand binary and those who do not.'
                                    ];

                                    const randomJoke =
                                        jokes[
                                            Math.floor(
                                                Math.random() *
                                                jokes.length
                                            )
                                        ];

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold(
                                                        "Here's a joke:"
                                                    ) +
                                                    '\n\n' +
                                                    randomJoke
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= FACT =================

                                case 'fact': {

                                    const facts = [

                                        'Honey can remain preserved for a very long time when stored properly.',

                                        'The human brain contains billions of neurons.',

                                        'Octopuses have three hearts.',

                                        'A group of flamingos is called a flamboyance.'
                                    ];

                                    const randomFact =
                                        facts[
                                            Math.floor(
                                                Math.random() *
                                                facts.length
                                            )
                                        ];

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold(
                                                        'Did you know?'
                                                    ) +
                                                    '\n\n' +
                                                    randomFact
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= QUOTE =================

                                case 'quote': {

                                    const quotes = [

                                        'Great work comes from consistency and patience.',

                                        'Keep learning, keep building, keep improving.',

                                        'Small progress every day becomes a big result.'
                                    ];

                                    const randomQuote =
                                        quotes[
                                            Math.floor(
                                                Math.random() *
                                                quotes.length
                                            )
                                        ];

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold(
                                                        'Quote of the day:'
                                                    ) +
                                                    '\n\n' +
                                                    randomQuote
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= CALCULATOR =================

                                case 'calc': {

                                    if (!q) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Please provide a calculation!'
                                                        ) +
                                                        '\n\n' +

                                                        italic(
                                                            'Example:'
                                                        ) +
                                                        ' ' +

                                                        mono(
                                                            '.calc 2+2'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    // Only basic mathematical characters
                                    if (
                                        !/^[0-9+\-*/().%\s]+$/.test(
                                            q
                                        )
                                    ) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Invalid calculation!'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    try {

                                        const result =
                                            Function(
                                                `"use strict"; return (${q})`
                                            )();

                                        if (
                                            typeof result !==
                                                'number' ||
                                            !Number.isFinite(
                                                result
                                            )
                                        ) {
                                            throw new Error(
                                                'Invalid result'
                                            );
                                        }

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Result:'
                                                        ) +
                                                        ` ${result}`
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                    } catch (error) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Invalid calculation!'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );
                                    }

                                    break;
                                }

                                // ================= SHORT URL =================

                                case 'shorturl': {

                                    if (!q) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Please provide a URL!'
                                                        ) +
                                                        '\n\n' +

                                                        italic(
                                                            'Example:'
                                                        ) +
                                                        ' ' +

                                                        mono(
                                                            '.shorturl https://example.com'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    try {

                                        const response =
                                            await axios.get(
                                                `https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`,
                                                {
                                                    timeout: 15000
                                                }
                                            );

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Shortened URL:'
                                                        ) +
                                                        '\n' +
                                                        mono(
                                                            response.data
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                    } catch (error) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Failed to shorten URL!'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );
                                    }

                                    break;
                                }

                                // ================= GROUP INFO =================

                                case 'groupinfo': {

                                    if (!isGroup) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'This command can only be used in a group.'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    try {

                                        const metadata =
                                            await this.sock
                                                .groupMetadata(
                                                    from
                                                );

                                        const groupText =

                                            bold(
                                                'GROUP INFORMATION'
                                            ) +
                                            '\n\n' +

                                            italic(
                                                'Name:'
                                            ) +
                                            ` ${metadata.subject}\n` +

                                            italic(
                                                'Members:'
                                            ) +
                                            ` ${metadata.participants.length}\n\n` +

                                            bold(
                                                '© MA Developers'
                                            );

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        groupText
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                    } catch (error) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'Unable to get group information.'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );
                                    }

                                    break;
                                }

                                // ================= TAG ALL =================

                                case 'tagall': {

                                    if (!isGroup) {

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        bold(
                                                            'This command can only be used in a group.'
                                                        )
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                        break;
                                    }

                                    try {

                                        const metadata =
                                            await this.sock
                                                .groupMetadata(
                                                    from
                                                );

                                        const mentions =
                                            metadata
                                                .participants
                                                .map(
                                                    participant =>
                                                        participant.id
                                                );

                                        let tagText =
                                            bold(
                                                'GROUP MEMBERS'
                                            ) +
                                            '\n\n';

                                        for (
                                            const member
                                            of mentions
                                        ) {

                                            tagText +=
                                                `@${member.split('@')[0]} `;

                                        }

                                        await this.sock
                                            .sendMessage(
                                                from,
                                                {
                                                    text:
                                                        tagText,
                                                    mentions
                                                },
                                                {
                                                    quoted: msg
                                                }
                                            );

                                    } catch (error) {

                                        console.error(
                                            '[TAGALL ERROR]',
                                            error.message
                                        );
                                    }

                                    break;
                                }

                                // ================= UNSUPPORTED ATTACK COMMANDS =================

                                case 'crash':
                                case 'freeze':
                                case 'lag':
                                case 'bug':
                                case 'vibrate':
                                case 'tornado': {

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold(
                                                        'Command unavailable'
                                                    ) +
                                                    '\n\n' +
                                                    'This command does not perform attacks or disrupt another user/device.'
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }

                                // ================= UNKNOWN =================

                                default: {

                                    await this.sock
                                        .sendMessage(
                                            from,
                                            {
                                                text:
                                                    bold(
                                                        'Command not found!'
                                                    ) +
                                                    '\n\n' +

                                                    italic(
                                                        'Type'
                                                    ) +
                                                    ' ' +

                                                    mono(
                                                        '.menu'
                                                    ) +
                                                    ' ' +

                                                    italic(
                                                        'to see all commands.'
                                                    )
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    break;
                                }
                            }

                        } catch (error) {

                            console.error(
                                '[MESSAGE PROCESSING ERROR]',
                                error
                            );
                        }
                    }
                }
            );

        } catch (error) {

            this.initializing = false;

            this.sendLog(
                `Initialization failed: ${error.message}. Retrying in 10s...`,
                'error'
            );

            setTimeout(() => {

                this.initialize()
                    .catch(err => {

                        console.error(
                            `[${this.userId}] Retry error:`,
                            err.message
                        );
                    });

            }, 10000);

            return;
        }

        this.initializing = false;
    }
}

// =================== LOAD EXISTING SESSIONS ===================

async function loadExistingSessions() {

    try {

        const authDirs =
            await fs.readdir(AUTH_DIR);

        for (const userId of authDirs) {

            const authPath =
                path.join(
                    AUTH_DIR,
                    userId
                );

            const stats =
                await fs.stat(authPath);

            if (!stats.isDirectory()) {
                continue;
            }

            const credsFile =
                path.join(
                    authPath,
                    'creds.json'
                );

            if (
                fs.existsSync(credsFile)
            ) {

                console.log(
                    `[MA BOT] Found existing session: ${userId}`
                );

                if (!sessions[userId]) {

                    sessions[userId] =
                        new BotSession(userId);

                    sessions[userId]
                        .initialize()
                        .catch(error => {

                            console.error(
                                `Failed to initialize ${userId}:`,
                                error.message
                            );
                        });
                }
            }
        }

    } catch (error) {

        console.error(
            '[MA BOT] Session loading error:',
            error.message
        );
    }
}

// =================== SOCKET.IO ===================

io.on('connection', socket => {

    console.log(
        `[SOCKET] Connected: ${socket.id}`
    );

    // ================= SET USER =================

    socket.on(
        'set-user',
        userId => {

            if (!userId) {
                return;
            }

            userSockets[userId] =
                socket.id;

            if (!sessions[userId]) {

                sessions[userId] =
                    new BotSession(userId);
            }

            sessions[userId]
                .sendConnectionStatus();
        }
    );

    // ================= PAIR REQUEST =================

    socket.on(
        'pair-request',
        async ({ userId, number }) => {

            try {

                if (!userId || !number) {

                    socket.emit(
                        'console',
                        {
                            timestamp:
                                new Date()
                                    .toLocaleTimeString(),
                            message:
                                'User ID and number are required.',
                            type:
                                'error'
                        }
                    );

                    return;
                }

                if (!sessions[userId]) {

                    sessions[userId] =
                        new BotSession(userId);
                }

                userSockets[userId] =
                    socket.id;

                sessions[userId]
                    .tgChatId = null;

                await sessions[userId]
                    .initialize(number);

            } catch (error) {

                console.error(
                    '[PAIR REQUEST ERROR]',
                    error.message
                );

                socket.emit(
                    'console',
                    {
                        timestamp:
                            new Date()
                                .toLocaleTimeString(),
                        message:
                            `Pairing failed: ${error.message}`,
                        type:
                            'error'
                    }
                );
            }
        }
    );

    // ================= DISCONNECT =================

    socket.on(
        'disconnect',
        () => {

            console.log(
                `[SOCKET] Disconnected: ${socket.id}`
            );

            for (
                const [userId, socketId]
                of Object.entries(userSockets)
            ) {

                if (
                    socketId ===
                    socket.id
                ) {

                    delete userSockets[userId];

                    break;
                }
            }
        }
    );
});

// =================== START SERVER ===================

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    async () => {

        console.log(
            `MA BOT v${settings.version} Server running on port ${PORT}`
        );

        console.log(
            'MA Developers | Muhammad Ayan'
        );

        console.log(
            `Health: /health`
        );

        await loadExistingSessions();
    }
);
