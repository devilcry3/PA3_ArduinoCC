// ============================================================================
// 1. EXPRESS SETUP
// Arduino sends to this EC2 server on port 3000 at /api/sensor.
// ============================================================================
const express = require("express");
const insertRouter = require("./routes/insert");

const app = express();
app.use(express.json({ limit: "16kb" }));

// ============================================================================
// 2. ROUTES
// The "/" route inside insert.js becomes "/api/sensor" here.
// ============================================================================
app.use("/api/sensor", insertRouter);

// Return JSON errors for malformed or oversized requests.
app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({
            message: "Invalid JSON body."
        });
    }

    if (err.type === "entity.too.large") {
        return res.status(413).json({
            message: "Request body is too large."
        });
    }

    console.error("Request error:", err.message);

    return res.status(500).json({
        message: "Server error."
    });
});

// ============================================================================
// 3. START SERVER
// ============================================================================
app.listen(3000, () => {
    console.log("Server running on port 3000");
    console.log("Sound reports: POST /api/sensor");
});