const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve public folder
app.use(express.static(path.join(__dirname, "public")));

// Main page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "online",
        bot: "MA BOT",
        uptime: process.uptime()
    });
});

// Socket.IO
let activeUsers = 0;

io.on("connection", (socket) => {
    activeUsers++;

    console.log("Client connected:", socket.id);

    io.emit("total-active", activeUsers);

    socket.on("set-user", (userId) => {
        socket.userId = userId;
        console.log("User registered:", userId);
    });

    /*
     * Safe demo pairing flow.
     *
     * IMPORTANT:
     * This does NOT generate a real WhatsApp
     * authentication/pairing code.
     */
    socket.on("pair-request", ({ userId, number }) => {
        console.log("Pair request:", {
            userId,
            number
        });

        if (!number || number.length < 10) {
            socket.emit(
                "pair-error",
                "Please enter a valid WhatsApp number."
            );
            return;
        }

        socket.emit(
            "pair-error",
            "Pairing service is not configured yet."
        );
    });

    socket.on("disconnect", () => {
        activeUsers--;

        if (activeUsers < 0) {
            activeUsers = 0;
        }

        console.log("Client disconnected:", socket.id);

        io.emit("total-active", activeUsers);
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "Not Found",
        path: req.originalUrl
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ MA BOT running on port ${PORT}`);
});
