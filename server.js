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

    // Call Claude API with the combined job description and resume
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        system: resumeSystemPrompt,
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

// New Claude API endpoint for cover letter generation
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

    // Call Claude API with the job description and resume for cover letter generation
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        system: coverLetterSystemPrompt,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
