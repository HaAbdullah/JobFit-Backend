const fs = require("fs");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { body, param, validationResult } = require("express-validator");
const winston = require("winston");
require("dotenv").config();

// Initialize Express app first
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Winston Logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

// Initialize Firebase Admin
const admin = require("firebase-admin");

try {
  let serviceAccount;

  // Try to load from environment variable first
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else if (fs.existsSync("./firebase-service-account.json")) {
    // Fallback to service account file
    serviceAccount = require("./firebase-service-account.json");
  } else {
    throw new Error(
      "Firebase service account key not found. Please set FIREBASE_SERVICE_ACCOUNT_KEY environment variable or create firebase-service-account.json file"
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  logger.info("Firebase Admin initialized successfully");
} catch (error) {
  logger.error("Failed to initialize Firebase Admin:", error);
  console.error("Firebase initialization error:", error.message);
  console.error("Please check your Firebase service account configuration");
  process.exit(1);
}
const db = admin.firestore();

// Initialize Stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  })
);

// Force HTTPS in production
if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https") {
      res.redirect(`https://${req.header("host")}${req.url}`);
    } else {
      next();
    }
  });
}

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", limiter);

// Body parsing middleware (webhook needs raw body)
app.use("/api/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));

// CORS configuration
const allowedOrigins = process.env.FRONTEND_URLS?.split(",") || [
  "http://localhost:8888",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Firebase Auth verification middleware
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    logger.error("Error verifying Firebase token:", error);
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Helper functions
async function getUserDocument(userId) {
  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      const userData = {
        userId,
        tier: "FREEMIUM",
        usageCount: 0,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        subscriptionStatus: "inactive",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await userRef.set(userData);
      logger.info(`Created new user document for ${userId}`);
      return userData;
    }

    return userDoc.data();
  } catch (error) {
    logger.error("Error getting user document:", error);
    throw error;
  }
}

async function updateUserDocument(userId, updates) {
  try {
    const userRef = db.collection("users").doc(userId);
    await userRef.update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info(`Updated user document for ${userId}:`, updates);
  } catch (error) {
    logger.error("Error updating user document:", error);
    throw error;
  }
}

// Load instruction files for AI endpoints
let resumeSystemPrompt, coverLetterSystemPrompt;
try {
  resumeSystemPrompt = fs.readFileSync("./Resume-Instructions.txt", "utf8");
  coverLetterSystemPrompt = fs.readFileSync(
    "./Cover-Letter-Instructions.txt",
    "utf8"
  );
} catch (error) {
  logger.warn("Could not load instruction files:", error.message);
  resumeSystemPrompt =
    "You are a professional resume writer. Create a well-formatted resume based on the job description.";
  coverLetterSystemPrompt =
    "You are a professional cover letter writer. Create a compelling cover letter based on the job description.";
}

// ============ HEALTH CHECK ENDPOINTS ============
app.get("/", (req, res) => {
  res.json({ message: "Job Fit API is running", status: "ok" });
});

app.get("/api/health", async (req, res) => {
  const healthCheck = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || "1.0.0",
    environment: process.env.NODE_ENV,
  };

  try {
    // Test database connection
    await db.collection("users").limit(1).get();
    healthCheck.database = "connected";

    // Test Stripe connection
    await stripe.products.list({ limit: 1 });
    healthCheck.stripe = "connected";

    res.status(200).json(healthCheck);
  } catch (error) {
    healthCheck.status = "error";
    healthCheck.error = error.message;
    logger.error("Health check failed:", error);
    res.status(503).json(healthCheck);
  }
});

// ============ USER MANAGEMENT ENDPOINTS ============
app.get(
  "/api/user/:userId",
  [
    param("userId").isString().trim().escape(),
    handleValidationErrors,
    verifyFirebaseToken,
  ],
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (req.user.uid !== userId) {
        return res
          .status(403)
          .json({ error: "Forbidden: Cannot access other user data" });
      }

      const userData = await getUserDocument(userId);

      res.json({
        success: true,
        data: userData,
      });
    } catch (error) {
      logger.error("Error fetching user data:", error);
      res.status(500).json({
        error: "Failed to fetch user data",
        message: error.message,
      });
    }
  }
);

app.post(
  "/api/user/:userId/increment-usage",
  [
    param("userId").isString().trim().escape(),
    handleValidationErrors,
    verifyFirebaseToken,
  ],
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (req.user.uid !== userId) {
        return res
          .status(403)
          .json({ error: "Forbidden: Cannot modify other user data" });
      }

      const userData = await getUserDocument(userId);

      const TIERS = {
        FREEMIUM: { name: "Freemium", limit: 2 },
        BASIC: { name: "Basic", limit: 5 },
        PREMIUM: { name: "Premium", limit: 10 },
        PREMIUM_PLUS: { name: "Premium+", limit: -1 },
      };

      const tier = TIERS[userData.tier];
      const canGenerate = tier.limit === -1 || userData.usageCount < tier.limit;

      if (!canGenerate) {
        return res.status(403).json({
          error: "Usage limit exceeded",
          usageCount: userData.usageCount,
          limit: tier.limit,
          tier: userData.tier,
        });
      }

      const newUsageCount = userData.usageCount + 1;
      await updateUserDocument(userId, { usageCount: newUsageCount });

      res.json({
        success: true,
        usageCount: newUsageCount,
        tier: userData.tier,
        canGenerate: tier.limit === -1 || newUsageCount < tier.limit,
      });
    } catch (error) {
      logger.error("Error incrementing usage:", error);
      res.status(500).json({
        error: "Failed to increment usage",
        message: error.message,
      });
    }
  }
);

app.post(
  "/api/user/:userId/reset-usage",
  [
    param("userId").isString().trim().escape(),
    handleValidationErrors,
    verifyFirebaseToken,
  ],
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (req.user.uid !== userId) {
        return res
          .status(403)
          .json({ error: "Forbidden: Cannot modify other user data" });
      }

      await updateUserDocument(userId, { usageCount: 0 });

      res.json({
        success: true,
        message: "Usage count reset successfully",
      });
    } catch (error) {
      logger.error("Error resetting usage:", error);
      res.status(500).json({
        error: "Failed to reset usage",
        message: error.message,
      });
    }
  }
);

// ============ STRIPE ENDPOINTS ============
app.post(
  "/api/create-checkout-session",
  [
    body("priceId").isString().trim(),
    body("planName").isString().trim().escape(),
    body("userId").isString().trim().escape(),
    body("userEmail").isEmail().normalizeEmail(),
    handleValidationErrors,
  ],
  async (req, res) => {
    try {
      const { priceId, planName, userId, userEmail } = req.body;

      const frontendUrls = process.env.FRONTEND_URLS.split(",");
      const productionUrl = frontendUrls.find((url) =>
        url.includes("https://")
      );
      const frontendUrl = (productionUrl || frontendUrls[0]).replace(/\/$/, "");

      logger.info("Creating checkout session:", {
        userId,
        planName,
        userEmail,
      });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: "subscription",
        success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}/pricing`,
        customer_email: userEmail,
        metadata: {
          userId: userId,
          planName: planName,
        },
        billing_address_collection: "auto",
        subscription_data: {
          trial_period_days: 7,
          metadata: {
            userId: userId,
            planName: planName,
          },
        },
      });

      res.json({
        sessionId: session.id,
        url: session.url,
      });
    } catch (error) {
      logger.error("Error creating checkout session:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

app.post("/api/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error(`Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        const session = event.data.object;
        logger.info("Payment succeeded:", {
          sessionId: session.id,
          userId: session.metadata?.userId,
        });

        if (session.metadata?.userId) {
          const tierMap = {
            Basic: "BASIC",
            Premium: "PREMIUM",
            "Premium+": "PREMIUM_PLUS",
          };

          const tier = tierMap[session.metadata.planName] || "PREMIUM";

          await updateUserDocument(session.metadata.userId, {
            tier,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            subscriptionStatus: "active",
            usageCount: 0,
          });

          logger.info(
            `Updated user ${session.metadata.userId} to tier ${tier}`
          );
        }
        break;

      case "invoice.payment_succeeded":
        const invoice = event.data.object;
        logger.info("Recurring payment succeeded:", invoice.id);

        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(
            invoice.subscription
          );
          if (subscription.metadata?.userId) {
            await updateUserDocument(subscription.metadata.userId, {
              subscriptionStatus: "active",
            });
          }
        }
        break;

      case "customer.subscription.deleted":
        const deletedSubscription = event.data.object;
        logger.info("Subscription cancelled:", deletedSubscription.id);

        if (deletedSubscription.metadata?.userId) {
          await updateUserDocument(deletedSubscription.metadata.userId, {
            tier: "FREEMIUM",
            subscriptionStatus: "cancelled",
            stripeSubscriptionId: null,
          });

          logger.info(
            `Downgraded user ${deletedSubscription.metadata.userId} to FREEMIUM`
          );
        }
        break;

      case "customer.subscription.updated":
        const updatedSubscription = event.data.object;
        logger.info("Subscription updated:", updatedSubscription.id);

        if (updatedSubscription.metadata?.userId) {
          const status =
            updatedSubscription.status === "active" ? "active" : "inactive";
          await updateUserDocument(updatedSubscription.metadata.userId, {
            subscriptionStatus: status,
          });
        }
        break;

      default:
        logger.info(`Unhandled event type ${event.type}`);
    }
  } catch (error) {
    logger.error("Error processing webhook:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }

  res.json({ received: true });
});

app.post(
  "/api/verify-session",
  [body("sessionId").isString().trim(), handleValidationErrors],
  async (req, res) => {
    try {
      const { sessionId } = req.body;

      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["line_items", "customer", "subscription"],
      });

      if (session.payment_status !== "paid") {
        return res.status(400).json({
          error: "Payment not completed",
          payment_status: session.payment_status,
        });
      }

      const planName = session.metadata?.planName || "Premium";
      const userId = session.metadata?.userId;

      if (userId) {
        const tierMap = {
          Basic: "BASIC",
          Premium: "PREMIUM",
          "Premium+": "PREMIUM_PLUS",
        };

        const tier = tierMap[planName] || "PREMIUM";

        await updateUserDocument(userId, {
          tier,
          stripeCustomerId: session.customer,
          stripeSubscriptionId:
            session.subscription?.id || session.subscription,
          subscriptionStatus: "active",
          usageCount: 0,
        });
      }

      const safeSessionData = {
        id: session.id,
        planName: planName,
        amount_total: session.amount_total,
        currency: session.currency,
        status: session.status,
        payment_status: session.payment_status,
        customer_email:
          session.customer_details?.email || session.customer_email,
        customer_id: session.customer,
        userId: userId,
        created: session.created,
        subscription_id: session.subscription?.id || session.subscription,
      };

      logger.info("Session verified successfully:", {
        sessionId: session.id,
        userId: userId,
        payment_status: session.payment_status,
      });

      res.json(safeSessionData);
    } catch (error) {
      logger.error("Error verifying session:", error);
      res.status(500).json({
        error: "Failed to verify session",
        message: error.message,
      });
    }
  }
);

app.post(
  "/api/cancel-subscription",
  [
    body("userId").isString().trim().escape(),
    body("customerId").optional().isString().trim(),
    body("subscriptionId").optional().isString().trim(),
    handleValidationErrors,
    verifyFirebaseToken,
  ],
  async (req, res) => {
    try {
      const { customerId, subscriptionId, userId } = req.body;

      if (req.user.uid !== userId) {
        return res
          .status(403)
          .json({ error: "Forbidden: Cannot cancel other user subscription" });
      }

      if (!customerId && !subscriptionId) {
        return res.status(400).json({
          error: "Either customerId or subscriptionId is required",
        });
      }

      let subscription;

      if (subscriptionId) {
        subscription = await stripe.subscriptions.cancel(subscriptionId);
        logger.info(
          `Cancelled subscription ${subscriptionId} for user ${userId}`
        );
      } else if (customerId) {
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          status: "active",
        });

        if (subscriptions.data.length === 0) {
          return res.status(404).json({
            error: "No active subscriptions found for this customer",
          });
        }

        subscription = await stripe.subscriptions.cancel(
          subscriptions.data[0].id
        );
        logger.info(
          `Cancelled subscription ${subscriptions.data[0].id} for customer ${customerId}`
        );
      }

      await updateUserDocument(userId, {
        tier: "FREEMIUM",
        subscriptionStatus: "cancelled",
        stripeSubscriptionId: null,
      });

      res.json({
        success: true,
        message: "Subscription cancelled successfully",
        subscription: {
          id: subscription.id,
          status: subscription.status,
          canceled_at: subscription.canceled_at,
        },
      });
    } catch (error) {
      logger.error("Error cancelling subscription:", error);
      res.status(500).json({
        error: "Failed to cancel subscription",
        message: error.message,
      });
    }
  }
);

// ============ AI GENERATION ENDPOINTS ============
const chatFeedbackPrompt = `
You are a professional resume and cover letter writer. You're receiving user feedback to improve their document. 
The user will provide:
1. Their resume
2. A job description
3. The current version of their document (resume or cover letter)
4. Their feedback on how to improve it

Your task is to carefully analyze the feedback and regenerate the document incorporating the user's suggestions.
Only output the complete HTML document with CSS styling - no explanations or surrounding text.

Remember to:
- Preserve the professional formatting and style
- Implement ALL the user's requested changes
- Maintain the overall structure while improving the content
- Make sure the document remains tailored to the specific job description

The output should be a complete, standalone HTML document ready for display.
`;

const questionGenerationPrompt = `
You are an expert interview coach and hiring manager. Based on the provided job description, generate a comprehensive list of interview questions that a company would typically ask for this role.

Please organize the questions into the following categories:
1. General/Behavioral Questions (5-7 questions)
2. Technical/Role-Specific Questions (7-10 questions) 
3. Company Culture/Situational Questions (4-6 questions)
4. Advanced/Problem-Solving Questions (3-5 questions)

For each question, also provide:
- The question text
- A brief hint about what the interviewer is looking for
- The difficulty level (Easy, Medium, Hard)

Return the response as a JSON object with this structure:
{
  "categories": [
    {
      "name": "General/Behavioral Questions",
      "questions": [
        {
          "question": "Tell me about yourself.",
          "hint": "Looking for concise professional summary and career highlights",
          "difficulty": "Easy"
        }
      ]
    }
  ]
}

Only return the JSON object, no additional text or explanation.
`;

app.post("/api/create-resume", async (req, res) => {
  try {
    const { jobDescription } = req.body;

    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Claude API key not configured" });
    }

    const isFeedbackRequest =
      jobDescription.includes("USER FEEDBACK") &&
      jobDescription.includes("CURRENT RESUME");

    const systemPrompt = isFeedbackRequest
      ? chatFeedbackPrompt
      : resumeSystemPrompt;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: jobDescription,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
      }
    );

    return res.json(response.data);
  } catch (error) {
    logger.error("Resume generation error:", error);
    return res.status(500).json({
      error: error.message || "Unknown error occurred",
    });
  }
});

app.post("/api/create-cover-letter", async (req, res) => {
  try {
    const { jobDescription } = req.body;

    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Claude API key not configured" });
    }

    const isFeedbackRequest =
      jobDescription.includes("USER FEEDBACK") &&
      jobDescription.includes("CURRENT COVER LETTER");

    const systemPrompt = isFeedbackRequest
      ? chatFeedbackPrompt
      : coverLetterSystemPrompt;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: jobDescription,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
      }
    );

    return res.json(response.data);
  } catch (error) {
    logger.error("Cover letter generation error:", error);
    return res.status(500).json({
      error:
        error.message ||
        "Unknown error occurred during cover letter generation",
    });
  }
});

app.post("/api/generate-questions", async (req, res) => {
  try {
    const { jobDescription } = req.body;

    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Claude API key not configured" });
    }

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        system: questionGenerationPrompt,
        messages: [
          {
            role: "user",
            content: `Please generate interview questions for this job posting:\n\n${jobDescription}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
      }
    );

    return res.json(response.data);
  } catch (error) {
    logger.error("Question generation error:", error);
    return res.status(500).json({
      error:
        error.message || "Unknown error occurred during question generation",
    });
  }
});

// Compensation analysis system prompt
const compensationAnalysisPrompt = `
You are an expert HR compensation analyst. Based on the provided job description, analyze and provide comprehensive compensation benchmarking data.

Please structure your response as a JSON object with the following format:
{
  "overview": {
    "position": "Job title extracted from description",
    "industry": "Industry sector",
    "averageSalary": 85000,
    "minSalary": 65000,
    "maxSalary": 110000,
    "trend": "Growing" | "Stable" | "Declining",
    "insights": [
      "Market insight 1",
      "Market insight 2",
      "Market insight 3"
    ]
  },
  "levels": [
    {
      "level": "Entry",
      "experience": "0-2 years",
      "minSalary": 55000,
      "maxSalary": 75000,
      "averageSalary": 65000
    },
    {
      "level": "Mid",
      "experience": "3-5 years", 
      "minSalary": 75000,
      "maxSalary": 95000,
      "averageSalary": 85000
    },
    {
      "level": "Senior",
      "experience": "6+ years",
      "minSalary": 95000,
      "maxSalary": 130000,
      "averageSalary": 110000
    }
  ],
  "locations": [
    {
      "city": "San Francisco",
      "state": "CA",
      "minSalary": 90000,
      "maxSalary": 140000,
      "averageSalary": 115000,
      "costOfLiving": 180,
      "jobCount": 245
    },
    {
      "city": "Austin",
      "state": "TX", 
      "minSalary": 70000,
      "maxSalary": 100000,
      "averageSalary": 85000,
      "costOfLiving": 110,
      "jobCount": 156
    }
  ],
  "benefits": [
    {
      "name": "Health Insurance",
      "value": "$8,000-$15,000/year",
      "icon": "🏥"
    },
    {
      "name": "401(k) Match",
      "value": "4-6% company match",
      "icon": "💰"
    },
    {
      "name": "PTO",
      "value": "15-25 days",
      "icon": "🏖️"
    },
    {
      "name": "Remote Work",
      "value": "Hybrid/Full Remote",
      "icon": "🏠"
    }
  ]
}

Provide realistic salary ranges based on current market data. Include 3-5 major locations with varying cost of living. Add 4-6 common benefits for this type of role.

Only return the JSON object, no additional text or explanation.
`;

// Perplexity API endpoint for compensation data
app.post("/api/generate-compensation", async (req, res) => {
  try {
    const { jobDescription } = req.body;
    console.log(
      "Compensation analysis - Job Description received length:",
      jobDescription ? jobDescription.length : 0
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Get API key from environment variable
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "Perplexity API key not configured" });
    }

    // Extract job title and key details for targeted search
    const jobTitleMatch =
      jobDescription.match(/(?:job title|position|role):\s*([^\n]+)/i) ||
      jobDescription.match(/^([^\n]+)/);
    const jobTitle = jobTitleMatch
      ? jobTitleMatch[1].trim()
      : "Software Developer";

    // Create search query for Perplexity
    const searchQuery = `Current salary ranges and compensation data for ${jobTitle} position in 2024-2025. Include salary by experience level (entry, mid, senior), major US cities, industry trends, and common benefits packages.`;

    // Call Perplexity API for real-time compensation data
    const perplexityResponse = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "llama-3.1-sonar-small-128k-online",
        messages: [
          {
            role: "system",
            content: compensationAnalysisPrompt,
          },
          {
            role: "user",
            content: `Search for current compensation data: ${searchQuery}\n\nJob Description: ${jobDescription}`,
          },
        ],
        max_tokens: 2000,
        temperature: 0.2,
        top_p: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Format response to match expected structure
    const responseData = {
      content: [
        {
          text: perplexityResponse.data.choices[0].message.content,
        },
      ],
    };

    return res.json(responseData);
  } catch (error) {
    console.error("Compensation analysis error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

    return res.status(500).json({
      error:
        error.message || "Unknown error occurred during compensation analysis",
    });
  }
});
// Company Insights API endpoint
app.post("/api/generate-company-insights", async (req, res) => {
  try {
    const { jobDescription } = req.body;
    console.log(
      "Company insights analysis - Job Description received length:",
      jobDescription ? jobDescription.length : 0
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Get API key from environment variable
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "Perplexity API key not configured" });
    }

    // Extract company name from job description
    const companyNameMatch =
      jobDescription.match(/(?:company|organization|employer):\s*([^\n]+)/i) ||
      jobDescription.match(
        /at\s+([A-Z][a-zA-Z\s&.,]+?)(?:\s+is|\s+seeks|\s+looking)/i
      ) ||
      jobDescription.match(
        /([A-Z][a-zA-Z\s&.,]+?)\s+is\s+(?:seeking|looking|hiring)/i
      );

    const companyName = companyNameMatch
      ? companyNameMatch[1].trim().replace(/[.,]$/, "")
      : "the company";

    // Create comprehensive search query for company insights
    const searchQuery = `${companyName} company reviews employee ratings Glassdoor Indeed LinkedIn company culture benefits workplace insights testimonials 2024 2025`;

    // System prompt for company insights analysis
    const companyInsightsPrompt = `You are a professional company research analyst. Based on the search results, create a comprehensive company insights report in JSON format. 

IMPORTANT: Return ONLY valid JSON without any markdown formatting, code blocks, or additional text.

The JSON should have this exact structure:
{
  "overview": {
    "companyName": "Company Name",
    "industry": "Industry Type",
    "companySize": "Employee count or size category",
    "founded": "Year founded (if available)",
    "description": "Brief company description"
  },
  "ratings": [
    {
      "platform": "Platform name (e.g., Glassdoor, Indeed, LinkedIn)",
      "rating": 4.2,
      "reviewCount": "Number of reviews",
      "recommendationRate": "Percentage who recommend (if available)"
    }
  ],
  "reviews": [
    {
      "title": "Review title or summary",
      "role": "Employee role/position",
      "rating": 4.0,
      "pros": "Positive aspects mentioned",
      "cons": "Negative aspects mentioned"
    }
  ],
  "culture": {
    "values": ["Value 1", "Value 2", "Value 3"],
    "benefits": ["Benefit 1", "Benefit 2", "Benefit 3"],
    "workEnvironment": "Description of work environment and culture"
  },
  "insights": [
    {
      "icon": "📈",
      "title": "Growth & Opportunities",
      "description": "Career development and growth opportunities"
    },
    {
      "icon": "💰",
      "title": "Compensation & Benefits",
      "description": "Salary competitiveness and benefits package"
    },
    {
      "icon": "🏢",
      "title": "Work-Life Balance",
      "description": "Work-life balance and flexibility"
    },
    {
      "icon": "👥",
      "title": "Team & Management",
      "description": "Management quality and team dynamics"
    }
  ]
}

Focus on providing accurate, recent information. If specific data is not available, use reasonable defaults or indicate "N/A". Ensure all ratings are numerical values between 1.0 and 5.0.`;

    // Call Perplexity API for real-time company data
    const perplexityResponse = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "llama-3.1-sonar-small-128k-online",
        messages: [
          {
            role: "system",
            content: companyInsightsPrompt,
          },
          {
            role: "user",
            content: `Search for comprehensive company insights: ${searchQuery}\n\nJob Description Context: ${jobDescription}`,
          },
        ],
        max_tokens: 3000,
        temperature: 0.3,
        top_p: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Get the response content
    const responseContent = perplexityResponse.data.choices[0].message.content;

    // Try to parse the JSON response
    let parsedData;
    try {
      // Remove any potential markdown formatting
      const cleanedContent = responseContent
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      parsedData = JSON.parse(cleanedContent);
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      // Fallback response if JSON parsing fails
      parsedData = {
        overview: {
          companyName: companyName,
          industry: "Technology",
          companySize: "Not specified",
          founded: "N/A",
          description:
            "Company information could not be retrieved at this time.",
        },
        ratings: [
          {
            platform: "Glassdoor",
            rating: 3.5,
            reviewCount: "N/A",
            recommendationRate: "N/A",
          },
        ],
        reviews: [
          {
            title: "General Employee Feedback",
            role: "Various Positions",
            rating: 3.5,
            pros: "Information not available",
            cons: "Information not available",
          },
        ],
        culture: {
          values: ["Innovation", "Collaboration", "Excellence"],
          benefits: ["Health Insurance", "Retirement Plan", "Paid Time Off"],
          workEnvironment: "Company culture information not available",
        },
        insights: [
          {
            icon: "📈",
            title: "Growth & Opportunities",
            description: "Career development information not available",
          },
          {
            icon: "💰",
            title: "Compensation & Benefits",
            description: "Compensation information not available",
          },
          {
            icon: "🏢",
            title: "Work-Life Balance",
            description: "Work-life balance information not available",
          },
          {
            icon: "👥",
            title: "Team & Management",
            description: "Management information not available",
          },
        ],
      };
    }

    // Format response to match expected structure
    const responseData = {
      content: [
        {
          text: JSON.stringify(parsedData),
        },
      ],
    };

    return res.json(responseData);
  } catch (error) {
    console.error("Company insights analysis error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

    return res.status(500).json({
      error:
        error.message ||
        "Unknown error occurred during company insights analysis",
    });
  }
});

// Keywords analysis prompt for system message
const keywordsAnalysisPrompt = `You are an expert resume and job matching analyst. Your task is to analyze job descriptions and resume analysis results to identify matching keywords and their strategic importance.

Focus ONLY on keywords that appear in BOTH the job description AND the resume analysis results. Do not mention missing keywords.

IMPORTANT: Format your response as a simple list where each line follows this exact pattern:
Keyword: Brief explanation of why this match is strategically important

Examples:
React: Demonstrates proficiency in the primary frontend framework required for this role
Project Management: Shows leadership experience that aligns with the role's management responsibilities
Agile: Indicates familiarity with the development methodology used by the team

Do not use headers, sections, or bullet points. Just provide a clean list of keywords with their analysis, one per line.

Focus on:
- Technical skills that match
- Soft skills that align
- Qualifications that correspond
- Industry terms that overlap

Keep explanations concise but valuable for ATS optimization and strategic positioning.`;

// Perplexity API endpoint for keywords analysis
app.post("/api/generate-keywords", async (req, res) => {
  try {
    const { jobDescription, analysisResults } = req.body;
    console.log(
      "Keywords analysis - Job Description received length:",
      jobDescription ? jobDescription.length : 0,
      "Analysis Results available:",
      !!analysisResults
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Check if analysis results are provided
    if (!analysisResults) {
      return res.status(400).json({
        error: "Analysis results are required for keyword comparison",
      });
    }

    // Get API key from environment variable
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "Perplexity API key not configured" });
    }

    // Extract job title for better context
    const jobTitleMatch =
      jobDescription.match(/(?:job title|position|role):\s*([^\n]+)/i) ||
      jobDescription.match(/^([^\n]+)/);
    const jobTitle = jobTitleMatch
      ? jobTitleMatch[1].trim()
      : "Software Developer";

    // Create analysis content combining job description and existing analysis
    const analysisContent = `
Job Title: ${jobTitle}

Job Description:
${jobDescription}

Resume Analysis Results:
${JSON.stringify(analysisResults, null, 2)}

Please analyze and identify ONLY the keywords that appear in BOTH the job description and the resume analysis results. Return each keyword with its analysis on a separate line using the format: "Keyword: Analysis"`;

    // Call Perplexity API for keywords analysis
    const perplexityResponse = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "llama-3.1-sonar-small-128k-online",
        messages: [
          {
            role: "system",
            content: keywordsAnalysisPrompt,
          },
          {
            role: "user",
            content: analysisContent,
          },
        ],
        max_tokens: 2000,
        temperature: 0.2,
        top_p: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Format response to match expected structure
    const responseData = {
      content: [
        {
          text: perplexityResponse.data.choices[0].message.content,
        },
      ],
    };

    return res.json(responseData);
  } catch (error) {
    console.error("Keywords analysis error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

    return res.status(500).json({
      error: error.message || "Unknown error occurred during keywords analysis",
    });
  }
});

app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "production"
        ? "Something went wrong"
        : error.message,
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `Route ${req.originalUrl} not found`,
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    logger.info("Process terminated");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received. Shutting down gracefully...");
  server.close(() => {
    logger.info("Process terminated");
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  logger.info(`Frontend URLs: ${process.env.FRONTEND_URLS}`);

  console.log("Environment check:", {
    has_stripe_key: !!process.env.STRIPE_SECRET_KEY,
    has_frontend_urls: !!process.env.FRONTEND_URLS,
    has_firebase_key: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
    has_claude_key: !!process.env.CLAUDE_API_KEY,
    node_env: process.env.NODE_ENV,
  });
});

module.exports = app;
