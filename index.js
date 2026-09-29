const express = require("express");

const app = express();

app.use(express.json());

app.post("/api/sensor", (req, res) => {
    console.log(req.body);
    res.json({
        message: "Sensor data received"
    });
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});
