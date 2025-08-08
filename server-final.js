const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

// Google Sheets integration
const { google } = require('googleapis');
let sheetsClient = null;

// Initialize Google Sheets client
try {
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
    const credentials = {
      type: 'service_account',
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets integration available');
  } else {
    console.log('Google Sheets credentials not found - using mock data');
  }
} catch (error) {
  console.log('Google Sheets setup error:', error.message);
}

const app = express();
const PORT = process.env.PORT || 8080;

// Simple in-memory cache for evaluations and tracking saves
const evaluationCache = new Map();
const savedToSheets = new Set(); // Track which evaluations have been saved
const processingKeys = new Set(); // Track which evaluations are currently being processed to prevent race conditions

// Clean up old cache entries every 24 hours, but only remove entries older than 30 days
// This provides persistent caching while preventing unlimited memory growth
setInterval(() => {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
  let removedCount = 0;
  
  for (const [key, value] of evaluationCache.entries()) {
    if (value.timestamp && value.timestamp < thirtyDaysAgo) {
      evaluationCache.delete(key);
      // Keep savedToSheets entry to prevent re-saving duplicates even after cache expiry
      removedCount++;
    }
  }
  
  // Only clear savedToSheets if we've cleared ALL cache entries (prevent memory leak)
  // But keep a size limit to prevent unlimited growth
  if (savedToSheets.size > 10000) {
    // If we have over 10,000 tracked saves, clear the oldest ones
    const entriesToKeep = Array.from(savedToSheets).slice(-5000);
    savedToSheets.clear();
    entriesToKeep.forEach(entry => savedToSheets.add(entry));
    console.log('Trimmed savedToSheets set to 5000 most recent entries');
  }
  
  if (removedCount > 0) {
    console.log(`Cache cleanup: Removed ${removedCount} entries older than 30 days`);
  }
  console.log('Cache status: Cache size:', evaluationCache.size, 'Saved entries tracked:', savedToSheets.size);
}, 24 * 60 * 60 * 1000); // Run cleanup once per day

// Database connection handled above with error checking

// Initialize database
async function initializeDatabase() {
  if (!pool) {
    console.log('Database not available - skipping initialization');
    return;
  }
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id SERIAL PRIMARY KEY,
        ticket_id VARCHAR(50) NOT NULL,
        ticket_number VARCHAR(50),
        agent_name VARCHAR(100) NOT NULL,
        customer_name VARCHAR(200),
        evaluation_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        response_text TEXT NOT NULL,
        conversation_context TEXT,
        overall_score DECIMAL(3,1),
        tone_score DECIMAL(3,1),
        clarity_score DECIMAL(3,1),
        english_score DECIMAL(3,1),
        resolution_score DECIMAL(3,1),
        structure_score DECIMAL(3,1),
        key_improvements JSONB,
        categories JSONB,
        response_length INTEGER
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Save evaluation to Google Sheets
async function saveEvaluation(ticketData, agentName, responseText, evaluation) {
  if (!sheetsClient) {
    console.log('Google Sheets not available - skipping save');
    return;
  }
  
  try {
    const categories = evaluation.categories || {};
    const now = new Date().toISOString();
    
    // Prepare the row data - keeping the same structure that was working
    const rowData = [
      now, // Evaluation_Date
      ticketData.id, // Ticket_ID
      ticketData.number, // Ticket_Number
      agentName, // Agent_Name
      '', // Customer_Name - empty for privacy
      evaluation.overall_score, // Overall_Score
      categories.tone_empathy?.score || 0, // Tone_Score
      categories.clarity_completeness?.score || 0, // Clarity_Score
      categories.standard_of_english?.score || 0, // English_Score
      categories.problem_resolution?.score || 0, // Resolution_Score
      categories.following_structure?.score || 0, // Structure_Score
      (evaluation.key_improvements || []).join('; '), // Key_Improvements
      responseText, // Response_Text - full text
      '', // Conversation_Context - empty for privacy
      responseText.length, // Response_Length
      categories.tone_empathy?.feedback || '', // Tone_Feedback
      categories.clarity_completeness?.feedback || '', // Clarity_Feedback
      categories.standard_of_english?.feedback || '', // English_Feedback
      categories.problem_resolution?.feedback || '', // Resolution_Feedback
      categories.following_structure?.feedback || '' // Structure_Feedback
    ];

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:T',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [rowData]
      }
    });
    
    console.log('Evaluation saved to Google Sheets for ticket:', ticketData.number);
  } catch (error) {
    console.error('Google Sheets save error:', error.message);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to escape HTML content safely
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Help Scout dynamic app endpoint
app.post('/', async (req, res) => {
  try {
    console.log('=== Help Scout Request ===');
    const { ticket, customer, user, mailbox } = req.body;
    
    if (!ticket || !ticket.id) {
      return res.json({
        html: '<div style="padding: 20px;">No ticket data received.</div>'
      });
    }

    // Check if this is a live chat - don't show widget for chats
    // Help Scout generates subjects like "Live chat on Aug 5" for chat conversations
    const isChatConversation = 
      ticket.type === 'chat' || 
      ticket.source?.type === 'chat' || 
      ticket.source?.type === 'beacon' ||
      (typeof ticket.type === 'string' && ticket.type.toLowerCase() === 'chat') ||
      (typeof ticket.source?.type === 'string' && ['chat', 'beacon'].includes(ticket.source.type.toLowerCase())) ||
      (ticket.subject && ticket.subject.startsWith('Live chat on '));

    if (isChatConversation) {
      console.log('Skipping evaluation for live chat conversation');
      return res.json({
        html: `
          <div style="font-family: Arial, sans-serif; padding: 16px; text-align: center; color: #666;">
            <h3 style="margin: 0 0 8px 0; font-size: 14px;">📊 Response Evaluator</h3>
            <p style="margin: 0; font-size: 12px;">Not available for chats</p>
          </div>
        `
      });
    }

    // Get conversation threads from Help Scout API
    const conversation = await getHelpScoutConversation(ticket.id);
    
    if (!conversation) {
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>Could not fetch conversation data.</p>
            <p>Ticket: #${ticket.number}</p>
          </div>
        `
      });
    }

    // Find the latest team response
    console.log('Looking for latest team response...');
    const latestResponse = findLatestTeamResponse(conversation);
    
    if (!latestResponse) {
      console.log('No team response found');
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>No team response found to evaluate.</p>
            <p>Ticket: #${ticket.number}</p>
          </div>
        `
      });
    }

    console.log('Found team response, length:', latestResponse.text?.length || 0);

    // Create cache key from ticket and a hash of the response text for true uniqueness
    const crypto = require('crypto');
    const responseHash = crypto.createHash('md5').update(latestResponse.text).digest('hex').substring(0, 8);
    const cacheKey = `${ticket.id}_${responseHash}`;
    console.log('Cache key:', cacheKey, 'Thread ID:', latestResponse.threadId);
    
    // Check if this evaluation is already being processed (race condition prevention)
    if (processingKeys.has(cacheKey)) {
      console.log('Evaluation already in progress for cache key:', cacheKey, '- returning processing message');
      return res.json({
        html: `
          <div style="font-family: Arial, sans-serif; padding: 16px;">
            <h3>📊 Response Evaluation</h3>
            <div style="text-align: center; padding: 12px; background: #f0f8ff; border-radius: 4px;">
              <p style="margin: 4px 0;"><strong>Status:</strong> Processing...</p>
              <p style="font-size: 10px; color: #666; margin: 4px 0;">Please refresh to view results</p>
            </div>
          </div>
        `
      });
    }
    
    // Check if we already have results
    if (evaluationCache.has(cacheKey)) {
      console.log('Returning cached evaluation results for:', cacheKey);
      const evaluation = evaluationCache.get(cacheKey);
      console.log('Cached evaluation score:', evaluation.overall_score, 'Key improvements:', evaluation.key_improvements?.length || 0);
      
      // Cached results should NOT trigger additional saves - they were already saved when first created
      console.log('Using cached results - no additional save needed for cache key:', cacheKey);
      
      // Build detailed results HTML
      let categoriesHTML = '';
      if (evaluation.categories) {
        const cats = evaluation.categories;
        if (cats.tone_empathy) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Tone & Empathy:</strong> ${cats.tone_empathy.score}/10 - ${cats.tone_empathy.feedback}</p>`;
        if (cats.clarity_completeness) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Clarity:</strong> ${cats.clarity_completeness.score}/10 - ${cats.clarity_completeness.feedback}</p>`;
        if (cats.standard_of_english) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>English:</strong> ${cats.standard_of_english.score}/10 - ${cats.standard_of_english.feedback}</p>`;
        if (cats.problem_resolution) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Problem Resolution:</strong> ${cats.problem_resolution.score}/10 - ${cats.problem_resolution.feedback}</p>`;
      }
      
      let improvementsHTML = '';
      if (evaluation.key_improvements && evaluation.key_improvements.length > 0) {
        improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #fff9e6; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><ul style="margin: 4px 0; padding-left: 16px;">';
        evaluation.key_improvements.forEach(improvement => {
          improvementsHTML += `<li style="font-size: 10px; margin: 2px 0;">${improvement}</li>`;
        });
        improvementsHTML += '</ul></div>';
      } else {
        improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #f0f8f0; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><span style="font-size: 10px;">No recommendations - excellent response!</span></div>';
      }
      
      const html = `
        <div style="font-family: Arial, sans-serif; padding: 16px; max-width: 350px;">
          <h3 style="margin: 0 0 12px 0;">📊 Response Evaluation</h3>
          <div style="text-align: center; padding: 8px; background: #f0f8f0; border-radius: 4px; margin-bottom: 12px;">
            <strong style="font-size: 16px;">Overall Score: ${evaluation.overall_score}/10</strong>
          </div>
          ${categoriesHTML}
          ${improvementsHTML}
        </div>
      `;
      
      return res.json({ html });
    }
    
    // Get conversation context for database storage
    const conversationContext = getConversationContext(conversation);
    
    // Mark this evaluation as being processed to prevent race conditions
    processingKeys.add(cacheKey);
    console.log('Starting OpenAI evaluation (waiting for completion)...');
    
    try {
      // Race between OpenAI and 7-second timeout
      const evaluation = await Promise.race([
        evaluateResponse(latestResponse, conversation),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Help Scout timeout')), 7000)
        )
      ]);
      
      console.log('OpenAI evaluation completed:', evaluation.overall_score);
      evaluation.timestamp = Date.now();
      evaluationCache.set(cacheKey, evaluation);
      
      // Save to Google Sheets only if not already saved
      if (!savedToSheets.has(cacheKey)) {
        console.log('Saving new evaluation to Google Sheets for cache key:', cacheKey);
        savedToSheets.add(cacheKey);
        const agentName = latestResponse.createdBy?.first || 'Unknown';
        try {
          await saveEvaluation(ticket, agentName, latestResponse.text, evaluation);
        } catch (saveError) {
          console.error('Failed to save evaluation to Google Sheets:', saveError);
          // Remove from savedToSheets so it can be retried
          savedToSheets.delete(cacheKey);
        }
      } else {
        console.log('Skipping Google Sheets save - already saved for cache key:', cacheKey);
      }
      
      // Remove from processing set - evaluation complete
      processingKeys.delete(cacheKey);
      
      // Return complete results immediately - NO REFRESH NEEDED!
      const html = generateEvaluationHTML(evaluation, false, ticket, customer);
      res.json({ html });
      
    } catch (timeoutError) {
      console.log('OpenAI taking too long, falling back to background processing...');
      
      // Start background evaluation for manual refresh
      evaluateResponse(latestResponse, conversation)
        .then(async (evaluation) => {
          console.log('Background evaluation completed:', evaluation.overall_score);
          evaluation.timestamp = Date.now();
          evaluationCache.set(cacheKey, evaluation);
          
          // Save to Google Sheets only if not already saved
          if (!savedToSheets.has(cacheKey)) {
            console.log('Background: Saving new evaluation to Google Sheets for cache key:', cacheKey);
            savedToSheets.add(cacheKey);
            const agentName = latestResponse.createdBy?.first || 'Unknown';
            try {
              await saveEvaluation(ticket, agentName, latestResponse.text, evaluation);
            } catch (saveError) {
              console.error('Background: Failed to save evaluation to Google Sheets:', saveError);
              // Remove from savedToSheets so it can be retried
              savedToSheets.delete(cacheKey);
            }
          } else {
            console.log('Background: Skipping Google Sheets save - already saved for cache key:', cacheKey);
          }
          
          // Remove from processing set - background evaluation complete
          processingKeys.delete(cacheKey);
        })
        .catch(error => {
          console.error('Background evaluation failed:', error.message);
          evaluationCache.set(cacheKey, { overall_score: 0, error: error.message });
          // Remove from processing set even on error
          processingKeys.delete(cacheKey);
        });
      
      // Return processing message for manual refresh
      const html = `
        <div style="font-family: Arial, sans-serif; padding: 16px;">
          <h3>📊 Response Evaluation</h3>
          <div style="text-align: center; padding: 12px; background: #f0f8ff; border-radius: 4px;">
            <p style="margin: 4px 0;"><strong>Status:</strong> Processing with OpenAI...</p>
            <p style="font-size: 10px; color: #666; margin: 4px 0;">Please refresh to view recommendations</p>
          </div>
        </div>
      `;
      
      res.json({ html });
    }

  } catch (error) {
    console.error('Error:', error);
    
    // Clean up processing key on error
    if (typeof cacheKey !== 'undefined') {
      processingKeys.delete(cacheKey);
    }
    
    res.json({
      html: `
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>📊 Response Evaluator</h3>
          <p style="color: red;">Error: ${error.message}</p>
        </div>
      `
    });
  }
});

// Get conversation from Help Scout API
async function getHelpScoutConversation(conversationId) {
  try {
    let accessToken = process.env.HELPSCOUT_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.log('Attempting to get OAuth token...');
      const authResponse = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
        grant_type: 'client_credentials',
        client_id: process.env.HELPSCOUT_APP_ID,
        client_secret: process.env.HELPSCOUT_APP_SECRET
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      accessToken = authResponse.data.access_token;
    }

    console.log('Fetching conversation threads...');
    const threadsResponse = await axios.get(`https://api.helpscout.net/v2/conversations/${conversationId}/threads`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Number of threads:', threadsResponse.data._embedded?.threads?.length || 0);
    
    return {
      _embedded: { threads: threadsResponse.data._embedded?.threads || [] }
    };
    
  } catch (error) {
    console.error('Help Scout API error:', error.response?.data || error.message);
    return null;
  }
}

// Find the most recent response from a team member
function findLatestTeamResponse(conversation) {
  if (!conversation._embedded?.threads) {
    return null;
  }

  const threads = [...conversation._embedded.threads].sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  for (const thread of threads) {
    const isUser = thread.createdBy === 'user' || thread.createdBy?.type === 'user';
    
    if (thread.type === 'message' && isUser && thread.body) {
      console.log('Found team response from:', thread.createdBy?.first || 'Unknown', 'Thread ID:', thread.id);
      return {
        text: thread.body,
        createdAt: thread.createdAt,
        createdBy: thread.createdBy,
        threadId: thread.id
      };
    }
  }

  return null;
}


// Get conversation context for OpenAI evaluation (keep full context for proper evaluation)
function getConversationContext(conversation) {
  if (!conversation._embedded?.threads) return '';
  
  return [...conversation._embedded.threads]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-3) // Last 3 messages for context (reduced from 5)
    .map(thread => {
      const isCustomer = thread.createdBy === 'customer' || thread.createdBy?.type === 'customer';
      const isTeam = thread.createdBy === 'user' || thread.createdBy?.type === 'user';
      const sender = isCustomer ? 'CUSTOMER' : isTeam ? 'TEAM' : 'SYSTEM';
      let text = thread.body ? thread.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      // Truncate very long messages to save tokens
      if (text.length > 500) {
        text = text.substring(0, 500) + '...';
      }
      return `${sender}: ${text}`;
    })
    .filter(msg => msg.length > 10) // Filter out very short messages
    .join('\n\n');
}

// Evaluate response using OpenAI
async function evaluateResponse(response, conversation) {
  
  // Clean the response text by removing HTML tags
  const cleanText = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Get conversation context (full context needed for proper evaluation)
  const conversationContext = getConversationContext(conversation);
  
  const prompt = `Evaluate this support response. Must thank customer, have polite closing, use positive language.

CONTEXT (last 3 messages):
${conversationContext || 'None'}

RESPONSE TO EVALUATE:
"${cleanText.substring(0, 1000)}"

Score (1-10) these 5 criteria with brief feedback:
1. Tone & Empathy (thanks, closing)
2. Clarity (answers questions)
3. English (grammar, spelling)
4. Problem Resolution (solves or investigates well)
5. Structure (greeting, closing)

Only suggest improvements if truly needed. Investigation responses are valid.
For refunds: gathering info before processing is good.

Format as JSON with this structure:
{
  "overall_score": 8.5,
  "categories": {
    "tone_empathy": {
      "score": 9,
      "feedback": "Great empathetic tone, thanked customer at start"
    },
    "clarity_completeness": {
      "score": 8,
      "feedback": "Clear explanation but could be more concise"
    },
    "standard_of_english": {
      "score": 7,
      "feedback": "Could use more natural phrasing in some areas"
    },
    "problem_resolution": {
      "score": 8,
      "feedback": "Addressed the issue but could suggest more alternatives"
    },
    "following_structure": {
      "score": 9,
      "feedback": "Good structure, used correct terminology"
    }
  },
  "key_improvements": [
    "Consider suggesting an alternative approach",
    "Add a link to the relevant documentation"
  ]
}`;

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is missing');
    }

    console.log('Making OpenAI API call...');
    const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo', // Changed from gpt-4 for 90% cost savings
      messages: [
        {
          role: 'system',
          content: 'You are an expert at evaluating customer support responses. Always respond with valid JSON only, no other text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('OpenAI API call successful');
    const content = apiResponse.data.choices[0].message.content;
    return JSON.parse(content);
    
  } catch (error) {
    console.error('OpenAI API error:', error.response?.data || error.message);
    return {
      overall_score: 0,
      categories: {
        tone_empathy: { score: 0, feedback: "Unable to evaluate - API error" },
        clarity_completeness: { score: 0, feedback: "Unable to evaluate - API error" },
        standard_of_english: { score: 0, feedback: "Unable to evaluate - API error" },
        problem_resolution: { score: 0, feedback: "Unable to evaluate - API error" },
        following_structure: { score: 0, feedback: "Unable to evaluate - API error" }
      },
      key_improvements: ["OpenAI API error occurred - check logs for details"],
      error: error.response?.data?.error?.message || error.message
    };
  }
}


// Generate HTML for Help Scout sidebar
function generateEvaluationHTML(evaluation, isShopify, ticket, customer) {
  try {
    // Handle error cases
    if (evaluation.error) {
      return `
        <div style="font-family: Arial, sans-serif; padding: 16px;">
          <h3>📊 Response Evaluation</h3>
          <p style="color: red;">Evaluation Error: ${escapeHtml(evaluation.error)}</p>
        </div>
      `;
    }

    // Build detailed results HTML (same format as cached results)
    let categoriesHTML = '';
    if (evaluation.categories) {
      const cats = evaluation.categories;
      if (cats.tone_empathy) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Tone & Empathy:</strong> ${cats.tone_empathy.score}/10 - ${cats.tone_empathy.feedback}</p>`;
      if (cats.clarity_completeness) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Clarity:</strong> ${cats.clarity_completeness.score}/10 - ${cats.clarity_completeness.feedback}</p>`;
      if (cats.standard_of_english) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>English:</strong> ${cats.standard_of_english.score}/10 - ${cats.standard_of_english.feedback}</p>`;
      if (cats.problem_resolution) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Problem Resolution:</strong> ${cats.problem_resolution.score}/10 - ${cats.problem_resolution.feedback}</p>`;
    }
    
    let improvementsHTML = '';
    if (evaluation.key_improvements && evaluation.key_improvements.length > 0) {
      improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #fff9e6; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><ul style="margin: 4px 0; padding-left: 16px;">';
      evaluation.key_improvements.forEach(improvement => {
        improvementsHTML += `<li style="font-size: 10px; margin: 2px 0;">${improvement}</li>`;
      });
      improvementsHTML += '</ul></div>';
    } else {
      improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #f0f8f0; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><span style="font-size: 10px;">No recommendations - excellent response!</span></div>';
    }
    
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 16px; max-width: 350px;">
        <h3 style="margin: 0 0 12px 0;">📊 Response Evaluation</h3>
        <div style="text-align: center; padding: 8px; background: #f0f8f0; border-radius: 4px; margin-bottom: 12px;">
          <strong style="font-size: 16px;">Overall Score: ${evaluation.overall_score}/10</strong>
        </div>
        ${categoriesHTML}
        ${improvementsHTML}
      </div>
    `;
    
    return html;
    
  } catch (error) {
    console.error('Error generating HTML:', error);
    return `
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p style="color: red;">HTML generation error: ${error.message}</p>
      </div>
    `;
  }
}

// Report endpoint - redirect to Google Sheet
app.get('/report', (req, res) => {
  if (!process.env.GOOGLE_SHEET_ID) {
    return res.json({ 
      error: 'Google Sheets not configured', 
      message: 'All evaluations are being saved to Google Sheets. Please configure GOOGLE_SHEET_ID to access reports.',
      sheet_url: 'https://docs.google.com/spreadsheets/d/1UCy71O0ctbEKoYCyx9wFiKyEfs0zT3jcINVebaALfo8/edit#gid=0'
    });
  }
  
  // Redirect to the Google Sheet
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit#gid=0`;
  res.redirect(sheetUrl);
});

// Generate AI pattern analysis for an agent
async function generatePatternAnalysis(agentName, allImprovements) {
  if (!allImprovements || !process.env.OPENAI_API_KEY) {
    return 'No pattern analysis available';
  }

  try {
    const prompt = `Analyze the following improvement suggestions for support agent "${agentName}" and identify recurring patterns or themes. Be concise (under 100 words):

Improvement suggestions: ${allImprovements}

Focus on:
1. Most common issues
2. Specific areas for improvement
3. Any positive patterns
4. Training recommendations

Provide a brief summary of patterns found.`;

    const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at analyzing customer support feedback to identify training opportunities. Be concise and actionable.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 200
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return apiResponse.data.choices[0].message.content.replace(/"/g, '""'); // Escape quotes for CSV
  } catch (error) {
    console.error('Pattern analysis error:', error);
    return 'Pattern analysis failed';
  }
}

// Test endpoint
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Complete evaluation server with OpenAI!</p>
      <p>Time: ${new Date().toISOString()}</p>
    </div>
  `);
});

// Cache management endpoint
app.get('/cache/clear', (req, res) => {
  const previousSize = evaluationCache.size;
  const previousSavedSize = savedToSheets.size;
  
  evaluationCache.clear();
  savedToSheets.clear();
  processingKeys.clear();
  
  console.log(`Cache cleared! Previous cache size: ${previousSize}, Previous saved tracking: ${previousSavedSize}`);
  
  res.json({
    message: 'Cache cleared successfully',
    previousCacheSize: previousSize,
    previousSavedSize: previousSavedSize,
    timestamp: new Date().toISOString()
  });
});

// Cache status endpoint
app.get('/cache/status', (req, res) => {
  res.json({
    cacheSize: evaluationCache.size,
    savedToSheetsSize: savedToSheets.size,
    processingSize: processingKeys.size,
    timestamp: new Date().toISOString()
  });
});

// Test Google Sheets connection
app.get('/test/sheets', async (req, res) => {
  try {
    if (!sheetsClient) {
      return res.json({
        error: 'Google Sheets client not initialized',
        sheetId: process.env.GOOGLE_SHEET_ID || 'NOT_SET',
        clientEmail: process.env.GOOGLE_CLIENT_EMAIL || 'NOT_SET'
      });
    }

    console.log('Testing Google Sheets connection...');
    console.log('Sheet ID:', process.env.GOOGLE_SHEET_ID);

    // First get spreadsheet metadata to see all sheets/tabs
    const spreadsheetInfo = await sheetsClient.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID
    });

    const sheets = spreadsheetInfo.data.sheets.map(sheet => ({
      title: sheet.properties.title,
      sheetId: sheet.properties.sheetId,
      rowCount: sheet.properties.gridProperties.rowCount,
      columnCount: sheet.properties.gridProperties.columnCount
    }));

    console.log('Available sheets:', sheets);

    // Read all data from the first sheet to see what's there
    const firstSheetName = sheets[0]?.title || 'Sheet1';
    const allData = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${firstSheetName}!A:T`
    });

    console.log('Current data rows:', allData.data.values?.length || 0);
    if (allData.data.values) {
      console.log('First few rows:', allData.data.values.slice(0, 5));
    }

    // Write test data with a unique identifier
    const timestamp = new Date().toISOString();
    const testRow = [
      timestamp,
      'TEST_TICKET_ID_' + Date.now(),
      'TEST123',
      'TestAgent',
      '',
      9.0,
      9,8,9,8,9,
      'Test improvements ' + timestamp,
      'This is a test response to verify Google Sheets integration - ' + timestamp,
      '',
      50,
      'Test feedback 1',
      'Test feedback 2', 
      'Test feedback 3',
      'Test feedback 4',
      'Test feedback 5'
    ];

    const writeResult = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${firstSheetName}!A:T`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [testRow]
      }
    });

    console.log('Write result:', writeResult.data);

    // Read the data again to confirm it was written
    const afterWrite = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${firstSheetName}!A:T`
    });

    res.json({
      success: true,
      message: 'Google Sheets connection working',
      sheetId: process.env.GOOGLE_SHEET_ID,
      availableSheets: sheets,
      targetSheet: firstSheetName,
      rowsBeforeWrite: allData.data.values?.length || 0,
      rowsAfterWrite: afterWrite.data.values?.length || 0,
      testRowTimestamp: timestamp,
      writeRange: writeResult.data.tableRange,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Google Sheets test failed:', error);
    res.status(500).json({
      error: 'Google Sheets test failed',
      message: error.message,
      details: error.response?.data || 'No additional details',
      sheetId: process.env.GOOGLE_SHEET_ID || 'NOT_SET',
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Help Scout Response Evaluator with Google Sheets running on 0.0.0.0:${PORT}`);
});
