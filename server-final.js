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

// Simple in-memory cache for evaluations
const evaluationCache = new Map();

// Track running OpenAI requests to prevent duplicates
const runningEvaluations = new Map();

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
async function saveEvaluation(ticketData, agentName, customerName, responseText, contextText, evaluation) {
  if (!sheetsClient) {
    console.log('Google Sheets not available - skipping save');
    return;
  }
  
  try {
    const categories = evaluation.categories || {};
    const now = new Date().toISOString();
    
    // Prepare the row data matching your sheet columns exactly
    const rowData = [
      now, // Date
      ticketData.id, // Ticket ID
      ticketData.number, // Ticket Number
      agentName, // Agent Name
      evaluation.overall_score, // Overall Score
      categories.tone_empathy?.score || 0, // Tone Score
      categories.clarity_completeness?.score || 0, // Clarity Score
      categories.standard_of_english?.score || 0, // English Score
      categories.problem_resolution?.score || 0, // Resolution Score
      Array.isArray(evaluation.key_improvements) && evaluation.key_improvements.length > 0 ? evaluation.key_improvements.join('; ') : 'No recommendations', // Response Text (Key Improvements)
      responseText, // Conversation Context (Response Text)
      responseText.length, // Response Length
      categories.tone_empathy?.feedback || '', // Tone Empathy
      categories.clarity_completeness?.feedback || '', // Clarity
      categories.standard_of_english?.feedback || '', // English
      categories.problem_resolution?.feedback || '' // Problem Resolution
    ];

    console.log('About to append to Google Sheets...');
    console.log('Spreadsheet ID:', process.env.GOOGLE_SHEET_ID);
    console.log('Row data length:', rowData.length);
    console.log('Row data:', JSON.stringify(rowData, null, 2));
    console.log('Sheets client available:', !!sheetsClient);
    
    const result = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:T1', // Append after header row
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [rowData]
      }
    });
    
    console.log('Google Sheets append SUCCESS!');
    console.log('Result data:', JSON.stringify(result.data, null, 2));
    console.log('Updated range:', result.data.updates?.updatedRange);
    console.log('Updated rows:', result.data.updates?.updatedRows);
    console.log('Evaluation saved to Google Sheets for agent:', agentName);
  } catch (error) {
    console.error('Google Sheets save FAILED:', error.message);
    console.error('Full error:', JSON.stringify(error.response?.data || error, null, 2));
    throw error;
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

    // Create cache key from response content hash (persistent across restarts)
    const crypto = require('crypto');
    const responseHash = crypto.createHash('md5').update(latestResponse.text).digest('hex').substring(0, 8);
    const cacheKey = `${ticket.id}_${responseHash}`;
    console.log('Cache key:', cacheKey);
    console.log('Cache size:', evaluationCache.size);
    console.log('Cache has key?', evaluationCache.has(cacheKey));
    console.log('Already processing?', runningEvaluations.has(cacheKey));
    
    // CRITICAL: Check Google Sheets for existing evaluation to avoid duplicate OpenAI calls
    if (!evaluationCache.has(cacheKey) && !runningEvaluations.has(cacheKey)) {
      console.log('Not in memory cache, checking Google Sheets for existing evaluation...');
      try {
        if (sheetsClient) {
          console.log('Fetching existing data from Google Sheets...');
          const existingData = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Sheet1!A1:P1000'  // Get first 1000 rows explicitly
          });
          
          const rows = existingData.data.values || [];
          console.log(`Found ${rows.length} rows in Google Sheets`);
          console.log('Looking for ticket ID:', ticket.id.toString());
          console.log('Today date:', new Date().toISOString().split('T')[0]);
          
          // Check if this ticket ID already exists (regardless of date for now)
          const existingRow = rows.find(row => row && row[1] === ticket.id.toString());
          
          if (existingRow) {
            console.log('FOUND EXISTING EVALUATION in Google Sheets - no OpenAI call needed!');
            console.log('Existing row data:', existingRow.slice(0, 5)); // First 5 fields for debug
            
            // Return the existing evaluation from the sheet
            const html = `
              <div style="font-family: Arial, sans-serif; padding: 16px;">
                <h3>📊 Response Evaluation</h3>
                <div style="text-align: center; padding: 8px; background: #f0f8f0; border-radius: 4px; margin-bottom: 12px;">
                  <strong style="font-size: 16px;">Overall Score: ${existingRow[4] || 'N/A'}/10</strong>
                </div>
                <p style="font-size: 11px; margin: 4px 0;"><strong>Key Improvements:</strong> ${existingRow[9] || 'No recommendations'}</p>
                <div style="margin-top: 8px; padding: 8px; background: #f9f9f9; border-radius: 4px;">
                  <p style="font-size: 10px; color: #666; margin: 0;">Previously evaluated - using cached result</p>
                </div>
              </div>
            `;
            return res.json({ html });
          } else {
            console.log('No existing evaluation found for this ticket ID');
          }
        }
      } catch (error) {
        console.log('Error checking Google Sheets:', error.message);
        console.error('Full error:', error);
      }
    }
    
    // Check if we already have results
    if (evaluationCache.has(cacheKey)) {
      console.log('USING CACHED RESULTS - no OpenAI call needed');
      const evaluation = evaluationCache.get(cacheKey);
      
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
    
    // Try to complete within Help Scout's ~8 second timeout
    console.log('Starting OpenAI evaluation (waiting for completion)...');
    
    // Mark as processing to prevent duplicates
    runningEvaluations.set(cacheKey, true);
    
    try {
      // Race between OpenAI and 7-second timeout
      const evaluation = await Promise.race([
        evaluateResponse(latestResponse, conversation),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Help Scout timeout')), 7000)
        )
      ]);
      
      console.log('OpenAI evaluation completed:', evaluation.overall_score);
      console.log('CACHING RESULT with key:', cacheKey);
      evaluationCache.set(cacheKey, evaluation);
      runningEvaluations.delete(cacheKey); // Mark as completed
      
      // Save to database
      const agentName = latestResponse.createdBy?.first || 'Unknown';
      await saveEvaluation(ticket, agentName, '', latestResponse.text, '', evaluation);
      
      // Return complete results immediately - NO REFRESH NEEDED!
      const html = generateEvaluationHTML(evaluation, false, ticket, customer);
      res.json({ html });
      
    } catch (timeoutError) {
      console.log('OpenAI taking too long, falling back to background processing...');
      
      // Start background evaluation and return processing message
      evaluateResponse(latestResponse, conversation)
        .then(async (evaluation) => {
          console.log('Background evaluation completed:', evaluation.overall_score);
          console.log('CACHING BACKGROUND RESULT with key:', cacheKey);
          evaluationCache.set(cacheKey, evaluation);
          runningEvaluations.delete(cacheKey); // Mark as completed
          
          // Save to database
          const agentName = latestResponse.createdBy?.first || 'Unknown';
          await saveEvaluation(ticket, agentName, '', latestResponse.text, '', evaluation);
        })
        .catch(error => {
          console.error('Background evaluation failed:', error.message);
          evaluationCache.set(cacheKey, { overall_score: 0, error: error.message });
          runningEvaluations.delete(cacheKey); // Mark as completed even on error
        });
      
      // Return processing message
      const html = `
        <div style="font-family: Arial, sans-serif; padding: 16px;">
          <h3>📊 Response Evaluation</h3>
          <div style="text-align: center; padding: 12px; background: #f0f8ff; border-radius: 4px;">
            <p style="margin: 4px 0;"><strong>Status:</strong> Processing with OpenAI...</p>
            <p style="font-size: 10px; color: #666; margin: 4px 0;">Refresh in 10-15 seconds for results</p>
          </div>
        </div>
      `;
      
      res.json({ html });
    }

  } catch (error) {
    console.error('Error:', error);
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
      console.log('Found team response from:', thread.createdBy?.first || 'Unknown');
      return {
        text: thread.body,
        createdAt: thread.createdAt,
        createdBy: thread.createdBy
      };
    }
  }

  return null;
}


// Get conversation context helper function
function getConversationContext(conversation) {
  if (!conversation._embedded?.threads) return '';
  
  return [...conversation._embedded.threads]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-5) // Last 5 messages for context
    .map(thread => {
      const isCustomer = thread.createdBy === 'customer' || thread.createdBy?.type === 'customer';
      const isTeam = thread.createdBy === 'user' || thread.createdBy?.type === 'user';
      const sender = isCustomer ? 'CUSTOMER' : isTeam ? 'TEAM' : 'SYSTEM';
      const text = thread.body ? thread.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      return `${sender}: ${text}`;
    })
    .filter(msg => msg.length > 10) // Filter out very short messages
    .join('\n\n');
}

// Evaluate response using OpenAI
async function evaluateResponse(response, conversation) {
  
  // Clean the response text by removing HTML tags
  const cleanText = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Get conversation context (previous 3-4 messages for context)
  const conversationContext = getConversationContext(conversation);
  
  const prompt = `You are evaluating a customer support response based on these guidelines:

SUPPORT TONE REQUIREMENTS:
1. MUST start by thanking the customer
2. MUST end with a polite closing - acceptable closings include: "Let me know if you have any questions", "Please let me know what happens", "Best regards", "Many thanks", "Kind regards", or similar polite phrases
3. Should suggest workarounds ONLY when saying something isn't possible (not when providing complete solutions)
4. Only apologize when the company has done something wrong
5. Use positive language (avoid "but" and "however")
6. Include relevant links ONLY when specifically mentioning documentation, help articles, or specific features that would benefit from a direct link
7. Focus on being helpful and reassuring, especially for pre-sales

CONVERSATION CONTEXT (for understanding the situation):
${conversationContext ? conversationContext : 'No previous conversation context available'}

RESPONSE TO EVALUATE (most recent team response):
"${cleanText}"

Please evaluate this response on these criteria:
1. Tone & Empathy (follows support tone guidelines, thanks customer, polite closing)
2. Clarity & Completeness (clear, direct answers, addresses all questions)
3. Standard of English (grammar, spelling, natural phrasing for non-native speakers)
4. Problem Resolution (addresses actual customer needs - distinguish between investigation/information gathering vs providing actual solutions)
5. Following Structure (proper greeting, closing, correct terminology)

For each category, provide:
- Score out of 10
- Specific feedback (what was good, what needs improvement)

IMPORTANT FOR KEY IMPROVEMENTS:
- Only suggest improvements that are actually needed
- If the response already does something well (like good English or proper closing), don't suggest "continuing" it
- If no meaningful improvements are needed, return an empty array
- Workarounds should only be suggested for negative responses where something isn't possible
- Only suggest adding links if the response mentions specific features/documentation but lacks helpful links
- For Problem Resolution scoring: Investigation/information gathering responses (asking for more details, requesting access, troubleshooting steps) should be scored based on how well they investigate, NOT whether they provide a final solution
- Each improvement should be a specific, actionable suggestion

Then provide an overall score out of 10 and specific suggestions for improvement.

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
      model: 'gpt-4',
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Help Scout Response Evaluator with Google Sheets running on 0.0.0.0:${PORT}`);
});
