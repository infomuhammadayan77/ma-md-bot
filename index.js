const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const {
    Client,
    LocalAuth
} = require("whatsapp-web.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve index.html from public/
app.use(express.static(path.join(__dirname, "public")));

// Homepage
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        bot: "MA BOT",
        uptime: process.uptime()
    });
});

// ===============================
// BOT STATE
// ===============================

let botReady = false;
let botState = "STARTING";
let pairingInProgress = false;
let currentPairingCode = null;
let activeUsers = 0;

// ===============================
// WHATSAPP CLIENT
// ===============================

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "ma-bot"
    }),

    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-zygote",
            "--disable-extensions"
        ]
    }
});

// ===============================
// CLIENT EVENTS
// ===============================

client.on("loading_screen", (percent, message) => {
    console.log(`[WHATSAPP] Loading: ${percent}% - ${message}`);

    botState = `LOADING ${percent}%`;

    io.emit("bot-status", {
        state: botState,
        ready: false
    });
});

client.on("authenticated", () => {
    console.log("[WHATSAPP] Authenticated");

    botState = "AUTHENTICATED";

    io.emit("bot-status", {
        state: botState,
        ready: false
    });
});

client.on("auth_failure", (message) => {
    console.error("[WHATSAPP] Authentication failure:", message);

    botReady = false;
    botState = "AUTH_FAILURE";

    io.emit("bot-status", {
        state: botState,
        ready: false
    });
});

client.on("ready", () => {
    console.log("=================================");
    console.log("MA BOT IS READY");
    console.log("=================================");

    botReady = true;
    botState = "READY";
    pairingInProgress = false;
    currentPairingCode = null;

    io.emit("bot-status", {
        state: "READY",
        ready: true
    });

    io.emit("connection-status", {
        connected: true
    });
});

client.on("change_state", (state) => {
    console.log("[WHATSAPP STATE]", state);

    botState = state;

    io.emit("bot-status", {
        state,
        ready: botReady
    });
});

client.on("disconnected", (reason) => {
    console.log("[WHATSAPP] Disconnected:", reason);

    botReady = false;
    botState = "DISCONNECTED";
    pairingInProgress = false;
    currentPairingCode = null;

    io.emit("connection-status", {
        connected: false,
        reason
    });

    io.emit("bot-status", {
        state: botState,
        ready: false
    });
});

// ===============================
// SAFE BOT COMMANDS
// ===============================

client.on("message", async (message) => {
    try {
        const body = message.body.trim();
        const command = body.toLowerCase();

        // Ping
        if (command === ".ping") {
            await message.reply("Pong! MA BOT is online.");
        }

        // Uptime
        else if (command === ".uptime") {
            const seconds = Math.floor(process.uptime());

            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;

            await message.reply(
                `MA BOT Uptime\n\n` +
                `${days}d ${hours}h ${minutes}m ${secs}s`
            );
        }

        // Bot info
        else if (command === ".botinfo") {
            await message.reply(
                `MA BOT\n\n` +
                `Status: ${botReady ? "Online" : "Starting"}\n` +
                `Version: 1.0\n` +
                `Developer: MA Developers\n` +
                `Founder: Muhammad Ayan`
            );
        }

        // Help
        else if (command === ".help" || command === ".menu") {
            await message.reply(
                `MA BOT COMMANDS\n\n` +
                `.ping - Check bot response\n` +
                `.uptime - Show bot uptime\n` +
                `.botinfo - Show bot information\n` +
                `.time - Show current time\n` +
                `.date - Show current date\n` +
                `.calc 10+5 - Calculator\n` +
                `.joke - Random joke\n` +
                `.fact - Random fact\n` +
                `.groupinfo - Group information`
            );
        }

        // Time
        else if (command === ".time") {
            await message.reply(
                `Current time: ${new Date().toLocaleTimeString()}`
            );
        }

        // Date
        else if (command === ".date") {
            await message.reply(
                `Current date: ${new Date().toLocaleDateString()}`
            );
        }

        // Calculator - basic arithmetic only
        else if (command.startsWith(".calc ")) {
            const expression = body
                .slice(6)
                .trim();

            if (!/^[0-9+\-*/().%\s]+$/.test(expression)) {
                await message.reply(
                    "Only basic arithmetic is supported."
                );
                return;
            }

            try {
                const result = Function(
                    `"use strict"; return (${expression})`
                )();

                if (!Number.isFinite(result)) {
                    throw new Error("Invalid result");
                }

                await message.reply(`Result: ${result}`);
            } catch {
                await message.reply("Invalid calculation.");
            }
        }

        // Joke
        else if (command === ".joke") {
            const jokes = [
                "Why did the developer go broke? Because he used up all his cache.",
                "Why do programmers prefer dark mode? Because light attracts bugs.",
                "A SQL query walks into a bar and asks: Can I join you?"
            ];

            const joke =
                jokes[Math.floor(Math.random() * jokes.length)];

            await message.reply(joke);
        }

        // Fact
        else if (command === ".fact") {
            const facts = [
                "JavaScript was created in 1995.",
                "HTML is a markup language, not a programming language.",
                "The first website went live in 1991."
            ];

            const fact =
                facts[Math.floor(Math.random() * facts.length)];

            await message.reply(fact);
        }

        // Group info
        else if (command === ".groupinfo") {
            if (!message.from.endsWith("@g.us")) {
                await message.reply(
                    "This command can only be used inside a group."
                );
                return;
            }

            const chat = await message.getChat();

            await message.reply(
                `GROUP INFO\n\n` +
                `Name: ${chat.name}\n` +
                `Members: ${chat.participants.length}`
            );
        }

    } catch (error) {
        console.error("[COMMAND ERROR]", error);
    }
});

// ===============================
// SOCKET.IO
// ===============================

io.on("connection", (socket) => {
    activeUsers++;

    console.log(
        `[SOCKET] Connected: ${socket.id}`
    );

    socket.emit("bot-status", {
        state: botState,
        ready: botReady
    });

    socket.emit("connection-status", {
        connected: botReady
    });

    io.emit("total-active", activeUsers);

    socket.on("disconnect", () => {
        activeUsers = Math.max(0, activeUsers - 1);

        console.log(
            `[SOCKET] Disconnected: ${socket.id}`
        );

        io.emit("total-active", activeUsers);
    });

    // ===============================
    // PAIRING REQUEST
    // ===============================

    socket.on("pair-request", async (data) => {
        try {
            if (!data || !data.number) {
                socket.emit(
                    "pair-error",
                    "Phone number is required."
                );
                return;
            }

            if (botReady) {
                socket.emit(
                    "pair-error",
                    "This bot is already connected."
                );
                return;
            }

            if (pairingInProgress) {
                socket.emit(
                    "pair-error",
                    "A pairing request is already in progress. Please wait."
                );
                return;
            }

            let number = String(data.number)
                .replace(/\D/g, "");

            // Basic international-number validation
            if (number.length < 10 || number.length > 15) {
                socket.emit(
                    "pair-error",
                    "Enter a valid international WhatsApp number."
                );
                return;
            }

            pairingInProgress = true;

            socket.emit(
                "pair-status",
                "Starting WhatsApp pairing..."
            );

            console.log(
                `[PAIRING] Request received for number ending ${number.slice(-4)}`
            );

            // Make sure the WhatsApp client has initialized
            if (
                !client.pupPage ||
                !client.pupPage.url()
            ) {
                socket.emit(
                    "pair-status",
                    "Waiting for WhatsApp Web to initialize..."
                );

                // Wait up to 30 seconds
                const start = Date.now();

                while (
                    (!client.pupPage ||
                        !client.pupPage.url()) &&
                    Date.now() - start < 30000
                ) {
                    await new Promise(resolve =>
                        setTimeout(resolve, 1000)
                    );
                }
            }

            if (!client.pupPage) {
                pairingInProgress = false;

                socket.emit(
                    "pair-error",
                    "WhatsApp Web has not finished starting yet. Wait a few seconds and try again."
                );

                return;
            }

            socket.emit(
                "pair-status",
                "Generating pairing code..."
            );

            const code =
                await client.requestPairingCode(
                    number,
                    true,
                    180000
                );

            currentPairingCode = code;

            console.log(
                "[PAIRING] Pairing code generated"
            );

            socket.emit(
                "pairing-code",
                code
            );

            socket.emit(
                "pair-status",
                "Pairing code generated. Enter it in WhatsApp > Linked Devices."
            );

            // Keep the request unlocked after code generation.
            pairingInProgress = false;

        } catch (error) {
            pairingInProgress = false;

            console.error(
                "[PAIRING ERROR]",
                error
            );

            socket.emit(
                "pair-error",
                "Could not generate pairing code. Check the Railway logs."
            );
        }
    });

    // Request current status
    socket.on("get-status", () => {
        socket.emit("bot-status", {
            state: botState,
            ready: botReady
        });

        socket.emit("connection-status", {
            connected: botReady
        });
    });
});

// ===============================
// START SERVER
// ===============================

server.listen(PORT, "0.0.0.0", () => {
    console.log("=================================");
    console.log(`MA BOT server running on port ${PORT}`);
    console.log(`http://0.0.0.0:${PORT}`);
    console.log("=================================");
});

// ===============================
// START WHATSAPP
// ===============================

console.log("[START] Starting WhatsApp client...");

client.initialize().catch((error) => {
    console.error(
        "[START ERROR]",
        error
    );
});
