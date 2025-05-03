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
const systemPrompt = fs.readFileSync("./Instructions.txt", "utf8");

// Health check endpoint
app.get("/", (req, res) => {
  res.send("API is running");
});

// Claude API endpoint
app.post("/api/create-bullets", async (req, res) => {
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

    //     // Prepare the system prompt to ensure a 3-line summary
    //     const systemPrompt = `You are a resume bullet point generator that creates 3 tailored bullet points matching a user's experience to job descriptions.

    // INPUT FORMAT:
    // - Resume information under "RESUME:" header
    // - Job listing under "JOB DESCRIPTION:" header

    // OUTPUT REQUIREMENTS:
    // 1. Produce EXACTLY 3 concise, single-sentence bullet points
    // 2. Focus on matching user's experience with key job requirements
    // 3. Prioritize mentioning skills/qualifications from the job description
    // 4. Format output as complete HTML with properly structured:
    //    - Job description section that includes the ENTIRE job description provided by the user
    //    - 3 bullet points using <ul> and <li> tags
    // 5. No explanations, commentary, or additional text

    // PRIORITIES:
    // - Highlight transferable skills that match the job description
    // - Emphasize relevant experience that aligns with role responsibilities
    // - Include keywords from job qualifications in the bullet points
    // - Use action verbs and quantifiable achievements when possible `;
    // Call Claude API with the combined job description and resume
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-5-sonnet-20241022",
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
