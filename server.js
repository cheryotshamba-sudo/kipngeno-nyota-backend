// server.js

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

const PAYLOR_API_KEY = process.env.PAYLOR_API_KEY;
const PAYLOR_CHANNEL_ID = process.env.PAYLOR_CHANNEL_ID;
const PAYLOR_WEBHOOK_SECRET = process.env.PAYLOR_WEBHOOK_SECRET;

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "https://nyota-funds-frontend.onrender.com";

const PAYLOR_BASE_URL = "https://api.paylorke.com/api/v1";

/*
====================================================
CORS
====================================================
*/

app.use(
    cors({
        origin: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

/*
====================================================
JSON BODY
====================================================

We keep the raw body because Paylor signs the exact
bytes sent to the callback.
*/

app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = Buffer.from(buf);
        },
    })
);

/*
====================================================
HEALTH CHECK
====================================================
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Nyota Funds backend is running",
        service: "nyota-funds-backend",
    });
});

/*
====================================================
PHONE NUMBER NORMALIZATION
====================================================
*/

function normalizePhone(phone) {
    if (!phone) {
        return null;
    }

    let value = String(phone).trim().replace(/\s+/g, "");

    // 07XXXXXXXX / 01XXXXXXXX
    if (/^0[17]\d{8}$/.test(value)) {
        return "254" + value.substring(1);
    }

    // +2547XXXXXXXX
    if (/^\+254[17]\d{8}$/.test(value)) {
        return value.substring(1);
    }

    // 2547XXXXXXXX
    if (/^254[17]\d{8}$/.test(value)) {
        return value;
    }

    return null;
}

/*
====================================================
AMOUNT VALIDATION
====================================================
*/

function validAmount(amount) {
    const number = Number(amount);

    return Number.isFinite(number) && number > 0;
}

/*
====================================================
CREATE UNIQUE REFERENCE
====================================================
*/

function createReference(prefix = "NYOTA") {
    return `${prefix}-${Date.now()}-${crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase()}`;
}

/*
====================================================
STK PUSH
====================================================
*/

app.post("/api/payment/stk-push", async (req, res) => {
    try {
        if (!PAYLOR_API_KEY) {
            return res.status(500).json({
                success: false,
                error: "PAYLOR_API_KEY is not configured",
            });
        }

        if (!PAYLOR_CHANNEL_ID) {
            return res.status(500).json({
                success: false,
                error: "PAYLOR_CHANNEL_ID is not configured",
            });
        }

        const {
            phone,
            amount,
            reference,
            description,
        } = req.body;

        const normalizedPhone = normalizePhone(phone);

        if (!normalizedPhone) {
            return res.status(400).json({
                success: false,
                error: "Invalid Kenyan phone number",
            });
        }

        if (!validAmount(amount)) {
            return res.status(400).json({
                success: false,
                error: "Invalid payment amount",
            });
        }

        const paymentAmount = Number(amount);

        const paymentReference =
            reference ||
            createReference("NYOTA");

        const callbackUrl =
            `${getBackendUrl(req)}/api/paylor-callback`;

        const payload = {
            phone: normalizedPhone,
            amount: paymentAmount,
            reference: paymentReference,
            channelId: PAYLOR_CHANNEL_ID,
            description:
                description || "Nyota Funds payment",
            callbackUrl,
        };

        console.log("====================================");
        console.log("NYOTA STK PUSH");
        console.log("Phone:", normalizedPhone);
        console.log("Amount:", paymentAmount);
        console.log("Reference:", paymentReference);
        console.log("Callback:", callbackUrl);
        console.log("====================================");

        const response = await fetch(
            `${PAYLOR_BASE_URL}/merchants/payments/stk-push`,
            {
                method: "POST",

                headers: {
                    Authorization: `Bearer ${PAYLOR_API_KEY}`,
                    "Content-Type": "application/json",

                    // Prevent accidental duplicate payment creation
                    "Idempotency-Key": paymentReference,
                },

                body: JSON.stringify(payload),
            }
        );

        const data = await response.json().catch(() => ({}));

        console.log("PAYLOR RESPONSE:", data);

        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                error: "Paylor rejected the STK Push",
                details: data,
            });
        }

        return res.json({
            success: true,
            message: "STK Push sent successfully",
            reference: paymentReference,
            transactionId: data.transactionId || null,
            status: data.status || "SENT",
            paylor: data,
        });
    } catch (error) {
        console.error("STK PUSH ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to initiate payment",
            message: error.message,
        });
    }
});

/*
====================================================
PAYLOR CALLBACK
====================================================
*/

app.post("/api/paylor-callback", (req, res) => {
    try {
        const signature =
            req.headers["x-webhook-signature"];

        if (!PAYLOR_WEBHOOK_SECRET) {
            console.error(
                "PAYLOR_WEBHOOK_SECRET is missing"
            );

            return res.status(500).json({
                success: false,
                error: "Webhook secret not configured",
            });
        }

        if (!signature) {
            console
