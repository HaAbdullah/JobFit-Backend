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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
