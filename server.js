const fs = require("fs");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// For comma-separated approach
const allowedOrigins = process.env.FRONTEND_URLS?.split(",") || [
  "http://localhost:8888",
];

// For CORS middleware
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Fix: Use STRIPE_SECRET_KEY instead of VITE_STRIPE_SECRET_KEY
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, planName, userId, userEmail } = req.body;

    // Get frontend URLs
    const frontendUrls = process.env.FRONTEND_URLS.split(",");
    const localhostUrl = frontendUrls.find(
      (url) => url.includes("localhost") || url.includes("127.0.0.1")
    );
    const productionUrl = frontendUrls.find((url) => url.includes("https://"));

    // Better localhost detection
    const isLocalhost =
      process.env.NODE_ENV === "development" ||
      process.env.PORT === "3000" ||
      process.env.PORT === 3000 ||
      req.get("host")?.includes("localhost") ||
      req.get("host")?.includes("127.0.0.1") ||
      req.headers.origin?.includes("localhost") ||
      req.headers.referer?.includes("localhost");

    // Select the appropriate frontend URL
    let frontendUrl;
    if (isLocalhost && localhostUrl) {
      frontendUrl = localhostUrl;
    } else {
      frontendUrl = productionUrl || frontendUrls[0];
    }

    // Remove trailing slash if present
    frontendUrl = frontendUrl.replace(/\/$/, "");

    // Comprehensive logging
    console.log("=== DEBUGGING URL SELECTION ===");
    console.log("Request host:", req.get("host"));
    console.log("Request origin:", req.headers.origin);
    console.log("Request referer:", req.headers.referer);
    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("PORT:", process.env.PORT, "Type:", typeof process.env.PORT);
    console.log("isLocalhost:", isLocalhost);
    console.log("FRONTEND_URLS:", process.env.FRONTEND_URLS);
    console.log("Frontend URLs array:", frontendUrls);
    console.log("Localhost URL:", localhostUrl);
    console.log("Production URL:", productionUrl);
    console.log("Selected frontend URL:", frontendUrl);
    console.log("Final success URL:", `${frontendUrl}/success`);
    console.log("================================");

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

    // Final verification
    console.log(
      "Stripe session created with success_url:",
      session.success_url
    );

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).json({ error: error.message });
  }
});

// Optional: Add webhook endpoint to handle successful payments
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(`Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed":
        const session = event.data.object;
        console.log("Payment succeeded:", session);

        // Update user's subscription status in your database
        // updateUserSubscription(session.metadata.userId, session.metadata.planName);
        break;

      case "invoice.payment_succeeded":
        // Handle successful recurring payments
        console.log("Recurring payment succeeded");
        break;

      case "customer.subscription.deleted":
        // Handle subscription cancellation
        console.log("Subscription cancelled");
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Add this endpoint to your backend server
// This allows the success page to fetch session details
app.get("/api/checkout-session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Retrieve the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "customer"],
    });

    // Only return safe data to the frontend
    const safeSessionData = {
      id: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      status: session.status,
      payment_status: session.payment_status,
      customer_details: session.customer_details,
      metadata: session.metadata,
      created: session.created,
      line_items: session.line_items
        ? session.line_items.data.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            amount_total: item.amount_total,
          }))
        : [],
    };

    res.json(safeSessionData);
  } catch (error) {
    console.error("Error retrieving session:", error);
    res.status(500).json({ error: "Failed to retrieve session details" });
  }
});

// Handle successful subscription (webhook)
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.log(`Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed":
        const session = event.data.object;
        // Update user subscription in your database
        console.log("Subscription successful:", session);
        break;
      case "invoice.payment_succeeded":
        // Handle successful payment
        break;
      case "customer.subscription.deleted":
        // Handle subscription cancellation
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Add a health check endpoint to verify environment variables
app.get("/api/health", (req, res) => {
  const frontendUrls = process.env.FRONTEND_URLS?.split(",") || [];
  const localhostUrl = frontendUrls.find(
    (url) => url.includes("localhost") || url.includes("127.0.0.1")
  );
  const productionUrl = frontendUrls.find((url) => url.includes("https://"));

  res.json({
    status: "ok",
    env_check: {
      has_stripe_key: !!process.env.STRIPE_SECRET_KEY,
      has_frontend_urls: !!process.env.FRONTEND_URLS,
      frontend_urls: frontendUrls,
      localhost_url: localhostUrl,
      production_url: productionUrl,
      node_env: process.env.NODE_ENV,
      port: process.env.PORT,
    },
  });
});

// Load instruction files
const resumeSystemPrompt = fs.readFileSync("./Resume-Instructions.txt", "utf8");
const coverLetterSystemPrompt = fs.readFileSync(
  "./Cover-Letter-Instructions.txt",
  "utf8"
);

// Chat feedback system prompt for focused document regeneration
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

// Question generation system prompt
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

// Health check endpoint
app.get("/", (req, res) => {
  res.send("API is running");
});

// Claude API endpoint for resume generation
app.post("/api/create-resume", async (req, res) => {
  try {
    const { jobDescription } = req.body;
    console.log(
      "Job Description received length:",
      jobDescription ? jobDescription.length : 0
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Get API key from environment variable
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Determine if this is a regeneration with feedback
    const isFeedbackRequest =
      jobDescription.includes("USER FEEDBACK") &&
      jobDescription.includes("CURRENT RESUME");

    // Use the appropriate system prompt
    const systemPrompt = isFeedbackRequest
      ? chatFeedbackPrompt
      : resumeSystemPrompt;

    // Call Claude API with the combined job description and resume
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
    console.error("Error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

    return res.status(500).json({
      error: error.message || "Unknown error occurred",
    });
  }
});

// Claude API endpoint for cover letter generation
app.post("/api/create-cover-letter", async (req, res) => {
  try {
    const { jobDescription } = req.body;
    console.log(
      "Cover Letter job description received length:",
      jobDescription ? jobDescription.length : 0
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Get API key from environment variable
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Determine if this is a regeneration with feedback
    const isFeedbackRequest =
      jobDescription.includes("USER FEEDBACK") &&
      jobDescription.includes("CURRENT COVER LETTER");

    // Use the appropriate system prompt
    const systemPrompt = isFeedbackRequest
      ? chatFeedbackPrompt
      : coverLetterSystemPrompt;

    // Call Claude API with the job description and resume for cover letter generation
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
    console.error("Cover letter generation error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

    return res.status(500).json({
      error:
        error.message ||
        "Unknown error occurred during cover letter generation",
    });
  }
});

// Claude API endpoint for question generation
app.post("/api/generate-questions", async (req, res) => {
  try {
    const { jobDescription } = req.body;
    console.log(
      "Question generation - Job Description received length:",
      jobDescription ? jobDescription.length : 0
    );

    // Check if job description is empty or undefined
    if (!jobDescription || jobDescription.trim() === "") {
      return res.status(400).json({ error: "Job description cannot be empty" });
    }

    // Get API key from environment variable
    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Call Claude API for question generation
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
    console.error("Question generation error:", error.message);

    // Add more detailed error logging
    if (error.response) {
      console.error("API response status:", error.response.status);
      console.error("API response data:", error.response.data);
    }

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const frontendUrls = process.env.FRONTEND_URLS?.split(",") || [];
  const productionUrl =
    frontendUrls.find((url) => url.includes("https://")) || frontendUrls[0];

  console.log("Environment check:", {
    has_stripe_key: !!process.env.STRIPE_SECRET_KEY,
    has_frontend_urls: !!process.env.FRONTEND_URLS,
    frontend_urls: frontendUrls,
    production_url_for_stripe: productionUrl,
  });
});

module.exports = app;
