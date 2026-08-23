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
const PAYLOR_WEBHOOK_SECRET =
    process.env.PAYLOR_WEBHOOK_SECRET;

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "https://nyota-funds-xoa7.onrender.com";

const PAYLOR_BASE_URL =
    "https://api.paylorke.com/api/v1";

/*
====================================================
TEMPORARY PAYMENT STATUS STORE
====================================================
*/

const paymentStatuses = new Map();

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
            "X-Webhook-Signature"
        ]
    })
);

/*
====================================================
JSON BODY
====================================================
*/

app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = Buffer.from(buf);
        }
    })
);

/*
====================================================
BACKEND URL
====================================================
*/

function getBackendUrl(req) {

    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }

    if (process.env.BACKEND_URL) {
        return process.env.BACKEND_URL;
    }

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
        frontend: FRONTEND_URL
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

        paylorApiKeyConfigured:
            Boolean(PAYLOR_API_KEY),

        paylorChannelConfigured:
            Boolean(PAYLOR_CHANNEL_ID),

        webhookSecretConfigured:
            Boolean(PAYLOR_WEBHOOK_SECRET),

        paylorChannelPreview:
            PAYLOR_CHANNEL_ID
                ? `${PAYLOR_CHANNEL_ID.substring(
                      0,
                      5
                  )}*****`
                : null,

        frontendUrl:
            FRONTEND_URL

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

    let value =
        String(phone)
            .trim()
            .replace(/\s+/g, "");

    /*
    07XXXXXXXX
    01XXXXXXXX
    */

    if (/^0[17]\d{8}$/.test(value)) {

        return "254" +
            value.substring(1);

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

    const number =
        Number(amount);

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

function createReference(
    prefix = "NYOTA"
) {

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
            Buffer.from(
                String(received),
                "utf8"
            );

        const expectedBuffer =
            Buffer.from(
                String(expected),
                "utf8"
            );

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
            CHECK API KEY
            */

            if (!PAYLOR_API_KEY) {

                return res.status(500).json({

                    success: false,

                    error:
                        "PAYLOR_API_KEY is not configured"

                });

            }

            /*
            CHECK CHANNEL
            */

            if (!PAYLOR_CHANNEL_ID) {

                return res.status(500).json({

                    success: false,

                    error:
                        "PAYLOR_CHANNEL_ID is not configured"

                });

            }

            const {
                phone,
                amount,
                reference,
                description
            } = req.body || {};

            /*
            NORMALIZE PHONE
            */

            const normalizedPhone =
                normalizePhone(phone);

            if (!normalizedPhone) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid Kenyan phone number"

                });

            }

            /*
            VALIDATE AMOUNT
            */

            if (!validAmount(amount)) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid payment amount"

                });

            }

            const paymentAmount =
                Number(amount);

            /*
            CREATE REFERENCE
            */

            const paymentReference =
                reference ||
                createReference("NYOTA");

            /*
            INITIAL PAYMENT STATUS
            */

            paymentStatuses.set(
                paymentReference,
                {
                    status: "PENDING",
                    reference:
                        paymentReference
                }
            );

            /*
            CALLBACK URL
            */

            const callbackUrl =
                `${getBackendUrl(
                    req
                )}/api/paylor-callback`;

            /*
            PAYLOR PAYLOAD
            */

            const payload = {

                phone:
                    normalizedPhone,

                amount:
                    paymentAmount,

                reference:
                    paymentReference,

                channelId:
                    PAYLOR_CHANNEL_ID,

                description:
                    description ||
                    "Nyota Funds payment",

                callbackUrl

            };

            console.log(
                "===================================="
            );

            console.log(
                "NYOTA FUNDS STK PUSH"
            );

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
            SEND TO PAYLOR
            */

            const response =
                await fetch(
                    `${PAYLOR_BASE_URL}/merchants/payments/stk-push`,
                    {
                        method: "POST",

                        headers: {

                            Authorization:
                                `Bearer ${PAYLOR_API_KEY}`,

                            "Content-Type":
                                "application/json",

                            "Idempotency-Key":
                                paymentReference

                        },

                        body:
                            JSON.stringify(
                                payload
                            )

                    }
                );

            /*
            READ PAYLOR RESPONSE
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
            PAYLOR ERROR
            */

            if (!response.ok) {

                paymentStatuses.delete(
                    paymentReference
                );

                return res
                    .status(
                        response.status
                    )
                    .json({

                        success: false,

                        error:
                            "Paylor rejected the STK Push",

                        details:
                            data

                    });

            }

            /*
            TRANSACTION ID
            */

            const transactionId =
                data.transactionId ||
                data.checkout_request_id ||
                data.id ||
                null;

            /*
            SAVE TRANSACTION ID
            */

            paymentStatuses.set(
                paymentReference,
                {
                    status: "PENDING",

                    reference:
                        paymentReference,

                    transactionId
                }
            );

            /*
            SUCCESS RESPONSE
            */

            return res.json({

                success: true,

                message:
                    "STK Push sent successfully",

                reference:
                    paymentReference,

                transactionId,

                status:
                    data.status ||
                    "PENDING",

                paylor:
                    data

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
                    error.message

            });

        }

    }
);

/*
====================================================
PAYMENT STATUS
====================================================
*/


app.get("/api/payment/status", (req, res) => {

    const reference = req.query.reference;

    console.log(
        "PAYMENT STATUS CHECK:",
        reference
    );

    if (!reference) {
        return res.status(400).json({
            success: false,
            error: "Payment reference is required"
        });
    }

    const payment =
        paymentStatuses.get(reference);

    console.log(
        "PAYMENT FOUND:",
        payment
    );

    if (!payment) {

        return res.json({
            success: true,
            status: "PENDING",
            reference: reference
        });

    }

    return res.json({
        success: true,
        status: payment.status,
        reference: payment.reference,
        transactionId: payment.transactionId || null,
        amount: payment.amount || null,
        mpesaReceipt: payment.mpesaReceipt || null,
        providerRef: payment.providerRef || null
    });

});
        

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
                "Body:",
                JSON.stringify(
                    req.body,
                    null,
                    2
                )
            );

            console.log(
                "===================================="
            );

            /*
            CHECK WEBHOOK SECRET
            */

            if (!PAYLOR_WEBHOOK_SECRET) {

                console.error(
                    "PAYLOR_WEBHOOK_SECRET is missing"
                );

                return res.status(500).json({

                    success: false,

                    error:
                        "Webhook secret not configured"

                });

            }

            /*
            VERIFY SIGNATURE
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
                        "Invalid webhook signature"

                });

            }

            console.log(
                "PAYLOR WEBHOOK SIGNATURE VERIFIED"
            );

            /*
            CALLBACK DATA
            */

            const body =
                req.body || {};

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
                body.reference ||
                null;

            const amount =
                transaction.amount ||
                body.amount ||
                null;

            const status =
                transaction.status ||
                body.status ||
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
                "EVENT:",
                event
            );

            console.log(
                "REFERENCE:",
                reference
            );

            console.log(
                "TRANSACTION ID:",
                transactionId
            );

            console.log(
                "STATUS:",
                status
            );

            /*
            SUCCESS
            */

            if (

                event ===
                    "payment.success" ||

                status ===
                    "COMPLETED" ||

                status ===
                    "SUCCESS"

            ) {

                console.log(
                    "===================================="
                );

                console.log(
                    "PAYMENT SUCCESSFUL"
                );

                console.log(
                    "REFERENCE:",
                    reference
                );

                console.log(
                    "TRANSACTION:",
                    transactionId
                );

                console.log(
                    "AMOUNT:",
                    amount
                );

                console.log(
                    "M-PESA RECEIPT:",
                    mpesaReceipt
                );

                console.log(
                    "===================================="
                );

                /*
                SAVE SUCCESS STATUS
                */

                if (reference) {

                    paymentStatuses.set(
                        reference,
                        {

                            status:
                                "COMPLETED",

                            reference,

                            transactionId,

                            amount,

                            providerRef,

                            mpesaReceipt

                        }
                    );

                }

                return res.status(200).json({

                    success: true,

                    received: true,

                    payment: {

                        event,

                        reference,

                        transactionId,

                        amount,

                        status:
                            "COMPLETED",

                        providerRef,

                        mpesaReceipt

                    }

                });

            }

            /*
            FAILED
            */

            if (

                event ===
                    "payment.failed" ||

                status ===
                    "FAILED"

            ) {

                console.log(
                    "PAYMENT FAILED:",
                    reference
                );

                if (reference) {

                    paymentStatuses.set(
                        reference,
                        {

                            status:
                                "FAILED",

                            reference,

                            transactionId,

                            amount

                        }
                    );

                }

                return res.status(200).json({

                    success: true,

                    received: true,

                    payment: {

                        reference,

                        transactionId,

                        amount,

                        status:
                            "FAILED"

                    }

                });

            }

            /*
            OTHER EVENT
            */

            console.log(
                "OTHER PAYLOR EVENT:",
                event
            );

            return res.status(200).json({

                success: true,

                received: true,

                event,

                reference,

                transactionId,

                status

            });

        } catch (error) {

            console.error(
                "PAYLOR CALLBACK ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Callback processing failed",

                message:
                    error.message

            });

        }

    }
);

/*
====================================================
404
====================================================
*/

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            error:
                "Route not found",

            path:
                req.originalUrl

        });

    }
);

/*
====================================================
GLOBAL ERROR
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

            error:
                "Internal server error"

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
