const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {
    Client,
    LocalAuth
} = require("whatsapp-web.js");

const path = require("path");
const os = require("os");

const settings = require("./settings");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || settings.port;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| DASHBOARD
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        bot: settings.botName,
        uptime: process.uptime()
    });
});

/*
|--------------------------------------------------------------------------
| BOT STATE
|--------------------------------------------------------------------------
*/

let botStatus = "starting";
let connected = false;
let currentPairingCode = null;

const connectedUsers = new Map();

const startTime = Date.now();

/*
|--------------------------------------------------------------------------
| WHATSAPP CLIENT
|--------------------------------------------------------------------------
*/

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
            "--single-process"
        ]
    }
});

/*
|--------------------------------------------------------------------------
| CLIENT EVENTS
|--------------------------------------------------------------------------
*/

client.on("loading_screen", (percent, message) => {
    console.log(`Loading: ${percent}% - ${message}`);

    botStatus = `loading-${percent}`;

    io.emit("bot-status", {
        status: botStatus,
        percent,
        message
    });
});

client.on("authenticated", () => {
    console.log("WhatsApp authenticated.");

    botStatus = "authenticated";

    io.emit("bot-status", {
        status: botStatus
    });
});

client.on("auth_failure", (message) => {
    console.error("Authentication failure:", message);

    botStatus = "auth-failure";
    connected = false;

    io.emit("bot-status", {
        status: botStatus,
        message: "Authentication failed."
    });
});

client.on("ready", () => {
    console.log("=================================");
    console.log("       MA BOT IS READY");
    console.log("=================================");

    botStatus = "ready";
    connected = true;

    io.emit("connection-status", {
        connected: true,
        status: "ready"
    });
});

client.on("disconnected", (reason) => {
    console.log("WhatsApp disconnected:", reason);

    botStatus = "disconnected";
    connected = false;

    io.emit("connection-status", {
        connected: false,
        status: "disconnected",
        reason
    });
});

/*
|--------------------------------------------------------------------------
| PAIRING CODE
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
    console.log("Dashboard connected:", socket.id);

    socket.emit("bot-status", {
        status: botStatus,
        connected
    });

    socket.emit("connection-status", {
        connected,
        status: botStatus
    });

    socket.on("set-user", (userId) => {
        if (!userId) return;

        connectedUsers.set(socket.id, {
            userId,
            socketId: socket.id
        });

        io.emit(
            "total-active",
            connectedUsers.size
        );
    });

    socket.on("pair-request", async (data) => {
        try {
            if (!data || !data.number) {
                socket.emit(
                    "pair-error",
                    "WhatsApp number is required."
                );
                return;
            }

            let number = String(data.number)
                .replace(/\D/g, "");

            /*
             * WhatsApp international format.
             * Example:
             * Pakistan: 923001234567
             */

            if (number.length < 10) {
                socket.emit(
                    "pair-error",
                    "Please enter a valid international WhatsApp number."
                );
                return;
            }

            console.log(
                "Pairing request:",
                number
            );

            /*
             * If already connected, no new pairing code
             * is required.
             */

            if (connected) {
                socket.emit(
                    "pair-error",
                    "A WhatsApp session is already connected."
                );

                return;
            }

            /*
             * requestPairingCode() must be available
             * in the installed whatsapp-web.js version.
             */

            if (
                typeof client.requestPairingCode !==
                "function"
            ) {
                socket.emit(
                    "pair-error",
                    "Pairing code is not supported by the installed whatsapp-web.js version."
                );

                return;
            }

            socket.emit(
                "pair-status",
                "Generating pairing code..."
            );

            const code =
                await client.requestPairingCode(
                    number
                );

            currentPairingCode = code;

            console.log(
                "Pairing code generated:",
                code
            );

            socket.emit(
                "pairing-code",
                code
            );

        } catch (error) {
            console.error(
                "PAIRING ERROR:",
                error
            );

            socket.emit(
                "pair-error",
                error.message ||
                "Failed to generate pairing code."
            );
        }
    });

    socket.on("disconnect", () => {
        connectedUsers.delete(socket.id);

        io.emit(
            "total-active",
            connectedUsers.size
        );

        console.log(
            "Dashboard disconnected:",
            socket.id
        );
    });
});

/*
|--------------------------------------------------------------------------
| WHATSAPP COMMANDS
|--------------------------------------------------------------------------
*/

client.on("message", async (message) => {
    try {
        const body =
            (message.body || "").trim();

        if (!body.startsWith(settings.prefix)) {
            return;
        }

        const args =
            body
                .slice(settings.prefix.length)
                .trim()
                .split(/\s+/);

        const command =
            (args.shift() || "").toLowerCase();

        /*
        |--------------------------------------------------------------------------
        | PING
        |--------------------------------------------------------------------------
        */

        if (
            command === "ping" &&
            settings.commands.ping
        ) {
            await message.reply(
                `🏓 ${settings.botName}\nPong!\nResponse: OK`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | UPTIME
        |--------------------------------------------------------------------------
        */

        if (
            command === "uptime" &&
            settings.commands.uptime
        ) {
            const uptime =
                formatUptime(
                    process.uptime()
                );

            await message.reply(
                `⏱️ ${settings.botName}\nUptime: ${uptime}`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | CALCULATOR
        |--------------------------------------------------------------------------
        */

        if (
            command === "calc" &&
            settings.commands.calc
        ) {
            const expression =
                args.join(" ");

            if (!expression) {
                await message.reply(
                    "Usage: .calc 10 + 5"
                );

                return;
            }

            /*
             * Only allow basic arithmetic characters.
             */

            if (
                !/^[0-9+\-*/().%\s]+$/.test(
                    expression
                )
            ) {
                await message.reply(
                    "Only basic mathematical expressions are allowed."
                );

                return;
            }

            try {
                const result =
                    Function(
                        `"use strict"; return (${expression})`
                    )();

                await message.reply(
                    `🧮 Result: ${result}`
                );
            } catch {
                await message.reply(
                    "Invalid calculation."
                );
            }

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | JOKE
        |--------------------------------------------------------------------------
        */

        if (
            command === "joke" &&
            settings.commands.joke
        ) {
            const jokes = [
                "Why do programmers prefer dark mode? Because light attracts bugs.",
                "I told my computer I needed a break. Now it won't stop sending me KitKat ads.",
                "There are 10 kinds of people: those who understand binary and those who don't."
            ];

            const joke =
                jokes[
                    Math.floor(
                        Math.random() *
                        jokes.length
                    )
                ];

            await message.reply(joke);

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | FACT
        |--------------------------------------------------------------------------
        */

        if (
            command === "fact" &&
            settings.commands.fact
        ) {
            const facts = [
                "JavaScript was created in 1995.",
                "The first computer mouse was made of wood.",
                "HTML stands for HyperText Markup Language."
            ];

            const fact =
                facts[
                    Math.floor(
                        Math.random() *
                        facts.length
                    )
                ];

            await message.reply(
                `💡 ${fact}`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | QUOTE
        |--------------------------------------------------------------------------
        */

        if (
            command === "quote" &&
            settings.commands.quote
        ) {
            const quotes = [
                "Success is built one step at a time.",
                "Keep learning. Keep building.",
                "Great software starts with a simple idea."
            ];

            const quote =
                quotes[
                    Math.floor(
                        Math.random() *
                        quotes.length
                    )
                ];

            await message.reply(
                `“${quote}”`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | NUMBER INFO
        |--------------------------------------------------------------------------
        */

        if (
            command === "numberinfo" &&
            settings.commands.numberinfo
        ) {
            const number =
                args.join("")
                    .replace(/\D/g, "");

            if (!number) {
                await message.reply(
                    "Usage: .numberinfo 923001234567"
                );

                return;
            }

            await message.reply(
                `📱 Number Info\n\nNumber: +${number}\nFormat: International\n\nNote: This bot does not reveal private subscriber information.`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | WHATSAPP INFO
        |--------------------------------------------------------------------------
        */

        if (
            command === "whatsappinfo" &&
            settings.commands.whatsappinfo
        ) {
            const number =
                args.join("")
                    .replace(/\D/g, "");

            if (!number) {
                await message.reply(
                    "Usage: .whatsappinfo 923001234567"
                );

                return;
            }

            try {
                const contact =
                    await client.getNumberId(
                        number
                    );

                if (!contact) {
                    await message.reply(
                        "This number could not be verified on WhatsApp."
                    );

                    return;
                }

                await message.reply(
                    `WhatsApp Check\n\nNumber: +${number}\nRegistered: Yes`
                );
            } catch {
                await message.reply(
                    "Unable to check this number."
                );
            }

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | GROUP INFO
        |--------------------------------------------------------------------------
        */

        if (
            command === "groupinfo" &&
            settings.commands.groupinfo
        ) {
            if (
                !message.from.endsWith(
                    "@g.us"
                )
            ) {
                await message.reply(
                    "This command can only be used in a group."
                );

                return;
            }

            const chat =
                await message.getChat();

            await message.reply(
                `👥 Group Info\n\nName: ${chat.name}\nMembers: ${chat.participants.length}`
            );

            return;
        }

        /*
        |--------------------------------------------------------------------------
        | TAG ALL
        |--------------------------------------------------------------------------
        */

        if (
            command === "tagall" &&
            settings.commands.tagall
        ) {
            if (
                !message.from.endsWith(
                    "@g.us"
                )
            ) {
                await message.reply(
                    "This command can only be used in a group."
                );

                return;
            }

            const chat =
                await message.getChat();

            const mentions = [];

            let text =
                "👥 Group Members\n\n";

            for (
                const participant
                of chat.participants
            ) {
                const contact =
                    await client.getContactById(
                        participant.id._serialized
                    );

                mentions.push(contact);

                text +=
                    `@${participant.id.user} `;
            }

            await chat.sendMessage(
                text,
                {
                    mentions
                }
            );

            return;
        }

    } catch (error) {
        console.error(
            "COMMAND ERROR:",
            error
        );
    }
});

/*
|--------------------------------------------------------------------------
| HELP COMMAND
|--------------------------------------------------------------------------
*/

client.on("message", async (message) => {
    const body =
        (message.body || "").trim();

    if (
        body.toLowerCase() !==
        ".menu"
    ) {
        return;
    }

    const menu = `
╭━━━〔 ${settings.botName} 〕━━━╮
┃
┃ 👑 Developer: ${settings.ownerName}
┃
┣━━ BASIC ━━
┃ .ping
┃ .uptime
┃ .calc
┃
┣━━ FUN ━━
┃ .joke
┃ .fact
┃ .quote
┃
┣━━ GROUP ━━
┃ .groupinfo
┃ .tagall
┃
┣━━ NUMBER ━━
┃ .numberinfo
┃ .whatsappinfo
┃
╰━━━━━━━━━━━━━━━━━━━━╯
`;

    await message.reply(menu);
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        `MA BOT dashboard running on port ${PORT}`
    );

    console.log(
        `Health: /health`
    );
});

/*
|--------------------------------------------------------------------------
| START WHATSAPP
|--------------------------------------------------------------------------
*/

console.log(
    "Starting WhatsApp client..."
);

client.initialize().catch((error) => {
    console.error(
        "CLIENT INITIALIZATION ERROR:",
        error
    );

    botStatus = "error";

    io.emit("bot-status", {
        status: "error",
        message: error.message
    });
});

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function formatUptime(seconds) {
    seconds =
        Math.floor(seconds);

    const days =
        Math.floor(
            seconds / 86400
        );

    seconds %= 86400;

    const hours =
        Math.floor(
            seconds / 3600
        );

    seconds %= 3600;

    const minutes =
        Math.floor(
            seconds / 60
        );

    seconds %= 60;

    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/*
|--------------------------------------------------------------------------
| PROCESS HANDLING
|--------------------------------------------------------------------------
*/

process.on(
    "unhandledRejection",
    (error) => {
        console.error(
            "Unhandled rejection:",
            error
        );
    }
);

process.on(
    "uncaughtException",
    (error) => {
        console.error(
            "Uncaught exception:",
            error
        );
    }
);
