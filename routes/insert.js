const mysql = require("mysql2/promise");
const express = require("express");

const router = express.Router();

// ============================================================================
// 1. DATABASE POOL
//
// Set DB_NAME and DB_PASSWORD on EC2 before starting Node/PM2.
// DB_NAME is the schema name shown in Workbench.
//
// One shared pool serves all requests. Each request borrows a connection
// and releases it afterward. Do not end the pool after each insert.
// ============================================================================
if (!process.env.DB_NAME || !process.env.DB_PASSWORD) {
    throw new Error(
        "Set DB_NAME and DB_PASSWORD before starting index.js."
    );
}

const pool = mysql.createPool({
    host:
        process.env.DB_HOST ||
        "ardsensor-dn.cnmi82ki8tut.us-east-2.rds.amazonaws.com",
    user: process.env.DB_USER || "admin",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 5000
});

// ============================================================================
// 2. FIELD DEFINITIONS AND VALIDATION
//
// Expected request:
// {
//     report_key: "...",
//     readings: [A0 reading, A5 reading]
// }
//
// Database ID and timestamp use the table's automatic defaults.
// ============================================================================
const SENSOR_IDS = ["mic_a0", "mic_a5"];

const LEVEL_FIELDS = [
    "initial_baseline_rms_adc",
    "baseline_rms_adc",
    "threshold_rms_adc",
    "rms_adc",
    "min_rms_adc",
    "max_rms_adc"
];

const TIME_FIELDS = [
    "sampled_ms",
    "above_threshold_ms",
    "near_limit_ms"
];

const VALUE_FIELDS = [...LEVEL_FIELDS, ...TIME_FIELDS];

const COLUMNS = [
    "report_key",
    "sensor_id",
    "baseline_event",
    ...VALUE_FIELDS
];

function validatePair(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "The body must be a JSON object.";
    }

    const keyPattern =
        /^[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/;

    if (
        typeof body.report_key !== "string" ||
        !keyPattern.test(body.report_key)
    ) {
        return "report_key must match the Arduino's 39-character key format.";
    }

    if (!Array.isArray(body.readings) || body.readings.length !== 2) {
        return "Provide exactly two microphone readings.";
    }

    const seen = new Set();

    for (const row of body.readings) {
        if (
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            !SENSOR_IDS.includes(row.sensor_id) ||
            seen.has(row.sensor_id)
        ) {
            return "Provide one mic_a0 reading and one mic_a5 reading.";
        }

        seen.add(row.sensor_id);

        if (![null, "Start", "Change"].includes(row.baseline_event)) {
            return "baseline_event must be Start, Change, or null.";
        }

        for (const name of LEVEL_FIELDS) {
            // DECIMAL(8,3): five digits before the decimal, three after.
            if (
                typeof row[name] !== "number" ||
                !Number.isFinite(row[name]) ||
                row[name] < 0 ||
                row[name] > 99999.999
            ) {
                return `${row.sensor_id}: invalid ${name}.`;
            }
        }

        for (const name of TIME_FIELDS) {
            if (
                !Number.isInteger(row[name]) ||
                row[name] < 0 ||
                row[name] > 4294967295
            ) {
                return `${row.sensor_id}: invalid ${name}.`;
            }
        }

        if (
            row.sampled_ms === 0 ||
            row.above_threshold_ms > row.sampled_ms ||
            row.near_limit_ms > row.sampled_ms
        ) {
            return `${row.sensor_id}: durations must fit within positive sampled_ms.`;
        }

        // Allow small rounding differences in three-decimal Arduino output.
        if (
            row.min_rms_adc > row.rms_adc + 0.002 ||
            row.rms_adc > row.max_rms_adc + 0.002 ||
            row.min_rms_adc > row.max_rms_adc
        ) {
            return `${row.sensor_id}: RMS must be between the minimum and maximum.`;
        }
    }

    if (body.readings[0].sampled_ms !== body.readings[1].sampled_ms) {
        return "Both readings must describe the same measured interval.";
    }

    return null;
}

// Match the three-decimal precision stored by MySQL.
function normalizeReading(row) {
    const normalized = {
        sensor_id: row.sensor_id,
        baseline_event: row.baseline_event
    };

    for (const field of LEVEL_FIELDS) {
        normalized[field] = row[field].toFixed(3);
    }

    for (const field of TIME_FIELDS) {
        normalized[field] = row[field];
    }

    return normalized;
}

// mysql2 may return DECIMAL values as strings.
// Compare both sides at the same stored precision.
function sameReading(saved, incoming) {
    return (
        saved.sensor_id === incoming.sensor_id &&
        saved.baseline_event === incoming.baseline_event &&
        LEVEL_FIELDS.every(
            field =>
                Number(saved[field]).toFixed(3) === incoming[field]
        ) &&
        TIME_FIELDS.every(
            field => Number(saved[field]) === incoming[field]
        )
    );
}

// ============================================================================
// 3. DATABASE HELPERS
//
// Values use SQL placeholders.
// One borrowed connection handles the entire transaction.
// ============================================================================
async function insertPair(connection, reportKey, readings) {
    const rowPlaceholders =
        `(${COLUMNS.map(() => "?").join(", ")})`;

    const sql = `
        INSERT INTO pa3_Ard_DualSound
        (${COLUMNS.join(", ")})
        VALUES ${rowPlaceholders}, ${rowPlaceholders}
    `;

    const values = readings.flatMap(row => [
        reportKey,
        row.sensor_id,
        row.baseline_event,
        ...VALUE_FIELDS.map(field => row[field])
    ]);

    await connection.execute(sql, values);
}

async function isIdenticalSavedPair(connection, reportKey, readings) {
    const [savedRows] = await connection.execute(
        `SELECT ${COLUMNS.join(", ")}
         FROM pa3_Ard_DualSound
         WHERE report_key = ?`,
        [reportKey]
    );

    // A duplicate-key error alone does not prove BOTH readings were saved.
    return (
        savedRows.length === 2 &&
        readings.every(incoming => {
            const saved = savedRows.find(
                row => row.sensor_id === incoming.sensor_id
            );

            return saved && sameReading(saved, incoming);
        })
    );
}

function acknowledgePair(res, reportKey, duplicate) {
    // Arduino checks this header before releasing its pending report.
    res.set("X-Report-Key", reportKey);

    return res.status(duplicate ? 200 : 201).json({
        message: duplicate
            ? "Report already saved."
            : "Both readings saved.",
        report_key: reportKey,
        duplicate
    });
}

// ============================================================================
// 4. POST /api/sensor
//
// New report:
// Begin transaction -> insert both -> commit -> acknowledge.
//
// Retry:
// Roll back duplicate attempt -> verify stored pair -> acknowledge.
//
// Failure:
// No acknowledgment; Arduino keeps its report for retry.
// ============================================================================
router.post("/", async (req, res) => {
    const validationError = validatePair(req.body);

    if (validationError) {
        return res.status(400).json({
            message: validationError
        });
    }

    const reportKey = req.body.report_key;

    // Always insert microphones in the same order.
    const readings = SENSOR_IDS.map(id =>
        normalizeReading(
            req.body.readings.find(row => row.sensor_id === id)
        )
    );

    let connection;
    let transactionOpen = false;

    try {
        connection = await pool.getConnection();

        await connection.beginTransaction();
        transactionOpen = true;

        try {
            await insertPair(connection, reportKey, readings);

            await connection.commit();
            transactionOpen = false;
        } catch (error) {
            await connection.rollback();
            transactionOpen = false;

            if (error.code !== "ER_DUP_ENTRY") {
                throw error;
            }

            // End the attempted transaction before checking existing rows.
            const identical = await isIdenticalSavedPair(
                connection,
                reportKey,
                readings
            );

            if (identical) {
                console.log("Acknowledging saved retry:", reportKey);

                return acknowledgePair(res, reportKey, true);
            }

            console.error("Report key conflict:", reportKey);

            return res.status(409).json({
                message:
                    "Report key exists with different or incomplete readings."
            });
        }

        console.log("Saved microphone pair:", reportKey);

        return acknowledgePair(res, reportKey, false);
    } catch (error) {
        if (connection && transactionOpen) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    "Rollback failed:",
                    rollbackError.code || rollbackError.message
                );

                connection.destroy();
                connection = null;
            }
        }

        console.error(
            "Sound report failed:",
            error.code || error.message
        );

        // No X-Report-Key header on failure.
        // If a commit succeeded but its reply was lost, the next retry
        // verifies the existing pair instead of inserting it again.
        return res.status(503).json({
            message: "Report not acknowledged; retry later."
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

module.exports = router;