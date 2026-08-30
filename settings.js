module.exports = {
    botName: "MA BOT",
    ownerName: "Muhammad Ayan",
    developerName: "MA Developers",

    prefix: ".",

    port: process.env.PORT || 3000,

    logo:
        "https://i.postimg.cc/050FQZ89/Chat-GPT-Image-Aug-26-2026-03-07-12-PM.png",

    commands: {
        ping: true,
        uptime: true,
        calc: true,
        joke: true,
        fact: true,
        quote: true,
        numberinfo: true,
        whatsappinfo: true,
        groupinfo: true,
        tagall: true
    }
};
