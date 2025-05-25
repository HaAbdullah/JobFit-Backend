const fs = require("fs");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
