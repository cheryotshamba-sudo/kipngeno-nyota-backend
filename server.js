// server.js

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

/*
====================================================
ENVIRONMENT VARIABLES
====================================================
*/

const PAYLOR_API_KEY = process.env.PAYLOR_API_KEY;
const PAYLOR_CHANNEL_ID = process.env.PAYLOR_CHANNEL_ID;
const PAYLOR_WEBHOOK_SECRET = process.env.PAYLOR_WEBHOOK_SECRET;

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "https://nyota-funds-frontend.onrender.com";

const PAYLOR_BASE_URL =
    "https://api.paylorke.com/api/v1";

/*
====================================================
CORS
====================================================
*/

app.use(
    cors({
        origin: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Webhook-Signature",
        ],
    })
);

/*
====================================================
JSON BODY
====================================================

Keep the exact raw body because Paylor signs the
original callback bytes.
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
GET BACKEND URL
====================================================
*/

function getBackendUrl(req) {
    /*
    Render automatically provides RENDER_EXTERNAL_URL.

    Example:
    https://nyota-funds-backend.onrender.com
    */

    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }

    /*
    Optional manual environment variable.
    */

    if (process.env.BACKEND_URL) {
        return process.env.BACKEND_URL;
    }

    /*
    Fallback to current request host.
    */

    const protocol =
        req.headers["x-forwarded-proto"] ||
        "https";

    const host = req.get("host");

    return `${protocol}://${host}`;
}

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
        frontend: FRONTEND_URL,
    });
});

/*
====================================================
ENVIRONMENT CHECK
====================================================
*/

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        backend: "online",
        paylorApiKeyConfigured: Boolean(PAYLOR_API_KEY),
        paylorChannelConfigured: Boolean(PAYLOR_CHANNEL_ID),
        webhookSecretConfigured: Boolean(
            PAYLOR_WEBHOOK_SECRET
        ),
        frontendUrl: FRONTEND_URL,
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

    let value = String(phone)
        .trim()
        .replace(/\s+/g, "");

    /*
    07XXXXXXXX
    01XXXXXXXX
    */

    if (/^0[17]\d{8}$/.test(value)) {
        return "254" + value.substring(1);
    }

    /*
    +2547XXXXXXXX
    +2541XXXXXXXX
    */

    if (/^\+254[17]\d{8}$/.test(value)) {
        return value.substring(1);
    }

    /*
    2547XXXXXXXX
    2541XXXXXXXX
    */

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

    return (
        Number.isFinite(number) &&
        number > 0
    );
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
CONSTANT-TIME SIGNATURE COMPARISON
====================================================
*/

function safeCompareSignatures(
    received,
    expected
) {
    try {
        const receivedBuffer =
            Buffer.from(String(received), "utf8");

        const expectedBuffer =
            Buffer.from(String(expected), "utf8");

        if (
            receivedBuffer.length !==
            expectedBuffer.length
        ) {
            return false;
        }

        return crypto.timingSafeEqual(
            receivedBuffer,
            expectedBuffer
        );
    } catch (error) {
        return false;
    }
}

/*
====================================================
VERIFY PAYLOR WEBHOOK
====================================================
*/

function verifyPaylorWebhook(req) {
    if (!PAYLOR_WEBHOOK_SECRET) {
        return false;
    }

    const signature =
        req.headers["x-webhook-signature"];

    if (!signature) {
        return false;
    }

    if (!req.rawBody) {
        return false;
    }

    /*
    Paylor uses HMAC SHA-256 over the exact raw body.
    */

    const expectedSignature =
        crypto
            .createHmac(
                "sha256",
                PAYLOR_WEBHOOK_SECRET
            )
            .update(req.rawBody)
            .digest("hex");

    return safeCompareSignatures(
        signature,
        expectedSignature
    );
}

/*
====================================================
STK PUSH
====================================================
*/

app.post(
    "/api/payment/stk-push",
    async (req, res) => {
        try {
            /*
            Check API key
            */

            if (!PAYLOR_API_KEY) {
                return res.status(500).json({
                    success: false,
                    error:
                        "PAYLOR_API_KEY is not configured",
                });
            }

            /*
            Check channel
            */

            if (!PAYLOR_CHANNEL_ID) {
                return res.status(500).json({
                    success: false,
                    error:
                        "PAYLOR_CHANNEL_ID is not configured",
                });
            }

            const {
                phone,
                amount,
                reference,
                description,
            } = req.body || {};

            /*
            Normalize phone
            */

            const normalizedPhone =
                normalizePhone(phone);

            if (!normalizedPhone) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid Kenyan phone number",
                });
            }

            /*
            Validate amount
            */

            if (!validAmount(amount)) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid payment amount",
                });
            }

            const paymentAmount =
                Number(amount);

            /*
            Create reference if frontend
            did not provide one.
            */

            const paymentReference =
                reference ||
                createReference("NYOTA");

            /*
            Create callback URL.

            Render:
            https://nyota-funds-backend.onrender.com
            */

            const callbackUrl =
                `${getBackendUrl(req)}/api/paylor-callback`;

            /*
            Paylor STK payload
            */

            const payload = {
                phone: normalizedPhone,
                amount: paymentAmount,
                reference: paymentReference,
                channelId: PAYLOR_CHANNEL_ID,
                description:
                    description ||
                    "Nyota Funds payment",
                callbackUrl,
            };

            console.log(
                "===================================="
            );

            console.log("NYOTA STK PUSH");

            console.log(
                "Phone:",
                normalizedPhone
            );

            console.log(
                "Amount:",
                paymentAmount
            );

            console.log(
                "Reference:",
                paymentReference
            );

            console.log(
                "Callback:",
                callbackUrl
            );

            console.log(
                "===================================="
            );

            /*
            Send request to Paylor
            */

            const response = await fetch(
                `${PAYLOR_BASE_URL}/merchants/payments/stk-push`,
                {
                    method: "POST",

                    headers: {
                        Authorization:
                            `Bearer ${PAYLOR_API_KEY}`,

                        "Content-Type":
                            "application/json",

                        /*
                        Prevent duplicate payment
                        attempts.
                        */

                        "Idempotency-Key":
                            paymentReference,
                    },

                    body:
                        JSON.stringify(payload),
                }
            );

            /*
            Safely parse response
            */

            const data =
                await response
                    .json()
                    .catch(() => ({}));

            console.log(
                "PAYLOR RESPONSE:",
                data
            );

            /*
            Paylor rejected request
            */

            if (!response.ok) {
                return res
                    .status(response.status)
                    .json({
                        success: false,
                        error:
                            "Paylor rejected the STK Push",
                        details: data,
                    });
            }

            /*
            Success
            */

            return res.json({
                success: true,

                message:
                    "STK Push sent successfully",

                reference:
                    paymentReference,

                transactionId:
                    data.transactionId ||
                    null,

                status:
                    data.status ||
                    "SENT",

                paylor: data,
            });
        } catch (error) {
            console.error(
                "STK PUSH ERROR:",
                error
            );

            return res.status(500).json({
                success: false,

                error:
                    "Unable to initiate payment",

                message:
                    error.message,
            });
        }
    }
);

/*
====================================================
PAYLOR CALLBACK
====================================================
*/

app.post(
    "/api/paylor-callback",
    (req, res) => {
        try {
            console.log(
                "===================================="
            );

            console.log(
                "PAYLOR CALLBACK RECEIVED"
            );

            console.log(
                "Headers:",
                req.headers
            );

            console.log(
                "Body:",
                req.body
            );

            console.log(
                "===================================="
            );

            /*
            Webhook secret must exist.
            */

            if (!PAYLOR_WEBHOOK_SECRET) {
                console.error(
                    "PAYLOR_WEBHOOK_SECRET is missing"
                );

                return res.status(500).json({
                    success: false,
                    error:
                        "Webhook secret not configured",
                });
            }

            /*
            Verify Paylor signature.
            */

            const validSignature =
                verifyPaylorWebhook(req);

            if (!validSignature) {
                console.error(
                    "INVALID PAYLOR WEBHOOK SIGNATURE"
                );

                return res.status(401).json({
                    success: false,
                    error:
                        "Invalid webhook signature",
                });
            }

            console.log(
                "PAYLOR WEBHOOK SIGNATURE VERIFIED"
            );

            /*
            Get callback data.
            */

            const body =
                req.body || {};

            /*
            Paylor webhook format:
            
            {
                event: "payment.success",
                transaction: {
                    id: "...",
                    reference: "...",
                    internalReference: "...",
                    amount: 1000,
                    status: "COMPLETED",
                    providerRef: "...",
                    metadata: {
                        mpesaReceipt: "..."
                    }
                }
            }
            */

            const event =
                body.event || null;

            const transaction =
                body.transaction || {};

            const transactionId =
                transaction.id ||
                transaction.transactionId ||
                null;

            const reference =
                transaction.reference ||
                null;

            const amount =
                transaction.amount ||
                null;

            const status =
                transaction.status ||
                null;

            const providerRef =
                transaction.providerRef ||
                null;

            const metadata =
                transaction.metadata ||
                {};

            const mpesaReceipt =
                metadata.mpesaReceipt ||
                metadata.mpesa_receipt ||
                null;

            console.log(
                "PAYLOR EVENT:",
                event
            );

            console.log(
                "TRANSACTION ID:",
                transactionId
            );

            console.log(
                "REFERENCE:",
                reference
            );

            console.log(
                "AMOUNT:",
                amount
            );

            console.log(
                "STATUS:",
                status
            );

            console.log(
                "MPESA RECEIPT:",
                mpesaReceipt
            );

            /*
            ====================================================
            SUCCESSFUL PAYMENT
            ====================================================
            */

            if (
                event === "payment.success" ||
                status === "COMPLETED" ||
                status === "SUCCESS"
            ) {
                console.log(
                    "===================================="
                );

                console.log(
                    "PAYMENT SUCCESSFUL"
                );

                console.log(
                    "Reference:",
                    reference
                );

                console.log(
                    "Transaction:",
                    transactionId
                );

                console.log(
                    "Amount:",
                    amount
                );

                console.log(
                    "M-PESA Receipt:",
                    mpesaReceipt
                );

                console.log(
                    "===================================="
                );

                /*
                IMPORTANT:
                This is where your application can
                mark the corresponding payment as PAID.

                Example:

                await Payment.updateOne(
                    { reference: reference },
                    {
                        status: "PAID",
                        transactionId,
                        mpesaReceipt
                    }
                );
                */

                return res.status(200).json({
                    success: true,

                    received: true,

                    payment: {
                        event,
                        reference,
                        transactionId,
                        amount,
                        status,
                        providerRef,
                        mpesaReceipt,
                    },
                });
            }

            /*
            ====================================================
            FAILED PAYMENT
            ====================================================
            */

            if (
                event === "payment.failed" ||
                status === "FAILED"
            ) {
                console.log(
                    "===================================="
                );

                console.log(
                    "PAYMENT FAILED"
                );

                console.log(
                    "Reference:",
                    reference
                );

                console.log(
                    "Transaction:",
                    transactionId
                );

                console.log(
                    "Status:",
                    status
                );

                console.log(
                    "===================================="
                );

                /*
                This is where you can mark the payment
                as FAILED in your database.
                */

                return res.status(200).json({
                    success: true,

                    received: true,

                    payment: {
                        event,
                        reference,
                        transactionId,
                        amount,
                        status,
                    },
                });
            }

            /*
            ====================================================
            OTHER PAYLOR EVENTS
            ====================================================
            */

            console.log(
                "PAYLOR EVENT RECEIVED:",
                event
            );

            return res.status(200).json({
                success: true,
                received: true,
                event,
                reference,
                transactionId,
                status,
            });
        } catch (error) {
            console.error(
                "PAYLOR CALLBACK ERROR:",
                error
            );

            /*
            Return 500 so Paylor can retry the
            callback if necessary.
            */

            return res.status(500).json({
                success: false,
                error:
                    "Callback processing failed",
                message:
                    error.message,
            });
        }
    }
);

/*
====================================================
404 HANDLER
====================================================
*/

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            error: "Route not found",
            path: req.originalUrl,
        });
    }
);

/*
====================================================
GLOBAL ERROR HANDLER
====================================================
*/

app.use(
    (err, req, res, next) => {
        console.error(
            "GLOBAL ERROR:",
            err
        );

        res.status(500).json({
            success: false,
            error: "Internal server error",
        });
    }
);

/*
====================================================
START SERVER
====================================================
*/

app.listen(
    PORT,
    () => {
        console.log(
            "===================================="
        );

        console.log(
            "NYOTA FUNDS BACKEND"
        );

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            "Frontend:",
            FRONTEND_URL
        );

        console.log(
            "Paylor API:",
            PAYLOR_BASE_URL
        );

        console.log(
            "API Key:",
            PAYLOR_API_KEY
                ? "CONFIGURED"
                : "MISSING"
        );

        console.log(
            "Channel ID:",
            PAYLOR_CHANNEL_ID
                ? "CONFIGURED"
                : "MISSING"
        );

        console.log(
            "Webhook Secret:",
            PAYLOR_WEBHOOK_SECRET
                ? "CONFIGURED"
                : "MISSING"
        );

        console.log(
            "===================================="
        );
    }
);
